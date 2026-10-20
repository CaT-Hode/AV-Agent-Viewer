import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadingContext } from '../packages/contracts/src/index';
import { SelectionTranslationService } from '../packages/translation/src/selection';
import { fitTranslationCapsule, placeTranslationPopover, shouldCollapseTranslation, translationDragShape, translationTextHeight } from '../apps/desktop/src/renderer/lib/translation-popover';
import { readerPanelDestination } from '../apps/desktop/src/main/reader-panel-policy';
import { floatingOverlap, planFloatingRoom } from '../apps/desktop/src/renderer/lib/floating-hitboxes';
import { TranslationProviderService, providerTargetLanguage, splitTranslationSource } from '../packages/translation/src/providers';

async function providerFixture(request?:typeof fetch,timeoutMs=1000){
  const directory=await mkdtemp(join(tmpdir(),'agentviewer-translation-provider-')),path=join(directory,'providers.json');
  const vault={available:()=>true,encrypt:(value:string)=>Buffer.from('test-vault:'+value).toString('base64'),decrypt:(value:string)=>Buffer.from(value,'base64').toString().slice('test-vault:'.length)};
  const service=new TranslationProviderService(path,vault,{fetch:request,baiduIntervalMs:0,timeoutMs});
  return {service,path,vault};
}
async function verifyProviderProtocols(){
  const calls:{url:string;headers:Headers;body:string}[]=[];
  const request:typeof fetch=async(url,init)=>{
    const call={url:String(url),headers:new Headers(init?.headers),body:String(init?.body)};calls.push(call);
    assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');assert(!call.url.includes('fixture-'));
    if(call.url.includes('googleapis.com')){const data=JSON.parse(call.body);assert.equal(data.format,'text');return Response.json({data:{translations:[{translatedText:data.q.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/'/g,'&#39;')}]}});}
    if(call.url.includes('baidu.com')){const data=new URLSearchParams(call.body);assert.equal(data.get('appid'),'20261020123456');assert.equal(data.get('from'),'auto');assert.equal(data.get('sign'),createHash('md5').update(data.get('appid')!+data.get('q')!+data.get('salt')!+'fixture-baidu').digest('hex'));return Response.json({trans_result:[{src:data.get('q'),dst:data.get('q')}]});}
    assert.equal(call.headers.get('Ocp-Apim-Subscription-Region'),'eastasia');assert.equal(call.headers.get('Ocp-Apim-Subscription-Key'),'fixture-azure');return Response.json([{translations:[{text:JSON.parse(call.body)[0].Text,to:new URL(call.url).searchParams.get('to')}]}]);
  };
  const f=await providerFixture(request),signal=new AbortController().signal;
  await f.service.save({provider:'google',apiKey:'fixture-google-old'});const frozen=f.service.capture('google');
  await f.service.save({provider:'google',apiKey:'fixture-google-new'});assert.notEqual(frozen.fingerprint,f.service.capture('google').fingerprint);
  assert.equal(await frozen.translate("A <tag> & 'quote'",'zh-CN',signal),"A <tag> & 'quote'");assert.equal(calls.at(-1)!.headers.get('X-Goog-Api-Key'),'fixture-google-old');
  assert.equal(JSON.parse(calls.at(-1)!.body).target,'zh-CN');
  const long='  Text 😀 汉字 with word boundaries.\n'.repeat(280),parts=splitTranslationSource(long);
  assert(parts.length>1);assert.equal(parts.join(''),long);assert(parts.every(part=>Buffer.byteLength(part)<=4500&&[...part].length<=3000));
  assert.equal(await f.service.capture('google').translate(long,'en',signal),long);assert.equal(calls.at(-1)!.headers.get('X-Goog-Api-Key'),'fixture-google-new');
  await f.service.save({provider:'baidu',appId:'20261020123456',apiKey:'fixture-baidu'});assert.equal(await f.service.capture('baidu').translate('你好 😀','ja',signal),'你好 😀');assert.equal(new URLSearchParams(calls.at(-1)!.body).get('to'),'jp');
  await f.service.save({provider:'microsoft',apiKey:'fixture-azure',region:'eastasia'});assert.equal(await f.service.capture('microsoft').translate('Traditional Chinese','zh-TW',signal),'Traditional Chinese');assert.equal(new URL(calls.at(-1)!.url).searchParams.get('to'),'zh-Hant');
  assert.equal(providerTargetLanguage('baidu','ko'),'kor');assert.equal(providerTargetLanguage('google','zh-Hant'),'zh-TW');
  const metadata=JSON.stringify(f.service.snapshot()),disk=await readFile(f.path,'utf8');for(const value of ['fixture-google-old','fixture-google-new','fixture-baidu','fixture-azure']){assert(!metadata.includes(value));assert(!disk.includes(value));}
  const loaded=new TranslationProviderService(f.path,f.vault,{fetch:request});await loaded.load();assert.deepEqual(loaded.snapshot(),f.service.snapshot());
  await loaded.save({provider:'google',apiKey:''});await loaded.capture('google').translate('retained key','en',signal);assert.equal(calls.at(-1)!.headers.get('X-Goog-Api-Key'),'fixture-google-new');
  await loaded.remove('google');assert.throws(()=>loaded.capture('google'),{code:'TRANSLATION_CREDENTIAL_REQUIRED'});assert.equal(await frozen.translate('frozen','en',signal),'frozen');
  await assert.rejects(f.service.save({provider:'baidu',appId:'invalid',apiKey:'fixture-baidu'}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(f.service.capture('baidu').translate('hello','xx-ZZ',signal),{code:'TRANSLATION_LANGUAGE_UNSUPPORTED'});
}
async function verifyProviderFailures(){
  const f=await providerFixture(async()=>Response.json({error_code:'54001',error_msg:'fixture-secret-must-not-leak'}));await f.service.save({provider:'baidu',appId:'20261020123456',apiKey:'fixture-baidu'});
  await assert.rejects(f.service.capture('baidu').translate('source','en',new AbortController().signal),(error:Error)=>{assert(!error.message.includes('fixture-secret'));return (error as Error&{code:string}).code==='TRANSLATION_CREDENTIAL_INVALID';});
  const forbidden=await providerFixture(async()=>new Response('secret',{status:403}));await forbidden.service.save({provider:'google',apiKey:'fixture-google'});await assert.rejects(forbidden.service.capture('google').translate('x','en',new AbortController().signal),{code:'TRANSLATION_CREDENTIAL_INVALID'});
  const response=gate<Response>(),pending=await providerFixture(()=>response.promise),controller=new AbortController();await pending.service.save({provider:'google',apiKey:'fixture-google'});
  const flight=pending.service.capture('google').translate('cancel','en',controller.signal),rejected=assert.rejects(flight,{code:'CANCELLED'});controller.abort();await rejected;response.resolve(Response.json({data:{translations:[{translatedText:'late'}]}}));
  const timeout=await providerFixture(()=>new Promise(resolve=>setTimeout(()=>resolve(Response.json({data:{translations:[{translatedText:'late'}]}})),60)),15);await timeout.service.save({provider:'google',apiKey:'fixture-google'});await assert.rejects(timeout.service.capture('google').translate('timeout','en',new AbortController().signal),{code:'REQUEST_TIMEOUT'});
  const huge=await providerFixture(async()=>Response.json({data:{translations:[{translatedText:'x'.repeat(1024*1024)}]}}));await huge.service.save({provider:'google',apiKey:'fixture-google'});await assert.rejects(huge.service.capture('google').translate('x','en',new AbortController().signal),{code:'TRANSLATION_RESPONSE_LIMIT'});
}

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(retainedSources = 128, timeoutMs = 1000) {
  let revision = 0, model = 'model-a';
  let context: ReadingContext = { viewId: 'view', documentId: 'doc', contentRevision: 0, viewRevision: 1, capturedAt: '', quality: 'confirmed', actor: 'human', locator: { kind: 'markdown' }, visibleText: 'Alpha', selection: { kind: 'text', text: 'Alpha', locator: { kind: 'markdown', from: 0, to: 5 } } };
  const calls: { source: string; language: string; model: string; signal: AbortSignal }[] = [];
  let generate = async (source: string, language: string, selected: string) => `${selected}:${language}:${source}`;
  let readContext = async () => context;
  const service = new SelectionTranslationService({ context: () => readContext(), revision: () => revision, capture: connectionId => {
    const selected = connectionId ?? model;
    return { fingerprint: selected, model: selected, translate: (source, language, signal) => { calls.push({ source, language, model: selected, signal }); return generate(source, language, selected); } };
  }, retainedSources, timeoutMs });
  const request = (requestId: string) => ({ requestId, viewId: 'view', text: 'Alpha', sourceRevision: 0, targetLanguage: 'zh-CN' });
  return { service, calls, request, setContext: (next: ReadingContext) => { context = next; }, context: () => context, setRevision: (next: number) => { revision = next; }, setModel: (next: string) => { model = next; }, setGenerate: (next: typeof generate) => { generate = next; }, setReadContext: (next: typeof readContext) => { readContext = next; } };
}

test('selection requests freeze source/locator/model/language, and pinned retry uses saved source after an edit', async () => {
  await verifyProviderProtocols();
  const viewport={x:44,y:60,width:1000,height:700};
  const short=placeTranslationPopover(viewport,{width:314,height:118})!;
  assert.equal(short.edge,'bottom');assert.equal(short.y,624);assert.equal(short.x,387);assert.equal(short.width,314);
  const tall=placeTranslationPopover(viewport,{width:460,height:1000})!;
  assert.equal(tall.height,tall.maxHeight);assert.equal(tall.y+tall.height,742);assert(tall.height<=420);
  const measure=(text:string)=>[...text].length*9,fit=(text:string,ratio=1)=>fitTranslationCapsule(viewport,translationTextHeight(text,measure,30),ratio);
  const tiny=fit('Hello'),medium=fit('A longer translated passage. '.repeat(6)),long=fit('长文本'.repeat(1200));
  assert.deepEqual([tiny.width,tiny.height],[340,118]);assert(medium.height>tiny.height);assert(medium.width>tiny.width);
  if(medium.height<medium.maxHeight&&medium.width<medium.maxWidth)assert(Math.abs((medium.width-340)/(medium.height-118)-1)<.03,'width and height increments follow the configured coefficient');
  assert.equal(long.width,560);assert.equal(long.height,long.maxHeight);assert(long.height>medium.height);
  const adjusted=fit('A longer translated passage. '.repeat(6),.6);assert.equal(adjusted.growthRatio,.6);assert.notDeepEqual(adjusted,medium,'the configured coefficient changes the width/height balance');
  assert.equal(medium.growthRatio,1);assert.equal(fit('Hello',2).growthRatio,1);
  const huge=fit('x'.repeat(100000));assert.equal(huge.width,560);assert.equal(huge.height,huge.maxHeight);
  assert.equal(placeTranslationPopover({...viewport,width:80},{width:314,height:118}),undefined);
  const field={x:0,y:0,width:400,height:200},toolbar={x:0,y:0,width:400,height:160},popup={id:'popup',group:'floating',bounds:{x:150,y:80,width:100,height:20},canMove:true};
  const pushed=planFloatingRoom(toolbar,field,[popup])!;
  assert.equal(pushed.yields.length,1);assert(pushed.yields[0].bounds);assert(!floatingOverlap(pushed.bounds,pushed.yields[0].bounds!));
  const collapsed=planFloatingRoom(toolbar,field,[{...popup,bounds:field,canMove:false,canCollapse:true}])!;
  assert.deepEqual(collapsed.yields,[{id:'popup'}]);
  assert.equal(planFloatingRoom(toolbar,field,[{...popup,bounds:field,canMove:false}]),undefined,'protected surfaces cannot be discarded');
  assert(translationDragShape(0,90).scaleY>1);assert(translationDragShape(0,90).scaleX<1);
  assert(shouldCollapseTranslation({x:2,y:80},0));assert(shouldCollapseTranslation({x:0,y:30},700));
  assert(!shouldCollapseTranslation({x:110,y:80},0));assert(!shouldCollapseTranslation({x:0,y:-90},1000));assert(!shouldCollapseTranslation({x:0,y:12},1000));
  const f = fixture(), answer = gate<string>();
  f.setGenerate(() => answer.promise);
  const pending = f.service.translate('owner', f.request('first'));
  await new Promise(resolve => setImmediate(resolve));
  f.setModel('model-b'); f.setRevision(1);
  f.setContext({ ...f.context(), contentRevision: 1, selection: { kind: 'cells', text: 'Other cells', locator: { kind: 'xlsx', cell: 'B2', sheetId: 'sheet' } } });
  answer.resolve('译文');
  const first = await pending;
  assert.equal(first.model, 'model-a'); assert.equal(first.targetLanguage, 'zh-CN'); assert.equal(first.source, 'Alpha'); assert.equal(first.sourceUpdated, true); assert.deepEqual(first.locator, { kind: 'markdown', from: 0, to: 5 });
  f.setGenerate(async (source, language, model) => `${model}:${language}:${source}`);
  const retry = await f.service.translate('owner', { requestId: 'retry', retryOf: first.requestId, viewId: 'view', text: 'untrusted old text', sourceRevision: 99, targetLanguage: 'EN', connectionId: 'model-c' });
  assert.equal(retry.text, 'model-c:en:Alpha'); assert.equal(retry.sourceRevision, 0); assert.equal(retry.sourceUpdated, true); assert.deepEqual(retry.locator, first.locator);
});

test('cancel rejects immediately and suppresses a driver which ignores its signal', async () => {
  const f = fixture(), answer = gate<string>(); f.setGenerate(() => answer.promise);
  const pending = f.service.translate('owner', f.request('cancelled')), rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.service.cancel('owner', 'view', 'cancelled'), { cancelled: true });
  await rejected; assert.equal(f.calls[0].signal.aborted, true);
  answer.resolve('late result'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.service.cancel('owner', 'view', 'cancelled'), { cancelled: false });
});

test('cancel during context capture never sends the request to a model', async () => {
  const f = fixture(), context = gate<ReadingContext>(); f.setReadContext(() => context.promise);
  const pending = f.service.translate('owner', f.request('early')), rejected = assert.rejects(pending, { code: 'CANCELLED' });
  f.service.cancel('owner', 'view', 'early'); await rejected;
  context.resolve(f.context()); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
});

test('invalid, agent-produced and revision-stale sources are rejected before model use; cells work', async () => {
  const f = fixture();
  f.setContext({ ...f.context(), actor: 'agent' }); await assert.rejects(f.service.translate('owner', f.request('agent')), { code: 'STALE_SELECTION' });
  f.setContext({ ...f.context(), actor: 'human' }); f.setRevision(1); await assert.rejects(f.service.translate('owner', f.request('edited')), { code: 'STALE_SELECTION' });
  f.setRevision(0); f.setContext({ ...f.context(), selection: { ...f.context().selection, kind: 'cells' } }); assert.equal((await f.service.translate('owner', f.request('cells'))).source, 'Alpha');
  assert.equal(f.calls.length, 1);
});

test('saved sources and cancellation cannot cross window/view boundaries', async () => {
  const url='http://localhost:5173/';
  assert.deepEqual(readerPanelDestination(url+'#/reader-panel?side=translation&view=view',url,'agentviewer-reader-panel-translation-view'),{side:'translation',viewId:'view'});
  assert.equal(readerPanelDestination(url+'#/reader-panel?side=translation&view=other',url,'agentviewer-reader-panel-translation-view'),undefined);
  assert.equal(readerPanelDestination('https://external.invalid/#/reader-panel?side=translation&view=view',url,'agentviewer-reader-panel-translation-view'),undefined);
  const f = fixture(); await f.service.translate('owner', f.request('saved'));
  await assert.rejects(f.service.translate('other', { ...f.request('retry-owner'), retryOf: 'saved' }), { code: 'AUTH_SCOPE_DENIED' });
  await assert.rejects(f.service.translate('owner', { ...f.request('retry-view'), viewId: 'other', retryOf: 'saved' }), { code: 'AUTH_SCOPE_DENIED' });
  assert.throws(() => f.service.cancel('other', 'view', 'saved'), { code: 'AUTH_SCOPE_DENIED' });
  assert.equal(f.calls.length, 1);
});

test('same-view pinned request survives cancel of another request, and request IDs cannot be recycled', async () => {
  const f = fixture(), answers = [gate<string>(), gate<string>()]; let index = 0; f.setGenerate(() => answers[index++].promise);
  const pinned = f.service.translate('owner', f.request('pinned')), temporary = f.service.translate('owner', f.request('temporary'));
  const rejected = assert.rejects(temporary, { code: 'CANCELLED' });
  await new Promise(resolve => setImmediate(resolve)); f.service.cancel('owner', 'view', 'temporary'); await rejected;
  assert.equal(f.calls[0].signal.aborted, false); answers[0].resolve('pinned result'); assert.equal((await pinned).text, 'pinned result');
  await assert.rejects(f.service.translate('owner', f.request('pinned')), { code: 'TRANSLATION_REQUEST_EXISTS' }); answers[1].resolve('ignored');
});

test('bounded saved sources expire explicitly, while a validated manual snapshot need not remain selected', async () => {
  const f = fixture(2); const snapshot = structuredClone(f.context());
  f.setContext({ ...f.context(), selection: { kind: 'none', text: '' } });
  const manual = await f.service.translateSnapshot('owner', { requestId: 'manual', viewId: 'view', targetLanguage: 'en' }, snapshot); assert.equal(manual.source, 'Alpha');
  await f.service.translateSnapshot('owner', { requestId: 'second', viewId: 'view', targetLanguage: 'en' }, snapshot);
  await f.service.translateSnapshot('owner', { requestId: 'third', viewId: 'view', targetLanguage: 'en' }, snapshot);
  await assert.rejects(f.service.translate('owner', { ...f.request('expired'), retryOf: 'manual' }), { code: 'TRANSLATION_SOURCE_EXPIRED' });
});

test('timeout, empty output and unsafe language tags fail explicitly, and owner cleanup cancels work', async () => {
  await verifyProviderFailures();
  const f = fixture(128, 10), answer = gate<string>(); f.setGenerate(() => answer.promise);
  await assert.rejects(f.service.translate('owner', f.request('timeout')), { code: 'REQUEST_TIMEOUT' });
  answer.resolve('late'); f.setGenerate(async () => '  '); await assert.rejects(f.service.translate('owner', f.request('empty')), { code: 'TRANSLATION_EMPTY' });
  await assert.rejects(f.service.translate('owner', { ...f.request('bad'), targetLanguage: '../../original' }), { code: 'INVALID_ARGUMENT' });
  const held = gate<string>(); f.setGenerate(() => held.promise); const closing = f.service.translate('owner', f.request('closing')), rejected = assert.rejects(closing, { code: 'CANCELLED' });
  f.service.cancelOwner('owner'); await rejected; held.resolve('late');
  await assert.rejects(f.service.translate('owner', { ...f.request('old'), retryOf: 'empty' }), { code: 'TRANSLATION_SOURCE_EXPIRED' });
});
