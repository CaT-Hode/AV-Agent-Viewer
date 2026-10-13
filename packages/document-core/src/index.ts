import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Actor, AgentViewState, AgentViewStatus, BrowserRequest, BrowserRuntime, BrowserAction, Rect, DocumentInfo, EditOperation, Format, HarnessDriver, HarnessTask, PreparedPatch, ReadingContext, ReadingSnapshot, Receipt, ViewInfo, WorkspaceState } from '../../contracts/src/index';
import { PROTOCOL_VERSION, ViewerError, editOperationSchema, browserRequestSchema, normalizeWebAddress } from '../../contracts/src/index';
import { AdapterRegistry, createRegistry } from '../../format-adapters/src/index';
import type { WorkspaceRepository } from '../../persistence/src/index';
import { convertLegacy } from '../../../apps/office-gateway/src/conversion';
import { scopedReadingSnapshot, type ScopedReadingSnapshot } from '../../ai-reading-tools/src/index';
import type { NativeOfficeDriver, NativeOfficeState, NativeOfficeSnapshot, NativeOfficeExecuteRequest, NativeOfficeExecution, NativeOfficeQuery, NativeOfficeStylePatch } from '../../contracts/src/native-office';
import { nativeOfficeStylePatchSchema } from '../../contracts/src/native-office';
import type { NativeOfficeNavigateTarget, NativeOfficeExportFormat, UNOProperty } from '../../contracts/src/native-office';
import { nativeOfficeCommandPolicy } from '../../contracts/src/native-office-policy';
import { normalizeNativeOfficeDriver } from './native-office-errors';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
// Dispatching a dialog or an editing command is work in progress, not proof of a
// byte change. Pure reading/navigation commands do not change that phase.
const nativeCommandEdits = (command: string) => !/^\.uno:(?:Copy(?:$|Text$|HyperlinkLocation$|Url$)|Select|Print|PrinterSetup|Zoom|Find|Search|GoTo|Goto|JumpTo|Navigator|Help|NextPage|PreviousPage|FirstPage|LastPage|Browse)/.test(command);
const nativeInputEdits = (action: BrowserAction) => action.kind === 'type' ? action.text.length > 0 : action.kind === 'press' && (['Backspace', 'Delete'].includes(action.key) || action.key.length === 1 && !action.modifiers.some(modifier => ['control', 'meta', 'alt'].includes(modifier)));
interface InternalDocument { info: DocumentInfo; bytes: Uint8Array; sourceHash?: string }
import type { Annotation } from '../../selection-tools/src/index';
interface StoredWorkspace { annotations?: Annotation[]; schemaVersion: string; documents: { info: DocumentInfo; bytes: string; sourceHash?: string }[]; views: ViewInfo[]; activeViewId?: string; lastHumanViewId?: string; receipts?: [string, { payload: string; receipt: unknown }][]; patches?: [string, PreparedPatch][] }
interface UndoEntry { documentId: string; before: InternalDocument; afterRevision: number; native?: { sessionId: string; writerEpoch: string; engineEpoch: string; engineRevision: number; viewId: string; undoToken?: string } }
interface NativeBinding { writerEpoch: string; state: NativeOfficeState; mirrorEngineRevision: number; openingEngineRevision: number; closing: boolean; workerExited?: boolean; viewIds: Set<string> }

