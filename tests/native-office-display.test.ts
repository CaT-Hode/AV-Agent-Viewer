import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { ViewerError } from '../packages/contracts/src/index';
import { OFFICE_SURFACE_METHODS, type OfficeSurfaceState } from '../packages/contracts/src/office-surface';

// This trusted test process has no Electron app, HWND, worker, profile or GUI.
// Only Electron's imports are substituted; the actual Host routing runs below.
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === 'electron' ? { url: 'agentviewer-test:electron', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === 'agentviewer-test:electron' ? { format: 'module', source: 'export class BrowserWindow {}; export const nativeImage = {};', shortCircuit: true } : next(url, context); },
});
const { NativeOfficeHost } = await import('../apps/desktop/src/main/native-office');hooks.deregister();
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

function fixture(t: test.TestContext) {
  const sent: unknown[] = [], states: OfficeSurfaceState[] = [], contexts: OfficeSurfaceState[] = [], activations: string[] = [], calls = { open: 0, state: 0, snapshot: 0, input: 0, capture: 0, close: 0, detach: 0, layout: 0, tiles:0,contextProjection:0,zoom:0 };
  let native: OfficeSurfaceState = { surfaceKind: 'tiled', sessionId: 'initial', documentId: 'doc', viewId: 'view', format: 'docx', engineEpoch: 'epoch', engineRevision: 0, selectionEpoch: 0, dirty: false, actor: 'human', status: 'ready', visible: false, focused: false, nativeGeometry: false, sizeTwips: { width: 12000, height: 18000 }, partIndex: 0, parts: [{ index: 0, name: 'Page' }], layoutRevision: 0, renderGeneration: 0, eventSequence: 0, selectionRects: [], selection: { kind: 'text', text: 'same-model text' }, visibleText: 'current viewport', visibleTextReady: true, visibleTextSource: 'actual-model-projection' };
  const owner = Object.assign(new EventEmitter(), { focused: true, isFocused() { return this.focused; }, isVisible: () => true, isMinimized: () => false, isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 1400, height: 900 }), getNativeWindowHandle: () => Buffer.alloc(8), webContents: { isDestroyed: () => false, getZoomFactor:()=>1, send: (_name: string, value: unknown) => sent.push(value) } });
  let host!: InstanceType<typeof NativeOfficeHost>;
  const doc = { info: { id: 'doc', format: 'docx', nativeOffice: { sessionId: 'initial', engineEpoch:'epoch', mirrorEngineRevision: 0, engineRevision: 0 } } };
  const core = Object.assign(new EventEmitter(), { views: new Map([['view', { id: 'view', documentId: 'doc' }]]), activeViewId: 'markdown', getView(id: string) { const view = this.views.get(id);if(!view)throw new ViewerError('TARGET_NOT_FOUND','closed');return view; }, getDocument: () => doc,
    async openNativeOffice(viewId: string) { return host.open({ documentId: 'doc', viewId, format: 'docx', bytes: new Uint8Array([1]), revision: 0 }); },
    updateNativeOfficeState(state: OfficeSurfaceState) { states.push(structuredClone(state));doc.info.nativeOffice.engineRevision = Math.max(doc.info.nativeOffice.engineRevision,state.engineRevision); }, updateNativeOfficeContext: (state:OfficeSurfaceState) => contexts.push(structuredClone(state)), setViewZoom: () => {}, event: () => {},
    activate(id: string) { this.activeViewId = id;activations.push(id); }, synchronizeNativeDocument: async () => { calls.snapshot++; },
  });
  host = new NativeOfficeHost(core as any, 'D:/own-display-test', 'D:/own-display-test', () => owner as any, () => {});
  t.after(() => clearInterval((host as any).timer));
  const runtime = host.runtime as any;
  runtime.enableContextProjection=async()=>{calls.contextProjection++;return {enabled:true};};
  runtime.zoom=async(_session:string,_view:string,factor:number)=>{calls.zoom++;native={...native,zoom:factor};return structuredClone(native);};
  runtime.open = async (value: any) => { calls.open++;native = { ...native, sessionId: value.sessionId, visible: false, focused: false };doc.info.nativeOffice.sessionId=value.sessionId;return structuredClone(native); };
  runtime.state = async () => { calls.state++;return structuredClone(native); };
  runtime.layout = async (_session: string,_view: string,value: any) => { calls.layout++;native = { ...native, visible: value.visible };return structuredClone(native); };
  runtime.surfaceLayout = async (_session: string,value: any) => { calls.layout++;native = { ...native, visible: value.visible, focused: value.focused, nativeGeometry: true, layoutRevision: value.layoutRevision };return structuredClone(native); };
  runtime.surfaceTiles=async()=>{calls.tiles++;return {state:structuredClone(native),tiles:[{key:'routed-tile'}]};};
  runtime.input = async () => { calls.input++;return { state: structuredClone(native) }; };
  runtime.capture = async () => { calls.capture++;throw new Error('capture must not run while withdrawn'); };
  runtime.close = async () => { calls.close++; };runtime.detachView = async () => { calls.detach++; };
  const layout = (leaseId: string, revision = 1, focused = false) => ({ viewId: 'view', leaseId, layoutRevision: revision, partIndex: 0, visibleTwips: { x: 0, y: 0, width: 10000, height: 9000 }, viewportCss: { width: 800, height: 600 }, documentOriginCss: { x: 0, y: 0 }, boundsCss: { x: 100, y: 100, width: 800, height: 600 }, zoom: 1, deviceScaleFactor: 1, visible: true, focused });
  const tiles=async(leaseId:string)=>host.surfaceRequest(owner as any,OFFICE_SURFACE_METHODS.tiles,{viewId:'view',leaseId,layoutRevision:native.layoutRevision,renderGeneration:0,partIndex:0,tiles:[{key:'tile',rectTwips:{x:0,y:0,width:960,height:960},pixelWidth:64,pixelHeight:64}]});
  const presented=(leaseId:string,proof:Partial<OfficeSurfaceState>={})=>host.display(owner as any,{viewId:'view',leaseId,action:'presented',sessionId:native.sessionId,engineEpoch:native.engineEpoch,engineRevision:native.engineRevision,layoutRevision:native.layoutRevision,...proof});
  const show = async (leaseId: string, revision = 1, focused = false, confirm=true) => { host.display(owner as any,{ viewId: 'view', leaseId, action: 'acquire' });await host.surfaceRequest(owner as any,OFFICE_SURFACE_METHODS.state,{ viewId: 'view', leaseId });await host.surfaceRequest(owner as any,OFFICE_SURFACE_METHODS.layout,layout(leaseId,revision,focused));if(confirm){await tiles(leaseId);presented(leaseId);} };
  return { host, core, owner, calls, sent, states, contexts, activations, runtime, layout, tiles, presented, show, native: () => native, setNative: (value: Partial<OfficeSurfaceState>) => { native = { ...native, ...value }; } };
}

