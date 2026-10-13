import { BrowserWindow, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { NativeOfficeRuntime } from '../../../../packages/office-runtime/src/index';
import type { NativeOfficeAppearance } from '../../../../packages/office-runtime/src/appearance';
import type { NativeOfficeDriver, NativeOfficeState, NativeOfficeFormat, NativeOfficeNavigateTarget, NativeOfficeExportFormat, Rect, NativeOfficeQuery, NativeOfficeExecuteRequest, BrowserAction } from '../../../../packages/contracts/src/index';
import type { ViewerCore } from '../../../../packages/document-core/src/index';
import type { NativeBackdropSource } from './web-toolbar';

type Layout = { owner: BrowserWindow; bounds: Rect; visible: boolean };
/** Only the trusted main process translates document views into native HWNDs. */
export class NativeOfficeHost implements NativeOfficeDriver {
  readonly runtime: NativeOfficeRuntime;
  private documents = new Map<string, string>();
  private views = new Map<string, { sessionId: string; state?: NativeOfficeState; layout?: Layout }>();
  private layouts = new Map<string, Layout>();
  private polling = false;
  private workerExited = false;
  private versions = new Map<string,{key:string;version:number}>();
  private settled = new Map<string,{revision:number;since:number}>();
  private published = new Map<string, { key: string; heartbeatAt: number }>();
  private overlayStates = new Map<string, string>();
  private desired = new Map<BrowserWindow,{ticket:number;views:{viewId:string;bounds:Rect}[]}>();
  private queues = new Map<BrowserWindow,Promise<void>>();
  private watchers = new Map<BrowserWindow,()=>void>();
  private timer: ReturnType<typeof setInterval>;
  get exited() { return this.workerExited; }
  constructor(private core: ViewerCore, appRoot: string, dataDir: string, private windowFor: (viewId: string) => BrowserWindow | undefined, private changed: (owner: BrowserWindow, viewId: string) => void, appearance?: NativeOfficeAppearance) {
    this.runtime = new NativeOfficeRuntime({ appRoot, dataDir, appearance });
    this.runtime.on('changed', () => { void this.poll(); });
    this.runtime.on('selection', () => { void this.poll(); });
    this.runtime.on('viewport', () => { void this.poll(); });
    this.runtime.on('exit',()=>{this.workerExited=true;for(const sessionId of this.documents.values())this.core.failNativeOfficeSession(sessionId);for(const [viewId,entry] of this.views){if(entry.state)entry.state={...entry.state,status:'failed',visible:false,nativeGeometry:false,visibleTextReady:false};if(entry.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,viewId);}});
    this.core.on('change',(event:{type:string;data:{sessionId?:string;viewId?:string;recovery?:boolean}})=>{
      if(event.type==='office.closed'&&event.data.recovery&&event.data.sessionId){
        const sessionId=event.data.sessionId;
        for(const [documentId,id] of this.documents)if(id===sessionId)this.documents.delete(documentId);
        for(const [viewId,entry] of this.views)if(entry.sessionId===sessionId){this.views.delete(viewId);this.layouts.delete(viewId);this.versions.delete(viewId);if(entry.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,viewId);}
      }
      if(event.type==='view.closed'&&event.data.viewId&&this.workerExited){this.views.delete(event.data.viewId);this.layouts.delete(event.data.viewId);this.versions.delete(event.data.viewId);}
    });
    this.runtime.on('application-action',(event:{sessionId?:string;viewId?:string;action?:string})=>{
      const entry=event.viewId?this.views.get(event.viewId):undefined,owner=entry?.layout?.owner;
      if(!entry||entry.sessionId!==event.sessionId||!owner||owner.isDestroyed()||!['save','save-as','open','new','close','quit'].includes(String(event.action)))return;
      owner.webContents.send('agentviewer:toolbar',{action:'native-'+event.action,viewId:event.viewId});
    });
    this.timer = setInterval(() => { void this.poll(); }, 450); this.timer.unref();
  }
  private hwnd(owner: BrowserWindow) { const handle = owner.getNativeWindowHandle(); return String(handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())); }
  private ownerViewport(owner: BrowserWindow) { const { width, height } = owner.getContentBounds(); return { width, height }; }
  private layoutFor(viewId: string): Layout {
    const found = this.layouts.get(viewId); if (found) return found;
    const owner = this.windowFor(viewId); if (!owner || owner.isDestroyed()) throw new Error('原生文档所属窗口不可用。');
    const box = owner.getContentBounds(); return { owner, bounds: { x: 80, y: 64, width: Math.max(300, box.width - 160), height: Math.max(240, box.height - 80) }, visible: false };
  }
  private accept(state: NativeOfficeState) {
    const entry = state.viewId ? this.views.get(state.viewId) : undefined; if (entry) entry.state = state;
    this.core.updateNativeOfficeState(state);
    if(state.viewId&&state.focused&&state.actor==='human'&&entry?.layout?.visible&&this.core.views.has(state.viewId)&&this.core.activeViewId!==state.viewId)this.core.activate(state.viewId,'human');
    const zoom=(state as NativeOfficeState&{zoom?:number}).zoom;if(state.viewId&&this.core.views.has(state.viewId)&&zoom&&Number.isFinite(zoom)&&zoom>=.25&&zoom<=4)this.core.setViewZoom(state.viewId,zoom,'human');
    const owner=entry?.layout?.owner;
    if (state.viewId && entry?.layout?.visible && owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) {
      const key=JSON.stringify(state), previous=this.published.get(state.viewId), now=Date.now();
      if(previous?.key!==key)owner.webContents.send('agentviewer:toolbar',{action:'office-state',state});
      if(!previous||now-previous.heartbeatAt>=900)owner.webContents.send('agentviewer:toolbar',{action:'office-state-heartbeat',viewId:state.viewId});
      this.published.set(state.viewId,{key,heartbeatAt:!previous||now-previous.heartbeatAt>=900?now:previous.heartbeatAt});
    }
  }
  async setAppearance(appearance: NativeOfficeAppearance) { await this.runtime.setAppearance(appearance); this.versions.clear(); this.overlayStates.clear(); await this.poll(); }
  async open(request: {documentId:string;viewId:string;format:NativeOfficeFormat;bytes:Uint8Array;revision:number}) {
    const sessionId = this.documents.get(request.documentId) ?? randomUUID(), layout = this.layoutFor(request.viewId);
    // A slow import must never flash above a tab the user has already left.
    const state = await this.runtime.open({ ...request, sessionId, ownerHwnd: this.hwnd(layout.owner), ownerViewport: this.ownerViewport(layout.owner), bounds: layout.bounds, visible: false });
    this.documents.set(request.documentId, sessionId); this.views.set(request.viewId, { sessionId, state, layout });
    return state;
  }
  async state(sessionId: string, viewId?: string) { const state = await this.runtime.state(sessionId, viewId); this.accept(state); return state; }
  snapshot(sessionId:string) { return this.runtime.snapshot(sessionId); }
  commands(sessionId:string,viewId:string) { return this.runtime.commands(sessionId,viewId); }
  commandStatus(sessionId:string,viewId:string,commands:string[]) { return Promise.all(commands.map(command => this.runtime.commandStatus(sessionId,viewId,command))); }
  query(sessionId:string,viewId:string,target:NativeOfficeQuery) { return this.runtime.query(sessionId,viewId,target); }
  execute(request:NativeOfficeExecuteRequest) { return this.runtime.execute(request); }
  zoom(sessionId:string,viewId:string,factor:number) {return this.runtime.zoom(sessionId,viewId,factor);}
  async input(request:{sessionId:string;viewId:string;expectedEngineEpoch:string;expectedEngineRevision:number;expectedLayoutRevision?:number;action:BrowserAction;idempotencyKey:string}) {
    const result=await this.runtime.input(request);this.accept(result.state);
    const owner=this.views.get(request.viewId)?.layout?.owner;if(owner&&!owner.isDestroyed())this.changed(owner,request.viewId);
    return result;
  }
  captureNative(sessionId:string,viewId:string,rect?:Rect) {return this.runtime.capture(sessionId,viewId,rect);}
  navigate(request:{sessionId:string;viewId:string;target:NativeOfficeNavigateTarget;expectedEngineEpoch:string;expectedEngineRevision:number;expectedSelectionEpoch?:number;requestId:string}) {return this.runtime.navigate(request);}
  exportCopy(sessionId:string,request:{format:NativeOfficeExportFormat;expectedEngineEpoch:string;expectedEngineRevision:number}) {return this.runtime.exportCopy(sessionId,request);}
  async detachView(sessionId:string,viewId:string) {
    const entry=this.views.get(viewId),layout=this.layouts.get(viewId);
    this.views.delete(viewId);this.layouts.delete(viewId);this.published.delete(viewId);this.overlayStates.delete(viewId);
    if(entry?.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,viewId);
    try{if(!this.workerExited)await this.runtime.detachView(sessionId,viewId);}
    catch(error){if(entry)this.views.set(viewId,entry);if(layout)this.layouts.set(viewId,layout);if(entry?.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,viewId);throw error;}
    this.versions.delete(viewId);
  }
  undo(request:{sessionId:string;viewId:string;expectedEngineEpoch:string;expectedEngineRevision:number;undoToken:string}) { return this.runtime.undo(request); }
  ackSaved(sessionId:string,saved:{engineEpoch:string;engineRevision:number;hash:string}) { return this.runtime.ackSaved(sessionId,saved); }
  async close(sessionId:string) {
    const closing=[...this.views].filter(([,entry])=>entry.sessionId===sessionId);
    // Reparent trusted overlays before Windows destroys the dock's owned HWNDs.
    for(const [id] of closing){this.views.delete(id);this.published.delete(id);this.overlayStates.delete(id);}
    for(const [id,entry] of closing)if(entry.layout&&!entry.layout.owner.isDestroyed())this.changed(entry.layout.owner,id);
    try{if(!this.workerExited)await this.runtime.close(sessionId,{discard:true});}
    catch(error){for(const [id,entry] of closing)this.views.set(id,entry);throw error;}
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
    const dispose=()=>{for(const event of events)emitter.removeListener(event,update);this.watchers.delete(owner);this.desired.delete(owner);};this.watchers.set(owner,dispose);owner.once('closed',dispose);
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
      const state=await this.runtime.layout(opened.sessionId,viewId,{ownerHwnd:this.hwnd(owner),ownerViewport:this.ownerViewport(owner),bounds:current?.bounds??bounds,visible:!!current&&owner.isVisible()&&!owner.isMinimized()});this.accept(state);
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
  source(viewId:string) { const entry=this.views.get(viewId),layout=this.layouts.get(viewId);if(!entry?.state||entry.state.status==='failed'||!layout?.visible)return; return {entry,layout}; }
  backdrop(viewId:string):NativeBackdropSource|undefined {const source=this.source(viewId);if(!source)return;const {entry,layout}=source,state=entry.state!;
    const key=JSON.stringify([state.engineRevision,state.selectionEpoch,state.visibleText,state.viewport,layout.bounds]);let version=this.versions.get(viewId);if(version?.key!==key){version={key,version:(version?.version??0)+1};this.versions.set(viewId,version);}
    const revision=state.engineRevision,epoch=state.engineEpoch,sessionId=entry.sessionId;
    return {bounds:{...layout.bounds},navigationId:epoch+':'+sessionId+':'+viewId,layoutRevision:version!.version,revision,sourceId:state.nativePid??0,capture:async rect=>{const result=await this.capture(viewId,rect);if(result.metadata.engineEpoch!==epoch||result.metadata.engineRevision!==revision||result.metadata.sessionId!==sessionId){void this.poll();throw new Error('STALE_NATIVE_CAPTURE');}return {image:result.image,rect:result.metadata.rect};},attach:window=>this.overlayOwner(viewId,window)};
  }
  async capture(viewId:string,rect:Rect) {const entry=this.views.get(viewId);if(!entry)throw new Error('NATIVE_SESSION_EXPIRED');const result=await this.runtime.capture(entry.sessionId,viewId,rect);return {image:nativeImage.createFromBuffer(Buffer.from(result.data,'base64')),metadata:result};}
  async overlayOwner(viewId:string,window:BrowserWindow) {const entry=this.views.get(viewId);if(!entry)throw new Error('NATIVE_SESSION_EXPIRED'); await this.runtime.setOverlayOwner({sessionId:entry.sessionId,viewId,hwnd:this.hwnd(window)});}
  async poll() {
    if(this.polling)return;this.polling=true;
    try {for(const [viewId,entry] of this.views){const layout=this.layouts.get(viewId);if(!layout?.visible||layout.owner.isDestroyed()||!layout.owner.isVisible()||layout.owner.isMinimized()||entry.state?.status==='failed')continue;
      const state=await this.state(entry.sessionId,viewId);if(!this.core.views.has(viewId))continue;
      const metadata=this.core.getDocument(state.documentId).info.nativeOffice;
      if(metadata&&metadata.mirrorEngineRevision!==state.engineRevision){
        let idle=this.settled.get(state.documentId);
        if(idle?.revision!==state.engineRevision){idle={revision:state.engineRevision,since:Date.now()};this.settled.set(state.documentId,idle);}
        // Keep recovery/read models current after an idle interval. Never snapshot
        // each keystroke or commit an in-progress native cell editor implicitly.
        if(!state.pendingInput&&Date.now()-idle.since>=1200)await this.core.synchronizeNativeDocument(state.documentId);
      }else this.settled.delete(state.documentId);
      this.core.updateNativeOfficeContext(state);
      const key=JSON.stringify([state.engineEpoch,state.engineRevision,state.selectionEpoch,state.viewport,state.visible,state.nativeGeometry,state.visibleText]);
      if(this.overlayStates.get(viewId)!==key){this.overlayStates.set(viewId,key);this.changed(layout.owner,viewId);}
    }}catch(error){this.core.event('office.error',{error:String(error)});}finally{this.polling=false;}
  }
  async shutdown() {clearInterval(this.timer);for(const docId of this.documents.keys())await this.core.closeNativeOffice(docId);await this.runtime.shutdown({discard:true});}
}
