import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfficeSurfaceInputController } from '../apps/desktop/src/renderer/lib/office-surface-controller';
import type { OfficeSurfaceInputEvent, OfficeSurfaceInputReply, OfficeSurfaceState } from '../packages/contracts/src/office-surface';
import type { NativeOfficeRequest } from '../apps/desktop/src/renderer/lib/native-office-tools';
const state = (): OfficeSurfaceState => ({ surfaceKind: 'tiled', sessionId: 'session', documentId: 'document', viewId: 'view', engineEpoch: 'epoch', engineRevision: 0, selectionEpoch: 0, format: 'docx', status: 'ready', dirty: false, sizeTwips: { width: 12000, height: 18000 }, parts: [], partIndex: 0, layoutRevision: 1, renderGeneration: 0, eventSequence: 0, selectionRects: [] });
const mods = { shift: false, control: false, alt: false, meta: false };
const pointer = (phase: 'down'|'move'|'up', x: number): Extract<OfficeSurfaceInputEvent,{kind:'pointer'}> => ({ kind: 'pointer', phase, pointTwips: { x, y: 30 }, buttons: phase === 'up' ? 0 : 1, clickCount: 1, modifiers: mods });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const until = async (check: () => boolean) => { for (let index = 0; index < 50; index++) { if (check()) return; await new Promise(done => setTimeout(done, 0)); } assert.fail('controller did not reach request boundary'); };

