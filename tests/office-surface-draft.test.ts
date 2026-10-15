import assert from 'node:assert/strict';
import {test} from 'node:test';
import {flushOfficeSurfaceDraft,officeSurfaceHasDrafts} from '../apps/desktop/src/renderer/lib/office-surface-draft';
import {OfficeSurfaceInputController} from '../apps/desktop/src/renderer/lib/office-surface-controller';
import type {OfficeSurfaceState} from '../packages/contracts/src/office-surface';
const ready:OfficeSurfaceState={surfaceKind:'tiled',viewId:'view',documentId:'doc',sessionId:'session',engineEpoch:'epoch',engineRevision:0,selectionEpoch:0,format:'pptx',status:'ready',dirty:false,sizeTwips:{width:19200,height:10800},parts:[],partIndex:0,layoutRevision:1,renderGeneration:0,eventSequence:0,selectionRects:[]};
test('an initializing reader with no actual edit does not invoke a native barrier while leaving or opening another tab',async()=>{
  let requests=0,syncs=0;
  const controller=new OfficeSurfaceInputController('view',{state:()=>undefined,request:async()=>{requests++;throw new Error('must not initialize Office from a clean flush');},beforeInput:async()=>{},accept:()=>{}});
  assert.equal(officeSurfaceHasDrafts(controller,undefined,undefined),false);await flushOfficeSurfaceDraft(controller,undefined,undefined,async()=>{syncs++;});assert.equal(requests,0);assert.equal(syncs,0);controller.dispose();
});
test('native edit buffers and formula drafts still go through the confirmed barrier and model synchronization',async()=>{
  const calls:string[]=[];let formulaDirty=true;
  const controller=new OfficeSurfaceInputController('view',{state:()=>ready,request:async(_method,args)=>{calls.push(String((args?.event as {kind:string}).kind));return {state:ready,streamId:args?.streamId,ackSequence:args?.sequence,composing:false} as any;},beforeInput:async()=>{},accept:()=>{}});
  const formula={viewId:'view',hasDrafts:()=>formulaDirty,flush:async()=>{calls.push('formula');formulaDirty=false;},discard:()=>{}};
  assert.equal(officeSurfaceHasDrafts(controller,ready,formula),true);await flushOfficeSurfaceDraft(controller,ready,formula,async()=>{calls.push('sync');});assert.deepEqual(calls,['formula','barrier','sync']);
  await flushOfficeSurfaceDraft(controller,{...ready,pendingInput:true},undefined,async()=>{calls.push('native-buffer-sync');});assert.deepEqual(calls.slice(-2),['barrier','native-buffer-sync']);controller.dispose();
});
test('an unconfirmed text dispatch remains a blocking draft and cannot be hidden by the clean-flush fast path',async()=>{
  let requests=0;
  const controller=new OfficeSurfaceInputController('view',{state:()=>ready,request:async(_method,args)=>{requests++;return {state:ready,streamId:args?.streamId,ackSequence:Number(args?.sequence)+1,composing:false} as any;},beforeInput:async()=>{},accept:()=>{}});
  await assert.rejects(controller.post({kind:'text',text:'未确认'}));assert.equal(officeSurfaceHasDrafts(controller,ready,undefined),true);await assert.rejects(flushOfficeSurfaceDraft(controller,ready,undefined,async()=>assert.fail('unconfirmed edit must not synchronize')));assert.equal(requests,1);controller.dispose();
});