export class ViewerCore extends EventEmitter {
  readonly annotations = new Map<string, Annotation>();
  readonly extensions = new Map<string, (args: Record<string, any>, actor: Actor) => Promise<unknown>>();
  readonly documents = new Map<string, InternalDocument>();
  readonly views = new Map<string, ViewInfo>();
  readonly snapshots = new Map<string, ReadingSnapshot>();
  readonly patches = new Map<string, PreparedPatch>();
  readonly transactions = new Map<string, UndoEntry>();
  readonly tasks = new Map<string, HarnessTask>();
  readonly drivers = new Map<string, HarnessDriver>();
  readonly receipts = new Map<string, { payload: string; receipt: unknown }>();
  readonly agentControl = new Map<string, 'running' | 'paused' | 'stopped'>();
  readonly eventLog: { seq: number; type: string; time: string; data: unknown }[] = [];
  browser?: BrowserRuntime;
  activeViewId?: string;
  lastHumanViewId?: string;
  private taskControllers = new Map<string, AbortController>();
  private queues = new Map<string, Promise<unknown>>();
  private agentStateEpochs = new Map<string, number>();
  private nativeOfficeDriver?: NativeOfficeDriver;
  private wrappedNativeOfficeDriver?: NativeOfficeDriver;
  private nativeOfficeBindings = new Map<string, NativeBinding>();
  private saveTimer?: NodeJS.Timeout;
  private positionSaveTimer?: NodeJS.Timeout;
  lastPersistenceError?: string;
  constructor(readonly repository: WorkspaceRepository, readonly registry: AdapterRegistry = createRegistry()) { super(); }
  async initialize() {
    const saved = await this.repository.load<StoredWorkspace>();
    if (!saved) return;
    if (saved.schemaVersion !== PROTOCOL_VERSION) throw new ViewerError('SCHEMA_MISMATCH', '工作区版本不兼容，原恢复文件保留。');
    for (const entry of saved.documents) { delete entry.info.nativeOffice; this.documents.set(entry.info.id, { info: entry.info, bytes: new Uint8Array(Buffer.from(entry.bytes, 'base64')), sourceHash: entry.sourceHash }); }
    for (const entry of this.documents.values()) if (entry.info.format !== 'web') entry.info.capabilities = this.registry.resolve(entry.info.format).capabilities(entry.info.format);
    for (const savedView of saved.views) { const { agentState: _onlineState, ...view } = savedView; this.views.set(view.id, { ...view, windowId: 'main', context: view.context ? { ...view.context, quality: 'last-confirmed' } : undefined }); }
    for (const annotation of saved.annotations ?? []) this.annotations.set(annotation.id, annotation);
    this.activeViewId = saved.activeViewId;
    this.lastHumanViewId = saved.lastHumanViewId;
    for (const [id, receipt] of saved.receipts ?? []) this.receipts.set(id, receipt);
    for (const [id, patch] of saved.patches ?? []) this.patches.set(id, patch);
  }
  state(): WorkspaceState { return clone({ protocolVersion: PROTOCOL_VERSION, documents: [...this.documents.values()].map(d => d.info), views: [...this.views.values()], agentStates: [...this.views.values()].flatMap(view => view.agentState ? [view.agentState] : []), activeViewId: this.activeViewId, eventsSeq: this.eventLog.at(-1)?.seq ?? 0, tasks: [...this.tasks.values()] }); }
  /** Trusted desktop display projection. Public SDK/HTTP state remains complete. */
  stateForDisplay(): WorkspaceState {
    return clone({ protocolVersion: PROTOCOL_VERSION, documents: [...this.documents.values()].map(document => this.nativeOfficeBindings.has(document.info.id) ? { ...document.info, model: { format: document.info.format } } : document.info), views: [...this.views.values()], agentStates: [...this.views.values()].flatMap(view => view.agentState ? [view.agentState] : []), activeViewId: this.activeViewId, eventsSeq: this.eventLog.at(-1)?.seq ?? 0, tasks: [...this.tasks.values()] });
  }
  event(type: string, data: unknown, persistence: 'normal' | 'position' = 'normal') {
    const event = { seq: (this.eventLog.at(-1)?.seq ?? 0) + 1, type, time: new Date().toISOString(), data };
    this.eventLog.push(event); if (this.eventLog.length > 1000) this.eventLog.shift(); this.emit('change', event);
    if (!type.startsWith('harness.')) {
      const save = () => { void this.persist().catch(e => { this.lastPersistenceError = String(e); this.emit('diagnostic', e); }); };
      if (persistence === 'position') {
        // Keep the most recent location with a bounded delay. Resetting this on
        // every native poll would postpone recovery forever during scrolling.
        this.positionSaveTimer ??= setTimeout(save, 2500);
      } else { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(save, 300); }
    }
  }
  async persist() {
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    clearTimeout(this.positionSaveTimer); this.positionSaveTimer = undefined;
    const value: StoredWorkspace = { annotations: [...this.annotations.values()], schemaVersion: PROTOCOL_VERSION, documents: [...this.documents.values()].map(d => ({ info: d.info, bytes: Buffer.from(d.bytes).toString('base64'), sourceHash: d.sourceHash })), views: [...this.views.values()].map(({ agentState: _onlineState, ...view }) => view), activeViewId: this.activeViewId, lastHumanViewId: this.lastHumanViewId, receipts: [...this.receipts.entries()].slice(-1000), patches: [...this.patches.entries()].slice(-1000) };
    await this.repository.save(value); this.lastPersistenceError = undefined;
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn); this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
    return next;
  }
  getDocument(id: string) { const document = this.documents.get(id); if (!document) throw new ViewerError('TARGET_NOT_FOUND', '文档已关闭或不存在。'); return document; }
  registerNativeOfficeDriver(driver: NativeOfficeDriver) {
    if (this.nativeOfficeBindings.size && this.nativeOfficeDriver !== driver) throw new ViewerError('NATIVE_SESSION_ACTIVE', '原生Office会话仍在运行，不能替换编辑源。');
    if (this.nativeOfficeDriver === driver && this.wrappedNativeOfficeDriver) return;
    this.nativeOfficeDriver = driver;
    this.wrappedNativeOfficeDriver = normalizeNativeOfficeDriver(driver);
  }
  private nativeDriver() { if (!this.wrappedNativeOfficeDriver) throw new ViewerError('ENGINE_UNAVAILABLE', '完整原生Office引擎尚未连接。'); return this.wrappedNativeOfficeDriver; }
  private nativeBinding(documentId: string) { const binding = this.nativeOfficeBindings.get(documentId); if (!binding || binding.closing || binding.state.status === 'failed') throw new ViewerError('NATIVE_SESSION_EXPIRED', '原生Office会话已关闭或不可用，请重新打开。'); return binding; }
  private publishNativeMetadata(documentId: string, binding: NativeBinding) {
    const doc = this.getDocument(documentId);
    doc.info.nativeOffice = { sessionId: binding.state.sessionId, writerEpoch: binding.writerEpoch, engineEpoch: binding.state.engineEpoch, engineRevision: binding.state.engineRevision, mirrorEngineRevision: binding.mirrorEngineRevision, status: binding.state.status ?? 'ready' };
    const unsaved = typeof binding.state.unsavedContentChanges === 'boolean' ? binding.state.unsavedContentChanges : binding.state.dirty || binding.mirrorEngineRevision >= 0 && binding.state.engineRevision !== binding.mirrorEngineRevision;
    if (unsaved) doc.info.dirty = true;
  }
  /** Called only by the trusted runtime owner after its native worker exits. */
  failNativeOfficeSession(sessionId: string, reasonCode = 'NATIVE_WORKER_EXITED') {
    for (const [documentId, binding] of this.nativeOfficeBindings) {
      if (binding.state.sessionId !== sessionId) continue;
      if (binding.state.engineRevision !== binding.mirrorEngineRevision) this.getDocument(documentId).info.dirty = true;
      binding.workerExited = true;
      binding.closing = false;
      binding.state = { ...binding.state, status: 'failed', visible: false, focused: false, nativeGeometry: false, visibleText: '', visibleTextReady: false, visibleTextSource: 'unavailable', selection: { kind: 'none', text: '' }, selectionActions: [], warnings: [...(binding.state.warnings ?? []), reasonCode] };
      this.publishNativeMetadata(documentId, binding);
      for (const view of this.views.values()) if (view.documentId === documentId) this.updateContext(view.id, { quality: 'not-ready', actor: 'engine', visibleText: '', selection: { kind: 'none', text: '' }, locator: { kind: 'unconfirmed' }, nativeOffice: undefined }, 'engine');
      this.event('office.failed', { documentId, sessionId, reasonCode });
    }
  }
  /** Trusted runtime events invalidate a mirror; they never pretend old bytes are fresh. */
  updateNativeOfficeState(state: NativeOfficeState) {
    const binding = this.nativeOfficeBindings.get(state.documentId);
    if (!binding || binding.closing || state.sessionId !== binding.state.sessionId || state.engineEpoch !== binding.state.engineEpoch || state.engineRevision < binding.state.engineRevision) return;
    if (JSON.stringify(state) === JSON.stringify(binding.state)) return;
    const previous = binding.state, durable = state.engineRevision !== previous.engineRevision || state.dirty !== previous.dirty || state.unsavedContentChanges !== previous.unsavedContentChanges || state.status !== previous.status;
    binding.state = clone(state); this.publishNativeMetadata(state.documentId, binding);
    if (state.engineRevision !== binding.mirrorEngineRevision) for (const view of this.views.values()) if (view.documentId === state.documentId && view.context) view.context = { ...view.context, quality: 'last-confirmed', selection: { ...view.context.selection, rect: undefined } };
    this.event('office.state', { documentId: state.documentId, sessionId: state.sessionId, engineRevision: state.engineRevision, dirty: state.dirty }, durable ? 'normal' : 'position');
  }
  async openNativeOffice(viewId: string) {
    const view = this.getView(viewId), documentId = view.documentId;
    return this.serial(documentId, async () => {
      const doc = this.getDocument(documentId);
      if (!['docx','pptx','xlsx'].includes(doc.info.format)) throw new ViewerError('CAPABILITY_UNSUPPORTED', '完整原生Office仅支持Word、PPT和Excel文档。');
      const driver = this.nativeDriver(), previous = this.nativeOfficeBindings.get(documentId);
      if (previous?.viewIds.has(viewId)) return this.nativeOfficeState(viewId);
      const state = await driver.open({ documentId, viewId, format: doc.info.format as NativeOfficeState['format'], bytes: doc.bytes.slice(), revision: doc.info.revision, sourcePath: doc.info.path });
      if (state.documentId !== documentId || state.format !== doc.info.format || !state.sessionId || !state.engineEpoch || !Number.isInteger(state.engineRevision) || state.engineRevision < 0) throw new ViewerError('NATIVE_STATE_INVALID', '原生引擎返回了不匹配的文档身份或版本。');
      if (previous && (previous.state.sessionId !== state.sessionId || previous.state.engineEpoch !== state.engineEpoch)) throw new ViewerError('NATIVE_WRITER_CONFLICT', '同一文档不能建立第二个独立的原生编辑源。');
      const binding = previous ?? { writerEpoch: randomUUID(), state: clone(state), mirrorEngineRevision: -1, openingEngineRevision: state.engineRevision, closing: false, viewIds: new Set<string>() };
      binding.viewIds.add(viewId);
      binding.state = clone(state); this.nativeOfficeBindings.set(documentId, binding); this.publishNativeMetadata(documentId, binding);
      doc.info.capabilities = { ...doc.info.capabilities, engine: 'libreoffice-native', editKinds: [...(state.supportedOperations ?? []), 'office.dispatch'], limitations: ['原生Office是唯一编辑源；未接入的旧操作需使用原生命令目录。', ...(state.warnings ?? [])] };
      if (!previous || binding.mirrorEngineRevision !== state.engineRevision) await this.syncNativeInside(documentId, 'engine');
      this.event('office.opened', { documentId, viewId, sessionId: state.sessionId });
      return this.nativeOfficeState(viewId);
    });
  }
  async nativeOfficeState(viewId: string) {
    const view = this.getView(viewId), existing = this.nativeOfficeBindings.get(view.documentId);
    if (existing?.workerExited) return clone({ ...existing.state, viewId });
    // A close veto or an unanswered close is not a confirmed worker exit. Keep
    // the writer registered and let a real state response confirm recovery.
    if (!existing || existing.closing) throw new ViewerError('NATIVE_SESSION_EXPIRED', '原生Office会话已关闭或不可用，请重新打开。');
    const binding = existing;
    const state = await this.nativeDriver().state(binding.state.sessionId, viewId);
    if (state.documentId !== view.documentId || state.sessionId !== binding.state.sessionId || state.engineEpoch !== binding.state.engineEpoch || state.viewId !== viewId) throw new ViewerError('NATIVE_SESSION_EXPIRED', '原生控制器与目标页面不匹配。');
    this.updateNativeOfficeState(state); return clone(state);
  }
  private async stableNativeSnapshot(documentId: string): Promise<NativeOfficeSnapshot> {
    const binding = this.nativeBinding(documentId), driver = this.nativeDriver();
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await driver.snapshot(binding.state.sessionId);
      if (result.state.documentId !== documentId || result.state.sessionId !== binding.state.sessionId || result.state.engineEpoch !== binding.state.engineEpoch || result.format !== this.getDocument(documentId).info.format) throw new ViewerError('NATIVE_SESSION_EXPIRED', '原生Office来源已更换。');
      if (result.state.pendingInput) throw new ViewerError('NATIVE_EDIT_IN_PROGRESS', '原生编辑器仍有未提交输入，请完成输入后重试。');
      if (!result.stable || result.engineRevisionBefore !== result.engineRevisionAfter || result.engineRevisionAfter !== result.state.engineRevision) continue;
      const digest = hash(result.bytes);
      if (result.sha256 && result.sha256 !== digest) throw new ViewerError('NATIVE_SNAPSHOT_INVALID', '原生文件镜像校验失败。');
      return { ...result, sha256: digest };
    }
    throw new ViewerError('NATIVE_SNAPSHOT_BUSY', '原生文档正在变化，未取得完整稳定快照。');
  }
  private async acceptNativeSnapshot(documentId: string, result: NativeOfficeSnapshot, actor: Actor) {
    const doc = this.getDocument(documentId), binding = this.nativeBinding(documentId), digest = result.sha256 ?? hash(result.bytes), changed = digest !== hash(doc.bytes);
    const model = changed ? await this.registry.resolve(doc.info.format).open(result.bytes, doc.info.format) : doc.info.model;
    if (changed) { doc.bytes = result.bytes.slice(); doc.info.model = model; doc.info.revision++; for (const view of this.views.values()) if (view.documentId === documentId && view.context) view.context = { ...view.context, contentRevision: doc.info.revision, quality: 'not-ready', visibleText: '', selection: { kind: 'none', text: '' } }; }
    binding.mirrorEngineRevision = result.engineRevisionAfter;
    if (result.state.engineRevision >= binding.state.engineRevision) binding.state = clone(result.state);
    this.publishNativeMetadata(documentId, binding);
    // LO may clear its own dirty flag after saving its managed temporary source.
    // That is not an acknowledgement that the application's original file was saved.
    // Initial serialization normalization alone is not a human edit, however.
    const originalUnsaved = typeof result.state.unsavedContentChanges === 'boolean' ? result.state.unsavedContentChanges : result.state.dirty || result.engineRevisionAfter > binding.openingEngineRevision && digest !== doc.sourceHash;
    doc.info.dirty = doc.info.dirty || originalUnsaved;
    if (changed) this.event('document.changed', { documentId, revision: doc.info.revision, actor, source: 'native-office', sessionId: result.state.sessionId });
    return changed;
  }
  private async syncNativeInside(documentId: string, actor: Actor) {
    const result = await this.stableNativeSnapshot(documentId); await this.acceptNativeSnapshot(documentId, result, actor); return result;
  }
  async synchronizeNativeDocument(documentId: string, actor: Actor = 'engine') {
    if (!this.nativeOfficeBindings.has(documentId)) return clone(this.getDocument(documentId).info);
    return this.serial(documentId, async () => { await this.syncNativeInside(documentId, actor); return clone(this.getDocument(documentId).info); });
  }
  async nativeOfficeCommands(viewId: string) { const view = this.getView(viewId), binding = this.nativeBinding(view.documentId); return this.nativeDriver().commands(binding.state.sessionId, viewId); }
  async nativeOfficeQuery(viewId: string, target: NativeOfficeQuery) { const view = this.getView(viewId), binding = this.nativeBinding(view.documentId); return this.nativeDriver().query(binding.state.sessionId, viewId, target); }
  async queryNativeOffice(viewId: string, target: NativeOfficeQuery) {
    const before = await this.nativeOfficeState(viewId), data = await this.nativeOfficeQuery(viewId, target), state = await this.nativeOfficeState(viewId);
    if (before.engineEpoch !== state.engineEpoch || before.engineRevision !== state.engineRevision || before.selectionEpoch !== state.selectionEpoch) throw new ViewerError('STALE_NATIVE_QUERY', '查询期间原生文档或选区已变化，请重新读取。');
    return { state, target: clone(target), data };
  }
  async captureNativeOffice(input: { viewId: string; rect?: Rect; expectedEngineEpoch?: string; expectedEngineRevision?: number; expectedLayoutRevision?: number }) {
    if ((input.expectedEngineEpoch === undefined) !== (input.expectedEngineRevision === undefined)) throw new ViewerError('INVALID_ARGUMENT', '截图版本身份需同时提供epoch和revision。');
    const state = await this.nativeOfficeState(input.viewId), driver = this.nativeDriver();
    if (!driver.captureNative) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生引擎尚未提供截图。');
    if (!state.visible) throw new ViewerError('NATIVE_VIEW_HIDDEN', '截图目标当前不可见。');
    if (input.expectedEngineEpoch !== undefined) this.checkNativeExpected(input.viewId, input.expectedEngineEpoch, input.expectedEngineRevision!);
    if (input.expectedLayoutRevision !== undefined && state.viewport?.layoutRevision !== input.expectedLayoutRevision) throw new ViewerError('STALE_COORDINATES', '原生区域已变化，请重新读取。');
    const result = await driver.captureNative(state.sessionId, input.viewId, input.rect), after = await this.nativeOfficeState(input.viewId);
    if (result.sessionId !== state.sessionId || result.engineEpoch !== state.engineEpoch || result.engineRevision !== state.engineRevision || after.engineRevision !== state.engineRevision || after.engineEpoch !== state.engineEpoch || after.selectionEpoch !== state.selectionEpoch || after.viewport?.layoutRevision !== state.viewport?.layoutRevision || !after.visible || result.layoutRevision !== undefined && result.layoutRevision !== after.viewport?.layoutRevision) throw new ViewerError('STALE_CAPTURE', '截图期间原生内容、选区或布局已变化，请重新获取截图。');
    return { ...result, viewId: input.viewId, documentId: state.documentId, layoutRevision: after.viewport?.layoutRevision };
  }
  async inputNativeOffice(input: { viewId: string; expectedEngineEpoch: string; expectedEngineRevision: number; expectedSelectionEpoch?: number; expectedLayoutRevision?: number; action: BrowserAction; idempotencyKey: string; controlId?: string }, actor: Actor = 'agent') {
    if (['click', 'move', 'drag', 'scroll'].includes(input.action.kind) && input.expectedLayoutRevision === undefined) throw new ViewerError('STALE_COORDINATES', '坐标操作必须提供当前原生布局版本，请先读取状态或截图。');
    const key = 'office-input:' + input.idempotencyKey, payload = JSON.stringify({ input, actor });
    return this.serial(key, async () => {
      const prior = this.receipts.get(key); if (prior) { if (prior.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '输入幂等键冲突。'); return clone(prior.receipt); }
      const view = this.getView(input.viewId);
      return this.serial(view.documentId, async () => {
        const state = await this.nativeOfficeState(view.id), driver = this.nativeDriver();
        if (!driver.input) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生引擎尚未提供鼠标键盘输入。');
        if (!state.visible || !state.nativeGeometry) throw new ViewerError('NATIVE_VIEW_HIDDEN', '输入目标没有当前可见的真实原生区域。');
        this.checkNativeExpected(view.id, input.expectedEngineEpoch, input.expectedEngineRevision, input.expectedSelectionEpoch);
        if (input.expectedLayoutRevision !== undefined && state.viewport?.layoutRevision !== input.expectedLayoutRevision) throw new ViewerError('STALE_COORDINATES', '原生区域已变化，请重新定位。');
        const agentBinding = { viewId: view.id, documentId: view.documentId, agentControlId: input.controlId ?? view.agentState?.controlId, agentStateEpoch: this.agentStateEpochs.get(view.id) ?? 0 };
        if (input.controlId !== undefined && input.controlId !== view.agentState?.controlId) throw new ViewerError('AGENT_CONTROL_MISMATCH', '控制身份与输入页面不匹配。');
        if (actor === 'agent') this.assertAgentPatchBinding(agentBinding);
        const result = await driver.input({ sessionId: state.sessionId, viewId: view.id, expectedEngineEpoch: input.expectedEngineEpoch, expectedEngineRevision: input.expectedEngineRevision, expectedSelectionEpoch: input.expectedSelectionEpoch, expectedLayoutRevision: input.expectedLayoutRevision, action: input.action, idempotencyKey: input.idempotencyKey, actor });
        this.updateNativeOfficeState(result.state);
        // SendInput/PostMessage delivery is not proof that an editor has committed its input.
        let replyState = result.state, warning: string | undefined;
        try { replyState = await this.nativeOfficeState(view.id); } catch { warning = '输入已经发出，后续状态暂不可读取。'; }
        let controlReleased: boolean | undefined;
        if (actor === 'agent') {
          try { this.assertAgentPatchBinding(agentBinding); if (nativeInputEdits(input.action)) this.markAgentEditingInProgress(view.id); }
          catch { controlReleased = true; }
        }
        const value = { status: 'dispatched' as const, state: clone(replyState), idempotencyKey: input.idempotencyKey, warning, ...(controlReleased ? { controlReleased } : {}) };
        const action = input.action, point = 'x' in action ? { x: action.x, y: action.y } : action.kind === 'drag' ? clone(action.to) : undefined;
        this.receipts.set(key, { payload, receipt: value }); this.event('office.input', { viewId: view.id, documentId: view.documentId, action: action.kind, actor, ...(controlReleased ? { controlReleased } : {}), ...(point ? { point } : {}), ...(action.kind === 'drag' ? { from: clone(action.from), to: clone(action.to) } : {}) }); return clone(value);
      });
    });
  }
  async nativeOfficeCommandStatus(viewId: string, commands: string[]) {
    const view = this.getView(viewId), binding = this.nativeBinding(view.documentId), driver = this.nativeDriver();
    if (!driver.commandStatus) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生引擎尚未提供命令可用状态。');
    return driver.commandStatus(binding.state.sessionId, viewId, commands);
  }
  async queryNativeOfficeCommandStatus(viewId: string, commands: string[]) {
    const before = await this.nativeOfficeState(viewId), statuses = await this.nativeOfficeCommandStatus(viewId, commands), state = await this.nativeOfficeState(viewId);
    if (before.engineEpoch !== state.engineEpoch || before.engineRevision !== state.engineRevision || before.selectionEpoch !== state.selectionEpoch) throw new ViewerError('STALE_NATIVE_QUERY', '读取命令状态期间原生文档或选区已变化，请重新读取。');
    return { state, commands: statuses };
  }
  private checkNativeExpected(viewId: string, epoch: string, revision: number, selectionEpoch?: number) {
    const view = this.getView(viewId), binding = this.nativeBinding(view.documentId);
    if (binding.state.engineEpoch !== epoch || binding.state.engineRevision !== revision) throw new ViewerError('VERSION_CONFLICT', '原生文档已变化，请重新读取状态。');
    if (selectionEpoch !== undefined && binding.state.selectionEpoch !== selectionEpoch) throw new ViewerError('STALE_SELECTION', '原生选区已变化，请重新定位。');
    return { view, binding };
  }
  private async nativeMutationReply(viewId: string, result: NativeOfficeExecution, receipt: Receipt) {
    try { return await this.nativeOfficeState(viewId); }
    catch (error) {
      // The native action is already irreversible. Preserve its real receipt even if
      // the subsequent status transport fails, without inventing a fresh controller.
      receipt.warnings = [...(receipt.warnings ?? []), '原生操作回执已保留，后续状态暂不可读取。', String(error)];
      return clone(result.state);
    }
  }
  async executeNativeOffice(input: { viewId: string; command?: string; args?: UNOProperty[]; cell?: { sheetName: string; address: string; content: string }; replacement?: { expectedText: string; text: string }; style?: NativeOfficeStylePatch; expectedEngineEpoch: string; expectedEngineRevision: number; expectedSelectionEpoch?: number; idempotencyKey: string; controlId?: string }, actor: Actor = 'agent') {
    if (input.style) { input = { ...input, style: nativeOfficeStylePatchSchema.parse(input.style) }; if (input.expectedSelectionEpoch === undefined) throw new ViewerError('STALE_SELECTION', '样式修改必须绑定当前真实选区版本，请先读取样式与状态。'); }
    const key = 'office-command:' + input.idempotencyKey, payload = JSON.stringify({ input, actor });
    return this.serial(key, async () => {
      const prior = this.receipts.get(key); if (prior) { if (prior.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '同一幂等键不能执行不同原生命令。'); return clone(prior.receipt); }
      const view = this.getView(input.viewId);
      return this.serial(view.documentId, async () => {
        await this.syncNativeInside(view.documentId, 'engine'); await this.nativeOfficeState(view.id);
        const { binding } = this.checkNativeExpected(view.id, input.expectedEngineEpoch, input.expectedEngineRevision, input.expectedSelectionEpoch);
        if ([input.command,input.cell,input.replacement,input.style].filter(value => value !== undefined).length !== 1 || !input.command && input.args?.length) throw new ViewerError('INVALID_ARGUMENT', '一次操作必须明确指定一个命令、单元格、当前文字范围或样式；只有命令接受UNO参数。');
        if (input.cell && this.getDocument(view.documentId).info.format !== 'xlsx') throw new ViewerError('CAPABILITY_UNSUPPORTED', '单元格编辑仅适用于原生表格。');
        if (input.replacement && (binding.state.selection?.kind !== 'text' || binding.state.selection.text !== input.replacement.expectedText || !binding.state.selectionActions?.includes('replace'))) throw new ViewerError('STALE_SELECTION', '当前原生文字范围已变化或不支持安全替换，请重新选择。');
        if (input.style) {
          const format = this.getDocument(view.documentId).info.format, selection = binding.state.selection, target = input.style.target;
          const compatible = target === 'text' ? selection?.kind === 'text' && !!selection.text : target === 'paragraph' ? ['docx','pptx'].includes(format) && (!selection || ['none','text'].includes(selection.kind)) : target === 'cells' ? format === 'xlsx' && selection?.kind === 'cells' && !!selection.range : format === 'pptx' && selection?.kind === 'objects';
          if (!compatible) throw new ViewerError('INVALID_TARGET', '样式目标与当前真实选择不匹配，未自动选择整份文档或第一个对象。');
        }
        if (input.command) {
          const policy = nativeOfficeCommandPolicy(input.command);
          if (policy.blocked) throw new ViewerError('NATIVE_COMMAND_MANAGED', policy.reason!);
          const catalog = await this.nativeDriver().commands(binding.state.sessionId, view.id);
          if (!catalog.some(command => command.command === input.command)) throw new ViewerError('CAPABILITY_UNSUPPORTED', '此命令不在当前原生引擎目录中。');
        }
        const agentBinding = { viewId: view.id, documentId: view.documentId, agentControlId: input.controlId ?? view.agentState?.controlId, agentStateEpoch: this.agentStateEpochs.get(view.id) ?? 0 };
        if (input.controlId !== undefined && input.controlId !== view.agentState?.controlId) throw new ViewerError('AGENT_CONTROL_MISMATCH', '控制身份与原生页面不匹配。');
        if (actor === 'agent') this.assertAgentPatchBinding(agentBinding);
        const operationKind = input.style ? 'native.style.' + input.style.target : input.command ?? (input.cell ? 'native.cell.set' : 'native.selection.replace');
        if (actor === 'agent') await this.extensions.get('before-agent-edit')?.({ documentId: view.documentId, viewId: view.id, operation: input.style ? { kind: operationKind, style: clone(input.style) } : input.cell ? { kind: 'native.cell.set', ...input.cell } : input.replacement ? { kind: 'native.selection.replace' } : { kind: input.command } }, actor);
        await this.nativeOfficeState(view.id); this.checkNativeExpected(view.id, input.expectedEngineEpoch, input.expectedEngineRevision, input.expectedSelectionEpoch);
        if (actor === 'agent') this.assertAgentPatchBinding(agentBinding);
        const revisionBefore = this.getDocument(view.documentId).info.revision, requestId = randomUUID();
        let result: NativeOfficeExecution;
        try { result = await this.nativeDriver().execute({ sessionId: binding.state.sessionId, viewId: view.id, expectedEngineEpoch: input.expectedEngineEpoch, expectedEngineRevision: input.expectedEngineRevision, expectedSelectionEpoch: input.expectedSelectionEpoch, requestId, actor, command: input.command, args: input.args, cell: input.cell, replacement: input.replacement, style: input.style }); }
        catch (error) {
          if (input.style || input.replacement) {
            // A typed edit failure may have rolled back or left an uncertain
            // native result. Read/checkpoint it, never invent success or
            // restore OOXML bytes into its still-authoritative writer.
            try { await this.nativeOfficeState(view.id); await this.syncNativeInside(view.documentId, 'engine'); await this.persist(); }
            catch (recoveryError) { this.event('office.error', { documentId: view.documentId, viewId: view.id, kind: operationKind, error: String(recoveryError) }); }
          }
          throw error;
        }
        this.updateNativeOfficeState(result.state);
        let status = result.status, warnings = result.warnings ?? [];
        try { await this.syncNativeInside(view.documentId, actor); } catch (error) { status = 'dispatched'; warnings = [...warnings, '命令已发出；实际文档结果尚未稳定。', String(error)]; }
        const receipt: Receipt = { transactionId: requestId, documentId: view.documentId, revision: this.getDocument(view.documentId).info.revision, status, idempotencyKey: input.idempotencyKey, nativeSessionId: binding.state.sessionId, warnings };
        let controlled = true; if (actor === 'agent') { try { this.assertAgentPatchBinding(agentBinding); } catch { controlled = false; receipt.controlReleased = true; } }
        if (actor === 'agent' && controlled && status !== 'no-change' && receipt.revision !== revisionBefore) this.markAgentEdit({ viewId: view.id, documentId: view.documentId, operation: { kind: operationKind } }, receipt);
        else if (actor === 'agent' && controlled && status === 'dispatched' && (input.style || input.command && nativeCommandEdits(input.command))) this.markAgentEditingInProgress(view.id);
        // A document snapshot may use its first controller; replies must use the requested view.
        const value = { receipt, state: await this.nativeMutationReply(view.id, result, receipt), undoToken: result.undoToken };
        this.receipts.set(key, { payload, receipt: value }); this.event('office.executed', { ...receipt, viewId: view.id, actor, kind: operationKind, command: input.command, styleTarget: input.style?.target, cell: input.cell && { sheetName: input.cell.sheetName, address: input.cell.address } }); await this.persist(); return value;
      });
    });
  }
  async navigateNativeOffice(input: { viewId: string; target: NativeOfficeNavigateTarget; expectedEngineEpoch: string; expectedEngineRevision: number; expectedSelectionEpoch?: number; idempotencyKey: string }, actor: Actor = 'agent') {
    const key = 'office-navigate:' + input.idempotencyKey, payload = JSON.stringify({ input, actor });
    return this.serial(key, async () => {
      const prior = this.receipts.get(key); if (prior) { if (prior.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '导航幂等键冲突。'); return clone(prior.receipt); }
      const view = this.getView(input.viewId);
      return this.serial(view.documentId, async () => {
        await this.nativeOfficeState(view.id);
        const { binding } = this.checkNativeExpected(view.id, input.expectedEngineEpoch, input.expectedEngineRevision, input.expectedSelectionEpoch), driver = this.nativeDriver();
        if (actor === 'agent') this.assertAgentRunning(view.documentId, view.id);
        if (!driver.navigate) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生引擎尚未提供此定位能力。');
        const requestId = randomUUID(), result = await driver.navigate({ sessionId: binding.state.sessionId, viewId: view.id, target: input.target, expectedEngineEpoch: input.expectedEngineEpoch, expectedEngineRevision: input.expectedEngineRevision, expectedSelectionEpoch: input.expectedSelectionEpoch, requestId, actor });
        this.updateNativeOfficeState(result.state); const value = { status: result.status, state: await this.nativeOfficeState(view.id), requestId };
        this.receipts.set(key, { payload, receipt: value }); this.event('office.navigated', { viewId: view.id, requestId, status: result.status, target: input.target }); return clone(value);
      });
    });
  }
  async undoNativeOffice(input: { viewId: string; expectedEngineEpoch: string; expectedEngineRevision: number; undoToken: string; idempotencyKey: string }, actor: Actor = 'agent') {
    const view = this.getView(input.viewId), key = 'office-undo:' + input.idempotencyKey, payload = JSON.stringify({ input, actor });
    return this.serial(key, async () => {
      const prior = this.receipts.get(key); if (prior) { if (prior.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '撤销幂等键冲突。'); return clone(prior.receipt); }
      return this.serial(view.documentId, async () => {
        await this.syncNativeInside(view.documentId, 'engine'); await this.nativeOfficeState(view.id);
        const { binding } = this.checkNativeExpected(view.id, input.expectedEngineEpoch, input.expectedEngineRevision);
        const agentBinding = { viewId: view.id, documentId: view.documentId, agentControlId: view.agentState?.controlId, agentStateEpoch: this.agentStateEpochs.get(view.id) ?? 0 };
        if (actor === 'agent') { this.assertAgentPatchBinding(agentBinding); await this.extensions.get('before-agent-edit')?.({ documentId: view.documentId, viewId: view.id, operation: { kind: 'native.undo' } }, actor); }
        await this.nativeOfficeState(view.id); this.checkNativeExpected(view.id, input.expectedEngineEpoch, input.expectedEngineRevision);
        if (actor === 'agent') this.assertAgentPatchBinding(agentBinding);
        if (!binding.state.undo?.canUndo || binding.state.undo.token !== input.undoToken) throw new ViewerError('VERSION_CONFLICT', '原生撤销栈已变化，不能撤销其他操作。');
        const before = this.getDocument(view.documentId).info.revision;
        const result = await this.nativeDriver().undo({ sessionId: binding.state.sessionId, viewId: view.id, expectedEngineEpoch: input.expectedEngineEpoch, expectedEngineRevision: input.expectedEngineRevision, undoToken: input.undoToken, actor });
        this.updateNativeOfficeState(result.state);
        let status: Receipt['status'] = result.status === 'applied' ? 'undone' : result.status, warnings = result.warnings ?? [];
        try { await this.syncNativeInside(view.documentId, actor); } catch (error) { status = 'dispatched'; warnings = [...warnings, '撤销已发出，文档尚未取得稳定结果。', String(error)]; }
        const receipt: Receipt = { transactionId: randomUUID(), documentId: view.documentId, revision: this.getDocument(view.documentId).info.revision, status, nativeSessionId: binding.state.sessionId, warnings };
        let controlled = true; if (actor === 'agent') { try { this.assertAgentPatchBinding(agentBinding); } catch { controlled = false; receipt.controlReleased = true; } }
        if (controlled && actor === 'agent' && status === 'undone' && receipt.revision !== before) this.markAgentEdit({ viewId: view.id, documentId: view.documentId, operation: { kind: 'native.undo' } }, receipt);
        const value = { receipt, state: await this.nativeMutationReply(view.id, result, receipt) }; this.receipts.set(key, { payload, receipt: value }); await this.persist(); return value;
      });
    });
  }
  async exportNativeOffice(input: { viewId: string; path: string; format: NativeOfficeExportFormat; expectedEngineEpoch: string; expectedEngineRevision: number; idempotencyKey: string }) {
    const view = this.getView(input.viewId), key = 'office-export:' + input.idempotencyKey, payload = JSON.stringify(input);
    return this.serial(key, async () => {
      const prior = this.receipts.get(key); if (prior) { if (prior.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '导出幂等键冲突。'); return clone(prior.receipt); }
      return this.serial(view.documentId, async () => {
        await this.syncNativeInside(view.documentId, 'engine'); const { binding } = this.checkNativeExpected(view.id, input.expectedEngineEpoch, input.expectedEngineRevision), doc = this.getDocument(view.documentId), driver = this.nativeDriver(), target = resolve(input.path);
        if (!driver.exportCopy) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生引擎尚未提供此副本导出。');
        if (doc.info.path && resolve(doc.info.path).toLowerCase() === target.toLowerCase()) throw new ViewerError('INVALID_TARGET', '导出副本不能覆盖原文路径。');
        if (!target.toLowerCase().endsWith('.' + input.format)) throw new ViewerError('FORMAT_MISMATCH', '导出文件扩展名与内容格式不一致。');
        try { await readFile(target); throw new ViewerError('FILE_EXISTS', '导出文件已存在，请使用新的副本路径。'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const result = await driver.exportCopy(binding.state.sessionId, { format: input.format, expectedEngineEpoch: input.expectedEngineEpoch, expectedEngineRevision: input.expectedEngineRevision });
        if (!result.stable || result.engineRevisionBefore !== input.expectedEngineRevision || result.engineRevisionAfter !== result.engineRevisionBefore || result.state.engineRevision !== result.engineRevisionAfter || result.state.documentId !== view.documentId || result.state.engineEpoch !== binding.state.engineEpoch || result.state.sessionId !== binding.state.sessionId || result.format !== input.format || !result.bytes.length || result.sha256 && result.sha256 !== hash(result.bytes)) throw new ViewerError('NATIVE_EXPORT_INVALID', '导出来源或文件校验不完整。');
        if (input.format === 'pdf') { const pdf = await this.registry.resolve('pdf').open(result.bytes, 'pdf'); if (!pdf.pageCount) throw new ViewerError('NATIVE_EXPORT_INVALID', '导出PDF无法读取。'); }
        else { const { default: JSZip } = await import('jszip'), zip = await JSZip.loadAsync(result.bytes); if (['odt','ods','odp'].includes(input.format)) { const mime = await zip.file('mimetype')?.async('string'); const expected = ({ odt: 'text', ods: 'spreadsheet', odp: 'presentation' } as Record<string,string>)[input.format]; if (mime !== 'application/vnd.oasis.opendocument.' + expected) throw new ViewerError('NATIVE_EXPORT_INVALID', '导出ODF类型不匹配。'); } else await this.registry.resolve(input.format as NativeOfficeState['format']).open(result.bytes, input.format as NativeOfficeState['format']); }
        await mkdir(dirname(target), { recursive: true }); const temp = target + '.agentviewer-' + randomUUID() + '.tmp';
        try { await writeFile(temp, result.bytes, { flag: 'wx' }); if (hash(new Uint8Array(await readFile(temp))) !== hash(result.bytes)) throw new ViewerError('SAVE_VERIFY_FAILED', '导出临时文件校验失败。'); await import('node:fs/promises').then(fs => fs.link(temp, target)); } finally { await unlink(temp).catch(() => {}); }
        const value = { status: 'exported', documentId: view.documentId, viewId: view.id, path: target, format: input.format, sha256: hash(result.bytes), byteLength: result.bytes.length, engineEpoch: result.state.engineEpoch, engineRevision: result.engineRevisionAfter };
        this.receipts.set(key, { payload, receipt: value }); this.event('office.exported', value); await this.persist(); return clone(value);
      });
    });
  }
  async closeNativeOffice(documentId: string) {
    return this.serial(documentId, () => this.closeNativeOfficeInside(documentId));
  }
  private async closeNativeOfficeInside(documentId: string) {
      const binding = this.nativeOfficeBindings.get(documentId); if (!binding) return;
      if (binding.workerExited) {
        const doc = this.getDocument(documentId), message = '原生引擎已退出，仅保留最后确认的恢复点（原生版本 ' + binding.mirrorEngineRevision + '），未保存到原文件。';
        if (!doc.info.warnings.includes(message)) doc.info.warnings.push(message);
        // Only a trusted exit proves the writer is already gone. A close veto or
        // transport timeout alone must never authorize dropping a live writer.
        await this.persist(); this.nativeOfficeBindings.delete(documentId); delete doc.info.nativeOffice;
        doc.info.capabilities = this.registry.resolve(doc.info.format).capabilities(doc.info.format);
        this.event('office.closed', { documentId, sessionId: binding.state.sessionId, recovery: true, mirrorEngineRevision: binding.mirrorEngineRevision, reasonCode: 'NATIVE_WORKER_EXITED' }); await this.persist(); return;
      }
      if (binding.state.status === 'failed') {
        const viewId = [...binding.viewIds].find(id => this.views.has(id));
        if (!viewId) throw new ViewerError('NATIVE_SESSION_EXPIRED', '关闭结果尚未确认，未释放原生编辑源。');
        await this.nativeOfficeState(viewId);
      }
      await this.syncNativeInside(documentId, 'engine');
      // Persist the actual stable recovery bytes before disposing the sole writer.
      await this.persist(); binding.closing = true;
      try { await this.nativeDriver().close(binding.state.sessionId); }
      catch (error) { binding.state.status = 'failed'; binding.closing = false; this.publishNativeMetadata(documentId, binding); throw error; }
      this.nativeOfficeBindings.delete(documentId); const doc = this.getDocument(documentId); delete doc.info.nativeOffice; doc.info.capabilities = this.registry.resolve(doc.info.format).capabilities(doc.info.format);
      this.event('office.closed', { documentId, sessionId: binding.state.sessionId }); await this.persist();
  }
  /** Detach a window controller while preserving its tab identity and model. */
  async detachNativeOfficeView(viewId: string) {
    const source = this.getView(viewId);
    return this.serial(source.documentId, async () => {
      const view = this.getView(viewId), binding = this.nativeOfficeBindings.get(view.documentId);
      if (!binding || !binding.viewIds.has(viewId)) return { detached: false, viewId, documentId: view.documentId };
      if (binding.viewIds.size === 1) await this.closeNativeOfficeInside(view.documentId);
      else {
        if (!binding.workerExited) {
          await this.syncNativeInside(view.documentId, 'engine'); await this.persist();
          const driver = this.nativeDriver(); if (!driver.detachView) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生引擎尚不支持独立关闭文档控制器。');
          await driver.detachView(binding.state.sessionId, viewId);
        } else await this.persist();
        binding.viewIds.delete(viewId);
      }
      this.updateContext(viewId, { quality: 'not-ready', visibleText: '', selection: { kind: 'none', text: '' }, locator: { kind: 'unconfirmed' }, viewport: undefined, nativeOffice: undefined }, 'engine');
      // updateContext retains a missing viewport for partial reader reports;
      // detaching a native controller explicitly invalidates that geometry.
      if (view.context) delete view.context.viewport;
      this.event('office.view-detached', { viewId, documentId: view.documentId }); await this.persist();
      return { detached: true, viewId, documentId: view.documentId };
    });
  }
  getView(id?: string) {
    const target = id ?? this.lastHumanViewId ?? this.activeViewId;
    const view = target && this.views.get(target);
    if (!view) throw new ViewerError('TARGET_NOT_FOUND', '没有有效阅读视图。请打开文档或指定 viewId。');
    return view;
  }
  async openFile(path: string, windowId = 'main', activate = true) {
    const fullPath = resolve(path);
    const existing = [...this.documents.values()].find(d => d.info.path?.toLowerCase() === fullPath.toLowerCase());
    if (existing) return this.addView(existing.info.id, windowId, activate);
    const bytes = new Uint8Array(await readFile(fullPath));
    if (bytes.byteLength > 100 * 1024 * 1024) throw new ViewerError('FILE_TOO_LARGE', '首版单文件上限为 100 MB。');
    const extension = extname(fullPath).slice(1).toLowerCase();
    if (['doc', 'ppt', 'xls'].includes(extension)) {
      const converted = await convertLegacy(fullPath, extension);
      const view = await this.openBytes(basename(fullPath).replace(/\.[^.]+$/, '.' + converted.format), converted.bytes, converted.format as Format, undefined, windowId, activate);
      this.getDocument(view.documentId).info.warnings.push(...converted.warnings, `原件：${fullPath}`);
      return view;
    }
    const format = ({ md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', pdf: 'pdf' } as Record<string, Format>)[extension];
    if (!format) throw new ViewerError('CAPABILITY_UNSUPPORTED', `暂不支持 .${extension}。`);
    return this.openBytes(basename(fullPath), bytes, format, fullPath, windowId, activate);
  }
  async openBytes(title: string, bytes: Uint8Array, format: Format, path?: string, windowId = 'main', activate = true) {
    const adapter = this.registry.resolve(format), model = await adapter.open(bytes, format), id = randomUUID();
    this.documents.set(id, { bytes: bytes.slice(), sourceHash: path ? hash(bytes) : undefined, info: { id, title, path, format, revision: 0, diskRevision: path ? 0 : -1, dirty: !path, capabilities: adapter.capabilities(format), model, warnings: [] } });
    return this.addView(id, windowId, activate);
  }
  async importArtifact(path: string, bytes: Uint8Array, format: Format) {
    const fullPath = resolve(path), adapter = this.registry.resolve(format), id = randomUUID();
    const info: DocumentInfo = { id, title: basename(fullPath), path: fullPath, format, revision: 0, diskRevision: 0, dirty: false, capabilities: adapter.capabilities(format), model: await adapter.open(bytes, format), warnings: [] };
    this.documents.set(id, { info, bytes: bytes.slice(), sourceHash: hash(bytes) });
    this.event('document.imported', { documentId: id, path: fullPath });
    await this.persist(); return clone(info);
  }
  addView(documentId: string, windowId = 'main', activate = true) {
    this.getDocument(documentId);
    const view: ViewInfo = { id: randomUUID(), documentId, windowId, mode: 'read', pinned: false };
    this.views.set(view.id, view); if (activate) this.activeViewId = view.id; this.event('view.opened', view); return clone(view);
  }
  async openWeb(url: string, windowId = 'main', activate = true) {
    const normalized = normalizeWebAddress(url);
    if (!normalized) throw new ViewerError('INVALID_URL', '请输入有效的 HTTP(S) 网页地址。');
    url = normalized;
    const parsed = new URL(url);
    const id = randomUUID();
    this.documents.set(id, { bytes: new Uint8Array(), info: { id, title: parsed.hostname, format: 'web', revision: 0, diskRevision: 0, dirty: false, model: { format: 'web', url }, warnings: [], capabilities: { engine: this.browser ? 'electron-chromium' : 'preview-iframe', protocolVersion: PROTOCOL_VERSION, readText: !!this.browser, readSelection: !!this.browser, readViewport: !!this.browser, editKinds: [], saveFormats: ['html'], browserInput: !!this.browser, limitations: this.browser ? ['实时网页操作影响当前站点；持久编辑请建立阅读副本。', '正文提取当前仅顶层 frame。'] : ['原生网页输入与跨站上下文需在桌面应用使用。'] } } });
    const view = this.addView(id, windowId, activate); if (this.browser) await this.browser.open(view.id, url); return view;
  }
  activate(viewId: string, actor: Actor = 'human') { this.getView(viewId); this.activeViewId = viewId; if (actor === 'human') this.lastHumanViewId = viewId; this.event('view.activated', { viewId, actor }); }
  setAgentControl(viewId: string, status: 'running' | 'paused' | 'stopped') { const view = this.getView(viewId); this.agentControl.set(viewId, status); this.agentControl.set(view.documentId, status); this.event('agent.control', { viewId, status }); }
  private agentView(viewId: string, documentId?: string) {
    const view = this.getView(viewId);
    if (documentId !== undefined && documentId !== view.documentId) throw new ViewerError('INVALID_TARGET', '页面与指定文档不匹配。');
    return view;
  }
  private assertAgentRunning(documentId: string, viewId?: string) {
    if ([this.agentControl.get(documentId), viewId ? this.agentControl.get(viewId) : undefined].some(status => status === 'paused' || status === 'stopped')) throw new ViewerError('AGENT_PAUSED', '此页面的 Agent 操作已暂停或停止。');
  }
  acquireAgentView(input: { viewId: string; documentId?: string; controlId?: string; agentId?: string; phase?: AgentViewState['phase'] }) {
    const view = this.agentView(input.viewId, input.documentId), previous = view.agentState;
    this.assertAgentRunning(view.documentId, view.id);
    if (previous) {
      if (!input.controlId) throw new ViewerError('AGENT_VIEW_BUSY', '此页面已有 Agent 协作会话，请先读取状态或显式释放。');
      if (input.controlId !== previous.controlId || input.agentId !== undefined && previous.agentId !== undefined && input.agentId !== previous.agentId) throw new ViewerError('AGENT_CONTROL_MISMATCH', '控制身份已变化，不能更新另一会话。');
      const phase = input.phase ?? previous.phase, agentId = input.agentId ?? previous.agentId;
      if (phase !== previous.phase || agentId !== previous.agentId) { view.agentState = { ...previous, phase, agentId, updatedAt: new Date().toISOString() }; this.event('agent.changed', clone(view.agentState)); }
    } else {
      if (input.controlId) throw new ViewerError('AGENT_CONTROL_MISMATCH', '原控制身份已释放，请重新建立会话。');
      const now = new Date().toISOString();
      view.agentState = { controlId: randomUUID(), viewId: view.id, documentId: view.documentId, agentId: input.agentId, phase: input.phase ?? 'reading', acquiredAt: now, updatedAt: now };
      this.agentStateEpochs.set(view.id, (this.agentStateEpochs.get(view.id) ?? 0) + 1);
      this.event('agent.acquired', clone(view.agentState));
    }
    return clone(view.agentState!);
  }
  agentViewStatus(input: { viewId: string; documentId?: string }): AgentViewStatus {
    const view = this.agentView(input.viewId, input.documentId);
    const controls = [this.agentControl.get(view.id), this.agentControl.get(view.documentId)];
    const userControl = controls.includes('stopped') ? 'stopped' : controls.includes('paused') ? 'paused' : controls.includes('running') ? 'running' : undefined;
    return clone({ viewId: view.id, documentId: view.documentId, state: view.agentState ?? null, userControl });
  }
  releaseAgentView(input: { viewId: string; documentId?: string; controlId: string }) {
    const view = this.agentView(input.viewId, input.documentId), previous = view.agentState;
    if (!previous) return { released: false, viewId: view.id, documentId: view.documentId, controlId: input.controlId };
    if (input.controlId !== previous.controlId) throw new ViewerError('AGENT_CONTROL_MISMATCH', '控制身份已变化，不能释放另一会话。');
    this.clearAgentView(view, 'explicit');
    return { released: true, viewId: view.id, documentId: view.documentId, controlId: input.controlId };
  }
  private clearAgentView(view: ViewInfo, reason: 'explicit' | 'view-closed') {
    const previous = view.agentState; delete view.agentState;
    this.agentStateEpochs.set(view.id, (this.agentStateEpochs.get(view.id) ?? 0) + 1);
    if (previous) this.event('agent.released', { ...clone(previous), reason });
  }
  private assertAgentPatchBinding(patch: Pick<PreparedPatch, 'documentId' | 'viewId' | 'agentStateEpoch' | 'agentControlId'>) {
    this.assertAgentRunning(patch.documentId, patch.viewId);
    if (!patch.viewId) return;
    const view = this.agentView(patch.viewId, patch.documentId);
    if (patch.agentStateEpoch !== undefined && patch.agentStateEpoch !== (this.agentStateEpochs.get(view.id) ?? 0) || patch.agentControlId !== undefined && patch.agentControlId !== view.agentState?.controlId) throw new ViewerError('AGENT_STATE_CHANGED', '页面协作会话已释放或更换，请重新准备修改。');
  }
  private markAgentEdit(patch: Pick<PreparedPatch, 'viewId' | 'documentId'> & { operation: { kind: string } }, receipt: Receipt) {
    if (!patch.viewId) return;
    const view = this.agentView(patch.viewId, patch.documentId), now = new Date().toISOString(), previous = view.agentState;
    view.agentState = { ...(previous ?? { controlId: randomUUID(), viewId: view.id, documentId: view.documentId, acquiredAt: now }), phase: 'editing', updatedAt: now, lastEdit: { transactionId: receipt.transactionId, revision: receipt.revision, kind: patch.operation.kind } };
    if (!previous) this.agentStateEpochs.set(view.id, (this.agentStateEpochs.get(view.id) ?? 0) + 1);
    this.event(previous ? 'agent.changed' : 'agent.acquired', clone(view.agentState));
  }
  private markAgentEditingInProgress(viewId: string) {
    const view = this.getView(viewId), previous = view.agentState;
    if (!previous || previous.phase !== 'reading') return;
    view.agentState = { ...previous, phase: 'editing', updatedAt: new Date().toISOString() };
    this.event('agent.changed', clone(view.agentState));
  }
  setMode(viewId: string, mode: ViewInfo['mode']) { this.getView(viewId).mode = mode; this.event('view.mode', { viewId, mode }); }
  async setNativeViewZoom(viewId: string, factor: number, actor: Actor = 'human') {
    if (!Number.isFinite(factor) || factor < .25 || factor > 4) throw new ViewerError('INVALID_ARGUMENT', '缩放比例应在25%到400%之间。');
    const view = this.getView(viewId), binding = this.nativeOfficeBindings.get(view.documentId);
    if (!binding) return this.setViewZoom(viewId, factor, actor);
    const driver = this.nativeDriver(); if (!driver.zoom) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生引擎尚未接入缩放。');
    if (actor === 'agent') this.assertAgentRunning(view.documentId, view.id);
    return this.serial(view.documentId, async () => { const state = await driver.zoom!(this.nativeBinding(view.documentId).state.sessionId, viewId, factor); this.updateNativeOfficeState(state); return this.setViewZoom(viewId, factor, actor); });
  }
  setViewZoom(viewId: string, factor: number, actor: Actor = 'human') {
    if (!Number.isFinite(factor) || factor < .25 || factor > 4) throw new ViewerError('INVALID_ARGUMENT', '缩放比例应在 25% 到 400% 之间。');
    const view = this.getView(viewId), zoom = Math.round(factor * 100) / 100;
    if (view.zoom === zoom) return clone(view);
    if (this.getDocument(view.documentId).info.format === 'web') this.browser?.setZoom?.(viewId, zoom);
    view.zoom = zoom;
    if (view.context) view.context = { ...view.context, viewRevision: view.context.viewRevision + 1, quality: 'last-confirmed', selection: { ...view.context.selection, rect: undefined, pageRects: undefined } };
    this.event('view.zoom', { viewId, zoom, actor });
    return clone(view);
  }
  closeView(viewId: string, retainRecovery = false) {
    this.closeViewInside(viewId, retainRecovery, false);
  }
  private closeViewInside(viewId: string, retainRecovery: boolean, nativeChecked: boolean) {
    const view = this.getView(viewId), document = this.getDocument(view.documentId);
    if (!nativeChecked && this.nativeOfficeBindings.has(view.documentId)) throw new ViewerError('NATIVE_SESSION_ACTIVE', '原生Office页面需要异步检查点与正常关闭，请使用关闭页面接口。');
    if (document.info.dirty && !retainRecovery && [...this.views.values()].filter(v => v.documentId === document.info.id).length === 1) throw new ViewerError('UNSAVED_CHANGES', '文档尚未保存，请先保存或保留恢复点后关闭。');
    this.clearAgentView(view, 'view-closed'); this.agentStateEpochs.delete(viewId); this.agentControl.delete(viewId);
    this.views.delete(viewId); this.browser?.close(viewId);
    if (![...this.views.values()].some(other => other.documentId === view.documentId)) this.agentControl.delete(view.documentId);
    if (this.activeViewId === viewId) this.activeViewId = [...this.views.keys()].at(-1);
    if (this.lastHumanViewId === viewId) this.lastHumanViewId = undefined;
    this.event('view.closed', { viewId });
  }
  async requestCloseView(viewId: string, retainRecovery = false) {
    const view = this.getView(viewId), native = this.nativeOfficeBindings.has(view.documentId);
    if (native) {
      const failed = this.nativeOfficeBindings.get(view.documentId)!;
      if (failed.workerExited) {
        const last = [...this.views.values()].filter(candidate => candidate.documentId === view.documentId).length === 1;
        if (last && this.getDocument(view.documentId).info.dirty && !retainRecovery) throw new ViewerError('UNSAVED_CHANGES', '原生引擎已退出，请保留最后确认恢复点后关闭；原文件尚未保存。');
        await this.persist();
        if (last) await this.closeNativeOffice(view.documentId);
        else failed.viewIds.delete(viewId);
        this.closeViewInside(viewId, retainRecovery, true); await this.persist(); return;
      }
      await this.synchronizeNativeDocument(view.documentId);
      const doc = this.getDocument(view.documentId), lastView = [...this.views.values()].filter(other => other.documentId === view.documentId).length === 1;
      if (lastView && doc.info.dirty && !retainRecovery) throw new ViewerError('UNSAVED_CHANGES', '原生文档尚未保存，请先保存或保留恢复点后关闭。');
      if (lastView) await this.closeNativeOffice(view.documentId);
      else {
        // A remaining controller continues to own the same model. Main unmounts
        // only this view; a synchronous close must not dispose the shared model.
        const binding = this.nativeOfficeBindings.get(view.documentId)!;
        const driver = this.nativeDriver(); if (!driver.detachView) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生引擎尚未提供独立视图关闭，请先关闭共享原生会话。');
        await driver.detachView(binding.state.sessionId, viewId); binding.viewIds.delete(viewId);
        this.closeViewInside(viewId, retainRecovery, true);
        await this.persist(); return;
      }
    }
    this.closeView(viewId, retainRecovery); await this.persist();
  }
  async shutdownNativeOffice() { for (const documentId of [...this.nativeOfficeBindings.keys()]) await this.closeNativeOffice(documentId); await this.persist(); }
  updateContext(viewId: string, update: Partial<ReadingContext>, actor: Actor = 'human') {
    const view = this.getView(viewId), doc = this.getDocument(view.documentId);
    if (update.contentRevision !== undefined && update.contentRevision !== doc.info.revision) return;
    const old = view.context;
    view.context = { viewId, documentId: view.documentId, contentRevision: doc.info.revision, viewRevision: (old?.viewRevision ?? 0) + 1, capturedAt: new Date().toISOString(), quality: update.quality ?? 'confirmed', actor, locator: update.locator ?? old?.locator ?? { kind: doc.info.format }, visibleText: update.visibleText ?? old?.visibleText ?? '', selection: update.selection ?? old?.selection ?? { kind: 'none', text: '' }, viewport: update.viewport ?? old?.viewport, nativeOffice: update.nativeOffice };
    const significant = (context?: ReadingContext) => context && JSON.stringify({ ...context, capturedAt: undefined, viewRevision: undefined });
    if (significant(old) !== significant(view.context)) this.event('context.changed', { viewId, viewRevision: view.context.viewRevision }, this.nativeOfficeBindings.has(view.documentId) ? 'position' : 'normal');
  }
  /** Trusted runtime-owner reuse only; no SDK/MCP route accepts a supplied state. */
  updateNativeOfficeContext(state: NativeOfficeState): ReadingContext {
    if (!state.viewId) throw new ViewerError('NATIVE_STATE_INVALID', '原生上下文缺少绑定页面。');
    const view = this.getView(state.viewId), binding = this.nativeOfficeBindings.get(view.documentId);
    if (!binding || binding.closing || !binding.viewIds.has(view.id) || state.documentId !== view.documentId || state.sessionId !== binding.state.sessionId || state.engineEpoch !== binding.state.engineEpoch) throw new ViewerError('NATIVE_SESSION_EXPIRED', '原生上下文与当前页面编辑源不匹配。');
    if (state.engineRevision !== binding.state.engineRevision || binding.state.viewId === view.id && (state.selectionEpoch !== binding.state.selectionEpoch || state.viewport?.layoutRevision !== binding.state.viewport?.layoutRevision)) throw new ViewerError('STALE_NATIVE_QUERY', '原生上下文版本已变化，请重新读取。');
    const selection = state.selection;
    const visibleReady = state.visibleTextReady === true && state.visibleTextSource === 'actual-a11y';
    const text = visibleReady ? state.visibleText ?? '' : '', rect = selection?.rect, viewport = state.viewport;
    const visibleSelection = state.visible && state.nativeGeometry === true && !!selection?.text && !!rect && !!viewport && rect.width > 0 && rect.height > 0 && rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < viewport.width && rect.y < viewport.height;
    const locator = visibleSelection && selection?.locator ? selection.locator : { kind: 'native-viewport', quote: text.slice(0, 120), ...(state.format === 'xlsx' ? { sheetId: selection?.sheetName, cell: viewport?.visibleRange } : {}), ...(state.format === 'pptx' && state.visible && selection?.slideIndex !== undefined ? { slideId: String(selection.slideIndex) } : {}) };
    const next: ReadingContext = { viewId: view.id, documentId: view.documentId, contentRevision: this.getDocument(view.documentId).info.revision, viewRevision: view.context?.viewRevision ?? 0, capturedAt: view.context?.capturedAt ?? '', quality: state.visible && state.nativeGeometry === true && visibleReady && binding.mirrorEngineRevision === state.engineRevision ? 'confirmed' : 'not-ready', actor: state.actor ?? 'engine', visibleText: text, locator, selection: { kind: selection?.kind ?? 'none', text: selection?.text ?? '', rect: state.nativeGeometry ? selection?.rect : undefined, locator: selection?.locator }, viewport: viewport ? { width: viewport.width, height: viewport.height, scrollX: 0, scrollY: 0, deviceScaleFactor: viewport.deviceScaleFactor, layoutRevision: viewport.layoutRevision, navigationId: state.engineEpoch + ':' + state.sessionId + ':' + view.id } : undefined, nativeOffice: { sessionId: state.sessionId, engineEpoch: state.engineEpoch, engineRevision: state.engineRevision, selectionEpoch: state.selectionEpoch, selectionActions: state.selectionActions, sheetName: selection?.sheetName, range: selection?.range, visibleTextReady: state.visibleTextReady, visibleTextTruncated: state.visibleTextTruncated, visibleTextSource: state.visibleTextSource } };
    // A successful fresh read of the same semantic source does not create a new
    // capture/version. Public context reads still validate the live engine above;
    // snapshot.createdAt supplies the receipt time without churning display state.
    if (!isDeepStrictEqual(view.context, next)) this.updateContext(view.id, next, next.actor);
    return clone(view.context!);
  }
  async context(viewId?: string) {
    const view = this.getView(viewId);
    if (this.nativeOfficeBindings.get(view.documentId)?.viewIds.has(view.id)) {
      this.updateNativeOfficeContext(await this.nativeOfficeState(view.id));
    }
    if (this.getDocument(view.documentId).info.format === 'web' && this.browser) {
      const fresh = await this.browser.context(view.id); this.updateContext(view.id, fresh, fresh.actor);
    }
    return clone(view.context ?? { viewId: view.id, documentId: view.documentId, contentRevision: this.getDocument(view.documentId).info.revision, viewRevision: 0, capturedAt: new Date().toISOString(), quality: 'not-ready', actor: 'engine', locator: { kind: 'unconfirmed' }, visibleText: '', selection: { kind: 'none', text: '' } } satisfies ReadingContext);
  }
  async snapshot(viewId?: string) {
    const sourceView = this.getView(viewId); await this.synchronizeNativeDocument(sourceView.documentId);
    const context = await this.context(viewId), document = clone(this.getDocument(context.documentId).info);
    const snapshot: ReadingSnapshot = { id: randomUUID(), schemaVersion: PROTOCOL_VERSION, context, document, createdAt: new Date().toISOString() };
    this.snapshots.set(snapshot.id, snapshot);
    if (this.snapshots.size > 100) { const referenced = new Set([...this.tasks.values()].filter(t => t.status === 'running').map(t => t.snapshotId)); for (const id of this.snapshots.keys()) { if (!referenced.has(id) && id !== snapshot.id) { this.snapshots.delete(id); break; } } }
    this.event('snapshot.created', { id: snapshot.id }); return clone(snapshot);
  }
  readSnapshot(id: string) { const snapshot = this.snapshots.get(id); if (!snapshot) throw new ViewerError('SNAPSHOT_EXPIRED', '快照已过期或所属应用已重启。'); return clone(snapshot); }
  prepare(documentId: string, expectedRevision: number, operation: EditOperation, binding: { viewId?: string; controlId?: string } = {}) {
    const doc = this.getDocument(documentId); if (doc.info.revision !== expectedRevision) throw new ViewerError('VERSION_CONFLICT', '内容版本已变化，请重新读取。', { actualRevision: doc.info.revision });
    const op = editOperationSchema.parse(operation), adapter = this.registry.resolve(doc.info.format);
    const matchingView = (id?: string) => id ? this.views.get(id)?.documentId === documentId ? this.views.get(id) : undefined : undefined;
    const view = binding.viewId !== undefined ? this.agentView(binding.viewId, documentId) : matchingView(this.lastHumanViewId) ?? matchingView(this.activeViewId) ?? [...this.views.values()].find(candidate => candidate.documentId === documentId);
    if (binding.controlId !== undefined && (!view || view.agentState?.controlId !== binding.controlId)) throw new ViewerError('AGENT_CONTROL_MISMATCH', '控制身份与修改目标页面不匹配。');
    const patch: PreparedPatch = { id: randomUUID(), documentId, viewId: view?.id, agentControlId: binding.controlId ?? view?.agentState?.controlId, agentStateEpoch: view ? this.agentStateEpochs.get(view.id) ?? 0 : undefined, expectedRevision, operation: op, preview: adapter.preview(doc.info.model, op), createdAt: new Date().toISOString() };
    const native = this.nativeOfficeBindings.get(documentId);
    if (native) {
      this.nativeBinding(documentId);
      if (!view) throw new ViewerError('TARGET_NOT_FOUND', '原生Office修改必须绑定明确页面。');
      if (native.state.pendingInput || native.mirrorEngineRevision !== native.state.engineRevision) throw new ViewerError('NATIVE_STATE_STALE', '请先读取当前原生Office快照，再准备修改。');
      if (native.state.supportedOperations && !native.state.supportedOperations.includes(op.kind)) throw new ViewerError('CAPABILITY_UNSUPPORTED', '此旧格式操作尚无原生UNO映射，请使用原生命令目录。');
      Object.assign(patch, { nativeSessionId: native.state.sessionId, nativeWriterEpoch: native.writerEpoch, nativeEngineEpoch: native.state.engineEpoch, nativeEngineRevision: native.state.engineRevision });
    }
    this.patches.set(patch.id, patch); return clone(patch);
  }
  async commit(patchId: string, idempotencyKey: string, actor: Actor = 'agent') {
    const patch = this.patches.get(patchId); if (!patch) throw new ViewerError('TARGET_NOT_FOUND', '修改计划不存在或已过期。');
    const payload = JSON.stringify(patch), prior = this.receipts.get(idempotencyKey);
    if (prior) { if (prior.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '同一幂等键不能提交不同修改。'); return clone(prior.receipt) as Receipt; }
    if (this.getDocument(patch.documentId).info.revision !== patch.expectedRevision) throw new ViewerError('VERSION_CONFLICT', '预览之后内容已改变，请重新准备。');
    if (actor === 'agent') this.assertAgentPatchBinding(patch);
    if (actor === 'agent') await this.extensions.get('before-agent-edit')?.({ documentId: patch.documentId, operation: clone(patch.operation) }, actor);
    return this.serial(patch.documentId, async () => {
      const existing = this.receipts.get(idempotencyKey); if (existing) { if (existing.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '幂等键内容冲突。'); return clone(existing.receipt) as Receipt; }
      const native = this.nativeOfficeBindings.get(patch.documentId);
      if (native || patch.nativeSessionId) {
        if (!native || patch.nativeSessionId !== native.state.sessionId || patch.nativeWriterEpoch !== native.writerEpoch || patch.nativeEngineEpoch !== native.state.engineEpoch) throw new ViewerError('NATIVE_WRITER_CHANGED', '编辑源已切换，请在当前原生会话重新准备。');
        await this.syncNativeInside(patch.documentId, 'engine');
        const doc = this.getDocument(patch.documentId); if (doc.info.revision !== patch.expectedRevision || native.state.engineRevision !== patch.nativeEngineRevision) throw new ViewerError('VERSION_CONFLICT', '原生文档已变化，请重新准备。');
        if (actor === 'agent') this.assertAgentPatchBinding(patch);
        const before = clone(doc), result = await this.nativeDriver().execute({ sessionId: native.state.sessionId, viewId: patch.viewId!, expectedEngineEpoch: native.state.engineEpoch, expectedEngineRevision: native.state.engineRevision, requestId: randomUUID(), actor, operation: clone(patch.operation) });
        this.updateNativeOfficeState(result.state);
        let status: Receipt['status'] = result.status, warnings = result.warnings ?? [];
        try { await this.syncNativeInside(patch.documentId, actor); }
        catch (error) { status = 'dispatched'; warnings = [...warnings, '原生命令已发出，但当前镜像尚未稳定；请重新查询实际状态。', String(error)]; }
        const receipt: Receipt = { transactionId: randomUUID(), documentId: patch.documentId, revision: doc.info.revision, status, idempotencyKey, nativeSessionId: native.state.sessionId, warnings };
        let controlled = true; if (actor === 'agent') { try { this.assertAgentPatchBinding(patch); } catch { controlled = false; receipt.controlReleased = true; } }
        if (status === 'applied' && result.undoToken) this.transactions.set(receipt.transactionId, { documentId: patch.documentId, before, afterRevision: doc.info.revision, native: { sessionId: native.state.sessionId, writerEpoch: native.writerEpoch, engineEpoch: native.state.engineEpoch, engineRevision: native.state.engineRevision, viewId: patch.viewId!, undoToken: result.undoToken } });
        this.receipts.set(idempotencyKey, { payload, receipt });
        this.event('office.executed', { ...receipt, viewId: patch.viewId, actor, kind: patch.operation.kind });
        if (actor === 'agent' && controlled && status === 'applied') this.markAgentEdit(patch, receipt);
        await this.persist(); return receipt;
      }
      const doc = this.getDocument(patch.documentId); if (doc.info.revision !== patch.expectedRevision) throw new ViewerError('VERSION_CONFLICT', '预览之后内容已改变，请重新准备。');
      if (actor === 'agent') this.assertAgentPatchBinding(patch);
      const before = clone(doc), adapter = this.registry.resolve(doc.info.format);
      const updated = await adapter.apply(doc.bytes, doc.info.model, patch.operation);
      if (actor === 'agent') this.assertAgentPatchBinding(patch);
      doc.bytes = updated.bytes; doc.info.model = updated.model; doc.info.revision++; doc.info.dirty = true; doc.info.warnings = updated.warnings;
      for (const view of this.views.values()) if (view.documentId === doc.info.id && view.context) view.context = { ...view.context, contentRevision: doc.info.revision, quality: 'not-ready', visibleText: '', selection: { kind: 'none', text: '' } };
      const receipt: Receipt = { transactionId: randomUUID(), documentId: doc.info.id, revision: doc.info.revision, status: 'applied', idempotencyKey, warnings: updated.warnings };
      this.transactions.set(receipt.transactionId, { documentId: doc.info.id, before, afterRevision: doc.info.revision }); this.receipts.set(idempotencyKey, { payload, receipt });
      const operation = patch.operation;
      const target = 'blockId' in operation ? { kind: operation.kind, blockId: operation.blockId } : 'afterBlockId' in operation ? { kind: operation.kind, blockId: operation.afterBlockId } : 'shapeId' in operation ? { kind: operation.kind, slideId: operation.slideId, shapeId: operation.shapeId } : 'address' in operation ? { kind: operation.kind, sheetId: operation.sheetId, address: operation.address } : 'sheetId' in operation ? { kind: operation.kind, sheetId: operation.sheetId } : 'pageIndex' in operation ? { kind: operation.kind, pageIndex: operation.pageIndex } : { kind: operation.kind };
      this.event('document.changed', { ...receipt, actor, target, viewId: patch.viewId });
      if (actor === 'agent') this.markAgentEdit(patch, receipt);
      await this.persist(); return receipt;
    });
  }
  async undo(transactionId: string, actor: Actor = 'agent') {
    const undoKey = 'native-transaction-undo:' + transactionId, cached = this.receipts.get(undoKey);
    if (cached) return clone(cached.receipt) as Receipt;
    const tx = this.transactions.get(transactionId); if (!tx) throw new ViewerError('TARGET_NOT_FOUND', '撤销事务不存在。');
    return this.serial(tx.documentId, async () => {
      const binding = this.nativeOfficeBindings.get(tx.documentId);
      if (binding || tx.native) {
        if (!tx.native || !binding || tx.native.sessionId !== binding.state.sessionId || tx.native.writerEpoch !== binding.writerEpoch || tx.native.engineEpoch !== binding.state.engineEpoch || !tx.native.undoToken) throw new ViewerError('NATIVE_UNDO_UNAVAILABLE', '不能用旧文件镜像覆盖活跃原生Office；请使用原生撤销。');
        const repeated = this.receipts.get(undoKey); if (repeated) return clone(repeated.receipt) as Receipt;
        const view = this.getView(tx.native.viewId), agentBinding = { documentId: tx.documentId, viewId: view.id, agentControlId: view.agentState?.controlId, agentStateEpoch: this.agentStateEpochs.get(view.id) ?? 0 };
        if (actor === 'agent') { this.assertAgentPatchBinding(agentBinding); await this.extensions.get('before-agent-edit')?.({ documentId: tx.documentId, viewId: view.id, operation: { kind: 'native.undo' } }, actor); this.assertAgentPatchBinding(agentBinding); }
        await this.syncNativeInside(tx.documentId, 'engine');
        if (binding.state.engineRevision !== tx.native.engineRevision || this.getDocument(tx.documentId).info.revision !== tx.afterRevision) throw new ViewerError('VERSION_CONFLICT', '该修改之后已有原生编辑，不能撤销其他操作。');
        const result = await this.nativeDriver().undo({ sessionId: binding.state.sessionId, viewId: tx.native.viewId, expectedEngineEpoch: binding.state.engineEpoch, expectedEngineRevision: binding.state.engineRevision, undoToken: tx.native.undoToken, actor });
        this.updateNativeOfficeState(result.state);
        let status: Receipt['status'] = result.status === 'applied' ? 'undone' : result.status, warnings = result.warnings ?? [];
        try { await this.syncNativeInside(tx.documentId, actor); } catch (error) { status = 'dispatched'; warnings = [...warnings, '撤销已发出，尚未取得稳定文件镜像。', String(error)]; }
        const receipt: Receipt = { transactionId: randomUUID(), documentId: tx.documentId, revision: this.getDocument(tx.documentId).info.revision, status, nativeSessionId: binding.state.sessionId, warnings };
        let controlled = true; if (actor === 'agent') { try { this.assertAgentPatchBinding(agentBinding); } catch { controlled = false; receipt.controlReleased = true; } }
        if (actor === 'agent' && controlled && receipt.revision !== tx.afterRevision) this.markAgentEdit({ documentId: tx.documentId, viewId: tx.native.viewId, operation: { kind: 'native.undo' } }, receipt);
        this.transactions.delete(transactionId); this.receipts.set(undoKey, { payload: transactionId, receipt }); this.event('office.executed', { ...receipt, viewId: view.id, actor, kind: 'native.undo' }); await this.persist(); return receipt;
      }
      const current = this.getDocument(tx.documentId); if (current.info.revision !== tx.afterRevision) throw new ViewerError('VERSION_CONFLICT', '该修改之后还有其他编辑，不能整组覆盖撤销。');
      const restored = clone(tx.before); restored.info.revision = current.info.revision + 1; restored.info.diskRevision = current.info.diskRevision; restored.sourceHash = current.sourceHash; restored.info.path = current.info.path; restored.info.dirty = hash(restored.bytes) !== current.sourceHash;
      this.documents.set(tx.documentId, restored); this.transactions.delete(transactionId);
      for (const view of this.views.values()) if (view.documentId === tx.documentId && view.context) view.context = { ...view.context, contentRevision: restored.info.revision, quality: 'not-ready', visibleText: '', selection: { kind: 'none', text: '' } };
      const receipt: Receipt = { transactionId: randomUUID(), documentId: tx.documentId, revision: restored.info.revision, status: 'undone' }; this.event('document.changed', receipt); return receipt;
    });
  }
  async save(documentId: string, path?: string, allowOverwrite = false) {
    return this.serial(documentId, async () => {
      const nativeSnapshot = this.nativeOfficeBindings.has(documentId) ? await this.syncNativeInside(documentId, 'engine') : undefined;
      const doc = this.getDocument(documentId), target = path ? resolve(path) : doc.info.path;
      if (!target) throw new ViewerError('SAVE_PATH_REQUIRED', '新文档需要选择保存位置。');
      if (doc.info.format === 'web') throw new ViewerError('CAPABILITY_UNSUPPORTED', '请先生成网页阅读副本。');
      const expectedExtension = doc.info.format === 'markdown' ? '.md' : '.' + doc.info.format;
      if (!target.toLowerCase().endsWith(expectedExtension) && !(doc.info.format === 'html' && target.endsWith('.htm')) && !(doc.info.format === 'markdown' && target.endsWith('.markdown'))) throw new ViewerError('FORMAT_MISMATCH', `当前内容需保存为 ${expectedExtension}，不能通过改扩展名转换格式。`);
      let disk: Uint8Array | undefined;
      try { disk = new Uint8Array(await readFile(target)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const sameSource = doc.info.path !== undefined && (process.platform === 'win32' ? resolve(target).toLowerCase() === resolve(doc.info.path).toLowerCase() : resolve(target) === resolve(doc.info.path));
      if (sameSource && doc.sourceHash && (!disk || hash(disk) !== doc.sourceHash)) throw new ViewerError('FILE_CONFLICT', '源文件被其他程序修改或删除，请另存副本。');
      if (!sameSource && disk && !allowOverwrite) throw new ViewerError('FILE_EXISTS', '目标文件已存在，需明确覆盖授权。');
      await mkdir(dirname(target), { recursive: true }); const temp = target + '.agentviewer-' + randomUUID() + '.tmp';
      try { await writeFile(temp, doc.bytes); if (hash(new Uint8Array(await readFile(temp))) !== hash(doc.bytes)) throw new ViewerError('SAVE_VERIFY_FAILED', '临时文件校验失败。'); await rename(temp, target); } finally { await unlink(temp).catch(() => {}); }
      const savedRevision = doc.info.revision;
      doc.info.path = target; doc.info.title = basename(target); doc.sourceHash = hash(doc.bytes); doc.info.diskRevision = savedRevision;
      let warnings: string[] | undefined;
      if (nativeSnapshot) {
        try {
          const binding = this.nativeBinding(documentId), cleared = await this.nativeDriver().ackSaved?.(binding.state.sessionId, { engineEpoch: nativeSnapshot.state.engineEpoch, engineRevision: nativeSnapshot.engineRevisionAfter, hash: doc.sourceHash });
          const latest = await this.nativeDriver().state(binding.state.sessionId); this.updateNativeOfficeState(latest);
          doc.info.dirty = cleared !== true || latest.engineRevision !== nativeSnapshot.engineRevisionAfter || latest.dirty;
        } catch (error) {
          // The atomic rename already committed the frozen bytes. Do not report
          // a failed file write or lose the saved source hash if its live writer
          // cannot acknowledge that version. Further native changes stay dirty.
          doc.info.dirty = true;
          warnings = ['文件已保存；原生编辑器尚未确认保存版本，保留未保存标记。', String(error)];
        }
      } else doc.info.dirty = false;
      const receipt: Receipt = { transactionId: randomUUID(), documentId, revision: doc.info.revision, status: 'saved', path: target, ...(warnings ? { warnings } : {}) }; this.event('document.saved', receipt); await this.persist(); return receipt;
    });
  }
  async reloadFromDisk(documentId: string) {
    return this.serial(documentId, async () => {
      if (this.nativeOfficeBindings.has(documentId)) throw new ViewerError('NATIVE_SESSION_ACTIVE', '请先保存并关闭原生Office会话，再重新载入磁盘文件。');
      const doc = this.getDocument(documentId);
      if (!doc.info.path) throw new ViewerError('SAVE_PATH_REQUIRED', '文档尚未保存到磁盘。');
      if (doc.info.dirty) throw new ViewerError('UNSAVED_CHANGES', '请先保存或另存当前修改，再重新载入。');
      const bytes = new Uint8Array(await readFile(doc.info.path));
      if (bytes.byteLength > 100 * 1024 * 1024) throw new ViewerError('FILE_TOO_LARGE', '文件超过 100 MB。');
      const nextHash = hash(bytes);
      if (nextHash === doc.sourceHash) return clone(doc.info);
      const model = await this.registry.resolve(doc.info.format).open(bytes, doc.info.format);
      doc.bytes = bytes; doc.sourceHash = nextHash; doc.info.model = model;
      doc.info.revision++; doc.info.diskRevision = doc.info.revision; doc.info.dirty = false; doc.info.warnings = [];
      for (const [id, tx] of this.transactions) if (tx.documentId === documentId) this.transactions.delete(id);
      for (const view of this.views.values()) if (view.documentId === documentId && view.context) view.context = { ...view.context, contentRevision: doc.info.revision, quality: 'not-ready', visibleText: '', selection: { kind: 'none', text: '' } };
      this.event('document.reloaded', { documentId, revision: doc.info.revision });
      await this.persist(); return clone(doc.info);
    });
  }
  async browserInput(raw: BrowserRequest) {
    if (!this.browser) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生鼠标键盘输入只能在桌面应用执行。');
    const request = browserRequestSchema.parse(raw); this.getView(request.viewId);
    if (this.agentControl.get(request.viewId) && this.agentControl.get(request.viewId) !== 'running') throw new ViewerError('AGENT_PAUSED', '此页面的 Agent 操作已暂停或停止。');
    const payload = JSON.stringify(request), prior = this.receipts.get(request.idempotencyKey);
    if (prior) { if (prior.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '输入幂等键冲突。'); return clone(prior.receipt); }
    return this.serial('browser:' + request.viewId, async () => {
      const existing = this.receipts.get(request.idempotencyKey); if (existing) { if (existing.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '输入幂等键冲突。'); return clone(existing.receipt); }
      if (this.agentControl.get(request.viewId) && this.agentControl.get(request.viewId) !== 'running') throw new ViewerError('AGENT_PAUSED', '此页面的 Agent 操作已暂停或停止。');
      const result = await this.browser!.input(request); this.updateContext(request.viewId, result.context, 'agent'); this.receipts.set(request.idempotencyKey, { payload, receipt: result }); this.event('browser.input', { viewId: request.viewId, kind: request.action.kind, point: 'x' in request.action ? { x: request.action.x, y: request.action.y } : 'to' in request.action ? request.action.to : undefined, actor: 'agent' }); await this.persist(); return result;
    });
  }
  async browserCopy(viewId: string) { if (!this.browser) throw new ViewerError('CAPABILITY_UNSUPPORTED', '请在桌面应用创建网页副本。'); const view = this.getView(viewId); const source = this.getDocument(view.documentId).info; const html = await this.browser.html(viewId); const copy = await this.openBytes(source.title + '.html', new TextEncoder().encode(html), 'html', undefined, view.windowId); this.getDocument(copy.documentId).info.warnings.push('来源：' + source.model.url, '这是本地阅读副本，未修改远程站点。外部资源未归档，相对链接可能失效。', '副本移除脚本、嵌入 frame、事件属性与已知敏感表单值。'); return copy; }
  async submitTask(driverId: string, prompt: string, viewId?: string, snapshotId?: string, sourceScope?: 'selection' | 'visible') {
    const driver = this.drivers.get(driverId); if (!driver) throw new ViewerError('HARNESS_UNAVAILABLE', '尚未配置该 harness 驱动。');
    const original = snapshotId ? this.readSnapshot(snapshotId) : await this.snapshot(viewId);
    const snapshot = sourceScope ? scopedReadingSnapshot(original, sourceScope) : original;
    if (viewId && snapshot.context.viewId !== viewId) throw new ViewerError('SNAPSHOT_TARGET_MISMATCH', '固定快照属于其他阅读视图。');
    return this.startTask(driver, prompt, snapshot, sourceScope);
  }
  /** Trusted SDK path for retrying a bounded source after the ordinary snapshot
   * cache expires. The public dispatcher never accepts a caller-supplied source. */
  async submitFrozenReadingTask(driver: HarnessDriver, prompt: string, frozen: ScopedReadingSnapshot, timeoutMs = 180000) {
    const snapshot = scopedReadingSnapshot(frozen, frozen.sourceScope);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new ViewerError('INVALID_ARGUMENT', '阅读任务超时必须在 1–900000 毫秒内。');
    return this.startTask(driver, prompt, snapshot, snapshot.sourceScope, timeoutMs);
  }
  private startTask(driver: HarnessDriver, prompt: string, snapshot: ReadingSnapshot, sourceScope?: 'selection' | 'visible', timeoutMs = sourceScope ? 180000 : 0) {
    const controller = new AbortController();
    const task: HarnessTask = { id: randomUUID(), snapshotId: snapshot.id, viewId: snapshot.context.viewId, sourceScope, prompt, text: '', status: 'running' }; this.tasks.set(task.id, task); this.taskControllers.set(task.id, controller); this.event('harness.started', { taskId: task.id });
    let ended = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: HarnessTask['status'], error?: unknown) => {
      if (ended) return;
      ended = true; clearTimeout(timer); controller.signal.removeEventListener('abort', cancelled);
      task.status = status; if (error !== undefined) task.error = String(error);
      this.taskControllers.delete(task.id); this.event('harness.completed', { taskId: task.id, status: task.status });
    };
    const cancelled = () => finish('cancelled'); controller.signal.addEventListener('abort', cancelled, { once: true });
    if (timeoutMs) { timer = setTimeout(() => { finish('failed', '阅读分析超过 ' + Math.round(timeoutMs / 1000) + ' 秒，已停止等待；可基于同一冻结来源重试。'); controller.abort(); }, timeoutMs); timer.unref(); }
    void Promise.resolve().then(() => {
      if (ended || controller.signal.aborted) return;
      return driver.submit(prompt, clone(snapshot), delta => {
      // A provider may ignore cancellation or emit after its promise settles.
      // Terminal tasks must not grow or change status when that happens.
      if (ended || controller.signal.aborted) return;
      if (typeof delta !== 'string') { finish('failed', 'Harness 返回了非文本内容。'); controller.abort(); return; }
      if (sourceScope && task.text.length + delta.length > 160000) { finish('failed', '模型输出超过 160000 字符，已停止接收；未静默截断为完整结果。'); controller.abort(); return; }
      task.text += delta; if (delta) this.event('harness.delta', { taskId: task.id, text: delta });
      }, controller.signal);
    }).then(() => {
      if (sourceScope && !task.text.trim()) finish('failed', '模型未返回可读结果。'); else finish('completed');
    }).catch(error => finish(controller.signal.aborted ? 'cancelled' : 'failed', error));
    return clone(task);
  }
  cancelTask(taskId: string) { const controller = this.taskControllers.get(taskId); if (!controller) { if (this.tasks.get(taskId)?.status === 'cancelled') return; throw new ViewerError('TARGET_NOT_FOUND', '任务已结束或不存在。'); } controller.abort(); }
}
