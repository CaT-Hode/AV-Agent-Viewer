import type { Debugger, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { ViewerCore } from '../../../../packages/document-core/src/index';
import type { ElectronBrowserRuntime } from '../../../../packages/browser-runtime/src/electron';
import { ViewerError } from '../../../../packages/contracts/src/index';

type SemanticAction = 'elements' | 'frames' | 'capture' | 'click' | 'fill' | 'select' | 'check' | 'wait';
export interface WebSemanticRequest { viewId: string; action: SemanticAction; frame?: string; element?: string; role?: string; name?: string; cursor?: string; limit?: number; text?: string; checked?: boolean; timeout?: number; signal?: AbortSignal }
type FrameTree = { frame: { id: string; parentId?: string; url: string; name?: string }; childFrames?: FrameTree[] };
type IsolatedContext = { id: number; session?: string };
type Connection = { contents: WebContents; debugger: Debugger; contexts: Map<string, IsolatedContext>; sessions: Map<string, string>; queue: Promise<unknown>; queued: number; invalid: Set<string>; attached: boolean; modal: boolean };
type FrameLease = { viewId: string; frameId: string; context: IsolatedContext; document: string; navigation: string };
type ElementLease = FrameLease & { node: string; generation: number; fingerprint: string };
type CursorLease = FrameLease & { generation: number; offset: number; role?: string; name?: string };
type SemanticElement = { node: string; fingerprint: string; role: string; name: string; tag: string; type?: string; value?: string; checked?: boolean; disabled: boolean; visible: boolean; href?: string };
type RuntimeReply = { document: string; generation: number; elements?: SemanticElement[]; total?: number; next?: number; element?: SemanticElement; error?: { code: string; message: string }; status?: string; [key: string]: unknown };
type RuntimeInput = { action: 'read' | 'inspect' | 'click' | 'fill' | 'select' | 'check'; seed?: string; document?: string; generation?: number; node?: string; fingerprint?: string; text?: string; checked?: boolean; offset?: number; limit?: number; role?: string; name?: string; tolerateMutation?: boolean };

/** This function is serialized only by this service, into its owned isolated
 * world. Callers provide typed values and never source code or CDP methods. */
function semanticRuntime(input: RuntimeInput): RuntimeReply {
  type State = { document: string; generation: number; next: number; composing: boolean; ids: WeakMap<Element, string>; nodes: Map<string, Element>; observer: MutationObserver };
  const global = globalThis as unknown as { __agentViewerSemantic?: State };
  let state = global.__agentViewerSemantic;
  if (!state) {
    const observer = new MutationObserver(records => { if (records.length) state!.generation++; });
    state = { document: input.seed!, generation: 0, next: 0, composing: false, ids: new WeakMap(), nodes: new Map(), observer };
    Object.defineProperty(global, '__agentViewerSemantic', { value: state, writable: false, configurable: false });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['id', 'role', 'aria-label', 'aria-labelledby', 'aria-disabled', 'disabled', 'readonly', 'type', 'href', 'multiple'] });
    document.addEventListener('input', () => { state!.generation++; }, true);
    document.addEventListener('change', () => { state!.generation++; }, true);
    document.addEventListener('compositionstart', () => { state!.composing = true; }, true);
    document.addEventListener('compositionend', () => { state!.composing = false; state!.generation++; }, true);
  }
  if (state.observer.takeRecords().length) state.generation++;
  const error = (code: string, message: string): RuntimeReply => ({ document: state!.document, generation: state!.generation, error: { code, message } });
  if (input.document && input.document !== state.document) return error('STALE_TARGET', 'The frame document changed.');
  if (input.generation !== undefined && input.generation !== state.generation && !input.tolerateMutation) return error('STALE_TARGET', 'The observed DOM changed; read the target again.');
  const sensitive = (element: Element) => element instanceof HTMLInputElement && (['password', 'file', 'hidden'].includes(element.type) || /(?:password|one-time-code|cc-)/i.test(element.autocomplete));
  const roleOf = (element: Element) => element.getAttribute('role')?.split(/\s+/)[0] || (element instanceof HTMLAnchorElement ? 'link' : element instanceof HTMLButtonElement || element instanceof HTMLElement && element.tagName === 'SUMMARY' ? 'button' : element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable ? 'textbox' : element instanceof HTMLSelectElement ? 'combobox' : element instanceof HTMLInputElement ? ['checkbox', 'radio'].includes(element.type) ? element.type : ['button', 'submit', 'reset'].includes(element.type) ? 'button' : 'textbox' : element.tagName.toLowerCase());
  const nameOf = (element: Element) => {
    const labelled = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).slice(0, 8).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? Array.from(element.labels ?? []).map(label => label.textContent ?? '').join(' ') : '';
    return String(element.getAttribute('aria-label') || labelled || labels || element.getAttribute('alt') || element.getAttribute('title') || (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) ? element.value : element instanceof HTMLElement ? element.innerText : element.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  };
  const describe = (element: Element): SemanticElement => {
    let node = state!.ids.get(element);
    if (!node) { node = String(++state!.next); state!.ids.set(element, node); }
    if (!state!.nodes.has(node)) { while (state!.nodes.size >= 2000) state!.nodes.delete(state!.nodes.keys().next().value!); state!.nodes.set(node, element); }
    const name = nameOf(element);
    const box = element.getBoundingClientRect(), style = getComputedStyle(element), visible = box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    const disabled = element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
    const rawValue = !sensitive(element) && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) ? element.value : undefined;
    const value = rawValue?.slice(0, 10000);
    const checked = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? element.checked : ['checkbox', 'radio', 'switch'].includes(roleOf(element)) ? element.getAttribute('aria-checked') === 'true' : undefined;
    const role = roleOf(element), type = element instanceof HTMLInputElement ? element.type : undefined;
    return { node, fingerprint: JSON.stringify([element.tagName, role, name, type, rawValue?.slice(0, 100000), checked]), role, name, tag: element.tagName.toLowerCase(), type, value, checked, disabled, visible, ...(element instanceof HTMLAnchorElement && /^https?:/.test(element.href) ? { href: element.href.slice(0, 2000) } : {}) };
  };
  if (input.action === 'read') {
    const candidates = document.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable="true"],summary'), elements: SemanticElement[] = [];
    const start = input.offset ?? 0, end = Math.min(candidates.length, start + 1000), count = Math.max(1, Math.min(100, input.limit ?? 20));
    let position = start;
    for (; position < end; position++) {
      const candidate = candidates[position];
      if (sensitive(candidate) || input.role && roleOf(candidate) !== input.role || input.name && !nameOf(candidate).toLocaleLowerCase().includes(input.name.toLocaleLowerCase())) continue;
      const element = describe(candidate); if (element.visible) elements.push(element);
      if (elements.length >= count) { position++; break; }
    }
    return { document: state.document, generation: state.generation, elements, next: position < candidates.length ? position : undefined, scanned: position - start, candidateCount: candidates.length, nameSource: 'aria-label/label/text-projection' };
  }
  const element = input.node ? state.nodes.get(input.node) : undefined;
  if (!element || !element.isConnected || element.ownerDocument !== document) return error('STALE_TARGET', 'The exact element is no longer connected.');
  if (sensitive(element)) return error('AUTH_SCOPE_DENIED', 'Credential, file and hidden inputs are excluded.');
  const before = describe(element);
  if (input.fingerprint && input.fingerprint !== before.fingerprint && !input.tolerateMutation) return error('STALE_TARGET', 'The exact element state changed.');
  if (input.action === 'inspect') return { document: state.document, generation: state.generation, element: before, status: 'observed', ...(input.text !== undefined && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) ? { valueMatches: element.value === input.text } : {}) };
  if (state.composing) return error('INPUT_BUSY', 'A human composition is active in this frame.');
  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.value.length > 100000) return error('READ_LIMIT', 'The complete current input value exceeds the guarded semantic range.');
  if (!before.visible || before.disabled) return error('ELEMENT_NOT_READY', 'The exact element is hidden or disabled.');
  if (input.action === 'fill') {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || element.readOnly || element instanceof HTMLInputElement && !['text', 'search', 'url', 'tel', 'email', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].includes(element.type)) return error('CAPABILITY_UNSUPPORTED', 'Fill requires a supported writable input or textarea.');
    const value = input.text ?? '', setter = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return error('CAPABILITY_UNSUPPORTED', 'The native value setter is unavailable.');
    if (!element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: value }))) return error('ACTION_BLOCKED', 'The site cancelled beforeinput.');
    setter.call(element, value); element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value })); element.dispatchEvent(new Event('change', { bubbles: true }));
    if (element.value !== value) return error('READBACK_FAILED', 'The input did not retain the requested value.');
  } else if (input.action === 'select') {
    if (!(element instanceof HTMLSelectElement) || element.multiple) return error('CAPABILITY_UNSUPPORTED', 'Select requires a native single-selection element.');
    const value = input.text ?? '', option = Array.from(element.options).find(option => option.value === value);
    if (!option || option.disabled) return error('INVALID_ARGUMENT', 'The requested option is absent or disabled.');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (!setter) return error('CAPABILITY_UNSUPPORTED', 'The native selection setter is unavailable.');
    setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    if (element.value !== value) return error('READBACK_FAILED', 'The select did not retain the requested option.');
  } else if (input.action === 'check') {
    if (!(element instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(element.type)) return error('CAPABILITY_UNSUPPORTED', 'Check requires a native checkbox or radio.');
    if (typeof input.checked !== 'boolean' || element.type === 'radio' && !input.checked) return error('INVALID_ARGUMENT', 'A checked boolean is required; radio buttons cannot be independently unchecked.');
    if (element.checked !== input.checked) element.click();
    if (element.checked !== input.checked) return error('READBACK_FAILED', 'The control did not retain the requested checked state.');
  } else {
    if (!(element instanceof HTMLElement)) return error('CAPABILITY_UNSUPPORTED', 'The exact element cannot receive a semantic click.');
    if (element instanceof HTMLAnchorElement && !/^https?:/.test(element.href)) return error('CAPABILITY_UNSUPPORTED', 'Only HTTP(S) link navigation is allowed.');
    element.click();
  }
  if (state.observer.takeRecords().length) state.generation++;
  return { document: state.document, generation: state.generation, element: element.isConnected ? describe(element) : undefined, status: input.action === 'click' ? 'dispatched' : 'applied', syntheticEvents: true, background: true };
}

