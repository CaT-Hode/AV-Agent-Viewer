import { BrowserWindow, WebContentsView } from 'electron';
type ToolbarEntry = { view: WebContentsView; state: Record<string, unknown>; panel?: boolean; tooltip?: boolean; sampling?: boolean; timer?: ReturnType<typeof setInterval> };

// A trusted, capsule-sized surface above the website; no page script or full-width scrim.
export class WebToolbarHost {
  private entries = new Map<BrowserWindow, ToolbarEntry>();
  constructor(private url: () => string, private preload: string, private route = '/web-toolbar', private channel = 'agentviewer:toolbar') {}
  permitsSnapshot(id: number, snapshotId: string) { const entry = [...this.entries.values()].find(e => e.view.webContents.id === id); return (entry?.state.selection as any)?.snapshot?.id === snapshotId; }
  owns(id: number) { return [...this.entries.values()].some(entry => entry.view.webContents.id === id); }
  focus(owner: BrowserWindow) { const entry = this.entries.get(owner); if (!entry) return; entry.view.setVisible(true); entry.view.webContents.focus(); entry.view.webContents.send('agentviewer:toolbar', { action: 'focus-address' }); }
  request(id: number, method: string, args: Record<string, unknown>) {
    const pair = [...this.entries].find(([, entry]) => entry.view.webContents.id === id);
    if (!pair) throw new Error('AUTH_SCOPE_DENIED');
    const [owner, entry] = pair;
    if (method === 'toolbar-state') return entry.state;
    if (method === 'toolbar-panel' || method === 'toolbar-tooltip') {
      if (method === 'toolbar-panel') entry.panel = !!args.expanded; else entry.tooltip = !!args.open;
      const bounds = (entry.state.bounds ?? entry.view.getBounds()) as Electron.Rectangle;
      const height = entry.panel ? 255 : entry.tooltip ? 112 : 62;
      entry.view.setBounds({ ...bounds, y: Math.max(0, Math.min(bounds.y, owner.getContentBounds().height-height)), height }); return {};
    }
    if (method !== 'toolbar-action' || !['back', 'forward', 'reload', 'navigate', 'copy', 'translate', 'focus', 'blur', 'hover', 'dismiss', 'result'].includes(String(args.action))) throw new Error('AUTH_SCOPE_DENIED');
    owner.webContents.send(this.channel, { ...args, viewId: entry.state.viewId });
    return {};
  }
  update(owner: BrowserWindow, state: Record<string, unknown>) {
    let entry = this.entries.get(owner);
    if (!entry && !state.viewId) return;
    if (!entry) {
      const view = new WebContentsView({ webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      view.setBackgroundColor('#00000000'); view.setVisible(false);
      entry = { view, state }; this.entries.set(owner, entry);
      owner.contentView.addChildView(view);
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', event => event.preventDefault());
      void view.webContents.loadURL(this.url() + '#' + this.route);
      const created = entry;
      if (this.route === '/web-toolbar') { created.timer = setInterval(() => this.sampleBackdrop(owner, created), 400); created.timer.unref(); }
      owner.once('closed', () => { clearInterval(created.timer); this.entries.delete(owner); if (!view.webContents.isDestroyed()) view.webContents.close(); });
    }
    if (!state.visible || state.viewId !== entry.state.viewId) { entry.panel = false; entry.tooltip = false; }
    entry.state = state;
    if (state.bounds) {
      const b = state.bounds as { x: number; y: number; width: number; height: number };
      const height = entry.panel ? 255 : entry.tooltip ? 112 : Math.max(1,Math.round(b.height));
      entry.view.setBounds({ x: Math.round(b.x), y: Math.max(0,Math.min(Math.round(b.y),owner.getContentBounds().height-height)), width: Math.max(1, Math.round(b.width)), height });
    }
    owner.contentView.addChildView(entry.view);
    entry.view.setVisible(!!state.viewId && !!state.visible);
    entry.view.webContents.send(this.channel, state);
    this.sampleBackdrop(owner, entry);
  }
  private sampleBackdrop(owner: BrowserWindow, entry: ToolbarEntry) {
    const state=entry.state, values=(state.settings as any)?.values;
    if (this.route === '/web-toolbar' && state.visible && state.bounds && !entry.sampling && !owner.isDestroyed() && !owner.isMinimized() && values?.['appearance.glass'] !== 'off' && !values?.['appearance.reduceTransparency'] && !values?.['appearance.highContrast']) {
      const b = entry.view.getBounds();
      const under = owner.contentView.children.filter(v => v instanceof WebContentsView && v !== entry!.view && v.getVisible() && v.getBounds().width > b.width && !(v as WebContentsView).webContents.getURL().includes('#/')) as WebContentsView[];
      const page = under[0];
      if (page) {
        const p = page.getBounds(), current = entry;
        entry.sampling=true;
        void page.webContents.capturePage({ x: Math.max(0, b.x-p.x+8), y: Math.max(0, b.y-p.y+8), width: b.width-16, height: 46 }).then(image => {
          if (current.state !== state || current.view.webContents.isDestroyed()) return;
          const pixels=image.toBitmap();let light=0,count=0;
          for(let i=0;i<pixels.length;i+=64){light+=pixels[i]*.0722+pixels[i+1]*.7152+pixels[i+2]*.2126;count++;}
          // Bounded in-memory sample from the actual page, never persisted or sent to a model.
          const sampled={...state,backdrop:light/Math.max(count,1)>140?'light':'dark',backdropImage:image.resize({width:Math.ceil(b.width/2)}).toDataURL()};
          current.state=sampled; current.view.webContents.send(this.channel,sampled);
        }).catch(()=>{}).finally(()=>{current.sampling=false;});
      }
    }
  }
}
