import { BrowserWindow, WebContentsView, screen, type NativeImage, type WebContents } from 'electron';
import { AGENT_OPERATION_METRICS, NAVIGATION_METRICS } from '../renderer/lib/navigation-optics';
import { NativeBackdropCache, backdropStatistics, type BackdropCacheStatistics, type BackdropPixels } from './backdrop-cache';
import { AI_POPOVER_MOTION_BASE_MS, SELECTION_POPOVER_MOTION_BASE_MS, motionDurationForMode, resolveMotionMode } from '../renderer/lib/motion-policy';
import { nativeTooltipLayout, type TooltipRect, type TooltipSize } from '../renderer/lib/tooltip-placement';
import { nativeBackdropFrames } from './backdrop-frame-hub';
import { alignFrameCapture, physicalFrameCrop } from './backdrop-frame-crop';
import { navigationExitDuration, retainedSurfaceExit } from './toolbar-motion';
import { preferredNavigationWidth, type NavigationLane } from '../renderer/lib/navigation-lane';
const backdropFrames = nativeBackdropFrames;
type Rect = { x: number; y: number; width: number; height: number };
export type BackdropSource = { view: WebContentsView; navigationId: string; layoutRevision: number; revision: number; scrollX: number; scrollY: number; deviceScaleFactor?: number };
type TooltipReply = { ticket: number; offsetY: number; viewId?: unknown; placement?: ReturnType<typeof nativeTooltipLayout>['placement'] };
type ToolbarEntry = { view: WebContentsView; overlay?: BrowserWindow; rootBounds?: Rect; state: Record<string, unknown>; ready?: boolean; focusViewId?: string; dispose?: () => void; panel?: boolean; panelBounds?: Rect; tooltip?: boolean; tooltipLayout?: ReturnType<typeof nativeTooltipLayout> & {size?:TooltipSize}; tooltipTicket?: number; tooltipPending?: boolean; tooltipClose?: (value: TooltipReply) => void; sampling?: boolean; pending?: boolean; forceSample?: boolean; backdropPatches?: boolean; cache: NativeBackdropCache; stats: BackdropCacheStatistics; sampledAt?: number; sequence?: number; geometryRevision: number; shapeSignature?:string; capsuleBounds?: Rect; sampleTimer?: ReturnType<typeof setTimeout>; timer?: ReturnType<typeof setInterval>; exitTimer?: ReturnType<typeof setTimeout>; tooltipTimer?: ReturnType<typeof setTimeout>; frameSource?: WebContents; unsubscribeFrame?: () => void; frameSignature?: string; frameAt?: number; pixelAt?: number; acceptedFrames?: number };
type CaptureRequest = { state: Record<string, unknown>; source: BackdropSource; page: WebContentsView; b: Rect; p: Rect; zoom: number; density: number; frameAligned: boolean; capsule: Rect; capture: Rect; geometryRevision: number; key: string; shape: string };

