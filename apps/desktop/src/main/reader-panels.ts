import { BrowserWindow, screen, type NativeImage, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import type { BackdropSource, NativeBackdropSource } from './web-toolbar';
import { nativeBackdropFrames } from './backdrop-frame-hub';
import { alignFrameCapture, physicalFrameCrop } from './backdrop-frame-crop';
import { readerPanelDestination, validReaderPanelRect } from './reader-panel-policy';

type Rect = { x: number; y: number; width: number; height: number };
type Side = 'left' | 'right' | 'translation';
type Entry = { owner: BrowserWindow; side: Side; popup: BrowserWindow; boundViewId: string; viewId?: string; bounds?: Rect; visible: boolean; ready: boolean; source?: string; attachedSource?: string; attachingSource?: string; attachRevision: number; unsubscribe?: () => void; frameSource?: WebContents; sampling: boolean; pending: boolean; timer?: ReturnType<typeof setTimeout>; sampledAt: number; signature?: string; pixels?: string; image?: string; rect?: Rect; generation: number };
const GUTTER = 12, FROST_FRAME_MS = 180;
const intersection = (a: Rect, b: Rect): Rect | undefined => { const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height); return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined; };

/** Same-origin popup DOM is owned by the main React tree through a portal.
 * Popup IPC is intentionally read-only and cannot select a different view. */
export class ReaderPanelHost {
  private readonly entries = new Map<BrowserWindow, Map<Side, Entry>>();
  private readonly layouts = new Map<BrowserWindow, { viewId?: string; panels: { side: Side; bounds: Rect }[] }>();
  constructor(private readonly rendererUrl: () => string, private readonly preload: string, private readonly web: (viewId: string) => BackdropSource | undefined, private readonly native: (viewId: string) => NativeBackdropSource | undefined, private readonly permits: (owner: BrowserWindow, viewId: string) => boolean, private readonly raised: (owner: BrowserWindow) => void, private readonly frostEnabled: () => boolean) {}