test('display acquire/release ACK is synchronous during real Host pending-open routing and never starts another core or writer', async t => {
  const ctx=fixture(t), entered=gate(), finish=gate(), original=ctx.runtime.open;
  ctx.runtime.open=async (value: unknown)=>{entered.resolve();await finish.promise;return original(value);};
  const ack=ctx.host.display(ctx.owner as any,{viewId:'view',leaseId:'first',action:'acquire'});assert.equal(ack.active,true);assert.equal(ctx.calls.open,0);assert.equal(ctx.host.runtime.statistics.started,false);
  const pending=ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.state,{viewId:'view',leaseId:'first'}), rejected=assert.rejects(pending,{code:'OFFICE_DISPLAY_EXPIRED'});
  await entered.promise;const hidden=ctx.host.display(ctx.owner as any,{viewId:'view',leaseId:'first',action:'release'});assert.equal(hidden.active,false);assert.equal(ctx.calls.open,0,'the native importer is still waiting at its own gate');
  finish.resolve();await rejected;await ctx.host.poll();assert.equal(ctx.calls.open,1);assert.equal(ctx.calls.state,0);assert.equal(ctx.calls.close,0);assert.equal(ctx.calls.detach,0);assert.equal(ctx.core.activeViewId,'markdown');
});

test('real Host stops withdrawn polling and masks stale native focus while preserving public semantic model state', async t => {
  const ctx=fixture(t);await ctx.show('mounted',1,true);ctx.core.activeViewId='markdown';ctx.activations.length=0;
  ctx.host.display(ctx.owner as any,{viewId:'view',leaseId:'mounted',action:'release'});const before=ctx.calls.state;await ctx.host.poll();assert.equal(ctx.calls.state,before);assert.equal(ctx.calls.snapshot,0);
  ctx.setNative({visible:true,focused:true,nativeGeometry:true,engineRevision:7,dirty:true,unsavedContentChanges:true,pendingInput:true});
  const state=await ctx.host.state(ctx.native().sessionId,'view');assert.equal(state.visible,false);assert.equal(state.focused,false);assert.equal(state.nativeGeometry,false);assert.equal(state.engineRevision,7);assert.equal(state.pendingInput,true);assert.equal(state.selection?.text,'same-model text');assert.equal(ctx.core.activeViewId,'markdown');assert.deepEqual(ctx.activations,[]);
  await assert.rejects(ctx.host.captureNative(ctx.native().sessionId,'view'),{code:'NATIVE_VIEW_HIDDEN'});await assert.rejects(ctx.host.input({sessionId:ctx.native().sessionId,viewId:'view',expectedEngineEpoch:'epoch',expectedEngineRevision:7,action:{kind:'type',text:'x'},idempotencyKey:'physical-hidden'}),{code:'NATIVE_VIEW_HIDDEN'});
  assert.equal(ctx.calls.capture,0);assert.equal(ctx.calls.input,0);assert.equal(ctx.calls.close,0);assert.equal(ctx.calls.detach,0);
});