export class WebSemanticService {
  private connections = new Map<number, Connection>();
  private frames = new Map<string, FrameLease>();
  private elements = new Map<string, ElementLease>();
  private cursors = new Map<string, CursorLease>();
  constructor(private core: ViewerCore) {}
  private remember<T>(map: Map<string, T>, prefix: string, value: T) { while (map.size >= 1024) map.delete(map.keys().next().value!); const ref = prefix + randomUUID().replaceAll('-', '').slice(0, 16); map.set(ref, value); return ref; }
  private async connection(viewId: string) {
    const view = this.core.getView(viewId), document = this.core.getDocument(view.documentId);
    if (document.info.format !== 'web' || !this.core.browser) throw new ViewerError('INVALID_TARGET', 'The target is not a live webpage.');
    const browser = this.core.browser as ElectronBrowserRuntime;
    // Reading context loads a lazy background page without activating it.
    await browser.context(viewId, 'agent');
    const entry = browser.entries.get(viewId);
    if (!entry || entry.view.webContents.isDestroyed()) throw new ViewerError('TARGET_NOT_FOUND', 'The webpage is unavailable.');
    const contents = entry.view.webContents, existing = this.connections.get(contents.id);
    if (existing?.attached && contents.debugger.isAttached()) return { connection: existing, navigation: entry.navigationId };
    if (contents.debugger.isAttached()) throw new ViewerError('DEBUGGER_BUSY', 'Another debugger owns this webpage; semantic operations will not take it over.');
    const debug = contents.debugger;
    try { debug.attach('1.3'); } catch (cause) { throw new ViewerError('BACKGROUND_UNSUPPORTED', 'The isolated semantic world could not be attached.', { cause: String(cause) }); }
    const connection: Connection = { contents, debugger: debug, contexts: new Map(), sessions: new Map(), queue: Promise.resolve(), queued: 0, invalid: new Set(), attached: true, modal: false };
    this.connections.set(contents.id, connection);
    debug.on('detach', () => { connection.attached = false; connection.contexts.clear(); if (this.connections.get(contents.id) === connection) this.connections.delete(contents.id); });
    debug.on('message', (_event, method, params, sessionId) => {
      if (method === 'Runtime.executionContextsCleared') for (const [frame, value] of connection.contexts) if ((value.session ?? '') === (sessionId ?? '')) connection.contexts.delete(frame);
      if (method === 'Runtime.executionContextDestroyed') for (const [frame, value] of connection.contexts) if (value.id === params.executionContextId && (value.session ?? '') === (sessionId ?? '')) connection.contexts.delete(frame);
      if (method === 'Page.frameNavigated' && params.frame?.id) { connection.contexts.delete(params.frame.id); connection.invalid.add(params.frame.id); }
      if (method === 'Page.frameDetached' && params.frameId) { connection.contexts.delete(params.frameId); connection.invalid.add(params.frameId); }
      if (method === 'Target.detachedFromTarget') for (const [frame, childSession] of connection.sessions) if (childSession === params.sessionId) { connection.sessions.delete(frame); connection.contexts.delete(frame); connection.invalid.add(frame); }
      if (method === 'Page.javascriptDialogOpening') connection.modal = true;
      if (method === 'Page.javascriptDialogClosed') connection.modal = false;
    });
    contents.once('destroyed', () => { connection.attached = false; connection.contexts.clear(); this.connections.delete(contents.id); });
    await debug.sendCommand('Page.enable'); await debug.sendCommand('Runtime.enable');
    return { connection, navigation: entry.navigationId };
  }
  private async tree(connection: Connection): Promise<FrameTree[]> {
    const result = await connection.debugger.sendCommand('Page.getFrameTree') as { frameTree: FrameTree }, frames: FrameTree[] = [];
    const known = new Set<string>();
    const walk = (tree: FrameTree) => { if (known.has(tree.frame.id)) return; known.add(tree.frame.id); frames.push(tree); for (const child of tree.childFrames ?? []) walk(child); }; walk(result.frameTree);
    // Chromium omits out-of-process children from the parent Page frame tree.
    // Target discovery is filtered by the already-owned parent-frame chain;
    // other tabs/workers are neither attached nor returned.
    const targets = await connection.debugger.sendCommand('Target.getTargets') as { targetInfos: { targetId: string; type: string; url: string; parentFrameId?: string; parentId?: string }[] };
    for (let pass = 0; pass < 16 && frames.length < 100; pass++) {
      let added = false;
      for (const target of targets.targetInfos) {
        const parent = target.parentFrameId ?? target.parentId;
        if (target.type !== 'iframe' || known.has(target.targetId) || !parent || !known.has(parent)) continue;
        walk({ frame: { id: target.targetId, parentId: parent, url: target.url } }); added = true;
      }
      if (!added) break;
    }
    for (const childSession of connection.sessions.values()) {
      try { const child = await connection.debugger.sendCommand('Page.getFrameTree', {}, childSession) as { frameTree: FrameTree }; for (const nested of child.frameTree.childFrames ?? []) walk(nested); }
      catch { /* A navigating child will be invalidated by its lifecycle event. */ }
    }
    return frames;
  }
  private async context(connection: Connection, frameId: string): Promise<IsolatedContext> {
    const current = connection.contexts.get(frameId); if (current) return current;
    let childSession = connection.sessions.get(frameId), result: { executionContextId: number };
    try { result = await connection.debugger.sendCommand('Page.createIsolatedWorld', { frameId, worldName: 'AgentViewerSemantic', grantUniveralAccess: false }, childSession); }
    catch (cause) {
      // OOPIFs have their own target. The target id comes only from this
      // page's current frame tree, never from a caller-supplied CDP id.
      if (childSession) throw cause;
      const attached = await connection.debugger.sendCommand('Target.attachToTarget', { targetId: frameId, flatten: true }) as { sessionId: string };
      childSession = attached.sessionId; connection.sessions.set(frameId, childSession);
      try {
        await connection.debugger.sendCommand('Page.enable', {}, childSession);
        await connection.debugger.sendCommand('Runtime.enable', {}, childSession);
        result = await connection.debugger.sendCommand('Page.createIsolatedWorld', { frameId, worldName: 'AgentViewerSemantic', grantUniveralAccess: false }, childSession);
      } catch (error) { connection.sessions.delete(frameId); await connection.debugger.sendCommand('Target.detachFromTarget', { sessionId: childSession }).catch(() => {}); throw error; }
    }
    const value = { id: result.executionContextId, session: childSession };
    connection.contexts.set(frameId, value); connection.invalid.delete(frameId); return value;
  }
  private async evaluate(connection: Connection, context: IsolatedContext, input: RuntimeInput): Promise<RuntimeReply> {
    if (!connection.attached) throw new ViewerError('STALE_TARGET', 'The semantic debugger session ended.');
    const result = await connection.debugger.sendCommand('Runtime.evaluate', { expression: '(' + semanticRuntime.toString() + ')(' + JSON.stringify({ ...input, seed: randomUUID() }) + ')', contextId: context.id, returnByValue: true, awaitPromise: true, userGesture: false, timeout: 5000 }, context.session) as { result: { value?: RuntimeReply }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails || !result.result.value) throw new ViewerError('WEB_READ_FAILED', 'The fixed semantic operation failed.', { error: result.exceptionDetails?.text });
    const value = result.result.value; if (value.error) throw new ViewerError(value.error.code, value.error.message); return value;
  }
  async request(input: WebSemanticRequest) {
    if (input.signal?.aborted) throw new ViewerError('CANCELLED', 'The web operation was cancelled.');
    const { connection, navigation } = await this.connection(input.viewId);
    if (connection.queued >= 16) throw new ViewerError('SERVICE_BUSY', 'The webpage semantic queue is full.');
    connection.queued++;
    // Each page is one semantic lane; another agent cannot replace a captured
    // element between validation and the fixed operation's immediate readback.
    const operation = connection.queue.catch(() => {}).then(() => this.inside(connection, navigation, input));
    connection.queue = operation;
    try { return await operation; } finally { connection.queued--; }
  }
  private async inside(connection: Connection, navigation: string, input: WebSemanticRequest): Promise<Record<string, unknown>> {
    if (input.signal?.aborted) throw new ViewerError('CANCELLED', 'The web operation was cancelled.');
    const current = (this.core.browser as ElectronBrowserRuntime).entries.get(input.viewId);
    if (!current || current.navigationId !== navigation) throw new ViewerError('STALE_TARGET', 'The webpage navigated while the semantic request was queued.');
    if (!['elements', 'frames', 'capture', 'wait'].includes(input.action)) {
      const control = this.core.agentControl?.get(input.viewId) ?? this.core.agentControl?.get(this.core.getView(input.viewId).documentId);
      if (control === 'paused' || control === 'stopped') throw new ViewerError('AGENT_PAUSED', 'The human paused Agent edits for this webpage.');
      if (connection.modal) throw new ViewerError('INPUT_BUSY', 'A webpage dialog is open; the Agent will not dismiss it.');
    }
    if (input.action === 'capture') return { ...await this.core.browser!.capture(input.viewId), background: true };
    const tree = await this.tree(connection);
    if (input.action === 'frames') {
      const frames: Record<string, unknown>[] = [], parents: (string|undefined)[] = [], refs = new Map<string,string>();
      for (const item of tree.slice(0, 100)) {
        parents.push(item.frame.parentId);
        try {
          const context = await this.context(connection, item.frame.id), observed = await this.evaluate(connection, context, { action: 'read', limit: 1 });
          const ref = this.remember(this.frames, 'wf', { viewId: input.viewId, frameId: item.frame.id, context, document: observed.document, navigation });
          refs.set(item.frame.id,ref);frames.push({ ref, url: item.frame.url, name: item.frame.name, background: true, supported: true });
        } catch (cause) { frames.push({ url: item.frame.url, name: item.frame.name, background: false, supported: false, reason: cause instanceof ViewerError ? cause.code : 'FRAME_UNAVAILABLE' }); }
      }
      for(let index=0;index<frames.length;index++)if(parents[index])frames[index].parent=refs.get(parents[index]!);
      return { frames, truncated: tree.length > frames.length, navigation, background: true };
    }
    if (input.action === 'elements') {
      const frame = input.frame ? this.frames.get(input.frame) : undefined, cursor = input.cursor ? this.cursors.get(input.cursor) : undefined;
      if (input.frame && (!frame || frame.viewId !== input.viewId || frame.navigation !== navigation)) throw new ViewerError('STALE_TARGET', 'The exact frame reference expired.');
      if (input.cursor && (!cursor || cursor.viewId !== input.viewId || cursor.navigation !== navigation || cursor.role !== input.role || cursor.name !== input.name || frame && cursor.frameId !== frame.frameId)) throw new ViewerError('STALE_CURSOR', 'The web query source or filters changed.');
      const frameId = frame?.frameId ?? cursor?.frameId ?? tree[0]?.frame.id;
      if (!frameId || !tree.some(item => item.frame.id === frameId)) throw new ViewerError('STALE_TARGET', 'The exact frame no longer exists.');
      const context = await this.context(connection, frameId);
      if (frame && frame.context !== context || cursor && cursor.context !== context) throw new ViewerError('STALE_TARGET', 'The exact frame navigated.');
      const observed = await this.evaluate(connection, context, { action: 'read', document: frame?.document ?? cursor?.document, generation: cursor?.generation, role: input.role, name: input.name, offset: cursor?.offset, limit: input.limit });
      const lease: FrameLease = { viewId: input.viewId, frameId, context, document: observed.document, navigation };
      const frameRef = input.frame ?? this.remember(this.frames, 'wf', lease);
      const elements = (observed.elements ?? []).map(element => {
        const ref = this.remember(this.elements, 'we', { ...lease, node: element.node, generation: observed.generation, fingerprint: element.fingerprint });
        const { node: _node, fingerprint: _fingerprint, ...value } = element; return { ref, ...value };
      });
      const next = observed.next !== undefined ? this.remember(this.cursors, 'wc', { ...lease, generation: observed.generation, offset: observed.next, role: input.role, name: input.name }) : undefined;
      if ((this.core.browser as ElectronBrowserRuntime).entries.get(input.viewId)?.navigationId !== navigation) throw new ViewerError('STALE_TARGET', 'The webpage navigated during observation.');
      return { elements, frame: frameRef, cursor: next, scanned: observed.scanned, candidateCount: observed.candidateCount, document: observed.document, generation: observed.generation, navigation, background: true, nameSource: observed.nameSource };
    }
    const lease = input.element ? this.elements.get(input.element) : undefined;
    if (!lease || lease.viewId !== input.viewId || lease.navigation !== navigation || !tree.some(item => item.frame.id === lease.frameId)) throw new ViewerError('STALE_TARGET', 'A current exact element reference is required.');
    const context = await this.context(connection, lease.frameId);
    if (context !== lease.context) throw new ViewerError('STALE_TARGET', 'The exact frame navigated.');
    const fixed = { document: lease.document, generation: lease.generation, node: lease.node, fingerprint: lease.fingerprint };
    if (input.action === 'wait') {
      const until = Date.now() + Math.min(10000, Math.max(1, input.timeout ?? 2000));
      while (true) {
        if (input.signal?.aborted) throw new ViewerError('CANCELLED', 'Waiting for the exact element was cancelled.');
        const observed = await this.evaluate(connection, context, { ...fixed, action: 'inspect', tolerateMutation: true });
        if (observed.element?.visible && !observed.element.disabled) return this.actionResult(input, lease, observed, navigation);
        if (Date.now() >= until) throw new ViewerError('ELEMENT_NOT_READY', 'The exact element was not ready before the timeout.');
        await new Promise(done => setTimeout(done, 50));
      }
    }
    const semanticEntry = current as typeof current & { semanticAgent?: boolean }, previousSemantic = semanticEntry.semanticAgent;
    semanticEntry.semanticAgent = true; semanticEntry.actor = 'agent';
    try {
      const observed = await this.evaluate(connection, context, { ...fixed, action: input.action, text: input.text, checked: input.checked });
      // Read again after synchronous site listeners. Never mark a click as a
      // verified edit: the actual server-side effect is site-specific.
      if (input.action !== 'click') {
        const fresh = await this.evaluate(connection, context, { document: lease.document, node: lease.node, action: 'inspect', text: input.text, tolerateMutation: true });
        if ((input.action === 'fill' || input.action === 'select') && fresh.valueMatches !== true || input.action === 'check' && fresh.element?.checked !== input.checked) throw new ViewerError('READBACK_FAILED', 'The site did not retain the requested state.');
        return this.actionResult(input, lease, { ...fresh, status: observed.status, syntheticEvents: true }, navigation);
      }
      return this.actionResult(input, lease, observed, navigation);
    } catch (cause) {
      if (input.action === 'click' && (connection.invalid.has(lease.frameId) || !connection.contexts.has(lease.frameId))) return { status: 'dispatched', navigationChanged: true, background: true, readback: 'navigation-observed' };
      throw cause;
    } finally { semanticEntry.semanticAgent = previousSemantic; }
  }
  private actionResult(input: WebSemanticRequest, lease: ElementLease, observed: RuntimeReply, navigation: string) {
    const target = observed.element;
    const ref = target ? this.remember(this.elements, 'we', { ...lease, generation: observed.generation, fingerprint: target.fingerprint }) : undefined;
    const value = target ? (({ node: _node, fingerprint: _fingerprint, ...rest }) => rest)(target) : undefined;
    return { status: observed.status, element: value, ref, document: observed.document, generation: observed.generation, navigation, background: true, syntheticEvents: input.action !== 'wait' };
  }
  dispose() { for (const connection of this.connections.values()) if (connection.attached && !connection.contents.isDestroyed()) { try { connection.debugger.detach(); } catch { /* Only detach our own debugger session. */ } } this.connections.clear(); this.frames.clear(); this.elements.clear(); this.cursors.clear(); }
}