  install(owner: BrowserWindow, windowId: string) {
    owner.webContents.setWindowOpenHandler(details => {
      const target = readerPanelDestination(details.url, this.rendererUrl(), details.frameName);
      if (!target || !this.permits(owner, target.viewId)) return { action: 'deny' };
      const { side } = target;
      const previous = this.entries.get(owner)?.get(side); if (previous && !previous.popup.isDestroyed()) previous.popup.close();
      return { action: 'allow', overrideBrowserWindowOptions: { parent: owner, frame: false, transparent: true, show: false, skipTaskbar: true, resizable: false, minimizable: false, maximizable: false, hasShadow: false, backgroundColor: '#00000000', webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--agentviewer-window=' + windowId] } } };
    });
    owner.webContents.on('did-create-window', (popup, details) => {
      const params = new URLSearchParams(new URL(details.url).hash.split('?')[1]), side = params.get('side') as Side;
      const entry: Entry = { owner, popup, side, boundViewId: params.get('view')!, visible: false, ready: false, sampling: false, pending: false, sampledAt: 0, generation: 0, attachRevision: 0 };
      let entries = this.entries.get(owner); if (!entries) this.entries.set(owner, entries = new Map()); entries.set(side, entry);
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const initial = details.url;
      popup.webContents.on('will-navigate', (event, url) => { if (url !== initial) event.preventDefault(); });
      popup.webContents.setZoomMode('disabled');
      const follow = () => this.position(entry), hide = () => this.hide(entry), show = () => this.sync(entry);
      owner.on('move', follow); owner.on('resize', follow); owner.on('minimize', hide); owner.on('hide', hide); owner.on('restore', show); owner.on('show', show);
      popup.once('closed', () => { this.hide(entry); if (entries!.get(side) === entry) entries!.delete(side); owner.removeListener('move', follow); owner.removeListener('resize', follow); owner.removeListener('minimize', hide); owner.removeListener('hide', hide); owner.removeListener('restore', show); owner.removeListener('show', show); });
      this.apply(entry);
    });
    owner.once('closed', () => { for (const entry of this.entries.get(owner)?.values() ?? []) { this.hide(entry); if (!entry.popup.isDestroyed()) entry.popup.close(); } this.entries.delete(owner); this.layouts.delete(owner); });
  }
  owns(contentsId: number) { return !!this.find(contentsId); }
  private find(contentsId: number) { for (const entries of this.entries.values()) for (const entry of entries.values()) if (!entry.popup.isDestroyed() && entry.popup.webContents.id === contentsId) return entry; }
  request(contentsId: number, method: string) {
    const entry = this.find(contentsId); if (!entry || method !== 'reader-panel-ready') throw new Error('AUTH_SCOPE_DENIED');
    entry.ready = true; this.send(entry); this.sync(entry); return {};
  }
  update(owner: BrowserWindow, viewId: string | undefined, panels: { side: Side; bounds: Rect }[]) {
    const viewport = owner.getContentBounds();
    if (!Array.isArray(panels) || panels.length > 2 || new Set(panels.map(panel => panel.side)).size !== panels.length || panels.some(panel => !['left', 'right'].includes(panel.side) || !validReaderPanelRect(panel.bounds, viewport))) throw new Error('INVALID_PANEL_GEOMETRY');
    const floating = this.layouts.get(owner);
    this.layouts.set(owner, { viewId, panels: [...panels, ...(floating && floating.viewId === viewId ? floating.panels.filter(panel => panel.side === 'translation') : [])] });
    for (const entry of this.entries.get(owner)?.values() ?? []) this.apply(entry);
  }
  updateTranslation(owner: BrowserWindow, viewId: string, bounds?: Rect) {
    if (bounds && !validReaderPanelRect(bounds, owner.getContentBounds())) throw new Error('INVALID_PANEL_GEOMETRY');
    const layout = this.layouts.get(owner);
    if (!bounds && layout?.viewId !== viewId) return;
    const panels = layout?.viewId === viewId ? layout.panels.filter(panel => panel.side !== 'translation') : [];
    this.layouts.set(owner, { viewId, panels: [...panels, ...(bounds ? [{ side: 'translation' as const, bounds }] : [])] });
    for (const entry of this.entries.get(owner)?.values() ?? []) this.apply(entry);
  }
  sourceChanged(owner: BrowserWindow, viewId: string) { for (const entry of this.entries.get(owner)?.values() ?? []) if (entry.viewId === viewId) this.sync(entry); }
  preferencesChanged() { for (const entries of this.entries.values()) for (const entry of entries.values()) { entry.generation++; entry.signature = undefined; entry.pixels = undefined; if (!this.frostEnabled()) { clearTimeout(entry.timer); entry.timer = undefined; entry.unsubscribe?.(); entry.unsubscribe = undefined; entry.frameSource = undefined; entry.pending = false; entry.image = undefined; entry.rect = undefined; this.send(entry); } this.sync(entry); } }
  private apply(entry: Entry) {
    const layout = this.layouts.get(entry.owner), bounds = layout?.panels.find(panel => panel.side === entry.side)?.bounds;
    if (entry.viewId !== layout?.viewId) { entry.generation++; entry.signature = undefined; entry.pixels = undefined; entry.image = undefined; entry.rect = undefined; this.send(entry); }
    else if (JSON.stringify(entry.bounds) !== JSON.stringify(bounds)) {
      // Reuse the last source pixels in document coordinates while a drag is
      // sampled. They must not appear glued to the moving native window.
      if (entry.side === 'translation' && entry.bounds && bounds && entry.rect) { entry.rect = { ...entry.rect, x: entry.rect.x+entry.bounds.x-bounds.x, y: entry.rect.y+entry.bounds.y-bounds.y }; this.send(entry); }
      entry.generation++; entry.signature = undefined; entry.pixels = undefined;
    }
    entry.viewId = layout?.viewId; entry.bounds = entry.boundViewId === layout?.viewId ? bounds : undefined;
    this.sync(entry);
  }
  private position(entry: Entry) {
    if (entry.owner.isDestroyed() || entry.popup.isDestroyed() || !entry.bounds) return;
    const owner = entry.owner.getContentBounds(), b = entry.bounds;
    entry.popup.setBounds({ x: owner.x + Math.round(b.x) - GUTTER, y: owner.y + Math.round(b.y) - GUTTER, width: Math.ceil(b.width) + 2 * GUTTER, height: Math.ceil(b.height) + 2 * GUTTER });
  }
  private documentSources(entry: Entry) {
    const native = entry.viewId ? this.native(entry.viewId) : undefined, candidate = entry.viewId ? this.web(entry.viewId) : undefined;
    // WebContentsView frames contain the page alone. Never accept the owner
    // renderer or another sidebar popup as a backdrop: either would feed the
    // panel's own frame/shadow back into the next sample. Native capture stays
    // on the provider's document HWND (PrintWindow), not the desktop composite.
    const web = candidate && !candidate.view.webContents.isDestroyed() && candidate.view.webContents !== entry.owner.webContents && !this.owns(candidate.view.webContents.id) ? candidate : undefined;
    return { native, web };
  }
  private sync(entry: Entry) {
    if (entry.owner.isDestroyed() || entry.popup.isDestroyed()) return;
    const { native, web } = this.documentSources(entry);
    if (!entry.ready || !entry.bounds || (!native && !web) || !entry.owner.isVisible() || entry.owner.isMinimized()) { this.hide(entry); return; }
    const source = native ? 'native:' + native.navigationId : 'web:' + (web as BackdropSource).navigationId;
    this.position(entry);
    if (entry.source !== source) {
      this.hide(entry); entry.source = source; entry.generation++; entry.signature = undefined; entry.image = undefined; entry.rect = undefined; entry.pixels = undefined; this.send(entry);
      entry.attachedSource = undefined; entry.attachingSource = undefined;
    }
    if (native && entry.attachedSource !== source) {
      if (entry.attachingSource === source) return;
      entry.attachingSource = source; const revision = ++entry.attachRevision;
      void native.attach(entry.popup).then(() => { if (entry.attachRevision === revision && entry.source === source && !entry.popup.isDestroyed()) { entry.attachedSource = source; entry.attachingSource = undefined; this.sync(entry); } }).catch(() => { if (entry.attachRevision === revision) { entry.attachingSource = undefined; this.hide(entry); } }); return;
    }
    if (!entry.visible || !entry.popup.isVisible()) { entry.popup.showInactive(); this.raised(entry.owner); }
    entry.visible = true;
    if (!this.frostEnabled()) return;
    if (web && entry.frameSource !== web.view.webContents) {
      entry.unsubscribe?.(); entry.frameSource = web.view.webContents;
      try { entry.unsubscribe = nativeBackdropFrames.subscribe(entry.frameSource, () => this.sample(entry, true)); } catch { entry.unsubscribe = undefined; }
    }
    this.sample(entry);
  }
  private hide(entry: Entry) {
    entry.visible = false; entry.generation++; clearTimeout(entry.timer); entry.timer = undefined; entry.unsubscribe?.(); entry.unsubscribe = undefined; entry.frameSource = undefined; entry.pending = false;
    if (!entry.popup.isDestroyed()) entry.popup.hide();
  }
  private send(entry: Entry) {
    if (entry.ready && !entry.popup.isDestroyed()) entry.popup.webContents.send('agentviewer:toolbar', { action: 'reader-panel-backdrop', image: entry.image, rect: entry.rect });
  }
  private sample(entry: Entry, force = false) {
    if (!this.frostEnabled() || !entry.visible || !entry.viewId || !entry.bounds || entry.owner.isDestroyed() || entry.popup.isDestroyed()) return;
    if (entry.sampling) { entry.pending = true; return; }
    const delay = FROST_FRAME_MS - (Date.now() - entry.sampledAt);
    if (delay > 0) { if (!entry.timer) entry.timer = setTimeout(() => { entry.timer = undefined; this.sample(entry, true); }, delay); return; }
    const { native, web } = this.documentSources(entry); if (!native && !web) return;
    const sourceBounds = native?.bounds ?? web!.view.getBounds(), panel = entry.bounds;
    const slot = { x: Math.round(panel.x) - GUTTER, y: Math.round(panel.y) - GUTTER, width: Math.ceil(panel.width) + 2 * GUTTER, height: Math.ceil(panel.height) + 2 * GUTTER };
    const overscan = entry.side === 'translation' ? 84 : 0;
    const area = intersection({ x:slot.x-overscan,y:slot.y-overscan,width:slot.width+2*overscan,height:slot.height+2*overscan }, sourceBounds); if (!area) return;
    const local = { x: area.x - sourceBounds.x, y: area.y - sourceBounds.y, width: area.width, height: area.height };
    const density = screen.getDisplayMatching(entry.owner.getBounds()).scaleFactor;
    const capture = alignFrameCapture(local, sourceBounds, density) ?? { x: Math.floor(local.x), y: Math.floor(local.y), width: Math.ceil(local.width), height: Math.ceil(local.height) };
    const source = native ?? web!;
    const signature = JSON.stringify([source.navigationId, source.layoutRevision, source.revision, web?.scrollX, web?.scrollY, slot, capture]);
    if (!force && entry.signature === signature) return;
    const generation = entry.generation;
    entry.sampling = true; entry.pending = false; entry.sampledAt = Date.now();
    const latest = web && nativeBackdropFrames.peek(web.view.webContents.id), crop = physicalFrameCrop(capture, density);
    const frameSize = latest?.image.getSize();
    const image: Promise<{ image: NativeImage; rect: Rect }> = native ? native.capture(capture) : latest && crop && frameSize && crop.x + crop.width <= frameSize.width && crop.y + crop.height <= frameSize.height ? Promise.resolve({ image: latest.image.crop(crop), rect: capture }) : web!.view.webContents.capturePage(capture).then(image => ({ image, rect: capture }));
    void image.then(value => {
      if (!entry.visible || generation !== entry.generation || entry.popup.isDestroyed()) return;
      // Refraction needs CSS-pixel detail. Tall frosted sidebars use half-DIP.
      const ratio = entry.side === 'translation' ? 1 : .5;
      const reduced = value.image.resize({ width: Math.max(1, Math.ceil(value.rect.width * ratio)), height: Math.max(1, Math.ceil(value.rect.height * ratio)), quality: 'good' });
      const hash = createHash('sha256').update(reduced.toBitmap()).digest('hex');
      entry.signature = signature;
      if (hash === entry.pixels && entry.image) return;
      entry.pixels = hash; entry.image = reduced.toDataURL(); entry.rect = { x: sourceBounds.x + value.rect.x - slot.x - GUTTER, y: sourceBounds.y + value.rect.y - slot.y - GUTTER, width: value.rect.width, height: value.rect.height }; this.send(entry);
    }).catch(() => {}).finally(() => { entry.sampling = false; if (entry.pending) this.sample(entry, true); });
  }
}
