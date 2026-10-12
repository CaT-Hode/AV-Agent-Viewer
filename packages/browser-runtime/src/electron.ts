import { BrowserWindow, WebContentsView } from 'electron';
import type { Actor, BrowserRequest, BrowserRuntime, ReadingContext, Rect } from '../../contracts/src/index';
import { ViewerError } from '../../contracts/src/index';
import type { ViewerCore } from '../../document-core/src/index';
import { randomUUID } from 'node:crypto';

interface BrowserEntry { view: WebContentsView; navigationId: string; layoutRevision: number; owner: BrowserWindow; visible: boolean; injecting: boolean; actor: Actor; sourceRevision: number; sourceSequence: number; sourceReady?: boolean; sourceClock?: number; deviceScaleFactor?: number; scrollAt: number; scrollX: number; scrollY: number; topHover?: boolean; sourceReading?: boolean; sourcePending?: { reason: string }; layoutBounds?: Rect }
type BrowserSurfaceOptions = { preload?: string; onSourceChanged?(owner: BrowserWindow, viewId: string): void };
import { readContextScript } from './context-script';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class ElectronBrowserRuntime implements BrowserRuntime {
  entries = new Map<string, BrowserEntry>();
  private requestedLayouts = new Map<string, { windowId: string; bounds: Rect }>();
  private pointerOverlays = new Map<BrowserWindow, { window: BrowserWindow; ready: Promise<void>; timer?: NodeJS.Timeout }>();
  constructor(readonly core: ViewerCore, readonly windowFor: (id: string) => BrowserWindow, readonly localOrigins: () => string[] = () => [], readonly pointerEnabled: () => boolean = () => true, private readonly surfaceOptions: BrowserSurfaceOptions = {}) {}
  surface(viewId: string) {
    const entry = this.entries.get(viewId);
    if (!entry || !entry.visible || !entry.sourceReady || entry.sourceReading || entry.view.webContents.isDestroyed()) return undefined;
    return { view: entry.view, navigationId: entry.navigationId, layoutRevision: entry.layoutRevision, revision: entry.sourceRevision, scrollX: entry.scrollX, scrollY: entry.scrollY, deviceScaleFactor: entry.deviceScaleFactor };
  }
  /** Accept only the fixed metadata channel from a known page's isolated preload. */
  sourceChanged(senderId: number, value: Record<string, unknown>) {
    const pair = [...this.entries].find(([, entry]) => entry.view.webContents.id === senderId);
    if (!pair) return;
    const [viewId, entry] = pair;
    const sequence = Number(value.sequence), sourceTime = Number(value.scrollAt), x = Number(value.scrollX), y = Number(value.scrollY);
    if (!Number.isSafeInteger(sequence) || sequence <= entry.sourceSequence || ![sourceTime, x, y, Number(value.width), Number(value.height)].every(Number.isFinite) || sourceTime < 0 || Math.abs(x) > 1e8 || Math.abs(y) > 1e8) return;
    entry.sourceSequence = sequence; entry.sourceRevision++;
    if (!entry.visible || entry.owner.isDestroyed()) return;
    // Metadata is a wake-up hint, not the authoritative viewport. Read back
    // from an isolated world, coalescing any newer signals while one read runs.
    entry.sourcePending = { reason: String(value.reason ?? '') };
    if (!entry.sourceReading) void this.readSource(viewId, entry);
  }
  private async readSource(viewId: string, entry: BrowserEntry) {
    const pending = entry.sourcePending;
    if (!pending || !entry.visible || entry.view.webContents.isDestroyed()) return;
    entry.sourcePending = undefined; entry.sourceReading = true;
    const navigationId = entry.navigationId;
    try {
      const data = await entry.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: '({x:scrollX,y:scrollY,at:performance.now(),width:innerWidth,height:innerHeight,dpr:devicePixelRatio})' }]) as { x: number; y: number; at: number; width: number; height: number; dpr: number };
      if (entry.navigationId !== navigationId || !entry.visible || entry.owner.isDestroyed() || ![data.x, data.y, data.at, data.width, data.height, data.dpr].every(Number.isFinite) || data.dpr <= 0) return;
      const now = performance.now();
      if (entry.sourceClock === undefined) entry.sourceClock = now - data.at;
      const at = Math.max(entry.scrollAt, Math.min(now, data.at + entry.sourceClock));
      const moved = entry.scrollX !== data.x || entry.scrollY !== data.y;
      entry.scrollAt = at; entry.scrollX = data.x; entry.scrollY = data.y;
      entry.deviceScaleFactor = data.dpr;
      entry.sourceReading = false; entry.sourceReady = true;
      if (moved || pending.reason === 'ready') entry.owner.webContents.send('agentviewer:toolbar', { action: 'scroll', viewId, scrollX: data.x, scrollY: data.y, scrollAt: at, navigationId });
      this.surfaceOptions.onSourceChanged?.(entry.owner, viewId);
    } catch { /* Navigation may destroy the originating execution context. */ }
    finally { entry.sourceReading = false; if (entry.sourcePending) void this.readSource(viewId, entry); }
  }
  private async pointer(entry: BrowserEntry, x: number, y: number, kind: string) {
    if (!this.pointerEnabled()) return;
    let overlay = this.pointerOverlays.get(entry.owner);
    if (!overlay || overlay.window.isDestroyed()) {
      const window = new BrowserWindow({ parent: entry.owner, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, skipTaskbar: true, focusable: false, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      window.setIgnoreMouseEvents(true, { forward: true });
      const html = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;unsafe-inline&apos;; style-src &apos;unsafe-inline&apos;"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}#cursor{position:absolute;width:18px;height:22px;filter:drop-shadow(0 2px 2px #24316688);transition:left .08s linear,top .08s linear}#cursor svg{width:18px;height:22px}#ring{position:absolute;width:25px;height:25px;border:2px solid #6974e7;border-radius:50%;transform:translate(-50%,-50%) scale(.3);opacity:0}#ring.click{animation:hit .45s ease-out}@keyframes hit{0%{transform:translate(-50%,-50%) scale(.2);opacity:.9}100%{transform:translate(-50%,-50%) scale(1.8);opacity:0}}</style><div id="cursor"><svg viewBox="0 0 18 22" xmlns="http://www.w3.org/2000/svg"><path d="M1 1v18l4.6-4.4 3.2 6 3-1.6-3.2-5.8H16z" fill="#606cdd" stroke="white" stroke-width="1.6"/></svg></div><div id="ring"></div><script>window.agentPointer=(x,y,kind)=>{const p=document.getElementById("cursor"),r=document.getElementById("ring");p.style.left=x+"px";p.style.top=y+"px";r.style.left=x+"px";r.style.top=y+"px";if(kind==="click"||kind==="drag-end"){r.classList.remove("click");void r.offsetWidth;r.classList.add("click")}}</script>';
      const ready = window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      overlay = { window, ready }; this.pointerOverlays.set(entry.owner, overlay);
      window.on('closed', () => this.pointerOverlays.delete(entry.owner));
    }
    clearTimeout(overlay.timer);
    const bounds = entry.view.getBounds(), owner = entry.owner.getBounds();
    overlay.window.setBounds({ x: owner.x + bounds.x, y: owner.y + bounds.y, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });
    await overlay.ready; overlay.window.showInactive();
    await overlay.window.webContents.executeJavaScript('window.agentPointer(' + JSON.stringify(x) + ',' + JSON.stringify(y) + ',' + JSON.stringify(kind) + ')');
    overlay.timer = setTimeout(() => { if (!overlay!.window.isDestroyed()) overlay!.window.close(); }, 1600);
  }
  async open(viewId: string, url: string) {
    if (this.entries.has(viewId)) return;
    const metadata = this.core.getView(viewId), owner = this.windowFor(metadata.windowId);
    const view = new WebContentsView({ webPreferences: { preload: this.surfaceOptions.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:agentviewer-web' } });
    const entry: BrowserEntry = { view, owner, navigationId: randomUUID(), layoutRevision: 0, visible: false, injecting: false, actor: 'human', sourceRevision: 0, sourceSequence: 0, scrollAt: 0, scrollX: 0, scrollY: 0 };
    this.entries.set(viewId, entry); owner.contentView.addChildView(view); view.setVisible(false);
    const layout = this.requestedLayouts.get(viewId);
    if (layout) this.layout(layout.windowId, [...this.requestedLayouts.entries()].filter(([, value]) => value.windowId === layout.windowId).map(([id, value]) => ({ viewId: id, bounds: value.bounds })));
    const wc = view.webContents;
    wc.setZoomMode('isolated');
    wc.setZoomFactor(metadata.zoom ?? 1);
    wc.on('zoom-changed', (_event, direction) => {
      const current = this.core.getView(viewId).zoom ?? wc.getZoomFactor();
      this.core.setViewZoom(viewId, Math.max(.25, Math.min(4, current + (direction === 'in' ? .1 : -.1))), entry.injecting ? 'agent' : 'human');
      if (!entry.owner.isDestroyed()) entry.owner.webContents.send('agentviewer:toolbar', { action: 'zoom-updated', viewId });
    });
    const protectedOrigins = new Set(this.localOrigins().flatMap(origin => {
      const parsed = new URL(origin), alias = new URL(origin);
      alias.hostname = parsed.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      return [parsed.origin, alias.origin];
    }));
    wc.session.webRequest.onBeforeRequest({ urls: [...protectedOrigins].flatMap(origin => [origin + '/api/*', origin + '/v1/*']) }, (_details, callback) => callback({ cancel: true }));
    wc.setWindowOpenHandler(({ url: target }) => { if (/^https?:/.test(target)) void this.core.openWeb(target, metadata.windowId).catch(e => this.core.event('browser.error', { viewId, error: String(e) })); return { action: 'deny' }; });
    wc.on('will-navigate', (event, url) => { if (!/^https?:/.test(url)) event.preventDefault(); });
    wc.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame) { entry.navigationId = randomUUID(); entry.layoutRevision = 0; entry.sourceReady = false; entry.sourceRevision++; if (!inPlace) { entry.sourceSequence = 0; entry.sourceClock = undefined; } this.core.event('browser.navigation', { viewId, navigationId: entry.navigationId }); this.surfaceOptions.onSourceChanged?.(entry.owner, viewId); } });
    const readySource = () => { entry.sourceRevision++; entry.sourcePending = { reason: 'ready' }; if (!entry.sourceReading) void this.readSource(viewId, entry); };
    wc.on('did-finish-load', readySource);
    wc.on('did-navigate-in-page', readySource);
    wc.on('page-title-updated', (_e, title) => { const doc = this.core.getDocument(metadata.documentId); doc.info.title = title; this.core.event('browser.title', { viewId }); });
    wc.on('did-navigate', (_e, currentUrl) => { this.core.getDocument(metadata.documentId).info.model.url = currentUrl; });
    wc.on('before-input-event', () => { if (entry.visible && !entry.injecting) { entry.actor = 'human'; this.core.activate(viewId, 'human'); } });
    wc.on('before-mouse-event', (_event, mouse) => {
      if (!entry.injecting && mouse.type === 'mouseMove') {
        const top = mouse.y < 65;
        if (top && !entry.topHover) entry.owner.webContents.send('agentviewer:toolbar', { action: 'reveal', viewId });
        if (!top && entry.topHover) entry.owner.webContents.send('agentviewer:toolbar', { action: 'leave', viewId });
        entry.topHover = top;
      }
      if (entry.visible && !entry.injecting && mouse.type === 'mouseDown') { entry.actor = 'human'; this.core.activate(viewId, 'human'); }
    });
    // Chromium may focus an autofocus element as a hidden page finishes
    // loading. That is not a user's change of reading target.
    wc.on('focus', () => { if (entry.visible && !entry.injecting) { entry.actor = 'human'; this.core.activate(viewId, 'human'); } });
    wc.on('did-fail-load', (_e, code, message, _url, main) => { if (main && code !== -3) this.core.event('browser.error', { viewId, error: message }); });
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    await wc.loadURL(url);
  }
  private entry(viewId: string) { const entry = this.entries.get(viewId); if (!entry || entry.view.webContents.isDestroyed()) throw new ViewerError('TARGET_NOT_FOUND', '网页视图不存在或已关闭。'); return entry; }
  setZoom(viewId: string, factor: number) {
    const entry = this.entries.get(viewId); if (!entry || entry.view.webContents.isDestroyed()) return;
    if (Math.abs(entry.view.webContents.getZoomFactor() - factor) < .001) return;
    entry.view.webContents.setZoomFactor(factor);
    entry.layoutRevision++; entry.sourceRevision++; entry.sourcePending = { reason: 'resize' };
    if (!entry.sourceReading) void this.readSource(viewId, entry);
    this.surfaceOptions.onSourceChanged?.(entry.owner, viewId);
  }
  layout(windowId: string, layouts: { viewId: string; bounds: Rect }[]) {
    const ids = new Set(layouts.map(l => l.viewId));
    for (const [id, value] of this.requestedLayouts) if (value.windowId === windowId && !ids.has(id)) this.requestedLayouts.delete(id);
    for (const layout of layouts) this.requestedLayouts.set(layout.viewId, { windowId, bounds: layout.bounds });
    for (const [id, entry] of this.entries) if (this.core.views.get(id)?.windowId === windowId) { entry.visible = ids.has(id); entry.view.setVisible(entry.visible); }
    for (const layout of layouts) {
      const entry = this.entries.get(layout.viewId); if (!entry) continue;
      const owner = this.windowFor(windowId); if (owner !== entry.owner) { entry.owner.contentView.removeChildView(entry.view); owner.contentView.addChildView(entry.view); entry.owner = owner; }
      const bounds = { x: Math.round(layout.bounds.x), y: Math.round(layout.bounds.y), width: Math.max(1, Math.round(layout.bounds.width)), height: Math.max(1, Math.round(layout.bounds.height)) }, previous = entry.layoutBounds;
      const changed = !previous || ['x', 'y', 'width', 'height'].some(key => previous[key as keyof Rect] !== bounds[key as keyof Rect]);
      if (!changed) continue;
      entry.view.setBounds(bounds); entry.layoutBounds = bounds;
      // The first usable layout preserves revision zero for existing clients.
      // Subsequent real native bounds invalidate both input coordinates and
      // sampled pixels; identical layout reports do not manufacture epochs.
      if (previous && previous.width > 0 && previous.height > 0) {
        entry.layoutRevision++; entry.sourceRevision++; entry.sourcePending = { reason: 'resize' };
        if (!entry.sourceReading) void this.readSource(layout.viewId, entry);
        this.surfaceOptions.onSourceChanged?.(entry.owner, layout.viewId);
      }
    }
  }
  async context(viewId: string, actor?: Actor): Promise<ReadingContext> {
    const entry = this.entry(viewId), view = this.core.getView(viewId), doc = this.core.getDocument(view.documentId);
    if (entry.view.webContents.isLoading()) return { viewId, documentId: view.documentId, contentRevision: doc.info.revision, viewRevision: view.context?.viewRevision ?? 0, capturedAt: new Date().toISOString(), quality: 'not-ready', actor: actor ?? entry.actor, locator: { kind: 'web-viewport', navigationId: entry.navigationId }, visibleText: '', selection: { kind: 'none', text: '' }, viewport: { width: entry.view.getBounds().width, height: entry.view.getBounds().height, scrollX: 0, scrollY: 0, deviceScaleFactor: 1, navigationId: entry.navigationId, layoutRevision: entry.layoutRevision } };
    const data = await entry.view.webContents.executeJavaScript(readContextScript) as { selectionRect?: Rect; title: string; url: string; heading: string; visibleText: string; selection: string; width: number; height: number; scrollX: number; scrollY: number; deviceScaleFactor: number; frameCount: number };
    return { viewId, documentId: view.documentId, contentRevision: doc.info.revision, viewRevision: (view.context?.viewRevision ?? 0) + 1, capturedAt: new Date().toISOString(), quality: entry.visible ? 'confirmed' : 'last-confirmed', actor: actor ?? entry.actor, locator: { kind: 'web-viewport', navigationId: entry.navigationId, scrollTop: data.scrollY, quote: data.heading }, visibleText: data.visibleText, selection: { kind: data.selection ? 'text' : 'none', text: data.selection, rect:data.selectionRect, locator: data.selection ? { kind: 'web-text-quote', navigationId: entry.navigationId, quote: data.selection } : undefined }, viewport: { width: data.width, height: data.height, scrollX: data.scrollX, scrollY: data.scrollY, deviceScaleFactor: data.deviceScaleFactor, navigationId: entry.navigationId, layoutRevision: entry.layoutRevision } };
  }
  async input(request: BrowserRequest) {
    const entry = this.entry(request.viewId);
    if (entry.navigationId !== request.expectedNavigationId) throw new ViewerError('STALE_NAVIGATION', '网页已发生导航，请重新读取视口再输入。');
    if (entry.layoutRevision > 0 && request.expectedLayoutRevision !== entry.layoutRevision) throw new ViewerError('STALE_LAYOUT', '翻译或页面更新已改变布局，请重新读取视口和坐标。');
    if (!entry.visible) throw new ViewerError('VIEW_NOT_VISIBLE', '请先激活网页标签，输入坐标基于可见网页视口。');
    const wc = entry.view.webContents, context = await this.context(request.viewId);
    if (context.quality !== 'confirmed' || entry.navigationId !== request.expectedNavigationId) throw new ViewerError('STALE_NAVIGATION', '网页尚未就绪或已发生导航，请重新读取视口。');
    if (request.expectedViewport) {
      const actual = context.viewport!, expected = request.expectedViewport;
      if (['width', 'height', 'scrollX', 'scrollY'].some(key => Math.abs(actual[key as keyof typeof expected] - expected[key as keyof typeof expected]) > 1)) throw new ViewerError('STALE_VIEWPORT', '网页尺寸或滚动位置已改变，请重新读取视口再输入。');
    }
    const zoom = wc.getZoomFactor();
    const point = (x: number, y: number) => { if (x >= context.viewport!.width || y >= context.viewport!.height) throw new ViewerError('INVALID_COORDINATES', '鼠标坐标超出网页视口。'); return { x: Math.round(x * zoom), y: Math.round(y * zoom) }; };
    const action = request.action;
    entry.injecting = true; entry.actor = 'agent';
    try {
      entry.owner.focus(); wc.focus();
      if (action.kind === 'click') {
        const p = point(action.x, action.y); await this.pointer(entry, action.x, action.y, 'click'); wc.sendInputEvent({ type: 'mouseMove', ...p });
        wc.sendInputEvent({ type: 'mouseDown', ...p, button: action.button, clickCount: action.clickCount, modifiers: action.modifiers });
        wc.sendInputEvent({ type: 'mouseUp', ...p, button: action.button, clickCount: action.clickCount, modifiers: action.modifiers });
      } else if (action.kind === 'move') { await this.pointer(entry, action.x, action.y, 'move'); wc.sendInputEvent({ type: 'mouseMove', ...point(action.x, action.y), modifiers: action.modifiers }); }
      else if (action.kind === 'drag') {
        const from = point(action.from.x, action.from.y); point(action.to.x, action.to.y); await this.pointer(entry, action.from.x, action.from.y, 'move');
        wc.sendInputEvent({ type: 'mouseDown', ...from, button: 'left', clickCount: 1, modifiers: action.modifiers });
        try { for (let i = 1; i <= action.steps; i++) { const x = action.from.x + (action.to.x - action.from.x) * i / action.steps, y = action.from.y + (action.to.y - action.from.y) * i / action.steps; wc.sendInputEvent({ type: 'mouseMove', ...point(x, y), modifiers: [...action.modifiers, 'leftbuttondown'] }); void this.pointer(entry, x, y, i === action.steps ? 'drag-end' : 'move').catch(() => {}); await delay(8); } }
        finally { wc.sendInputEvent({ type: 'mouseUp', ...point(action.to.x, action.to.y), button: 'left', clickCount: 1, modifiers: action.modifiers }); }
      } else if (action.kind === 'scroll') { await this.pointer(entry, action.x, action.y, 'move'); wc.sendInputEvent({ type: 'mouseWheel', ...point(action.x, action.y), deltaX: -action.deltaX, deltaY: -action.deltaY, canScroll: true, modifiers: action.modifiers }); }
      else if (action.kind === 'press') { wc.sendInputEvent({ type: 'keyDown', keyCode: action.key, modifiers: action.modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode: action.key, modifiers: action.modifiers }); }
      else await wc.insertText(action.text);
      await delay(100);
      const fresh = await this.context(request.viewId, 'agent');
      return { navigationId: entry.navigationId, context: fresh };
    } finally { entry.injecting = false; }
  }
  async navigate(viewId: string, action: 'back' | 'forward' | 'reload' | 'url', url?: string) {
    const wc = this.entry(viewId).view.webContents;
    if (action === 'reload') wc.reload();
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'url') { if (!url || !/^https?:/.test(url)) throw new ViewerError('INVALID_URL', '只允许 HTTP(S)。'); await wc.loadURL(url); }
  }
  async capture(viewId: string) {
    const entry = this.entry(viewId), context = await this.context(viewId), navigationId = entry.navigationId;
    if (!entry.visible || context.quality !== 'confirmed') throw new ViewerError('VIEW_NOT_VISIBLE', '请先激活并等待网页就绪后截图。');
    const image = await entry.view.webContents.capturePage(), fresh = await this.context(viewId);
    if (entry.navigationId !== navigationId || fresh.quality !== 'confirmed') throw new ViewerError('STALE_NAVIGATION', '截图期间网页发生导航，请重试。');
    const before = context.viewport!, after = fresh.viewport!;
    if (['width', 'height', 'scrollX', 'scrollY'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw new ViewerError('STALE_VIEWPORT', '截图期间视口发生变化，请重试。');
    const png = image.toPNG();
    if (png.length < 24) throw new ViewerError('CAPTURE_FAILED', '网页尚未生成有效截图，请等待后重试。');
    return { mimeType: 'image/png', data: png.toString('base64'), width: png.readUInt32BE(16), height: png.readUInt32BE(20), navigationId, viewport: context.viewport };
  }
  async html(viewId: string) {
    return this.entry(viewId).view.webContents.executeJavaScript(`(() => {
      const copy = document.documentElement.cloneNode(true);
      copy.querySelectorAll('script,iframe,frame,object,embed').forEach(node=>node.remove());
      copy.querySelectorAll('input[type="password"],input[type="hidden"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]').forEach(node=>node.removeAttribute('value'));
      copy.querySelectorAll('*').forEach(node=>[...node.attributes].forEach(attr=>{if(/^on/i.test(attr.name)||(/^(href|src|action)$/i.test(attr.name)&&/^javascript:/i.test(attr.value)))node.removeAttribute(attr.name)}));
      return '<!doctype html>\\n' + copy.outerHTML;
    })()`);
  }
  async translationUnits(viewId: string, scope: 'page' | 'selection' = 'page') {
    const entry = this.entry(viewId), navigationId = entry.navigationId;
    const units = await entry.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const key = '__agentViewerTranslationState';
      const state = window[key] || (window[key] = { sequence: 0, nodes: new Map(), originals: new Map(), ids: new WeakMap() });
      const register = node => { let id = state.ids.get(node); if (!id) { id = String(++state.sequence); state.ids.set(node,id); state.nodes.set(id,node); } return id; };
      if (${JSON.stringify(scope)} === 'selection') {
        const selection = window.getSelection(); if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return [];
        const range = selection.getRangeAt(0); if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return [];
        const node = range.startContainer, text = node.data.slice(range.startOffset, range.endOffset);
        if (!text.trim() || node.parentElement?.closest('input,textarea,[contenteditable],script,style,code,pre,math,svg')) return [];
        return [{ id: register(node), text, start: range.startOffset, end: range.endOffset, whole: node.data }];
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), result = [];
      while (walker.nextNode() && result.length < 80) {
        const node = walker.currentNode, parent = node.parentElement, text = node.data;
        if (!parent || !text.trim() || text.length > 4000 || parent.closest('script,style,code,pre,textarea,input,[contenteditable],math,svg,noscript')) continue;
        const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
        const id = register(node); const previous = state.originals.get(id); if (previous && node.data === previous.translated) continue; if (previous) state.originals.delete(id);
        result.push({ id, text, start: 0, end: text.length, whole: text });
      }
      result.sort((a,b) => { const na = state.nodes.get(a.id), nb = state.nodes.get(b.id); const ra = na.parentElement.getBoundingClientRect(), rb = nb.parentElement.getBoundingClientRect(); return (ra.top >= 0 && ra.top < innerHeight ? 0 : 1) - (rb.top >= 0 && rb.top < innerHeight ? 0 : 1); });
      return result;
    })()` }]) as { id: string; text: string; start: number; end: number; whole: string }[];
    if (entry.navigationId !== navigationId) throw new ViewerError('STALE_NAVIGATION', '提取期间网页已导航。');
    return { navigationId, units };
  }
  async applyTranslation(viewId: string, navigationId: string, unit: { id: string; text: string; start: number; end: number; whole: string }, translated: string) {
    const entry = this.entry(viewId); if (entry.navigationId !== navigationId) throw new ViewerError('STALE_NAVIGATION', '网页已导航。');
    const applied = await entry.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const s = window.__agentViewerTranslationState, u = ${JSON.stringify(unit)}, translated = ${JSON.stringify(translated)};
      const node = s?.nodes.get(u.id); if (!node || !node.isConnected || node.data !== u.whole || s.originals.has(u.id)) return false;
      const next = u.whole.slice(0,u.start) + translated + u.whole.slice(u.end);
      s.originals.set(u.id, { original:u.whole, translated:next }); node.data = next; return true;
    })()` }]);
    if (entry.navigationId !== navigationId) throw new ViewerError('STALE_NAVIGATION', '写入前网页已导航。');
    if (applied) { entry.layoutRevision++; this.core.event('browser.translation', { viewId, layoutRevision: entry.layoutRevision }); }
    return !!applied;
  }
  async restoreTranslation(viewId: string) {
    const entry = this.entry(viewId), navigationId = entry.navigationId;
    const restored = await entry.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const s = window.__agentViewerTranslationState; if (!s) return { restored: 0, skipped: 0 };
      let restored = 0, skipped = 0;
      for (const [id, item] of s.originals) { const node = s.nodes.get(id); if (node?.isConnected && node.data === item.translated) { node.data = item.original; restored++; } else skipped++; s.originals.delete(id); }
      return { restored, skipped };
    })()` }]);
    if (entry.navigationId !== navigationId) throw new ViewerError('STALE_NAVIGATION', '恢复期间网页已导航。');
    if (restored.restored) { entry.layoutRevision++; this.core.event('browser.translation-restored', { viewId, layoutRevision: entry.layoutRevision }); }
    return restored as { restored: number; skipped: number };
  }
  close(viewId: string) { this.requestedLayouts.delete(viewId); const entry = this.entries.get(viewId); if (!entry) return; if (!entry.owner.isDestroyed()) entry.owner.contentView.removeChildView(entry.view); if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close(); this.entries.delete(viewId); }
}