test('human input preserves down/up and only coalesces undispatched motion, with contiguous acknowledgements', async () => {
  const first = deferred<void>(), seen: { sequence: number; event: OfficeSurfaceInputEvent }[] = [];
  const request: NativeOfficeRequest = async (_method, args = {}) => { seen.push({ sequence: Number(args.sequence), event: args.event as OfficeSurfaceInputEvent }); if (seen.length === 1) await first.promise; return { state: state(), streamId: args.streamId, ackSequence: args.sequence, composing: false } as any; };
  const controller = new OfficeSurfaceInputController('view', { request, state, beforeInput: async () => {}, accept: () => {} });
  const promises = [controller.post(pointer('down', 0))]; await until(() => seen.length === 1);
  for (let index = 1; index <= 50; index++) promises.push(controller.post(pointer('move', index)));
  promises.push(controller.post(pointer('up', 50))); first.resolve(); await Promise.all(promises);
  assert.deepEqual(seen.map(event => event.sequence), [1, 2, 3]); assert.deepEqual(seen.map(event => (event.event as Extract<OfficeSurfaceInputEvent, { kind: 'pointer' }>).phase), ['down', 'move', 'up']);
  assert.deepEqual((seen[1].event as Extract<OfficeSurfaceInputEvent, { kind: 'pointer' }>).pointTwips, { x: 50, y: 30 }); assert.equal(controller.pending, false); controller.dispose();
});
test('composition prevents a save barrier until the engine acknowledges its end exactly once', async () => {
  const start = deferred<void>(); let composing = false, ends = 0;
  const request: NativeOfficeRequest = async (_method, args = {}) => { const event = args.event as OfficeSurfaceInputEvent; if (event.kind === 'composition') { if (event.phase === 'start') { composing = true; await start.promise; } if (event.phase === 'end') { ends++; composing = false; } } return { state: state(), streamId: args.streamId, ackSequence: args.sequence, composing } as any; };
  const controller = new OfficeSurfaceInputController('view', { request, state, beforeInput: async () => {}, accept: () => {} });
  const first = controller.post({ kind: 'composition', compositionId: 'ime', phase: 'start', text: '' }), end = controller.post({ kind: 'composition', compositionId: 'ime', phase: 'end', text: '潮灯町' });
  await assert.rejects(controller.barrier(), /组合输入/); start.resolve(); await Promise.all([first, end]); await controller.barrier(); assert.equal(ends, 1); assert.equal(controller.compositionActive, false); controller.dispose();
});
test('an unconfirmed input reply blocks further mutation and never replays the queued text', async () => {
  let calls = 0, accepted = 0;
  const request: NativeOfficeRequest = async (_method, args = {}) => { calls++; return { state: state(), streamId: args.streamId, ackSequence: Number(args.sequence) + 1, composing: false } as any; };
  const controller = new OfficeSurfaceInputController('view', { request, state, beforeInput: async () => {}, accept: () => { accepted++; } });
  const results = await Promise.allSettled([controller.post({ kind: 'text', text: 'first' }), controller.post({ kind: 'text', text: 'second' })]);
  assert.equal(results.every(result => result.status === 'rejected'), true); await assert.rejects(controller.post({ kind: 'text', text: 'retry' }), /回执/); assert.equal(calls, 1); assert.equal(accepted, 0); assert.ok(controller.failure); controller.dispose();
});
test('an input reply from a disposed reader cannot update its replacement reader', async () => {
  const pending = deferred<OfficeSurfaceInputReply>(); let args: Record<string, unknown> | undefined, accepted = 0;
  const request: NativeOfficeRequest = async (_method, input = {}) => { args = input; return await pending.promise as any; };
  const controller = new OfficeSurfaceInputController('view', { request, state, beforeInput: async () => {}, accept: () => { accepted++; } });
  const call = controller.post({ kind: 'text', text: 'late' }), rejected = assert.rejects(call, /关闭/); await until(() => !!args); controller.dispose(); pending.resolve({ state: state(), streamId: String(args!.streamId), ackSequence: Number(args!.sequence), composing: false }); await rejected; assert.equal(accepted, 0);
});
test('a replaced engine epoch rejects a late reply even before React disposes its old controller', async () => {
  const pending = deferred<OfficeSurfaceInputReply>(); let args: Record<string, unknown> | undefined, accepted = 0, live = state();
  const request: NativeOfficeRequest = async (_method, input = {}) => { args = input; return await pending.promise as any; };
  const controller = new OfficeSurfaceInputController('view', { request, state: () => live, beforeInput: async () => {}, accept: () => { accepted++; } });
  const call = controller.post({ kind: 'text', text: 'old model' }), rejected = assert.rejects(call, /回执/); await until(() => !!args);
  live = { ...state(), sessionId: 'replacement', engineEpoch: 'replacement epoch' };
  pending.resolve({ state: state(), streamId: String(args!.streamId), ackSequence: Number(args!.sequence), composing: false }); await rejected; assert.equal(accepted, 0); controller.dispose();
});
test('a save barrier drains the physical shortcut modifier release without replaying its engine commit', async () => {
  const commit = deferred<void>(), release = deferred<void>(), seen: OfficeSurfaceInputEvent[] = [];
  const request: NativeOfficeRequest = async (_method, args = {}) => { const event = args.event as OfficeSurfaceInputEvent; seen.push(event); if (event.kind === 'barrier') await commit.promise; else await release.promise; return { state: state(), streamId: args.streamId, ackSequence: args.sequence, composing: false } as any; };
  const controller = new OfficeSurfaceInputController('view', { request, state, beforeInput: async () => {}, accept: () => {} });
  let saved = false;
  const save = controller.barrier().then(() => { saved = true; });
  await until(() => seen.length === 1);
  const keyup = controller.post({ kind: 'key', phase: 'up', key: 'Control', code: 'ControlLeft', repeat: false, modifiers: mods });
  commit.resolve(); await until(() => seen.length === 2); assert.equal(saved, false, 'save cannot race an unacknowledged physical release');
  release.resolve(); await Promise.all([save, keyup]); assert.equal(saved, true); assert.equal(seen.filter(event => event.kind === 'barrier').length, 1, 'the engine commit is not reissued'); assert.equal(controller.pending, false); controller.dispose();
});
test('composition that begins behind a save barrier still prevents saving a new preedit', async () => {
  const commit = deferred<void>(); let seen = 0;
  const request: NativeOfficeRequest = async (_method, args = {}) => { const event = args.event as OfficeSurfaceInputEvent; seen++; if (event.kind === 'barrier') await commit.promise; return { state: state(), streamId: args.streamId, ackSequence: args.sequence, composing: event.kind === 'composition' } as any; };
  const controller = new OfficeSurfaceInputController('view', { request, state, beforeInput: async () => {}, accept: () => {} });
  const save = assert.rejects(controller.barrier(), /输入尚未稳定/); await until(() => seen === 1);
  const preedit = controller.post({ kind: 'composition', compositionId: 'new preedit', phase: 'start', text: '' }); commit.resolve(); await Promise.all([save, preedit]); assert.equal(controller.compositionActive, true); controller.dispose();
});
test('a physical release during native model synchronization is confirmed without creating a draft or duplicating the commit', async () => {
  const sync = deferred<void>(), release = deferred<void>(); let syncing = false, commits = 0, releases = 0, saved = false;
  const request: NativeOfficeRequest = async (_method, args = {}) => { const event=args.event as OfficeSurfaceInputEvent; if (event.kind==='barrier') commits++; else {releases++;await release.promise;} return { state:state(),streamId:args.streamId,ackSequence:args.sequence,composing:false } as any; };
  const controller = new OfficeSurfaceInputController('view',{request,state,beforeInput:async()=>{},accept:()=>{}});
  const save=controller.flush(async()=>{syncing=true;await sync.promise;}).then(()=>{saved=true;}); await until(()=>syncing);
  const keyup=controller.post({kind:'key',phase:'up',key:'Control',code:'ControlLeft',repeat:false,modifiers:mods}); await until(()=>releases===1);
  assert.equal(controller.pending,true);assert.equal(controller.pendingEdit,false);sync.resolve();await new Promise(done=>setTimeout(done,0));assert.equal(saved,false);
  release.resolve();await Promise.all([save,keyup]);assert.equal(saved,true);assert.equal(commits,1);assert.equal(releases,1);controller.dispose();
});
test('new typed input during native synchronization invalidates that save even after its acknowledgement', async () => {
  const sync=deferred<void>();let syncing=false,texts=0,commits=0;
  const request:NativeOfficeRequest=async(_method,args={})=>{const event=args.event as OfficeSurfaceInputEvent;if(event.kind==='barrier')commits++;if(event.kind==='text')texts++;return {state:state(),streamId:args.streamId,ackSequence:args.sequence,composing:false} as any;};
  const controller=new OfficeSurfaceInputController('view',{request,state,beforeInput:async()=>{},accept:()=>{}});
  const save=assert.rejects(controller.flush(async()=>{syncing=true;await sync.promise;}),/输入内容仍在变化/);await until(()=>syncing);await controller.post({kind:'text',text:'a new edit'});sync.resolve();await save;assert.equal(commits,1);assert.equal(texts,1);controller.dispose();
});
test('a pointer queued behind another input cannot be retargeted to an Agent-switched worksheet',async()=>{
  const ack=deferred<void>();let live=state(),calls=0;
  const request:NativeOfficeRequest=async(_method,args={})=>{calls++;const original=live;await ack.promise;return {state:original,streamId:args.streamId,ackSequence:args.sequence,composing:false} as any;};
  const controller=new OfficeSurfaceInputController('view',{request,state:()=>live,beforeInput:async()=>{},accept:()=>{}});
  const first=controller.post({kind:'key',phase:'up',key:'Shift',code:'ShiftLeft',repeat:false,modifiers:mods});await until(()=>calls===1);
  const oldPointer=assert.rejects(controller.post(pointer('down',45)),/工作表、页面或会话已变化/);
  live={...live,partIndex:1,layoutRevision:20};ack.resolve();await Promise.all([first,oldPointer]);assert.equal(calls,1,'old pointer never reaches the new worksheet');controller.dispose();
});
test('target identity is rechecked after coordinate synchronization, without rejecting a same-part resize',async()=>{
  for(const switchPart of [true,false]){
    const sync=deferred<void>();let live=state(),entered=false,calls=0,revision=0,expectedPart=-1;
    const request:NativeOfficeRequest=async(_method,args={})=>{calls++;revision=Number(args.layoutRevision);expectedPart=Number(args.expectedPartIndex);return {state:live,streamId:args.streamId,ackSequence:args.sequence,composing:false} as any;};
    const controller=new OfficeSurfaceInputController('view',{request,state:()=>live,beforeInput:async()=>{entered=true;await sync.promise;},accept:()=>{}});
    const sent=controller.post(pointer('down',45));const checked=switchPart?assert.rejects(sent,/工作表、页面或会话已变化/):sent;await until(()=>entered);
    live={...live,partIndex:switchPart?1:0,layoutRevision:20};sync.resolve();await checked;assert.equal(calls,switchPart?0:1);if(!switchPart){assert.equal(revision,20,'same part uses its newly acknowledged layout');assert.equal(expectedPart,0,'the frozen input part is transmitted rather than derived by the engine');}controller.dispose();
  }
});
test('an explicitly unexecuted stale passive hover keeps its acknowledged sequence and cannot interrupt a committed save',async()=>{
  const sync=deferred<void>();let syncing=false,live=state(),commits=0;const sequences:number[]=[];
  const request:NativeOfficeRequest=async(_method,args={})=>{const event=args.event as OfficeSurfaceInputEvent;sequences.push(Number(args.sequence));if(event.kind==='barrier')commits++;const discarded=event.kind==='pointer'?{code:'STALE_OFFICE_SURFACE_LAYOUT',reason:'The viewport changed before passive hover.'}:undefined;if(discarded)live={...live,layoutRevision:3};return {state:live,streamId:args.streamId,ackSequence:args.sequence,composing:false,discarded} as any;};
  const controller=new OfficeSurfaceInputController('view',{request,state:()=>live,beforeInput:async()=>{},accept:next=>{live=next;}});
  const save=controller.flush(async()=>{syncing=true;await sync.promise;});await until(()=>syncing);
  const hover=await controller.post({...pointer('move',35),buttons:0});assert.equal(hover.discarded?.code,'STALE_OFFICE_SURFACE_LAYOUT');assert.equal(controller.failure,undefined);sync.resolve();await save;await controller.barrier();assert.deepEqual(sequences,[1,2,3],'passive hover is acknowledged once and never reissued');assert.equal(commits,2);controller.dispose();
});
test('a discarded mutation or drag reply remains an unconfirmed edit and is never silently accepted',async()=>{
  for(const event of [{kind:'text',text:'unconfirmed'} as OfficeSurfaceInputEvent,pointer('move',35)]){
    let accepted=0;
    const request:NativeOfficeRequest=async(_method,args={})=>({state:state(),streamId:args.streamId,ackSequence:args.sequence,composing:false,discarded:{code:'STALE_OFFICE_SURFACE_LAYOUT',reason:'invalid mutation discard'}} as any);
    const controller=new OfficeSurfaceInputController('view',{request,state,beforeInput:async()=>{},accept:()=>{accepted++;}});
    await assert.rejects(controller.post(event),/丢弃了需要确认的编辑事件/);assert.equal(accepted,0);assert.ok(controller.failure);controller.dispose();
  }
});
