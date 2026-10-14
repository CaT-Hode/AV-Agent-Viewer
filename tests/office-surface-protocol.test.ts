import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOfficeSurfaceRequest } from '../packages/office-runtime/src/surface-protocol';
import { OFFICE_SURFACE_METHODS as methods } from '../packages/contracts/src/office-surface';
test('private Office surface rejects forged paths, nonfinite coordinates and oversized tile batches', () => {
  const valid = { viewId:'view',layoutRevision:1,renderGeneration:1,partIndex:0,tiles:[{key:'tile',rectTwips:{x:0,y:0,width:7680,height:7680},pixelWidth:512,pixelHeight:512}] };
  assert.deepEqual(validateOfficeSurfaceRequest(methods.tiles,valid),valid);
  assert.throws(()=>validateOfficeSurfaceRequest(methods.tiles,{...valid,adapterPath:'C:\\evil.dll'}));
  assert.throws(()=>validateOfficeSurfaceRequest(methods.tiles,{...valid,tiles:[{...valid.tiles[0],rectTwips:{...valid.tiles[0].rectTwips,x:Infinity}}]}));
  assert.throws(()=>validateOfficeSurfaceRequest(methods.tiles,{...valid,tiles:[0,1].map(i=>({...valid.tiles[0],key:String(i),pixelWidth:4096,pixelHeight:4096}))}));
  assert.throws(()=>validateOfficeSurfaceRequest('office-surface-anything',{viewId:'view'}));
});
test('dialog requests require complete engine/window identity and an ordered input stream',()=>{
  const valid={viewId:'view',sessionId:'session',engineEpoch:'epoch',windowId:1,windowInstanceId:'instance',streamId:'stream',sequence:1,event:{kind:'composition',compositionId:'ime',phase:'update',text:'中文'}};
  assert.deepEqual(validateOfficeSurfaceRequest(methods.windowInput,valid),valid);
  for(const key of ['engineEpoch','windowInstanceId','sequence']){const incomplete={...valid};delete (incomplete as any)[key];assert.throws(()=>validateOfficeSurfaceRequest(methods.windowInput,incomplete));}
  assert.throws(()=>validateOfficeSurfaceRequest(methods.windowInput,{...valid,event:{kind:'paste',items:[{mimeType:'text/plain',data:'not actual IPC binary'}]}}));
});
test('document input must carry a frozen part index while native windows retain their independent coordinate identity',()=>{
  const valid={viewId:'view',streamId:'stream',sequence:1,layoutRevision:3,expectedPartIndex:0,event:{kind:'barrier'}};
  assert.deepEqual(validateOfficeSurfaceRequest(methods.input,valid),valid);
  const missing={...valid};delete (missing as any).expectedPartIndex;assert.throws(()=>validateOfficeSurfaceRequest(methods.input,missing));
  for(const forged of [-1,Infinity,'0',false])assert.throws(()=>validateOfficeSurfaceRequest(methods.input,{...valid,expectedPartIndex:forged}));
  const window={viewId:'view',sessionId:'session',engineEpoch:'epoch',windowId:1,windowInstanceId:'instance',streamId:'stream',sequence:1,event:{kind:'barrier'}};
  assert.deepEqual(validateOfficeSurfaceRequest(methods.windowInput,window),window);
});