for(const method of [OFFICE_SURFACE_METHODS.input,OFFICE_SURFACE_METHODS.windowInput,OFFICE_SURFACE_METHODS.windowClose])test('real Host retains known '+method+' success after its display owner retires without publishing to the remount',async t=>{
  const ctx=fixture(t);await ctx.show('old');const entered=gate(),finish=gate();
  const nativeMethod=method===OFFICE_SURFACE_METHODS.input?'surfaceInput':method===OFFICE_SURFACE_METHODS.windowInput?'surfaceWindowInput':'surfaceWindowClose';
  ctx.runtime[nativeMethod]=async (...args:any[])=>{ctx.calls.input++;entered.resolve();await finish.promise;ctx.setNative({engineRevision:9,dirty:true,unsavedContentChanges:true,pendingInput:false});const state=structuredClone(ctx.native()),input=args[args.length-1];return method===OFFICE_SURFACE_METHODS.windowClose?state:{state,streamId:input.streamId,ackSequence:input.sequence,composing:false};};
  const payload=method===OFFICE_SURFACE_METHODS.input?{viewId:'view',leaseId:'old',streamId:'stream',sequence:4,layoutRevision:1,expectedPartIndex:0,event:{kind:'text',text:'confirmed input'}}:{viewId:'view',leaseId:'old',sessionId:ctx.native().sessionId,engineEpoch:'epoch',windowId:1,windowInstanceId:'window-instance',...(method===OFFICE_SURFACE_METHODS.windowInput?{streamId:'stream',sequence:4,event:{kind:'text',text:'confirmed input'}}:{})};
  const pending=ctx.host.surfaceRequest(ctx.owner as any,method,payload);await entered.promise;ctx.host.display(ctx.owner as any,{viewId:'view',leaseId:'old',action:'release'});await ctx.show('new',3);ctx.core.activeViewId='markdown';const published=ctx.sent.length;finish.resolve();const reply=await pending as any;
  assert.equal(reply.retiredDisplay,true);const state=reply.state??reply;assert.equal(state.engineRevision,9);assert.equal(state.visible,false);assert.equal(state.focused,false);
  if(method!==OFFICE_SURFACE_METHODS.windowClose){assert.equal(reply.streamId,'stream');assert.equal(reply.ackSequence,4);assert.equal(reply.composing,false);}
  assert.equal(ctx.calls.input,1);assert.equal(ctx.states.at(-1)?.engineRevision,9);assert.equal(ctx.sent.length,published);assert.equal(ctx.core.activeViewId,'markdown');assert.equal(ctx.host.source('view')?.entry.state?.engineRevision,0,'retired input never replaces the new display state');
});

test('real Host never turns an unknown native input outcome into a successful retired acknowledgement',async t=>{
  const ctx=fixture(t);await ctx.show('old');const entered=gate(),finish=gate();ctx.runtime.surfaceInput=async()=>{entered.resolve();await finish.promise;throw new ViewerError('NATIVE_OUTCOME_UNKNOWN','actual worker reply missing');};
  const pending=ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.input,{viewId:'view',leaseId:'old',streamId:'stream',sequence:1,layoutRevision:1,expectedPartIndex:0,event:{kind:'text',text:'unknown'}}),rejected=assert.rejects(pending,{code:'NATIVE_OUTCOME_UNKNOWN'});
  await entered.promise;ctx.host.display(ctx.owner as any,{viewId:'view',leaseId:'old',action:'release'});finish.resolve();await rejected;
});

test('real Host cannot reactivate a visible Office view from stale native focus when its owning window is unfocused',async t=>{
  const ctx=fixture(t);await ctx.show('mount',1,true);ctx.owner.focused=false;ctx.core.activeViewId='markdown';ctx.activations.length=0;
  await ctx.host.state(ctx.native().sessionId,'view');assert.equal(ctx.core.activeViewId,'markdown');assert.deepEqual(ctx.activations,[]);
});

