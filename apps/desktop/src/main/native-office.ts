import { BrowserWindow, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { NativeOfficeRuntime } from '../../../../packages/office-runtime/src/index';
import type { NativeOfficeAppearance } from '../../../../packages/office-runtime/src/appearance';
import type { NativeOfficeDriver, NativeOfficeState, NativeOfficeFormat, NativeOfficeNavigateTarget, NativeOfficeExportFormat, Rect, NativeOfficeQuery, NativeOfficeExecuteRequest, NativeOfficeSnapshotReuse, BrowserAction } from '../../../../packages/contracts/src/index';
import { normalizeViewZoom, type ViewerCore } from '../../../../packages/document-core/src/index';
import type { NativeBackdropSource } from './web-toolbar';
import { OFFICE_SURFACE_METHODS, isOfficeSurfaceState, type OfficeSurfaceState } from '../../../../packages/contracts/src/office-surface';
import { validateOfficeSurfaceRequest } from '../../../../packages/office-runtime/src/surface-protocol';
import { ViewerError } from '../../../../packages/contracts/src/index';
import { OfficeDisplayLeases, withdrawnOfficeDisplayState, type OfficeDisplayTicket } from './office-display-leases';

type Layout = { owner: BrowserWindow; bounds: Rect; visible: boolean; displayGeneration?: number; surfaceLayoutRevision?: number };
type HostedView = { sessionId: string; state?: NativeOfficeState; layout?: Layout; firstTileAt?: number; nativeTileSource?: { sessionId: string; engineEpoch: string } };
type ObservationKeys = { receipt: object; source: NativeOfficeState; entry: object; layout: Layout; owner: BrowserWindow; display: OfficeDisplayTicket<BrowserWindow>; focused: boolean; zoomIntent?: object; publication?: string; overlay?: string };
/** Only the trusted main process translates document views into native HWNDs. */
export class NativeOfficeHost implements NativeOfficeDriver {
  readonly runtime: NativeOfficeRuntime;
  private documents = new Map<string, string>();
  private views = new Map<string, HostedView>();
  private layouts = new Map<string, Layout>();
  private displays = new OfficeDisplayLeases<BrowserWindow>();
  private polling = false;
  private workerExited = false;
  private unavailableSessions = new Set<string>();
  private versions = new Map<string,{key:string;version:number}>();
  private settled = new Map<string,{revision:number;since:number}>();
  private published = new Map<string, { key: string; heartbeatAt: number }>();
  private overlayStates = new Map<string, string>();
  private observationKeys = new Map<string, ObservationKeys>();
  /** Latest user zoom per view. Layouts carrying an older zoom are stale. */
  private zoomIntents = new Map<string, { factor: number; sequence: number }>();
  private desired = new Map<BrowserWindow,{ticket:number;views:{viewId:string;bounds:Rect}[]}>();
  private queues = new Map<BrowserWindow,Promise<void>>();
  private watchers = new Map<BrowserWindow,()=>void>();
  private timer: ReturnType<typeof setInterval>;
  get exited() { return this.workerExited; }
  constructor(private core: ViewerCore, appRoot: string, dataDir: string, private windowFor: (viewId: string) => BrowserWindow | undefined, private changed: (owner: BrowserWindow, viewId: string) => void, appearance?: NativeOfficeAppearance) {
    this.runtime = new NativeOfficeRuntime({ appRoot, dataDir, appearance, backend: 'kit' });
    this.runtime.on('surface', (event: any) => {
      const viewId = event.viewId ?? event.state?.viewId, entry = this.views.get(viewId), owner = entry?.layout?.owner;
      if (!entry || this.unavailableSessions.has(entry.sessionId) || !owner || owner.isDestroyed() || owner.webContents.isDestroyed() || (event.sessionId ?? event.state?.sessionId) !== entry.sessionId) return;
      if (event.action === 'office-surface-state' && isOfficeSurfaceState(event.state)) this.accept(event.state);
      else if (this.displayMounted(viewId)) owner.webContents.send('agentviewer:toolbar', { ...event, type: undefined });
    });
    this.runtime.on('changed', () => { void this.poll(); });
    this.runtime.on('selection', () => { void this.poll(); });
    this.runtime.on('viewport', () => { void this.poll(); });
    this.runtime.on('session-unavailable',(event:{sessionId?:string;code?:string})=>{
      if(!event.sessionId)return;
      this.unavailableSessions.add(event.sessionId);
      this.core.failNativeOfficeSession(event.sessionId,event.code??'NATIVE_SESSION_UNAVAILABLE');
      for(const [viewId,entry] of this.views)if(entry.sessionId===event.sessionId){
        this.observationKeys.delete(viewId);
        if(entry.state)entry.state={...entry.state,status:'failed',visible:false,nativeGeometry:false,visibleTextReady:false};
        if(entry.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,viewId);
      }
    });
    this.runtime.on('exit',()=>{this.workerExited=true;this.observationKeys.clear();for(const sessionId of this.documents.values())this.core.failNativeOfficeSession(sessionId);for(const [viewId,entry] of this.views){if(entry.state)entry.state={...entry.state,status:'failed',visible:false,nativeGeometry:false,visibleTextReady:false};if(entry.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,viewId);}});
    this.core.on('change',(event:{type:string;data:{sessionId?:string;viewId?:string;recovery?:boolean}})=>{
      if(event.type==='view.closed'&&event.data.viewId){this.displays.remove(event.data.viewId);this.zoomIntents.delete(event.data.viewId);this.observationKeys.delete(event.data.viewId);}
      if(event.type==='office.closed'&&event.data.recovery&&event.data.sessionId){
        const sessionId=event.data.sessionId;
        for(const [documentId,id] of this.documents)if(id===sessionId)this.documents.delete(documentId);
        for(const [viewId,entry] of this.views)if(entry.sessionId===sessionId){this.views.delete(viewId);this.layouts.delete(viewId);this.versions.delete(viewId);this.observationKeys.delete(viewId);if(entry.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,viewId);}
      }
      if(event.type==='view.closed'&&event.data.viewId&&this.workerExited){this.views.delete(event.data.viewId);this.layouts.delete(event.data.viewId);this.versions.delete(event.data.viewId);}
    });
    this.runtime.on('application-action',(event:{sessionId?:string;viewId?:string;action?:string})=>{
      const entry=event.viewId?this.views.get(event.viewId):undefined,owner=entry?.layout?.owner;
      if(!entry||entry.sessionId!==event.sessionId||!owner||owner.isDestroyed()||!this.displayVisible(event.viewId!)||!['save','save-as','open','new','close','quit'].includes(String(event.action)))return;
      owner.webContents.send('agentviewer:toolbar',{action:'native-'+event.action,viewId:event.viewId});
    });
    this.timer = setInterval(() => { void this.poll(); }, 450); this.timer.unref();
  }
  private hwnd(owner: BrowserWindow) { const handle = owner.getNativeWindowHandle(); return String(handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())); }
  private ownerViewport(owner: BrowserWindow) { const { width, height } = owner.getContentBounds(); return { width, height }; }
  private displayMounted(viewId: string) {
    const entry = this.views.get(viewId), layout = this.layouts.get(viewId), ticket = this.displays.current(viewId);
    if (!entry || !layout?.visible || layout.owner.isDestroyed() || !layout.owner.isVisible() || layout.owner.isMinimized()) return false;
    return !isOfficeSurfaceState(entry.state) || !!ticket && this.displays.active(ticket) && ticket.owner === layout.owner && layout.displayGeneration === ticket.generation;
  }
  private displayVisible(viewId: string) { const entry=this.views.get(viewId),ticket=this.displays.current(viewId);return this.displayMounted(viewId)&&(!isOfficeSurfaceState(entry?.state)||!!ticket&&this.displays.presented(ticket,entry.state)); }
  private privateDisplayState<T extends NativeOfficeState>(state:T,forceWithdrawn=false):T { return isOfficeSurfaceState(state)&&(forceWithdrawn||!this.displayMounted(state.viewId))?withdrawnOfficeDisplayState(state):state; }
  private displayState<T extends NativeOfficeState>(state: T, forceWithdrawn = false): T {
    if(this.unavailableSessions.has(state.sessionId))throw new ViewerError('NATIVE_SESSION_UNAVAILABLE','Office 模型的清理状态未能确认，已停止访问并保留恢复内容。');
    return isOfficeSurfaceState(state) && (forceWithdrawn || !this.displayVisible(state.viewId)) ? withdrawnOfficeDisplayState(state) : state;
  }
  private withdrawDisplay(ticket: OfficeDisplayTicket<BrowserWindow>) {
    const layout = this.layouts.get(ticket.viewId), entry = this.views.get(ticket.viewId);
    if (layout) this.layouts.set(ticket.viewId, { ...layout, visible: false });
    if (entry?.layout) entry.layout = { ...entry.layout, visible: false };
    this.published.delete(ticket.viewId); this.overlayStates.delete(ticket.viewId); this.observationKeys.delete(ticket.viewId);
    if (entry?.state) {
      entry.state = withdrawnOfficeDisplayState(entry.state); this.core.updateNativeOfficeState(entry.state);
      if (this.core.views.has(ticket.viewId)) {
        try { this.core.updateNativeOfficeContextForHost(entry.state); }
        catch (error) { if (!(error instanceof ViewerError) || !['NATIVE_SESSION_EXPIRED','STALE_NATIVE_QUERY','TARGET_NOT_FOUND'].includes(error.code)) throw error; }
      }
    }
    if (!ticket.owner.isDestroyed()) this.changed(ticket.owner, ticket.viewId);
    // A display release never starts or awaits the native core. If it already
    // exists, serialize hide behind earlier layout writes and before a remount.
    if (!entry || entry.state?.status === 'failed' || this.workerExited) return;
    void this.displays.serialize(ticket.viewId, async () => {
      if (!this.displays.matches(ticket) || this.views.get(ticket.viewId) !== entry || this.layouts.get(ticket.viewId)?.visible || ticket.owner.isDestroyed()) return;
      const bounds = entry.layout?.bounds ?? layout?.bounds; if (!bounds) return;
      const next = await this.runtime.layout(entry.sessionId, ticket.viewId, { ownerHwnd: this.hwnd(ticket.owner), ownerViewport: this.ownerViewport(ticket.owner), bounds, visible: false });
      if (this.displays.matches(ticket) && this.views.get(ticket.viewId) === entry) this.accept(next, ticket);
    }).catch(error => this.core.event('office.error', { viewId: ticket.viewId, error: String(error) }));
  }
  /** Synchronous display ownership ACK; no model load, close, detach or commit. */
  display(owner: BrowserWindow, raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ViewerError('INVALID_ARGUMENT', 'Office 显示请求无效。');
    const value = raw as Record<string, unknown>, { viewId, leaseId, action } = value;
    const keys=action==='presented'?['viewId','leaseId','action','sessionId','engineEpoch','engineRevision','layoutRevision','decodeMs']:['viewId','leaseId','action'];
    if (Object.keys(value).some(key => !keys.includes(key)) || typeof viewId !== 'string' || !viewId || viewId.length > 128 || typeof leaseId !== 'string' || !leaseId || leaseId.length > 128 || !['acquire','release','presented'].includes(String(action))) throw new ViewerError('INVALID_ARGUMENT', 'Office 显示身份无效。');
    const view = this.core.views.get(viewId), current = this.displays.current(viewId);
    if (action === 'release' && !view && !current) return { viewId, leaseId, generation: 0, active: false };
    if (action !== 'release' ? !view || this.windowFor(viewId) !== owner : current ? current.owner !== owner : !view || this.windowFor(viewId) !== owner) throw new ViewerError('AUTH_SCOPE_DENIED', 'Office 显示页面不属于当前窗口。');
    if (view && !['docx','pptx','xlsx'].includes(this.core.getDocument(view.documentId).info.format)) throw new ViewerError('AUTH_SCOPE_DENIED', '此页面不是 Office 文档。');
    this.watchOwner(owner);
    if (action === 'acquire') {
      const previous = this.displays.current(viewId), ticket = this.displays.acquire(owner, viewId, leaseId);
      if (previous !== ticket) { const entry = this.views.get(viewId); if (entry) entry.firstTileAt = undefined; this.withdrawDisplay(ticket); }
      return { viewId, leaseId, generation: ticket.generation, active: true, presented:this.displays.presented(ticket,this.views.get(viewId)?.state) };
    }
    if(action==='presented'){
      // Optional telemetry never grants authority and cannot reject a valid
      // presentation after a long session or an older renderer's counter.
      const decodeMs=typeof value.decodeMs==='number'&&Number.isFinite(value.decodeMs)&&value.decodeMs>=0&&value.decodeMs<=120000?value.decodeMs:undefined;
      if(typeof value.sessionId!=='string'||!value.sessionId||value.sessionId.length>128||typeof value.engineEpoch!=='string'||!value.engineEpoch||value.engineEpoch.length>128||!Number.isSafeInteger(value.engineRevision)||Number(value.engineRevision)<0||!Number.isSafeInteger(value.layoutRevision)||Number(value.layoutRevision)<=0)throw new ViewerError('INVALID_ARGUMENT','Office 画面确认版本无效。');
      const ticket=this.displays.require(owner,viewId,leaseId),entry=this.views.get(viewId),state=entry?.state,layout=this.layouts.get(viewId),metadata=view&&this.core.getDocument(view.documentId).info.nativeOffice;
      if(!isOfficeSurfaceState(state)||state.status!=='ready'||!state.visible||state.nativeGeometry!==true||!this.displayMounted(viewId)||entry?.nativeTileSource?.sessionId!==state.sessionId||entry.nativeTileSource.engineEpoch!==state.engineEpoch||layout?.surfaceLayoutRevision!==state.layoutRevision||state.documentId!==view?.documentId||state.sessionId!==value.sessionId||state.engineEpoch!==value.engineEpoch||state.engineRevision!==value.engineRevision||state.layoutRevision!==value.layoutRevision||metadata?.sessionId!==state.sessionId||metadata.engineEpoch!==state.engineEpoch||metadata.engineRevision!==state.engineRevision)throw new ViewerError('STALE_OFFICE_DISPLAY','Office 画面或实际布局已经变化，请重新呈现当前图块后确认。');
      this.displays.confirm(ticket,{sessionId:state.sessionId,engineEpoch:state.engineEpoch,engineRevision:state.engineRevision,layoutRevision:state.layoutRevision});
      entry.firstTileAt??=Date.now();
      this.runtime.recordOpenStage(state.sessionId,viewId,'renderer-decode',decodeMs);
      this.runtime.recordOpenStage(state.sessionId,viewId,'presented');
      this.accept(state,ticket);this.core.updateNativeOfficeContextForHost(state);
      // Semantic paragraph projection is useful after real pixels are shown,
      // but must never hold the first paint acknowledgement or the input gate.
      void this.displays.serialize(viewId,async()=>{
        if(!this.displays.active(ticket)||this.views.get(viewId)!==entry)return;
        await this.runtime.enableContextProjection(state.sessionId,viewId);
      }).catch(()=>this.runtime.emit('diagnostic',{code:'OFFICE_CONTEXT_PROJECTION_FAILED'}));
      return {viewId,leaseId,generation:ticket.generation,active:true,presented:true,sessionId:state.sessionId,engineEpoch:state.engineEpoch,engineRevision:state.engineRevision,layoutRevision:state.layoutRevision};
    }
    const result = this.displays.release(owner, viewId, leaseId);
    if (result.changed && result.ticket) this.withdrawDisplay(result.ticket);
    return { viewId, leaseId, generation: result.ticket?.generation ?? this.displays.current(viewId)?.generation ?? 0, active: false };
  }
  private layoutFor(viewId: string): Layout {
    const found = this.layouts.get(viewId); if (found) return found;
    const owner = this.windowFor(viewId); if (!owner || owner.isDestroyed()) throw new Error('原生文档所属窗口不可用。');
    const box = owner.getContentBounds(); return { owner, bounds: { x: 80, y: 64, width: Math.max(300, box.width - 160), height: Math.max(240, box.height - 80) }, visible: false };
  }
  /** Reuses only derived strings, never acceptance, Core validation, or native state. */
  private observationKeyRecord(source: NativeOfficeState, receipt?: object) {
    const viewId = source.viewId, entry = viewId ? this.views.get(viewId) : undefined, layout = viewId ? this.layouts.get(viewId) : undefined, display = viewId ? this.displays.current(viewId) : undefined;
    if (!viewId || !receipt || !Object.isFrozen(source) || entry?.state !== source || !layout || !display || !this.displayVisible(viewId) || entry.layout?.owner !== layout.owner) {
      if (viewId) this.observationKeys.delete(viewId);
      return;
    }
    const owner = layout.owner, focused = owner.isFocused(), zoomIntent = this.zoomIntents.get(viewId), previous = this.observationKeys.get(viewId);
    if (previous?.receipt === receipt && previous.source === source && previous.entry === entry && previous.layout === layout && previous.owner === owner && previous.display === display && previous.focused === focused && previous.zoomIntent === zoomIntent) return previous;
    const next: ObservationKeys = { receipt, source, entry, layout, owner, display, focused, zoomIntent };
    this.observationKeys.set(viewId, next); return next;
  }
  private currentController(state: NativeOfficeState, capturedEntry?: HostedView) {
    const view = state.viewId ? this.core.views.get(state.viewId) : undefined, entry = state.viewId ? this.views.get(state.viewId) : undefined;
    const metadata = this.core.documents.get(state.documentId)?.info.nativeOffice;
    return !!entry && (!capturedEntry || entry === capturedEntry) && entry.sessionId === state.sessionId && (!entry.state || entry.state.engineEpoch === state.engineEpoch) && view?.documentId === state.documentId && metadata?.sessionId === state.sessionId && metadata.engineEpoch === state.engineEpoch;
  }
  private accept(rawState: NativeOfficeState, capturedDisplay?: OfficeDisplayTicket<BrowserWindow>, forceWithdrawn=false, observationReceipt?: object, capturedEntry?: HostedView) {
    if(this.unavailableSessions.has(rawState.sessionId))throw new ViewerError('NATIVE_SESSION_UNAVAILABLE','Office 模型的清理状态未能确认，已停止访问并保留恢复内容。');
    if (!this.currentController(rawState, capturedEntry)) {
      // A completed native input still owns its real model receipt. It must
      // never overwrite a replacement controller or revive its old display.
      const state = withdrawnOfficeDisplayState(rawState), metadata = this.core.documents.get(rawState.documentId)?.info.nativeOffice;
      if (metadata?.sessionId === state.sessionId && metadata.engineEpoch === state.engineEpoch && state.engineRevision > metadata.engineRevision) this.core.updateNativeOfficeState(state);
      return state;
    }
    const retiredDisplay = forceWithdrawn || !!capturedDisplay && !this.displays.active(capturedDisplay);
    const entry = rawState.viewId ? this.views.get(rawState.viewId) : undefined; if (entry && !retiredDisplay) entry.state = this.privateDisplayState(rawState);
    const state = this.displayState(rawState, retiredDisplay);
    if (state.viewId && (!observationReceipt || retiredDisplay)) this.observationKeys.delete(state.viewId);
    this.core.updateNativeOfficeState(state);
    if(!retiredDisplay&&state.viewId&&state.visible&&state.focused&&state.actor==='human'&&this.displayVisible(state.viewId)&&entry?.layout?.owner.isFocused()&&this.core.views.has(state.viewId)&&this.core.activeViewId!==state.viewId)this.core.activate(state.viewId,'human');
    const zoom=(state as NativeOfficeState&{zoom?:number}).zoom,intent=state.viewId?this.zoomIntents.get(state.viewId):undefined;
    // A native read/layout issued before zoom() can settle after that intent.
    // Preserve its real geometry, but never publish its old scale as a new
    // human zoom: doing so would make every subsequent layout fail the intent
    // guard, and permanently leave automatic fit at the previous page size.
    if(!retiredDisplay&&state.viewId&&this.core.views.has(state.viewId)&&zoom&&Number.isFinite(zoom)&&zoom>=.25&&zoom<=4&&(!intent||Math.abs(zoom-intent.factor)<=.005)&&this.core.getView(state.viewId).zoom!==normalizeViewZoom(zoom))this.core.setViewZoom(state.viewId,zoom,'human');
    const owner=entry?.layout?.owner;
    if (!retiredDisplay && state.viewId && this.displayMounted(state.viewId) && owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) {
      const surface=this.privateDisplayState(rawState),cached=state===rawState&&surface===rawState?this.observationKeyRecord(rawState,observationReceipt):undefined,key=cached?(cached.publication??=JSON.stringify([state,surface])):JSON.stringify([state,surface]), previous=this.published.get(state.viewId), now=Date.now();
      if(previous?.key!==key)owner.webContents.send('agentviewer:toolbar',{action:'office-state',state});
      if(previous?.key!==key && isOfficeSurfaceState(surface)) owner.webContents.send('agentviewer:toolbar',{action:'office-surface-state',state:surface});
      if(!previous||now-previous.heartbeatAt>=900)owner.webContents.send('agentviewer:toolbar',{action:'office-state-heartbeat',viewId:state.viewId});
      this.published.set(state.viewId,{key,heartbeatAt:!previous||now-previous.heartbeatAt>=900?now:previous.heartbeatAt});
    }
    return state;
  }
  async setAppearance(appearance: NativeOfficeAppearance) { this.observationKeys.clear(); await this.runtime.setAppearance(appearance); this.versions.clear(); this.overlayStates.clear(); await this.poll(); }
  async open(request: {documentId:string;viewId:string;format:NativeOfficeFormat;bytes:Uint8Array;revision:number}) {
    const sessionId = this.documents.get(request.documentId) ?? randomUUID(), layout = this.layoutFor(request.viewId);
    // A slow import must never flash above a tab the user has already left.
    const state = await this.runtime.open({ ...request, sessionId, ownerHwnd: this.hwnd(layout.owner), ownerViewport: this.ownerViewport(layout.owner), bounds: layout.bounds, visible: false });
    const currentLayout = this.layouts.get(request.viewId) ?? { ...layout, visible: false };
    this.documents.set(request.documentId, sessionId); this.views.set(request.viewId, { sessionId, state, layout: currentLayout });
    return state;
  }
  async state(sessionId: string, viewId?: string) { const captured = viewId ? this.displays.current(viewId) : undefined, entry = viewId ? this.views.get(viewId) : undefined, state = await this.runtime.state(sessionId, viewId); return this.accept(state,captured,!!viewId&&this.displays.current(viewId)!==captured,undefined,entry); }
  async surfaceRequest(owner: BrowserWindow, method: string, raw: unknown) {
    const incoming = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const leaseId = incoming?.leaseId;
    if (leaseId !== undefined && (typeof leaseId !== 'string' || !leaseId || leaseId.length > 128)) throw new ViewerError('INVALID_ARGUMENT', 'Office 显示租约无效。');
    const payload = incoming ? Object.fromEntries(Object.entries(incoming).filter(([key]) => key !== 'leaseId')) : raw;
    const value = validateOfficeSurfaceRequest(method, payload) as any;
    const view = this.core.getView(value.viewId);
    if (this.windowFor(view.id) !== owner || !['docx','pptx','xlsx'].includes(this.core.getDocument(view.documentId).info.format)) throw new Error('AUTH_SCOPE_DENIED');
    const writesDisplay = [OFFICE_SURFACE_METHODS.layout, OFFICE_SURFACE_METHODS.input, OFFICE_SURFACE_METHODS.windowInput, OFFICE_SURFACE_METHODS.windowClose, OFFICE_SURFACE_METHODS.windowAction].includes(method as any);
    const capturedDisplay = leaseId !== undefined || writesDisplay ? this.displays.require(owner, view.id, leaseId) : undefined;
    const checkDisplay = () => { if (capturedDisplay && !this.displays.active(capturedDisplay)) throw new ViewerError('OFFICE_DISPLAY_EXPIRED', 'Office 页面显示目标已变化；操作不会自动重试。'); };
    let entry = this.views.get(view.id);
    if (!entry) { await this.core.ensureNativeOfficeBoundForHost(view.id); entry = this.views.get(view.id); }
    checkDisplay();
    if (!entry || entry.state?.status === 'failed') throw new Error('NATIVE_SESSION_EXPIRED');
    if (value.sessionId && (value.sessionId !== entry.sessionId || value.engineEpoch !== entry.state?.engineEpoch)) throw new Error('NATIVE_SESSION_EXPIRED');
    let result: any;
    if (method === OFFICE_SURFACE_METHODS.state) {
      // A DOM scroll (for example Home/End on the horizontal Office bar)
      // schedules a surface layout asynchronously.  Reading the state while
      // that layout is still queued can return the previous layoutRevision;
      // an immediate coordinate input then gets rejected as stale even though
      // the caller just read the state.  Join the same per-view write queue so
      // state is always observed after pending layout/hide writes settle.
      const checkEntry = () => { if (this.views.get(view.id) !== entry || !this.core.views.has(view.id)) throw new ViewerError('NATIVE_SESSION_EXPIRED', 'Office 页面编辑源已关闭或更换，请重新读取。'); };
      result = await this.displays.serialize(view.id, async () => {
        checkDisplay();
        checkEntry();
        const fresh = await this.runtime.state(entry!.sessionId, view.id);
        checkEntry();
        return fresh;
      });
      // A following queue task can settle before this await continuation.
      // Read-only replies must still target this exact controller at acceptance.
      checkEntry();
    }
    else if (method === OFFICE_SURFACE_METHODS.layout) {
      const b = value.boundsCss, content = owner.getContentBounds();
      if (b.x < 0 || b.y < 0 || b.width < 1 || b.height < 1) throw new Error('INVALID_NATIVE_LAYOUT');
      if(b.x+b.width>content.width+2||b.y+b.height>content.height+2)throw new ViewerError('OFFICE_VIEWPORT_CHANGED','Office 布局尚未匹配当前窗口，请重新测量视口。',{ownerViewport:{width:content.width,height:content.height},rendererZoom:owner.webContents.getZoomFactor?.()??1});
      const intent=this.zoomIntents.get(view.id);
      if(intent&&Math.abs(Number(value.zoom)-intent.factor)>.005)throw new ViewerError('STALE_OFFICE_SURFACE_LAYOUT','Office 布局使用了过期的缩放比例，未写入原生视图。');
      result = await this.displays.serialize(view.id, async () => {
        checkDisplay();
        if (this.views.get(view.id) !== entry) throw new Error('NATIVE_SESSION_EXPIRED');
        const layout:Layout = { owner, bounds: b, visible: value.visible, displayGeneration: capturedDisplay!.generation }; this.layouts.set(view.id, layout); entry.layout = layout;
        const painted=await this.runtime.surfaceLayout(entry.sessionId, value);layout.surfaceLayoutRevision=painted.layoutRevision;return painted;
      });
    } else if (method === OFFICE_SURFACE_METHODS.tiles) result = await this.runtime.surfaceTiles(entry.sessionId, value);
    else if (method === OFFICE_SURFACE_METHODS.input) {if(!this.displayVisible(view.id))throw new ViewerError('OFFICE_DISPLAY_NOT_PRESENTED','原生正文尚未呈现，不能使用预览画面的坐标输入。');result = await this.runtime.surfaceInput(entry.sessionId, value);this.runtime.recordOpenStage(entry.sessionId,view.id,'first-input-ack');}
    else if (method === OFFICE_SURFACE_METHODS.windowPaint) result = await this.runtime.surfaceWindowPaint(value);
    else if (method === OFFICE_SURFACE_METHODS.windowInput) {if(!this.displayVisible(view.id))throw new ViewerError('OFFICE_DISPLAY_NOT_PRESENTED','原生正文尚未呈现，不能操作其原生窗口。');result = await this.runtime.surfaceWindowInput(value);}
    else if (method === OFFICE_SURFACE_METHODS.windowClose) {if(!this.displayVisible(view.id))throw new ViewerError('OFFICE_DISPLAY_NOT_PRESENTED','原生正文尚未呈现，不能操作其原生窗口。');result = await this.runtime.surfaceWindowClose(value);}
    else if (method === OFFICE_SURFACE_METHODS.windowClipboard) result = await this.runtime.surfaceWindowClipboard(value);
    else if (method === OFFICE_SURFACE_METHODS.windowControls) result = await this.runtime.surfaceWindowControls(value);
    else if (method === OFFICE_SURFACE_METHODS.windowAction) {if(!this.displayVisible(view.id))throw new ViewerError('OFFICE_DISPLAY_NOT_PRESENTED','原生正文尚未呈现，不能操作其文档选项。');result = await this.runtime.surfaceWindowAction(value);}
    else throw new Error('UNKNOWN_OFFICE_SURFACE_METHOD');
    const rawState = result.state ?? result;
    let state = this.privateDisplayState(rawState, !!capturedDisplay && !this.displays.active(capturedDisplay));
    if (!isOfficeSurfaceState(state) || state.viewId !== view.id || state.documentId !== view.documentId || state.sessionId !== entry.sessionId) throw new Error('INVALID_OFFICE_SURFACE_REPLY');
    // An input already delivered to the native model retains its real revision
    // even when its former DOM owner left. Never publish/focus the retired UI.
    const retiredController = !this.currentController(state, entry);
    state=this.accept(state, capturedDisplay, retiredController, undefined, entry);
    const retiredDisplay = retiredController || !!capturedDisplay && !this.displays.active(capturedDisplay);
    if (retiredDisplay && [OFFICE_SURFACE_METHODS.input, OFFICE_SURFACE_METHODS.windowInput, OFFICE_SURFACE_METHODS.windowClose, OFFICE_SURFACE_METHODS.windowAction].includes(method as any)) return result.state ? { ...result, state, retiredDisplay: true } : { ...state, retiredDisplay: true };
    if (retiredController) throw new ViewerError('OFFICE_DISPLAY_EXPIRED', 'Office 页面编辑源已关闭或更换，请重新读取当前页面。');
    checkDisplay();
    if(method===OFFICE_SURFACE_METHODS.tiles&&result.tiles?.length&&this.displayMounted(view.id)){entry.nativeTileSource={sessionId:state.sessionId,engineEpoch:state.engineEpoch};entry.firstTileAt??=Date.now();this.runtime.recordOpenStage(entry.sessionId,view.id,'first-tiles-reply');}
    this.core.updateNativeOfficeContextForHost(this.displayState(state));
    // This authenticated renderer needs the mounted engine geometry in order
    // to paint its first tile. Public Core/SDK state remains withdrawn until
    // presented(), and native input is independently gated by displayVisible.
    // Returning that public projection here races the private surface push:
    // a same-version withdrawn reply can replace drawable state and leave the
    // renderer waiting for the 2500ms heartbeat deadline before it can paint.
    const rendererState = this.privateDisplayState(rawState);
    return result.state ? { ...result, state: rendererState } : rendererState;
  }
  async snapshot(sessionId:string,reuse?:NativeOfficeSnapshotReuse) { const result = await this.runtime.snapshot(sessionId,undefined,reuse); return { ...result, state: this.displayState(result.state) }; }
  commands(sessionId:string,viewId:string) { return this.runtime.commands(sessionId,viewId); }
  commandStatus(sessionId:string,viewId:string,commands:string[]) { return this.runtime.commandStatuses(sessionId,viewId,commands); }
  query(sessionId:string,viewId:string,target:NativeOfficeQuery) { return this.runtime.query(sessionId,viewId,target); }
  async inspect(sessionId:string,viewId:string,request:{target?:NativeOfficeQuery;commands?:string[]}) { const result=await this.runtime.inspect(sessionId,viewId,request); return {...result,state:this.displayState(result.state)}; }
  async execute(request:NativeOfficeExecuteRequest) { const result = await this.runtime.execute(request); return { ...result, state: this.displayState(result.state) }; }
  async zoom(sessionId:string,viewId:string,factor:number) {
    const normalized=normalizeViewZoom(factor),previous=this.zoomIntents.get(viewId);
    const intent={factor:normalized,sequence:(previous?.sequence??0)+1};this.zoomIntents.set(viewId,intent);
    try { return this.displayState(await this.runtime.zoom(sessionId,viewId,factor)); }
    catch(error) { if(this.zoomIntents.get(viewId)===intent)this.zoomIntents.delete(viewId); throw error; }
  }
  async input(request:{sessionId:string;viewId:string;expectedEngineEpoch:string;expectedEngineRevision:number;expectedLayoutRevision?:number;action:BrowserAction;idempotencyKey:string}) {
    if (!this.displayVisible(request.viewId)) throw new ViewerError('NATIVE_VIEW_HIDDEN', 'Office 页面已离开当前显示区域，请先显示目标页面。');
    const captured = this.displays.current(request.viewId), entry = this.views.get(request.viewId), result=await this.runtime.input(request), state=this.accept(this.displayState(result.state, !!captured && !this.displays.active(captured)), captured, false, undefined, entry);
    const owner=this.views.get(request.viewId)?.layout?.owner;if(owner&&!owner.isDestroyed())this.changed(owner,request.viewId);
    return { ...result, state };
  }
  async captureNative(sessionId:string,viewId:string,rect?:Rect) {if (!this.displayVisible(viewId)) throw new ViewerError('NATIVE_VIEW_HIDDEN', 'Office 页面当前不可见，不能提供当前显示区域截图。');const ticket=this.displays.current(viewId),result=await this.runtime.capture(sessionId,viewId,rect);if(!this.displayVisible(viewId)||this.displays.current(viewId)!==ticket)throw new ViewerError('NATIVE_VIEW_HIDDEN','截图期间 Office 显示目标已变化。');return result;}
  async navigate(request:{sessionId:string;viewId:string;target:NativeOfficeNavigateTarget;expectedEngineEpoch:string;expectedEngineRevision:number;expectedSelectionEpoch?:number;requestId:string}) {const result=await this.runtime.navigate(request);return {...result,state:this.displayState(result.state)};}
  async exportCopy(sessionId:string,request:{format:NativeOfficeExportFormat;expectedEngineEpoch:string;expectedEngineRevision:number}) {const result=await this.runtime.exportCopy(sessionId,request);return {...result,state:this.displayState(result.state)};}
  async detachView(sessionId:string,viewId:string) {
    const entry=this.views.get(viewId),layout=this.layouts.get(viewId);
    this.views.delete(viewId);this.layouts.delete(viewId);this.published.delete(viewId);this.overlayStates.delete(viewId);this.observationKeys.delete(viewId);
    if(entry?.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,viewId);
    try{if(!this.workerExited)await this.runtime.detachView(sessionId,viewId);}
    catch(error){if(entry){if(this.unavailableSessions.has(sessionId)&&entry.state)entry.state={...entry.state,status:'failed',visible:false,nativeGeometry:false,visibleTextReady:false};this.views.set(viewId,entry);}if(layout)this.layouts.set(viewId,layout);if(entry?.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,viewId);throw error;}
    this.versions.delete(viewId);
  }
  async undo(request:{sessionId:string;viewId:string;expectedEngineEpoch:string;expectedEngineRevision:number;undoToken:string}) { const result=await this.runtime.undo(request);return {...result,state:this.displayState(result.state)}; }
  ackSaved(sessionId:string,saved:{engineEpoch:string;engineRevision:number;hash:string}) { return this.runtime.ackSaved(sessionId,saved); }
  async close(sessionId:string) {
    const closing=[...this.views].filter(([,entry])=>entry.sessionId===sessionId);
    // Reparent trusted overlays before Windows destroys the dock's owned HWNDs.
    for(const [id] of closing){this.views.delete(id);this.published.delete(id);this.overlayStates.delete(id);this.observationKeys.delete(id);}
    for(const [id,entry] of closing)if(entry.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,id);
    try{if(!this.workerExited)await this.runtime.close(sessionId,{discard:true});}
    catch(error){for(const [id,entry] of closing){if(this.unavailableSessions.has(sessionId)&&entry.state)entry.state={...entry.state,status:'failed',visible:false,nativeGeometry:false,visibleTextReady:false};this.views.set(id,entry);if(entry.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,id);}throw error;}
    for(const [id,value] of this.documents)if(value===sessionId)this.documents.delete(id);
  }
  async layoutWindow(owner:BrowserWindow, requested:{viewId:string;bounds:Rect}[]) {
    const desired={ticket:(this.desired.get(owner)?.ticket??0)+1,views:requested.map(value=>({viewId:value.viewId,bounds:{...value.bounds}}))};
    this.desired.set(owner,desired);this.watchOwner(owner);
    const ids=new Set(requested.map(value=>value.viewId));for(const [viewId,layout] of this.layouts)if(layout.owner===owner&&!ids.has(viewId))layout.visible=false;
    for(const value of requested){if(this.windowFor(value.viewId)!==owner)throw new Error('AUTH_SCOPE_DENIED');this.layouts.set(value.viewId,{owner,bounds:{...value.bounds},visible:true});}
    const previous=this.queues.get(owner)??Promise.resolve();
    const next=previous.catch(()=>{}).then(async()=>{if(this.desired.get(owner)!==desired||owner.isDestroyed())return;await this.applyLayout(owner,desired);});
    this.queues.set(owner,next);void next.finally(()=>{if(this.queues.get(owner)===next)this.queues.delete(owner);}).catch(()=>{});return next;
  }
  private watchOwner(owner:BrowserWindow) {
    if(this.watchers.has(owner))return;
    const update=()=>{const desired=this.desired.get(owner);if(!owner.isDestroyed()&&desired)void this.layoutWindow(owner,desired.views).catch(error=>this.core.event('office.error',{error:String(error)}));};
    const events=['move','resize','show','hide','minimize','restore','maximize','unmaximize'] as const;
    const emitter=owner as unknown as EventEmitter;
    for(const event of events)emitter.on(event,update);
    const dispose=()=>{for(const ticket of this.displays.releaseOwner(owner))this.withdrawDisplay(ticket);for(const event of events)emitter.removeListener(event,update);this.watchers.delete(owner);this.desired.delete(owner);};this.watchers.set(owner,dispose);owner.once('closed',dispose);
  }
  private async applyLayout(owner:BrowserWindow,desired:{ticket:number;views:{viewId:string;bounds:Rect}[]}) {
    const requested=desired.views;
    const valid = new Map(requested.map(value => [value.viewId,value.bounds]));
    for (const [viewId,layout] of this.layouts) if (layout.owner === owner && !valid.has(viewId)) { layout.visible=false; const entry=this.views.get(viewId); if(entry&&entry.state?.status!=='failed') await this.runtime.layout(entry.sessionId,viewId,{ownerHwnd:this.hwnd(owner),ownerViewport:this.ownerViewport(owner),bounds:layout.bounds,visible:false}); }
    for (const [viewId,bounds] of valid) {
      const view=this.core.getView(viewId); if(this.windowFor(viewId)!==owner)throw new Error('AUTH_SCOPE_DENIED');
      const layout={owner,bounds,visible:true};this.layouts.set(viewId,layout);
      const entry=this.views.get(viewId);
      if(!entry) await this.core.openNativeOffice(viewId);
      const opened=this.views.get(viewId);if(!opened||opened.state?.status==='failed')continue;
      const latest=this.desired.get(owner),current=latest?.views.find(value=>value.viewId===viewId);
      layout.visible=!!current;
      opened.layout=this.layouts.get(viewId);
      const state=await this.runtime.layout(opened.sessionId,viewId,{ownerHwnd:this.hwnd(owner),ownerViewport:this.ownerViewport(owner),bounds:current?.bounds??bounds,visible:!!current&&owner.isVisible()&&!owner.isMinimized()});this.accept(state,undefined,false,undefined,opened);
      this.changed(owner,view.id);
    }
  }
  async closeOwner(owner:BrowserWindow) {
    const previous=this.desired.get(owner),resumeViews=previous?.views??[],hideTicket=(previous?.ticket??0)+1;
    await this.layoutWindow(owner,[]);
    try{
    const affected=[...this.views].filter(([,entry])=>entry.layout?.owner===owner);
    for(const [viewId,entry] of affected){if(!this.views.has(viewId))continue;const documentId=this.core.getView(viewId).documentId;
      if([...this.views].some(([other,candidate])=>other!==viewId&&candidate.sessionId===entry.sessionId&&candidate.layout?.owner!==owner)){await this.core.detachNativeOfficeView(viewId);}
      else await this.core.closeNativeOffice(documentId);
    }
    for(const [viewId,layout] of this.layouts)if(layout.owner===owner)this.layouts.delete(viewId);
    }catch(error){
      if(!owner.isDestroyed()){const latest=this.desired.get(owner);await this.layoutWindow(owner,latest?.ticket===hideTicket?resumeViews:latest?.views??resumeViews).catch(()=>{});}
      throw error;
    }
  }
  source(viewId:string) { const entry=this.views.get(viewId),layout=this.layouts.get(viewId);if(!entry?.state||entry.state.status==='failed'||!layout||!this.displayVisible(viewId))return; return {entry,layout}; }
  backdrop(viewId:string):NativeBackdropSource|undefined {const source=this.source(viewId);if(!source||isOfficeSurfaceState(source.entry.state))return;const {entry,layout}=source,state=entry.state!;
    const key=JSON.stringify([state.engineRevision,state.selectionEpoch,state.visibleText,state.viewport,layout.bounds]);let version=this.versions.get(viewId);if(version?.key!==key){version={key,version:(version?.version??0)+1};this.versions.set(viewId,version);}
    const revision=state.engineRevision,epoch=state.engineEpoch,sessionId=entry.sessionId;
    return {bounds:{...layout.bounds},navigationId:epoch+':'+sessionId+':'+viewId,layoutRevision:version!.version,revision,sourceId:state.nativePid??0,capture:async rect=>{const result=await this.capture(viewId,rect);if(result.metadata.engineEpoch!==epoch||result.metadata.engineRevision!==revision||result.metadata.sessionId!==sessionId){void this.poll();throw new Error('STALE_NATIVE_CAPTURE');}return {image:result.image,rect:result.metadata.rect};},attach:window=>this.overlayOwner(viewId,window)};
  }
  async capture(viewId:string,rect:Rect) {const entry=this.views.get(viewId);if(!entry)throw new Error('NATIVE_SESSION_EXPIRED');const result=await this.runtime.capture(entry.sessionId,viewId,rect);return {image:nativeImage.createFromBuffer(Buffer.from(result.data,'base64')),metadata:result};}
  async overlayOwner(viewId:string,window:BrowserWindow) {const entry=this.views.get(viewId);if(!entry)throw new Error('NATIVE_SESSION_EXPIRED'); await this.runtime.setOverlayOwner({sessionId:entry.sessionId,viewId,hwnd:this.hwnd(window)});}
  async poll() {
    if(this.polling)return;this.polling=true;
    try {for(const [viewId,entry] of this.views){const layout=this.layouts.get(viewId),capturedDisplay=this.displays.current(viewId);if(!layout||!this.displayVisible(viewId)||entry.state?.status==='failed'){this.observationKeys.delete(viewId);continue;}
      const observed=await this.runtime.observeStateForHost(entry.sessionId,viewId);
      // The confirmed immutable source reuses only its derived strings. Every
      // observation still accepts real state, checks display/Core identity,
      // publishes its heartbeat, and advances the idle recovery deadline.
      const current = (state: NativeOfficeState) => this.currentController(state,entry) && this.layouts.get(viewId)===layout && this.displayVisible(viewId) && this.displays.current(viewId)===capturedDisplay;
      if(!current(observed.state))continue;
      const state=this.accept(observed.state,capturedDisplay,false,observed.receipt,entry);if(!current(state))continue;
      const metadata=this.core.getDocument(state.documentId).info.nativeOffice;
      const firstDisplayReady=!isOfficeSurfaceState(state)||!!entry.firstTileAt&&state.visible&&state.nativeGeometry;
      if(metadata&&metadata.mirrorEngineRevision!==state.engineRevision&&firstDisplayReady){
        let idle=this.settled.get(state.documentId);
        if(idle?.revision!==state.engineRevision){idle={revision:state.engineRevision,since:Date.now()};this.settled.set(state.documentId,idle);}
        // Keep recovery/read models current after an idle interval. Never snapshot
        // each keystroke or commit an in-progress native cell editor implicitly.
        if(!state.pendingInput&&Date.now()-idle.since>=1200&&(!entry.firstTileAt||Date.now()-entry.firstTileAt>=1200))await this.core.synchronizeNativeDocumentForHost(state.documentId);
      }else this.settled.delete(state.documentId);
      // Recovery synchronization yields to the document queue. A close/reopen,
      // layout or newer selection may have replaced this sample while it ran.
      const latest=entry.state, latestMetadata=this.core.documents.get(state.documentId)?.info.nativeOffice;
      if(!current(state)||!latest||latest.engineRevision!==state.engineRevision||latest.selectionEpoch!==state.selectionEpoch||latest.viewport?.layoutRevision!==state.viewport?.layoutRevision||isOfficeSurfaceState(latest)&&isOfficeSurfaceState(state)&&(latest.layoutRevision!==state.layoutRevision||latest.eventSequence!==state.eventSequence)||latestMetadata?.engineRevision!==state.engineRevision)continue;
      try { this.core.updateNativeOfficeContextForHost(state); }
      catch(error) { if(error instanceof ViewerError&&['NATIVE_SESSION_EXPIRED','STALE_NATIVE_QUERY','TARGET_NOT_FOUND'].includes(error.code))continue;throw error; }
      const cached=this.observationKeyRecord(state,observed.receipt),key=cached?(cached.overlay??=JSON.stringify([state.engineEpoch,state.engineRevision,state.selectionEpoch,state.viewport,state.visible,state.nativeGeometry,state.visibleText])):JSON.stringify([state.engineEpoch,state.engineRevision,state.selectionEpoch,state.viewport,state.visible,state.nativeGeometry,state.visibleText]);
      if(this.overlayStates.get(viewId)!==key){this.overlayStates.set(viewId,key);this.changed(layout.owner,viewId);}
    }}catch(error){this.core.event('office.error',{error:String(error)});}finally{this.polling=false;}
  }
  async shutdown() {clearInterval(this.timer);for(const docId of this.documents.keys())await this.core.closeNativeOffice(docId);await this.runtime.shutdown({discard:true});}
}
