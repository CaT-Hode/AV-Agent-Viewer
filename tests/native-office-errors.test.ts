import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ViewerError, type NativeOfficeDriver, type NativeOfficeState } from '../packages/contracts/src/index';
import { NativeOfficeError } from '../packages/office-runtime/src/types';
import { normalizeNativeOfficeDriver } from '../packages/document-core/src/native-office-errors';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { blankBytes } from '../packages/document-core/src/fixtures';
import { startServer } from '../apps/local-service/src/server';

test('trusted driver normalizes only known native Error codes and preserves method receivers and existing ViewerErrors',async()=>{
  let error:unknown=new NativeOfficeError('STALE_COORDINATES','布局已变');
  const driver={ async query(){assert.equal(this,driver);throw error;}, async close(){assert.equal(this,driver);throw error;} } as unknown as NativeOfficeDriver;
  const normalized=normalizeNativeOfficeDriver(driver);assert.equal(normalized.commandStatus,undefined);
  await assert.rejects(normalized.query('session','view',{kind:'selection'}),cause=>cause instanceof ViewerError&&cause.code==='STALE_COORDINATES');
  const existing=new ViewerError('DRAFT_CONFLICT','未提交草稿',{scope:'view'});error=existing;await assert.rejects(normalized.close('session'),cause=>cause===existing);
  const unknown=Object.assign(new Error('未知来源'),{code:'DOCUMENT_DATA_CODE'});error=unknown;await assert.rejects(normalized.query('session','view',{kind:'selection'}),cause=>cause===unknown);
  const data={code:'STALE_COORDINATES',message:'这只是数据，不是受信Error'};error=data;await assert.rejects(normalized.query('session','view',{kind:'selection'}),cause=>cause===data);
});

test('real authenticated HTTP preserves native conflict/outcome/pending codes without promoting arbitrary data.code',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'av-native-errors-http-')),core=new ViewerCore(new JsonWorkspaceRepository(join(directory,'workspace.json'))),bytes=await blankBytes('docx'),view=await core.openBytes('actual-source.docx',bytes,'docx');
  let error:unknown,state!:NativeOfficeState;
  const driver:NativeOfficeDriver={
    async open(input){state={sessionId:'native-session',documentId:input.documentId,viewId:input.viewId,format:input.format,engineEpoch:'native-epoch',engineRevision:0,dirty:false};return state;},
    async state(_session,viewId){return {...state,viewId:viewId??view.id};},
    async snapshot(){return {bytes,format:'docx',state,engineRevisionBefore:0,engineRevisionAfter:0,stable:true};},
    async commands(){return [];},async query(){throw error;},async execute(){throw new Error('not used');},async undo(){throw new Error('not used');},async close(){},
  };
  core.registerNativeOfficeDriver(driver);await core.openNativeOffice(view.id);core.registerNativeOfficeDriver(driver); // Re-registering the same actual driver keeps identity stable.
  const runtime=await startServer(core,process.cwd(),directory,0),endpoint='http://127.0.0.1:'+(runtime.server.address() as AddressInfo).port;
  const request=()=>fetch(endpoint+'/api/command',{method:'POST',headers:{Authorization:'Bearer '+runtime.token,'Content-Type':'application/json'},body:JSON.stringify({method:'office-query',args:{viewId:view.id,target:{kind:'selection'}}})});
  try{
    for(const code of ['STALE_COORDINATES','SELECTION_CHANGED','REVISION_CONFLICT','ENGINE_EPOCH_CHANGED','NATIVE_OUTCOME_UNKNOWN','NATIVE_PENDING_INPUT','NATIVE_REQUEST_TIMEOUT','INVALID_NATIVE_STYLE','NATIVE_STYLE_TARGET_UNAVAILABLE','NATIVE_STYLE_FIELD_UNSUPPORTED','NATIVE_STYLE_APPLY_FAILED','NATIVE_STYLE_ROLLBACK_FAILED','NATIVE_STYLE_ROLLBACK_UNVERIFIED','NATIVE_UNDO_BUSY','NATIVE_INPUT_RESTORE_FAILED']){
      error=new NativeOfficeError(code,'受信原生错误');const response=await request();assert.equal(response.status,400);assert.deepEqual((await response.json()).error,{code,message:'受信原生错误'});
    }
    error=Object.assign(new Error('普通错误'),{code:'DOCUMENT_DATA_CODE'});let response=await request();assert.equal(response.status,500);assert.equal((await response.json()).error.code,'INTERNAL_ERROR');
    error={code:'STALE_COORDINATES',message:'非Error数据'};response=await request();assert.equal(response.status,500);assert.equal((await response.json()).error.code,'INTERNAL_ERROR');
  }finally{await new Promise<void>((resolve,reject)=>runtime.server.close(cause=>cause?reject(cause):resolve()));await core.persist();}
});