test('unpresented preview keeps private native drawing ready but withdraws public context and physical tools',async t=>{
  const ctx=fixture(t);await ctx.show('preview',1,true,false);
  const raw=await ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.state,{viewId:'view',leaseId:'preview'}) as OfficeSurfaceState;
  assert.equal(raw.visible,true);assert.equal(raw.nativeGeometry,true);assert.equal((await ctx.host.state(raw.sessionId,'view')).visible,false);assert.equal(ctx.states.at(-1)?.nativeGeometry,false);assert.equal(ctx.contexts.at(-1)?.visibleText,'');assert.equal(ctx.host.source('view'),undefined);assert.equal(ctx.host.backdrop('view'),undefined);assert.equal(ctx.core.activeViewId,'markdown');
  await assert.rejects(ctx.host.input({sessionId:raw.sessionId,viewId:'view',expectedEngineEpoch:'epoch',expectedEngineRevision:0,action:{kind:'click',x:10,y:10,button:'left',clickCount:1,modifiers:[]},idempotencyKey:'preview-click'}),{code:'NATIVE_VIEW_HIDDEN'});
  await assert.rejects(ctx.host.captureNative(raw.sessionId,'view'),{code:'NATIVE_VIEW_HIDDEN'});
  await assert.rejects(ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.input,{viewId:'view',leaseId:'preview',streamId:'preview',sequence:1,layoutRevision:1,expectedPartIndex:0,event:{kind:'barrier'}}),{code:'OFFICE_DISPLAY_NOT_PRESENTED'});
  const window={viewId:'view',leaseId:'preview',sessionId:raw.sessionId,engineEpoch:raw.engineEpoch,windowId:1,windowInstanceId:'native-window'};
  await assert.rejects(ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.windowInput,{...window,streamId:'preview',sequence:1,event:{kind:'text',text:'not dispatched'}}),{code:'OFFICE_DISPLAY_NOT_PRESENTED'});
  await assert.rejects(ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.windowClose,window),{code:'OFFICE_DISPLAY_NOT_PRESENTED'});
  assert.equal(ctx.calls.input,0);assert.equal(ctx.calls.capture,0);assert.throws(()=>ctx.presented('preview'),{code:'STALE_OFFICE_DISPLAY'},'an engine layout alone is not a painted native frame');
  await ctx.tiles('preview');assert.equal(ctx.calls.tiles,1);assert.equal(ctx.contexts.at(-1)?.nativeGeometry,false,'a returned tile alone is not a presentation acknowledgement');
  ctx.setNative({pendingInput:true});await ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.state,{viewId:'view',leaseId:'preview'});
  const ack=ctx.presented('preview');assert.equal(ack.presented,true);const visible=await ctx.host.state(raw.sessionId,'view');assert.equal(visible.nativeGeometry,true);assert.equal(visible.pendingInput,true,'presentation does not commit or discard a real native editor buffer');assert.ok(ctx.host.source('view'));assert.equal(ctx.contexts.at(-1)?.nativeGeometry,true);
});

test('presentation rejects stale versions and released mounts, but a remount can redraw valid same-source cached tiles',async t=>{
  const ctx=fixture(t);await ctx.show('old',1,false,false);await ctx.tiles('old');
  for(const proof of [{sessionId:'different'},{engineEpoch:'different'},{engineRevision:1},{layoutRevision:2}])assert.throws(()=>ctx.presented('old',proof),{code:'STALE_OFFICE_DISPLAY'});
  assert.equal(ctx.host.source('view'),undefined);ctx.presented('old');ctx.host.display(ctx.owner as any,{viewId:'view',leaseId:'old',action:'release'});
  await ctx.show('new',2,false,false);assert.equal(ctx.host.source('view'),undefined);assert.throws(()=>ctx.presented('old'),{code:'OFFICE_DISPLAY_EXPIRED'});
  assert.equal(ctx.calls.tiles,1);ctx.presented('new');assert.ok(ctx.host.source('view'),'the renderer may genuinely redraw its same-content native tile cache');
  ctx.host.display(ctx.owner as any,{viewId:'view',leaseId:'old',action:'release'});assert.ok(ctx.host.source('view'),'late old release cannot withdraw the new native frame');
});