// A trusted, capsule-sized surface above the website; no page script or full-width scrim.
export class WebToolbarHost {
  private entries = new Map<BrowserWindow, ToolbarEntry>();
  // An unseen surface retains only its current target, never content or geometry.
  // Weak keys need no owner listeners or explicit disposal before first display.
  private deferred = new WeakMap<BrowserWindow, { viewId: string; focusRequested?: boolean }>();
  constructor(private url: () => string, private preload: string, private route = '/web-toolbar', private channel = 'agentviewer:toolbar', private sourceFor?: (viewId: string) => BackdropSource | undefined) {}
  ownerFor(id: number) { return [...this.entries].find(([,entry])=>!entry.view.webContents.isDestroyed()&&entry.view.webContents.id===id)?.[0]; }
  private bounds(entry: ToolbarEntry) { return entry.rootBounds ?? entry.view.getBounds(); }
  private syncNavigationShape(entry:ToolbarEntry) {
    const overlay=entry.overlay;if(this.route!=='/web-toolbar'||!overlay||overlay.isDestroyed())return;
    const host=this.bounds(entry),zoom=entry.view.webContents.getZoomFactor(),lane=entry.state.laneBounds as NavigationLane|undefined;
    const width=preferredNavigationWidth(lane?.width??Math.max(32,host.width-2*NAVIGATION_METRICS.shadowGutter));
    const capsule=entry.capsuleBounds??{x:(lane?.center??host.width/2)-width/2,y:NAVIGATION_METRICS.shadowGutter,width,height:NAVIGATION_METRICS.height};
    const regions:Rect[]=[];
    const add=(rect:Rect,gutter=0)=>{const x=Math.max(0,Math.floor(rect.x*zoom-gutter)),y=Math.max(0,Math.floor(rect.y*zoom-gutter)),right=Math.min(host.width,Math.ceil((rect.x+rect.width)*zoom+gutter)),bottom=Math.min(host.height,Math.ceil((rect.y+rect.height)*zoom+gutter));if(right>x&&bottom>y)regions.push({x,y,width:right-x,height:bottom-y});};
    add(capsule,NAVIGATION_METRICS.shadowGutter);
    if(entry.panel)add({x:Math.max(0,capsule.x+capsule.width-316),y:capsule.y+capsule.height,width:316,height:Math.max(0,host.height/zoom-capsule.y-capsule.height)});
    const tooltip=entry.tooltipLayout;
    if(tooltip?.size)add({...tooltip.placement,...tooltip.size},6);
    // An empty shape restores the full rectangle. Keep the transparent host
    // click-through outside the actual capsule and temporary popup regions.
    const shape=regions.length?regions:[{x:0,y:0,width:1,height:1}],signature=JSON.stringify([overlay.id,shape]);
    if(entry.shapeSignature!==signature){overlay.setShape(shape);entry.shapeSignature=signature;}
  }
  private showOverlay(owner: BrowserWindow, entry: ToolbarEntry) {
    const overlay=entry.overlay;
    if(!overlay||overlay.isDestroyed()||!entry.state.visible||owner.isDestroyed()||!owner.isVisible()||owner.isMinimized())return;
    if(!overlay.isVisible())overlay.showInactive();
  }
  private syncHost(owner: BrowserWindow, entry: ToolbarEntry) {
    if(entry.overlay?.isDestroyed()){
      const bounds=entry.rootBounds;entry.overlay=undefined;entry.rootBounds=undefined;
      if(!entry.view.webContents.isDestroyed()&&!owner.isDestroyed()){if(bounds)entry.view.setBounds(bounds);owner.contentView.addChildView(entry.view);}
    }
    if(entry.view.webContents.isDestroyed()||owner.isDestroyed())return;
    // Hidden requests and source notifications must not create an owned window.
    // An existing host remains available for its already-running exit animation.
    if(!entry.state.visible)return;
    const source=this.sourceFor?.(String(entry.state.viewId));
    // Owned sidebars are above the parent's compositor. Trusted capsules must
    // use the same window layer as the embedded webpage and its sidebars.
    if(!source){
      if(entry.overlay){const overlay=entry.overlay,b=entry.rootBounds;entry.overlay=undefined;entry.rootBounds=undefined;overlay.hide();overlay.contentView.removeChildView(entry.view);overlay.close();if(b)entry.view.setBounds(b);owner.contentView.addChildView(entry.view);}
      return;
    }
    if(!entry.overlay){
      const b=entry.view.getBounds(),p=owner.getContentBounds();entry.rootBounds=b;
      owner.contentView.removeChildView(entry.view);
      const overlay=new BrowserWindow({parent:owner,x:p.x+b.x,y:p.y+b.y,width:b.width,height:b.height,frame:false,transparent:true,show:false,skipTaskbar:true,resizable:false,hasShadow:false,backgroundColor:'#00000000',webPreferences:{sandbox:true}});
      overlay.contentView.addChildView(entry.view);entry.overlay=overlay;
      entry.view.setBounds({x:0,y:0,width:b.width,height:b.height});
      overlay.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      const follow=()=>{if(!owner.isDestroyed()&&!overlay.isDestroyed()&&entry.rootBounds){const p=owner.getContentBounds(),b=entry.rootBounds;overlay.setBounds({x:p.x+b.x,y:p.y+b.y,width:b.width,height:b.height});}};
      const hide=()=>{if(!overlay.isDestroyed())overlay.hide();},show=()=>{follow();this.showOverlay(owner,entry);};
      owner.on('move',follow);owner.on('resize',follow);owner.on('minimize',hide);owner.on('hide',hide);owner.on('restore',show);owner.on('show',show);
      overlay.once('closed',()=>{owner.removeListener('move',follow);owner.removeListener('resize',follow);owner.removeListener('minimize',hide);owner.removeListener('hide',hide);owner.removeListener('restore',show);owner.removeListener('show',show);});
    }
    this.syncNavigationShape(entry);
    this.showOverlay(owner,entry);
  }
  raise(owner:BrowserWindow){const entry=this.entries.get(owner);if(entry?.state.visible&&entry.overlay&&!entry.overlay.isDestroyed()&&entry.overlay.isVisible())entry.overlay.moveTop();}
  sourceChanged(owner: BrowserWindow, viewId: string) {
    const entry = this.entries.get(owner);
    if (!entry || entry.state.viewId !== viewId) return;
    if(entry.view.webContents.isDestroyed()){this.update(owner,{viewId,visible:false});return;}
    this.syncHost(owner,entry);
    const source = this.sourceFor?.(viewId), sample = entry.state.backdropSample as { navigationId?: string; layoutRevision?: number } | undefined;
    if (sample && (source?.navigationId !== sample.navigationId || source?.layoutRevision !== sample.layoutRevision)) {
      entry.cache.clear();
      entry.frameSignature = undefined;
      entry.state = { ...entry.state, backdropImage: undefined, backdropSample: undefined };
      this.sendBackdrop(entry, undefined, undefined);
    }
    this.syncFrameSubscription(owner, entry);
    this.sampleBackdrop(owner, entry);
  }
  permitsSnapshot(id: number, snapshotId: string) { const entry = [...this.entries.values()].find(e => !e.view.webContents.isDestroyed()&&e.view.webContents.id === id); return !!entry?.state.visible && (entry.state.selection as any)?.snapshot?.id === snapshotId; }
  owns(id: number) { return [...this.entries.values()].some(entry => !entry.view.webContents.isDestroyed()&&entry.view.webContents.id === id); }
  stateFor(owner: BrowserWindow) { if(owner.isDestroyed())return;const target=this.deferred.get(owner);return this.entries.get(owner)?.state??(target?{viewId:target.viewId,visible:false}:undefined); }
  capsuleFor(owner:BrowserWindow,viewId:string):{visible:boolean;bounds?:Rect}{
    const entry=this.entries.get(owner);if(!entry||entry.view.webContents.isDestroyed()||!entry.state.visible||entry.state.viewId!==viewId)return {visible:false};
    const capsule=entry.capsuleBounds;if(!capsule)return {visible:true};
    const host=this.bounds(entry),zoom=entry.view.webContents.getZoomFactor();
    return {visible:true,bounds:{x:host.x+capsule.x*zoom,y:host.y+capsule.y*zoom,width:capsule.width*zoom,height:capsule.height*zoom}};
  }
  focus(owner: BrowserWindow) {
    if(owner.isDestroyed())return;
    const entry=this.entries.get(owner);
    if(entry?.view.webContents.isDestroyed())this.update(owner,{viewId:entry.state.viewId,visible:false});
    if(!entry||entry.view.webContents.isDestroyed()||!entry.state.visible){
      const pending=this.deferred.get(owner),viewId=entry?.state.viewId??pending?.viewId;
      if(this.route==='/web-toolbar'&&typeof viewId==='string'&&viewId&&!(pending?.viewId===viewId&&pending.focusRequested)){
        this.deferred.set(owner,{viewId,focusRequested:true});
        // The main renderer already handles this action by revealing navigation
        // and publishing a fresh layout. Its echoed focus call is coalesced.
        owner.webContents.send(this.channel,{action:'focus-address-request',viewId});
      }
      return;
    }
    if(typeof entry.state.viewId!=='string')return;
    clearTimeout(entry.exitTimer);entry.exitTimer=undefined;
    entry.state={...entry.state,visible:true,hideProgress:0,instant:true};
    entry.focusViewId=entry.state.viewId as string;
    this.syncHost(owner,entry);entry.view.setVisible(true);this.sendState(entry);
    this.syncFrameSubscription(owner,entry);this.sampleBackdrop(owner,entry);this.focusReady(owner,entry);
  }
  private focusReady(owner:BrowserWindow,entry:ToolbarEntry){
    if(!entry.ready||!entry.focusViewId||entry.focusViewId!==entry.state.viewId||!entry.state.visible||owner.isDestroyed()||entry.view.webContents.isDestroyed()||this.entries.get(owner)!==entry)return;
    entry.focusViewId=undefined;entry.view.webContents.focus();entry.view.webContents.send('agentviewer:toolbar',{action:'focus-address'});
  }
  request(id: number, method: string, args: Record<string, unknown>) {
    const pair = [...this.entries].find(([, entry]) => !entry.view.webContents.isDestroyed()&&entry.view.webContents.id === id);
    if (!pair) throw new Error('AUTH_SCOPE_DENIED');
    const [owner, entry] = pair;
    if (method === 'toolbar-state') { if (args.backdropPatches === true && this.hasBackdrop()) entry.backdropPatches = true; return { ...entry.state, tooltipOffsetY: entry.tooltipLayout?.offsetY ?? 0, backdropDiagnostics: { ...entry.stats }, backdropFrameHub: backdropFrames.stats() }; }
    if (method === 'toolbar-panel' || method === 'toolbar-tooltip') {
      const resize=()=>{if(owner.isDestroyed()||entry.view.webContents.isDestroyed())return;this.setBounds(owner, entry);this.sampleBackdrop(owner, entry);};
      if (this.route === '/ai-result-toolbar' || this.route === '/agent-toolbar' && method === 'toolbar-panel') throw new Error('AUTH_SCOPE_DENIED');
      if (method === 'toolbar-panel') {
        entry.panel=!!args.expanded;
        if(!entry.panel)entry.panelBounds=undefined;
        else if(this.route==='/selection-toolbar'&&args.bounds){
          const bounds=args.bounds as Rect;
          if(![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)||bounds.x<0||bounds.y<0||bounds.width<=0||bounds.width>720||bounds.height<=0||bounds.height>720)throw new Error('INVALID_PANEL_BOUNDS');
          entry.panelBounds={...bounds};
        }
        resize();
      }
      else {
        if (args.ready !== undefined) {
          if (args.ready !== entry.tooltipTicket || args.viewId !== entry.state.viewId) throw new Error('STALE_TOOLTIP');
          const geometry=args.capsuleBounds as Rect|undefined;
          if(geometry&&[geometry.x,geometry.y,geometry.width,geometry.height].every(Number.isFinite)&&geometry.width>0&&geometry.width<2600&&geometry.height>0&&geometry.height<300){entry.capsuleBounds={...geometry};entry.geometryRevision++;}
          entry.tooltipPending=false;this.sampleBackdrop(owner,entry);return this.tooltipReply(entry);
        }
        clearTimeout(entry.tooltipTimer);entry.tooltipClose?.(this.tooltipReply(entry));entry.tooltipClose=undefined;
        if(args.open){
          if(!entry.state.visible)throw new Error('STALE_TOOLTIP');
          const anchor=args.anchor as TooltipRect,size=args.size as TooltipSize;
          if(!anchor||!size||![anchor.x,anchor.y,anchor.width,anchor.height,size.width,size.height].every(Number.isFinite)||size.width<=0||size.width>1000||size.height<=0||size.height>700)throw new Error('INVALID_TOOLTIP');
          entry.tooltip=true;entry.tooltipLayout={...nativeTooltipLayout(anchor,size,this.bounds(entry),this.normalBounds(owner,entry),owner.getContentBounds(),entry.view.webContents.getZoomFactor()),size};
          this.resizeTooltip(owner,entry);return this.tooltipReply(entry);
        }
        const close=()=>{entry.tooltip=false;entry.tooltipLayout=undefined;this.resizeTooltip(owner,entry);const reply=this.tooltipReply(entry);entry.tooltipClose?.(reply);entry.tooltipClose=undefined;return reply;};
        const delay=Number(args.duration??0);
        if(Number.isFinite(delay)&&delay>0)return new Promise<TooltipReply>(resolve=>{entry.tooltipClose=resolve;entry.tooltipTimer=setTimeout(close,Math.min(700,delay));});
        return close();
      }
      return {};
    }
    if (method !== 'toolbar-action' || !['back', 'forward', 'reload', 'navigate', 'copy', 'translate', 'zoom', 'undo', 'save', 'focus', 'blur', 'hover', 'leave', 'dismiss', 'result', 'started', 'failed', 'geometry','hitboxes'].includes(String(args.action))) throw new Error('AUTH_SCOPE_DENIED');
    if (typeof args.viewId === 'string' && args.viewId !== entry.state.viewId) throw new Error('STALE_VIEW');
    if ((this.route === '/agent-toolbar' || this.route === '/ai-result-toolbar') && !['geometry','hitboxes'].includes(String(args.action))) throw new Error('AUTH_SCOPE_DENIED');
    if(args.action==='hitboxes'){
      const boxes=args.boxes as {id:string;group:string;bounds:Rect}[];
      if(!Array.isArray(boxes)||boxes.length>64||boxes.some(box=>typeof box.id!=='string'||box.id.length>160||!['selection','navigation','navigation-child','panel','rail','translation','agent','floating','tooltip'].includes(box.group)||!box.bounds||![box.bounds.x,box.bounds.y,box.bounds.width,box.bounds.height].every(Number.isFinite)||box.bounds.width<=0||box.bounds.height<=0||box.bounds.width>4000||box.bounds.height>3000))throw new Error('INVALID_GEOMETRY');
      const origin=this.bounds(entry),zoom=entry.view.webContents.getZoomFactor();
      owner.webContents.send(this.channel,{action:'floating-hitboxes',sourceId:entry.view.webContents.id,viewId:entry.state.viewId,boxes:entry.state.visible?boxes.map(box=>({...box,bounds:{x:origin.x+box.bounds.x*zoom,y:origin.y+box.bounds.y*zoom,width:box.bounds.width*zoom,height:box.bounds.height*zoom}})):[]});return {};
    }
    if (args.action === 'geometry') {
      if(entry.tooltipPending)return {};
      const geometry = args.capsuleBounds as Rect | undefined;
      const result = this.route === '/ai-result-toolbar';
      if (!geometry || ![geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite) || geometry.width <= 0 || geometry.width > (result ? 800 : 2600) || geometry.height <= 0 || geometry.height > (result ? 620 : 160) || Math.abs(geometry.x) > 3000 || Math.abs(geometry.y) > 300) throw new Error('INVALID_GEOMETRY');
      if (JSON.stringify(entry.capsuleBounds) !== JSON.stringify(geometry)) { entry.capsuleBounds = { ...geometry }; entry.geometryRevision++; if (this.route === '/agent-toolbar') this.setBounds(owner, entry); this.sampleBackdrop(owner, entry); }
      this.syncNavigationShape(entry);
      if(this.route==='/web-toolbar'&&entry.state.visible){const host=this.bounds(entry),zoom=entry.view.webContents.getZoomFactor();owner.webContents.send(this.channel,{action:'geometry',viewId:entry.state.viewId,bounds:{x:host.x+geometry.x*zoom,y:host.y+geometry.y*zoom,width:geometry.width*zoom,height:geometry.height*zoom}});}
      return {};
    }
    owner.webContents.send(this.channel, { ...args, viewId: entry.state.viewId });
    return {};
  }
  update(owner: BrowserWindow, state: Record<string, unknown>) {
    if(owner.isDestroyed())return;
    let entry = this.entries.get(owner);
    if(entry?.view.webContents.isDestroyed()){
      entry.dispose?.();entry=undefined;
    }
    if(this.route==='/selection-toolbar'&&state.geometryOnly===true){
      // Motion carries no snapshot/model/settings body. A delayed sample from
      // an obsolete selection cannot reposition its replacement popup.
      const selected=entry?.state.selection as {snapshot?:{id?:string}}|undefined,b=state.bounds as Rect|undefined;
      if(!entry?.state.visible||state.viewId!==entry.state.viewId||state.snapshotId!==selected?.snapshot?.id||!b||![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<1||b.height<1||b.width>2600||b.height>800)return;
      const previous=this.bounds(entry),zoom=entry.view.webContents.getZoomFactor(),sample=entry.state.backdropSample as {origin?:{x:number;y:number}}|undefined;
      const translated=sample?.origin?{...sample,origin:{x:sample.origin.x+(previous.x-b.x)/zoom,y:sample.origin.y+(previous.y-b.y)/zoom}}:sample;
      entry.state={...entry.state,bounds:{...b},backdropSample:translated};
      this.syncHost(owner,entry);this.setBounds(owner,entry);
      if(translated)this.sendBackdrop(entry,undefined,translated,false);
      this.syncFrameSubscription(owner,entry);this.sampleBackdrop(owner,entry);return;
    }
    const visible=typeof state.viewId==='string'&&!!state.viewId&&!!state.visible;
    if(!visible&&entry)owner.webContents.send(this.channel,{action:'floating-hitboxes',sourceId:entry.view.webContents.id,viewId:entry.state.viewId,boxes:[]});
    if(!entry&&!visible){
      const target=this.deferred.get(owner);
      if(typeof state.viewId==='string'&&state.viewId)this.deferred.set(owner,{viewId:state.viewId,...(target?.viewId===state.viewId&&target.focusRequested?{focusRequested:true}:{})});
      else this.deferred.delete(owner);
      return;
    }
    const pending=this.deferred.get(owner),focusRequested=pending?.viewId===state.viewId&&pending?.focusRequested;
    if(visible||pending?.viewId!==state.viewId)this.deferred.delete(owner);
    if (!entry) {
      const view = new WebContentsView({ webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      view.setBackgroundColor('#00000000'); view.setVisible(false);
      entry = { view, state, geometryRevision: 0, cache: new NativeBackdropCache(), stats: backdropStatistics() }; this.entries.set(owner, entry);
      owner.contentView.addChildView(view);
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', event => event.preventDefault());
      const created = entry;
      view.webContents.once('did-finish-load',()=>{created.ready=true;this.focusReady(owner,created);});
      void view.webContents.loadURL(this.url() + '#' + this.route);
      // Live presentation frames drive updates. The watchdog also catches a
      // terminal dirty frame dropped by the compositor subscription's 30Hz cap.
      if (this.route === '/web-toolbar') { created.timer = setInterval(() => { this.syncFrameSubscription(owner, created); this.sampleBackdrop(owner, created, true); }, 400); created.timer.unref(); }
      const suspend=()=>this.clearFrameSubscription(created);
      owner.on('minimize', suspend);
      owner.on('hide', suspend);
      const resume = () => { this.syncFrameSubscription(owner, created); this.sampleBackdrop(owner, created, true); };
      owner.on('restore', resume);
      owner.on('show', resume);
      let disposed=false;
      created.dispose=()=>{
        if(disposed)return;disposed=true;
        owner.removeListener('minimize',suspend);owner.removeListener('hide',suspend);owner.removeListener('restore',resume);owner.removeListener('show',resume);owner.removeListener('closed',created.dispose!);
        this.clearFrameSubscription(created);clearInterval(created.timer);clearTimeout(created.sampleTimer);clearTimeout(created.exitTimer);clearTimeout(created.tooltipTimer);created.tooltipClose?.(this.tooltipReply(created));
        if(this.entries.get(owner)===created)this.entries.delete(owner);
        if(created.overlay&&!created.overlay.isDestroyed()){created.overlay.hide();created.overlay.close();}
        else if(!owner.isDestroyed())owner.contentView.removeChildView(view);
        if(!view.webContents.isDestroyed())view.webContents.close();
      };
      owner.once('closed',created.dispose);
    }
    const previous=entry.state;
    if(!visible||previous.viewId!==state.viewId)entry.focusViewId=undefined;
    const wasExiting=!!entry.exitTimer;
    if(visible){clearTimeout(entry.exitTimer);entry.exitTimer=undefined;}
    const mode=((state.settings ?? previous.settings) as any)?.values?.['appearance.motion'];
    const duration=this.route==='/selection-toolbar'?Math.min(180,motionDurationForMode(SELECTION_POPOVER_MOTION_BASE_MS,resolveMotionMode(mode))):this.route==='/agent-toolbar'||this.route==='/ai-result-toolbar'?Math.max(0,Math.min(650,Number(state.hideDurationMs ?? motionDurationForMode(this.route==='/ai-result-toolbar'?AI_POPOVER_MOTION_BASE_MS:200,resolveMotionMode(mode))))):navigationExitDuration(state.hideDurationMs,previous.hideDurationMs);
    const retainedExit=(this.route==='/ai-result-toolbar'||this.route==='/web-toolbar')&&wasExiting&&state.viewId===previous.viewId?retainedSurfaceExit(duration,previous.hideDurationMs):undefined;
    const animate=!visible&&!!previous.visible&&!!(state.animate||(state.viewId&&state.viewId===previous.viewId));
    if (!state.visible || state.viewId !== entry.state.viewId || (entry.tooltipLayout && JSON.stringify(previous.bounds)!==JSON.stringify(state.bounds))) { clearTimeout(entry.tooltipTimer);entry.panel = false; entry.panelBounds = undefined; entry.tooltip = false;entry.tooltipLayout=undefined;entry.tooltipPending=false;entry.tooltipTicket=(entry.tooltipTicket??0)+1;entry.tooltipClose?.(this.tooltipReply(entry));entry.tooltipClose=undefined; }
    if (state.viewId !== entry.state.viewId) { this.clearFrameSubscription(entry); entry.capsuleBounds = undefined; entry.geometryRevision++; entry.cache.clear(); }
    const agentGeometryChange = this.route === '/agent-toolbar' && (previous.kind !== state.kind || previous.status !== state.status || previous.target !== state.target);
    if (agentGeometryChange) { entry.capsuleBounds = undefined; entry.geometryRevision++; }
    const sameSample = !agentGeometryChange && previous.viewId === state.viewId && previous.address === state.address && JSON.stringify(previous.bounds) === JSON.stringify(state.bounds);
    entry.state = visible ? { ...(sameSample ? { backdropImage: previous.backdropImage, backdropSample: previous.backdropSample } : {}), ...state } : { ...previous, ...state, visible: false };
    if((this.route==='/ai-result-toolbar'||this.route==='/web-toolbar')&&!visible)entry.state.hideDurationMs=duration;
    // A bottom operation surface exists only for its short visible operation.
    // It has no permanent idle sampling loop; paused/stopped labels also expire.
    if (this.route === '/agent-toolbar' || this.route === '/ai-result-toolbar') {
      if (visible && !entry.timer) { entry.timer = setInterval(() => { this.syncFrameSubscription(owner, entry!); this.sampleBackdrop(owner, entry!, true); }, 400); entry.timer.unref(); }
      if (!visible) { clearInterval(entry.timer); entry.timer = undefined; }
    }
    this.syncHost(owner,entry);
    if (state.bounds) {
      this.setBounds(owner, entry);
    }
    if(!entry.overlay)owner.contentView.addChildView(entry.view);
    if(visible){entry.view.setVisible(true);this.showOverlay(owner,entry);}
    else if(wasExiting&&(state.animate||state.viewId===previous.viewId)&&(!retainedExit||retainedExit==='keep')){/* Keep the existing exit during layout updates. */}
    else if((animate||retainedExit==='restart')&&duration){clearTimeout(entry.exitTimer);const current=entry;entry.exitTimer=setTimeout(()=>{current.exitTimer=undefined;if(!current.view.webContents.isDestroyed())this.hide(owner,current);},duration);}
    else {clearTimeout(entry.exitTimer);entry.exitTimer=undefined;this.hide(owner,entry);}
    this.sendState(entry);
    this.syncFrameSubscription(owner, entry);
    this.sampleBackdrop(owner, entry);
    if(visible&&focusRequested)this.focus(owner);
  }
  private hide(owner: BrowserWindow, entry: ToolbarEntry) {
    this.clearFrameSubscription(entry);
    clearTimeout(entry.sampleTimer); entry.sampleTimer = undefined; entry.pending = false;
    const focused=entry.view.webContents.isFocused();entry.view.setVisible(false);
    if(entry.overlay&&!entry.overlay.isDestroyed())entry.overlay.hide();
    if(focused&&!owner.isDestroyed()&&owner.isFocused()){
      const page=owner.contentView.children.find(v=>v instanceof WebContentsView&&v!==entry.view&&v.getVisible()&&!(v as WebContentsView).webContents.getURL().includes('#/')) as WebContentsView|undefined;
      (page?.webContents??owner.webContents).focus();
    }
  }
  private hasBackdrop() { return this.route === '/web-toolbar' || this.route === '/selection-toolbar' || this.route === '/agent-toolbar' || this.route === '/ai-result-toolbar'; }
  private tooltipReply(entry: ToolbarEntry): TooltipReply { return {ticket:entry.tooltipTicket??0,offsetY:entry.tooltipLayout?.offsetY??0,placement:entry.tooltipLayout?.placement,viewId:entry.state.viewId}; }
  private resizeTooltip(owner:BrowserWindow,entry:ToolbarEntry){
    if(owner.isDestroyed()||entry.view.webContents.isDestroyed())return;
    const before=this.bounds(entry),zoom=entry.view.webContents.getZoomFactor();entry.tooltipTicket=(entry.tooltipTicket??0)+1;entry.tooltipPending=true;
    this.setBounds(owner,entry);const after=this.bounds(entry),shift=(before.y-after.y)/zoom;
    if(entry.capsuleBounds&&shift){entry.capsuleBounds={...entry.capsuleBounds,y:entry.capsuleBounds.y+shift};entry.geometryRevision++;}
    this.syncNavigationShape(entry);
    const sample=entry.state.backdropSample as {origin:{x:number;y:number};capsuleBounds:Rect;geometryRevision:number}|undefined;
    if(sample&&shift){entry.state={...entry.state,backdropSample:{...sample,origin:{...sample.origin,y:sample.origin.y+shift},capsuleBounds:{...sample.capsuleBounds,y:sample.capsuleBounds.y+shift},geometryRevision:entry.geometryRevision}};this.sendBackdrop(entry,undefined,entry.state.backdropSample,false);}
    this.sendState(entry);
  }
  private normalBounds(owner: BrowserWindow, entry: ToolbarEntry): Rect {
    const b = entry.state.bounds as Rect | undefined; if (!b) return this.bounds(entry);
    const agent = this.route === '/agent-toolbar', normalHeight = Math.max(1, Math.round(b.height));
    let width = agent && entry.capsuleBounds ? Math.min(Math.round(b.width), Math.ceil(entry.capsuleBounds.width) + 2 * AGENT_OPERATION_METRICS.shadowGutter) : Math.max(1, Math.round(b.width));
    const selectionPanel=this.route==='/selection-toolbar'&&entry.panel,available=owner.getContentBounds();
    let height = entry.panel ? 255 : normalHeight;
    if(selectionPanel){width=Math.min(available.width,Math.max(width,336,Math.ceil((entry.panelBounds?.x??8)+(entry.panelBounds?.width??320)+8)));height=Math.min(available.height,Math.max(normalHeight,Math.ceil((entry.panelBounds?.y??62)+(entry.panelBounds?.height??185)+8)));}
    const x=Math.round(b.x+(agent?(b.width-width)/2:0));
    const next = { x:selectionPanel?Math.max(0,Math.min(x,available.width-width)):x, y: Math.max(0, Math.min(Math.round(b.y), available.height - height)), width, height };
    return next;
  }
  private setBounds(owner:BrowserWindow,entry:ToolbarEntry){
    if(!entry.state.bounds)return;const agent=this.route==='/agent-toolbar',next=entry.tooltipLayout?.bounds??this.normalBounds(owner,entry),width=next.width;
    if (agent && entry.capsuleBounds && this.bounds(entry).width !== width) { entry.capsuleBounds = { ...entry.capsuleBounds, x: AGENT_OPERATION_METRICS.shadowGutter }; entry.geometryRevision++; }
    if (['x', 'y', 'width', 'height'].some(key => this.bounds(entry)[key as keyof Rect] !== next[key as keyof Rect])) {
      if (agent && entry.state.backdropSample && !entry.tooltipPending) { entry.cache.clear(); entry.state = { ...entry.state, backdropImage: undefined, backdropSample: undefined }; this.sendBackdrop(entry, undefined, undefined); }
      if(entry.overlay&&!entry.overlay.isDestroyed()){const p=owner.getContentBounds();entry.rootBounds=next;entry.overlay.setBounds({x:p.x+next.x,y:p.y+next.y,width:next.width,height:next.height});entry.view.setBounds({x:0,y:0,width:next.width,height:next.height});}
      else entry.view.setBounds(next);
    }
    this.syncNavigationShape(entry);
  }
  private send(entry: ToolbarEntry, payload: Record<string, unknown>) {
    const { backdropImage, ...metadata } = payload;
    entry.stats.sentFrames++; entry.stats.sentBytes += (typeof backdropImage === 'string' ? backdropImage.length : 0) + Buffer.byteLength(JSON.stringify(metadata));
    if (typeof backdropImage === 'string') { entry.stats.backdropImageFrames++; entry.stats.backdropBytes += Buffer.byteLength(backdropImage); }
    entry.view.webContents.send(this.channel, payload);
  }
  private sendState(entry: ToolbarEntry) {
    if (!entry.backdropPatches) { this.send(entry, {...entry.state,tooltipOffsetY:entry.tooltipLayout?.offsetY??0}); return; }
    const { backdropImage: _image, backdropSample: _sample, ...state } = entry.state;
    this.send(entry, { ...state, tooltipOffsetY:entry.tooltipLayout?.offsetY??0, action: 'state', ...(!entry.state.backdropSample || typeof entry.state.backdropImage !== 'string' ? { backdropImage: undefined, backdropSample: undefined } : {}) });
  }
  private sendBackdrop(entry: ToolbarEntry, image: string | undefined, sample: unknown, changed = true) {
    if (!entry.backdropPatches) { this.send(entry, entry.state); return; }
    this.send(entry, { action: 'backdrop', viewId: entry.state.viewId, backdropSample: sample, ...(changed ? { backdropImage: image } : {}) });
  }
  private clearFrameSubscription(entry: ToolbarEntry) {
    entry.unsubscribeFrame?.(); entry.unsubscribeFrame = undefined; entry.frameSource = undefined;
    entry.frameSignature = undefined; entry.frameAt = undefined;
  }
  private syncFrameSubscription(owner: BrowserWindow, entry: ToolbarEntry) {
    const values = (entry.state.settings as any)?.values;
    if (!this.hasBackdrop() || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized() || entry.view.webContents.isDestroyed() || (!entry.state.visible && (!entry.exitTimer || this.route === '/ai-result-toolbar')) || values?.['appearance.glass'] === 'off' || values?.['appearance.reduceTransparency'] || values?.['appearance.highContrast']) { this.clearFrameSubscription(entry); return; }
    const source = this.sourceFor?.(String(entry.state.viewId));
    // Source readback briefly returns undefined. Do not restart subscriptions
    // on every scroll hint; callbacks still require a current capture request.
    if (!source) { if (entry.frameSource?.isDestroyed()) this.clearFrameSubscription(entry); return; }
    if (entry.frameSource === source.view.webContents && entry.unsubscribeFrame) return;
    this.clearFrameSubscription(entry); entry.frameSource = source.view.webContents;
    try { entry.unsubscribeFrame = backdropFrames.subscribe(entry.frameSource, (image, presentedAt) => {
      entry.stats.framePresentations++;
      if (!this.canSample(owner, entry) || presentedAt - (entry.frameAt ?? -Infinity) < 16) return;
      const request = this.captureRequest(owner, entry); if (!request || request.page.webContents !== entry.frameSource) return;
      entry.frameAt = presentedAt;
      if (this.acceptFrame(owner, entry, image, presentedAt, request)) {
        entry.frameSignature = this.frameSourceSignature(request);
        // A fresh presentation satisfies ordinary source/geometry hints. Keep
        // the watchdog's explicit screenshot request for the dropped tail case.
        if (!entry.forceSample) { entry.pending = false; clearTimeout(entry.sampleTimer); entry.sampleTimer = undefined; }
      }
    }); } catch { entry.stats.frameErrors++; this.clearFrameSubscription(entry); }
  }
  private frameSourceSignature(request: CaptureRequest) {
    const { source, page, p, zoom, density } = request;
    return JSON.stringify([page.webContents.id, source.navigationId, source.layoutRevision, source.revision, source.scrollX, source.scrollY, source.deviceScaleFactor, page.webContents.getZoomFactor(), p.width, p.height, zoom, density]);
  }
  private acceptFrame(owner: BrowserWindow, entry: ToolbarEntry, image: NativeImage, presentedAt: number, request: CaptureRequest): boolean {
    if (!this.canSample(owner, entry) || !request.frameAligned || image.isEmpty()) return false;
    // Electron 44's frame subscriber creates a 1x NativeImage containing
    // physical pixels. Page zoom is separate from the window display density.
    const density = request.density;
    const size = image.getSize();
    if (image.getScaleFactors().length !== 1 || image.getScaleFactors()[0] !== 1 || Math.abs(size.width - Math.round(request.p.width * density)) > 1 || Math.abs(size.height - Math.round(request.p.height * density)) > 1) { entry.stats.frameErrors++; return false; }
    const crop = physicalFrameCrop(request.capture, density);
    if (!crop || crop.x + crop.width > size.width || crop.y + crop.height > size.height) { entry.stats.frameErrors++; return false; }
    try {
      const started = performance.now(), cropped = image.crop(crop); entry.stats.cropMs += performance.now() - started; entry.stats.frameCrops++;
      const bitmapAt = performance.now(), bitmap = cropped.toBitmap(); entry.stats.bitmapMs += performance.now() - bitmapAt;
      const accepted = entry.cache.accept(request.key, request.shape, bitmap, () => {
        const encodeAt = performance.now(), png = cropped.toPNG(); entry.stats.encodeMs += performance.now() - encodeAt; entry.stats.pngEncodes++;
        return { image: 'data:image/png;base64,' + png.toString('base64'), pixelSize: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } };
      }, presentedAt);
      if (accepted.reusedEncoding) entry.stats.pngReuses++;
      entry.pixelAt = presentedAt; entry.acceptedFrames = (entry.acceptedFrames ?? 0) + 1; this.publishBackdrop(entry, request, accepted.pixels, true); return true;
    } catch { entry.stats.frameErrors++; return false; }
  }
  private sampleBackdrop(owner: BrowserWindow, entry: ToolbarEntry, force = false) {
    if (!this.canSample(owner, entry)) return;
    const request = this.captureRequest(owner, entry), frame = entry.frameSource && backdropFrames.peek(entry.frameSource.id);
    if (!force && request && frame && entry.frameSignature === this.frameSourceSignature(request) && frame.presentedAt >= (entry.pixelAt ?? 0)) {
      entry.stats.frameReuses++; if (this.acceptFrame(owner, entry, frame.image, frame.presentedAt, request)) return;
    }
    entry.pending = true;
    entry.forceSample ||= force;
    if (entry.sampling || entry.sampleTimer) return;
    // Give an active compositor one presentation before taking another copy.
    // If subscription delivery stalls, the bounded screenshot fallback runs.
    const wait = !force && entry.unsubscribeFrame ? 100 : Math.max(0, 32 - (performance.now() - (entry.sampledAt ?? -Infinity)));
    if (wait > 0) { entry.sampleTimer = setTimeout(() => { entry.sampleTimer = undefined; this.captureLatest(owner, entry); }, wait); return; }
    this.captureLatest(owner, entry);
  }
  private canSample(owner: BrowserWindow, entry: ToolbarEntry) {
    const values = (entry.state.settings as any)?.values;
    return this.hasBackdrop() && !entry.tooltipPending && (!!entry.state.visible || (!!entry.exitTimer && this.route !== '/ai-result-toolbar')) && !!entry.state.bounds && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized() && !entry.view.webContents.isDestroyed() && values?.['appearance.glass'] !== 'off' && !values?.['appearance.reduceTransparency'] && !values?.['appearance.highContrast'];
  }
  private captureLatest(owner: BrowserWindow, entry: ToolbarEntry) {
    if (!entry.pending || entry.sampling || !this.canSample(owner, entry)) return;
    entry.pending = false;
    const force = !!entry.forceSample; entry.forceSample = false;
    const request = this.captureRequest(owner, entry);
    if (!request) return;
    entry.sampledAt = performance.now();
    const cached = !force && entry.cache.reuse(request.key);
    if (cached) { entry.stats.sampleReuses++; this.publishBackdrop(entry, request, cached); return; }
    entry.sampling = true; entry.stats.captures++;
    const started = performance.now(), acceptedFrames = entry.acceptedFrames ?? 0;
    void request.page.webContents.capturePage(request.capture).then(image => {
      entry.stats.captureMs += performance.now() - started;
      const latest = this.captureRequest(owner, entry);
      // Geometry can move subpixel inside the same integer crop. Reuse its
      // pixels only when all source epochs, DPR/zoom and crop coordinates still
      // match; publish the latest actual origin/geometry, never stale metadata.
      if (!this.canSample(owner, entry) || !latest || latest.key !== request.key || image.isEmpty() || (entry.acceptedFrames ?? 0) !== acceptedFrames) { entry.stats.discarded++; return; }
      const bitmapStarted = performance.now(), bitmap = image.toBitmap(); entry.stats.bitmapMs += performance.now() - bitmapStarted;
      const accepted = entry.cache.accept(latest.key, latest.shape, bitmap, () => {
        const encodeStarted = performance.now(), png = image.toPNG(); entry.stats.encodeMs += performance.now() - encodeStarted; entry.stats.pngEncodes++;
        return { image: 'data:image/png;base64,' + png.toString('base64'), pixelSize: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } };
      }, Date.now());
      if (accepted.reusedEncoding) entry.stats.pngReuses++;
      entry.pixelAt = accepted.pixels.capturedAt;
      this.publishBackdrop(entry, latest, accepted.pixels, true);
    }).catch(() => {}).finally(() => { entry.sampling = false; if (entry.pending) this.sampleBackdrop(owner, entry); });
  }
  private captureRequest(owner: BrowserWindow, entry: ToolbarEntry): CaptureRequest | undefined {
    const state = entry.state, b = this.bounds(entry), source = this.sourceFor?.(String(state.viewId));
    if (!source || source.view.webContents.isDestroyed() || source.view.webContents.isLoading()) return;
    const page = source.view, p = page.getBounds(), zoom = entry.view.webContents.getZoomFactor();
    const progress = Number(state.hideProgress ?? 0);
    // Geometry from the shared toolbar includes the current interpolated CSS
    // transform. The fallback preserves the old protocol until it reports.
    const result = this.route === '/ai-result-toolbar';
    const metrics = this.route === '/agent-toolbar' ? AGENT_OPERATION_METRICS : result ? { height: 330, shadowGutter: 16, captureOverscan: 27 } : NAVIGATION_METRICS;
    const tooltipOffset=entry.tooltipLayout?.offsetY??0;
    const capsule = entry.capsuleBounds ?? { x: metrics.shadowGutter, y: metrics.shadowGutter+tooltipOffset - (this.route === '/web-toolbar' ? NAVIGATION_METRICS.hideShift * progress : 0), width: b.width / zoom - 2 * metrics.shadowGutter, height: metrics.height };
    const geometryRevision = entry.geometryRevision;
    // Reserve the navigation's entire transform envelope once. Its actual
    // capsuleBounds/origin still update throughout the animation, but moving
    // the UI alone does not turn every RAF geometry report into a screenshot.
    const captureTop = this.route === '/web-toolbar' ? metrics.shadowGutter+tooltipOffset - NAVIGATION_METRICS.hideShift : capsule.y;
    const captureBottom = this.route === '/selection-toolbar' && entry.panel ? b.height/zoom : this.route === '/web-toolbar' ? metrics.shadowGutter+tooltipOffset + capsule.height : capsule.y + capsule.height;
    const left = Math.max(0, Math.floor(b.x - p.x + (capsule.x - metrics.captureOverscan) * zoom));
    const top = Math.max(0, Math.floor(b.y - p.y + (captureTop - metrics.captureOverscan) * zoom));
    const panelRight=this.route==='/selection-toolbar'&&entry.panel?(entry.panelBounds?.x??8)+(entry.panelBounds?.width??320):0;
    const right = Math.min(p.width, Math.ceil(b.x - p.x + (Math.max(capsule.x + capsule.width,panelRight) + metrics.captureOverscan) * zoom));
    const bottom = Math.min(p.height, Math.ceil(b.y - p.y + (captureBottom + metrics.captureOverscan) * zoom));
    const requestedCapture = { x: left, y: top, width: right - left, height: bottom - top };
    const density = screen.getDisplayMatching(owner.getBounds()).scaleFactor;
    // Both compositor crops and the screenshot fallback use this actual grid
    // rectangle. Fractional physical edges otherwise trigger resampling in
    // capturePage, and cannot truthfully share the original ROI metadata.
    const aligned = alignFrameCapture(requestedCapture, p, density), capture = aligned ?? requestedCapture;
    if (capture.width <= 0 || capture.height <= 0 || capture.width > (result ? 900 : 3000) || capture.height > (result ? 720 : entry.panel ? 600 : 300)) return;
    const shape = JSON.stringify([capture.width, capture.height, source.deviceScaleFactor, page.webContents.getZoomFactor(), zoom, density]);
    const key = JSON.stringify([state.viewId, state.address, page.webContents.id, source.navigationId, source.layoutRevision, source.revision, source.scrollX, source.scrollY, p.width, p.height, capture.x, capture.y, shape]);
    return { state, source, page, b, p, zoom, density, frameAligned: !!aligned, capsule, capture, geometryRevision, key, shape };
  }
  private publishBackdrop(entry: ToolbarEntry, request: CaptureRequest, pixels: BackdropPixels, silentUnchanged = false) {
      const { source, page, b, p, zoom, capsule, capture, geometryRevision } = request, pixelSize = pixels.pixelSize;
      const sequence = (entry.sequence ?? 0) + 1; entry.sequence = sequence;
      const cssSize = { width: capture.width / zoom, height: capture.height / zoom };
      const backdropSample = {
        sequence, capturedAt: pixels.capturedAt, sourceContentsId: page.webContents.id, navigationId: source.navigationId, layoutRevision: source.layoutRevision, sourceRevision: source.revision,
        scrollX: source.scrollX, scrollY: source.scrollY, geometryRevision, capsuleBounds: capsule,
        origin: { x: (p.x + capture.x - b.x) / zoom, y: (p.y + capture.y - b.y) / zoom }, cssSize, pixelSize,
        density: { x: pixelSize.width / cssSize.width, y: pixelSize.height / cssSize.height }, captureBounds: capture,
      };
      const previous = entry.state.backdropSample as typeof backdropSample | undefined;
      const changed = entry.state.backdropImage !== pixels.image;
      const sameGeometry = previous && previous.sourceContentsId === backdropSample.sourceContentsId && previous.navigationId === backdropSample.navigationId && previous.layoutRevision === backdropSample.layoutRevision && previous.sourceRevision === backdropSample.sourceRevision && previous.scrollX === backdropSample.scrollX && previous.scrollY === backdropSample.scrollY && previous.geometryRevision === backdropSample.geometryRevision && JSON.stringify(previous.captureBounds) === JSON.stringify(capture) && JSON.stringify(previous.origin) === JSON.stringify(backdropSample.origin) && JSON.stringify(previous.capsuleBounds) === JSON.stringify(capsule);
      entry.state = { ...entry.state, backdropImage: pixels.image, backdropSample };
      if (silentUnchanged && !changed && sameGeometry) return;
      // Only a bounded current-page image crosses into the trusted toolbar.
      this.sendBackdrop(entry, pixels.image, backdropSample, changed);
  }
}