test('semantic projection starts only after actual presentation and never blocks its synchronous acknowledgement',async t=>{
  const ctx=fixture(t),entered=gate(),finish=gate();
  ctx.runtime.enableContextProjection=async()=>{ctx.calls.contextProjection++;entered.resolve();await finish.promise;return {enabled:true};};
  await ctx.show('preview',1,false,false);await ctx.tiles('preview');assert.equal(ctx.calls.contextProjection,0);
  const ack=ctx.presented('preview');assert.equal(ack.presented,true);assert.ok(ctx.host.source('view'));
  await entered.promise;assert.equal(ctx.calls.contextProjection,1);assert.equal(ctx.calls.input,0);finish.resolve();
});

test('a layout from before a user zoom cannot write its old scale back into the native view',async t=>{
  const ctx=fixture(t);await ctx.show('zoomed',1,false,false);
  const before=ctx.calls.layout;const state=ctx.native();const zoomed=await ctx.host.zoom(state.sessionId,'view',4);
  assert.equal(ctx.calls.zoom,1);assert.equal(zoomed.zoom,4);
  await assert.rejects(ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.layout,ctx.layout('zoomed',2)),(error:unknown)=>error instanceof ViewerError&&error.code==='STALE_OFFICE_SURFACE_LAYOUT');
  assert.equal(ctx.calls.layout,before,'the stale layout is rejected before the native engine call');
  await ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.layout,{...ctx.layout('zoomed',3),zoom:4});
  assert.equal(ctx.calls.layout,before+1);
});

test('surface state waits for a queued layout so coordinate input cannot race a stale revision',async t=>{
  const ctx=fixture(t);await ctx.show('mounted');
  const entered=gate(),finish=gate(),original=ctx.runtime.surfaceLayout;
  ctx.runtime.surfaceLayout=async(session:string,value:any)=>{entered.resolve();await finish.promise;return original(session,value);};
  const pendingLayout=ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.layout,{...ctx.layout('mounted',7),zoom:1});
  await entered.promise;
  let settled=false;
  const pendingState=ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.state,{viewId:'view',leaseId:'mounted'}).then(value=>{settled=true;return value as OfficeSurfaceState;});
  await Promise.resolve();assert.equal(settled,false,'state remains behind the in-flight layout write');
  finish.resolve();await pendingLayout;const state=await pendingState;assert.equal(state.layoutRevision,7,'the immediately following state observes the committed layout');
});

test('public semantic query, edit, snapshot and save acknowledgement remain same-model while a preview is unpresented',async t=>{
  const ctx=fixture(t);await ctx.show('preview',1,false,false);const session=ctx.native().sessionId;
  ctx.runtime.query=async()=>({model:'same-native-source'});ctx.runtime.execute=async()=>{ctx.setNative({engineRevision:2,dirty:true,pendingInput:false});return {state:structuredClone(ctx.native()),receipt:{status:'applied'}};};
  ctx.runtime.snapshot=async()=>({state:structuredClone(ctx.native()),bytes:new Uint8Array([1,2]),engineRevisionBefore:2,engineRevisionAfter:2,stable:true});ctx.runtime.ackSaved=async()=>true;
  assert.deepEqual(await ctx.host.query(session,'view',{kind:'selection'} as any),{model:'same-native-source'});const edited=await ctx.host.execute({sessionId:session,viewId:'view'} as any);assert.equal(edited.state.engineRevision,2);assert.equal(edited.state.visible,false);
  const snapshot=await ctx.host.snapshot(session);assert.equal(snapshot.state.nativeGeometry,false);assert.deepEqual([...snapshot.bytes],[1,2]);assert.equal(await ctx.host.ackSaved(session,{engineEpoch:'epoch',engineRevision:2,hash:'hash'}),true);
});

test('a positive layout exceeding the current owner viewport is rejected before any native layout or input is dispatched',async t=>{
  const ctx=fixture(t);await ctx.show('mount');const before={...ctx.calls};ctx.owner.getContentBounds=()=>({x:0,y:0,width:700,height:500});
  await assert.rejects(ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.layout,ctx.layout('mount',2)),(error:unknown)=>{assert.ok(error instanceof ViewerError);assert.equal(error.code,'OFFICE_VIEWPORT_CHANGED');assert.deepEqual(error.details,{ownerViewport:{width:700,height:500},rendererZoom:1});return true;});
  assert.equal(ctx.calls.layout,before.layout);assert.equal(ctx.calls.input,before.input);
  await assert.rejects(ctx.host.surfaceRequest(ctx.owner as any,OFFICE_SURFACE_METHODS.layout,{...ctx.layout('mount',2),boundsCss:{x:-1,y:0,width:100,height:100}}),/INVALID_NATIVE_LAYOUT/);assert.equal(ctx.calls.layout,before.layout);
});
