import { _electron as electron, type Page, type Locator } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ReadingContext, WorkspaceState } from '../packages/contracts/src/index';
type Rect={x:number;y:number;width:number;height:number};
type Sample={sequence:number;captureBounds:Rect;capsuleBounds:Rect;origin:{x:number;y:number};sourceContentsId:number};
type ToolbarState={viewId:string;backdropSample:Sample;backdropImage:string;backdropDiagnostics:{captures:number;pngEncodes:number}};
const require=createRequire(import.meta.url),directory=await mkdtemp(join(tmpdir(),'agentviewer-tooltip-')),evidence=join(directory,'evidence');await mkdir(evidence);
await writeFile(join(directory,'settings.json'),JSON.stringify({schemaVersion:1,revision:0,values:{'appearance.motion':'elegant','appearance.autoHideToolbar':false,'appearance.theme':'light'}}));
const port=await new Promise<number>((done,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();assert.ok(address&&typeof address!=='string');server.close(error=>error?reject(error):done(address.port));});});
const scale=Number(process.env.AGENTVIEWER_QA_SCALE??1.5);assert.ok([1,1.5,2].includes(scale));
const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((item):item is[string,string]=>typeof item[1]==='string')),AGENTVIEWER_DATA_DIR:directory,AGENTVIEWER_PORT:String(port),AGENTVIEWER_TEST_MODE:'1'};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:['--force-device-scale-factor='+scale,'.'],cwd:resolve('.'),env,timeout:45000}),main=await app.firstWindow(),errors:string[]=[],results:Record<string,unknown>={};
main.on('pageerror',error=>errors.push(error.message));app.context().on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
const invoke=<T>(page:Page,method:string,args:Record<string,unknown>={})=>page.evaluate(input=>window.agentViewer!.call(input.method,input.args),{method,args})as Promise<T>;
const until=async(check:()=>Promise<boolean>,label:string)=>{for(let i=0;i<160;i++){if(await check())return;await new Promise(done=>setTimeout(done,40));}throw new Error(label);};
const beginFrames=(page:Page)=>page.evaluate(`(()=>{window.__tipFrames=[];const tick=()=>{const e=document.querySelector('#app-tooltip');if(e){const c=e.querySelector('.app-tooltip-content'),t=e.querySelector('.liquid-glass-tint');window.__tipFrames.push({ready:e.dataset.tooltipReady,visibility:getComputedStyle(e).visibility,content:Number(getComputedStyle(c).opacity),tint:Number(getComputedStyle(t).opacity),border:getComputedStyle(e).borderTopWidth,shadow:getComputedStyle(e).boxShadow});}window.__tipRAF=requestAnimationFrame(tick);};tick();})()`);
// A retained exit bubble still has ready=true for 420ms. It cannot satisfy
// the next hover's reveal condition, even when its material remains visible.
const readyTip=(page:Page,text:string)=>page.locator('#app-tooltip[data-tooltip-ready=true]:not([aria-hidden=true])').filter({hasText:text}).waitFor();
const checkAtomic=async(page:Page)=>{const frames=await page.evaluate(`(()=>{cancelAnimationFrame(window.__tipRAF);return window.__tipFrames;})()`)as{ready:string;visibility:string;content:number;tint:number;border:string;shadow:string}[];const visible=frames.filter(frame=>frame.visibility==='visible');assert.ok(visible.length>2);assert.ok(visible.every(frame=>Math.abs(frame.content-frame.tint)<.0001),'frame/text/material have exactly the same opacity on every sampled animation frame');assert.ok(visible.every(frame=>parseFloat(frame.border)===0&&frame.shadow==='none'),'host never paints a frame ahead of the words');assert.ok(visible.every(frame=>frame.ready==='true'));return frames;};
const checkGap=async(page:Page,target:Locator)=>{const tip=await page.getByRole('tooltip').boundingBox(),anchor=await target.boundingBox();assert.ok(tip&&anchor);const above=tip.y+tip.height<=anchor.y,gap=above?anchor.y-tip.y-tip.height:tip.y-anchor.y-anchor.height;results.lastGap={url:page.url(),text:await page.getByRole('tooltip').innerText(),tip,anchor,gap,above};assert.ok(Math.abs(gap-7)<.6,'measured tooltip is exactly 7 CSSpx from its control');assert.ok(anchor.x+anchor.width/2>=tip.x-.6&&anchor.x+anchor.width/2<=tip.x+tip.width+.6,'tooltip stays horizontally attached to its source');assert.ok(tip.x>=5.5&&tip.y>=5.5);return{tip,anchor,gap,above};};
const nativeGeometry=async(page:Page,selector:string)=>{const rect=await page.locator(selector).boundingBox();assert.ok(rect);const host=await app.evaluate(({webContents,BrowserWindow},url)=>{const wc=webContents.getAllWebContents().find(w=>w.getURL()===url)!;const owner=BrowserWindow.getAllWindows().find(w=>w.contentView.children.some(v=>'webContents'in v&&(v as any).webContents.id===wc.id))!;const view=owner.contentView.children.find(v=>'webContents'in v&&(v as any).webContents.id===wc.id)!;return{bounds:view.getBounds(),zoom:wc.getZoomFactor()};},page.url());return{rect,host,global:{x:host.bounds.x+rect.x*host.zoom,y:host.bounds.y+rect.y*host.zoom,width:rect.width*host.zoom,height:rect.height*host.zoom}};};
const assertSameRect=(actual:Rect,expected:Rect)=>{for(const key of['x','y','width','height']as const)assert.ok(Math.abs(actual[key]-expected[key])<.5,key+' remains fixed in owner coordinates');};
async function nativeTip(page:Page,selector:string,name:string){
  await until(async()=>{const sample=(await invoke<ToolbarState>(page,'toolbar-state')).backdropSample,box=await page.locator(selector).boundingBox();return!!sample&&!!box&&Math.abs(sample.capsuleBounds.width-box.width)<.5&&Math.abs(sample.capsuleBounds.y-box.y)<.5;},'initial measured source geometry settles');
  const target=page.getByRole('button',{name,exact:true}),before=await nativeGeometry(page,selector),stateBefore=await invoke<ToolbarState>(page,'toolbar-state');
  await page.evaluate(`(()=>{window.__tipPointerLog=[];window.__tipStateLog=[];for(const type of ['pointerover','pointerout','pointermove'])document.addEventListener(type,event=>{const node=event.target instanceof Element?event.target.closest('button'):null;const related=event.relatedTarget instanceof Element?event.relatedTarget.closest('button'):null;window.__tipPointerLog.push({at:performance.now(),type,x:event.clientX,y:event.clientY,screenX:event.screenX,screenY:event.screenY,target:node?.getAttribute('aria-label')||node?.getAttribute('title'),related:related?.getAttribute('aria-label')||related?.getAttribute('title'),relatedTag:event.relatedTarget?.tagName,offset:getComputedStyle(document.documentElement).getPropertyValue('--native-tooltip-offset-y'),height:innerHeight});if(window.__tipPointerLog.length>200)window.__tipPointerLog.shift();},true);window.agentViewer.onToolbar(state=>{if(state.action==='state')window.__tipStateLog.push({at:performance.now(),visible:state.visible,offset:state.tooltipOffsetY,viewId:state.viewId});});})()`);
  results.nativeTipProgress={name,stage:'before-hover',before,stateVisible:(await invoke<Record<string,unknown>>(page,'toolbar-state')).visible,clock:await page.evaluate(()=>performance.now())};
  await beginFrames(page);await target.hover();await readyTip(page,name);results.nativeTipProgress={...results.nativeTipProgress as object,stage:'ready',opened:await nativeGeometry(page,selector),clockReady:await page.evaluate(()=>performance.now())};await page.waitForTimeout(460);
  const geometry=await checkGap(page,target),opened=await nativeGeometry(page,selector);assertSameRect(opened.global,before.global);
  const frames=await checkAtomic(page);const stateOpen=await invoke<ToolbarState>(page,'toolbar-state');assert.deepEqual(stateOpen.backdropSample.captureBounds,stateBefore.backdropSample.captureBounds,'tooltip does not shift the actual body crop');
  await until(async()=>{const sample=(await invoke<ToolbarState>(page,'toolbar-state')).backdropSample,box=await page.locator(selector).boundingBox();return!!sample&&!!box&&Math.abs(sample.capsuleBounds.y-box.y)<.5;},'current sampling geometry includes transparent top gutter');
  const sampled=await invoke<ToolbarState>(page,'toolbar-state');assert.ok(sampled.backdropDiagnostics.captures-stateBefore.backdropDiagnostics.captures<=6,'tooltip animation does not capture every frame');
  const pixels=await app.evaluate(async({nativeImage,webContents},data)=>{const expected=nativeImage.createFromDataURL(data.image),source=webContents.fromId(data.sample.sourceContentsId)!;return expected.toBitmap().equals((await source.capturePage(data.sample.captureBounds)).toBitmap());},{image:sampled.backdropImage,sample:sampled.backdropSample});assert.equal(pixels,true,'tooltip preserves actual sampled document pixels');
  await page.screenshot({path:join(evidence,name+'-'+scale+'.png'),omitBackground:true,scale:'css'});
  await page.mouse.move(1,1);await page.getByRole('tooltip').waitFor({state:'detached'});await until(async()=>{const now=await nativeGeometry(page,selector);return Math.abs(now.host.bounds.height-before.host.bounds.height)<.5;},'native gutter shrinks after exit');
  const after=await nativeGeometry(page,selector);assertSameRect(after.global,before.global);assert.deepEqual(after.host.bounds,before.host.bounds);return{before,opened,after,geometry,frames,sample:sampled.backdropSample};
}
async function rapidTargets(page:Page,firstName:string,secondName:string,nativeSelector?:string){
  const first=page.getByRole('button',{name:firstName,exact:true}),second=page.getByRole('button',{name:secondName,exact:true});
  const before=nativeSelector?await nativeGeometry(page,nativeSelector):undefined;
  await first.hover();await readyTip(page,firstName);
  // The old close stays pending for 420ms. Reverse targets while both its RPC
  // and the next target's hover timer are live; neither may win out of order.
  await second.hover();await page.waitForTimeout(60);await first.hover();
  await readyTip(page,firstName);await page.waitForTimeout(550);
  assert.equal(await page.getByRole('tooltip').innerText(),firstName,'an obsolete request cannot replace the newest target text');
  const anchor=await checkGap(page,first);
  if(nativeSelector){const current=await nativeGeometry(page,nativeSelector);assertSameRect(current.global,before!.global);const state=await invoke<ToolbarState>(page,'toolbar-state');await assert.rejects(invoke(page,'toolbar-tooltip',{ready:-1,viewId:state.viewId,capsuleBounds:{x:0,y:0,width:100,height:30}}),/STALE_TOOLTIP/,'expired ready tickets cannot change actual sampling geometry');assertSameRect((await nativeGeometry(page,nativeSelector)).global,before!.global);}
  // Leave the second target before its 420ms reveal delay. Await the old
  // retained DOM, then wait beyond both delays to detect a late resurrection.
  await second.hover();await page.waitForTimeout(60);await page.mouse.move(nativeSelector?1:700,nativeSelector?1:500);await page.locator('#app-tooltip').waitFor({state:'detached'});await page.waitForTimeout(550);
  assert.equal(await page.locator('#app-tooltip').count(),0,'a tooltip whose target was left cannot appear later');
  let after:Awaited<ReturnType<typeof nativeGeometry>>|undefined;
  if(nativeSelector){await until(async()=>{const current=await nativeGeometry(page,nativeSelector);return current.host.bounds.height===before!.host.bounds.height;},'rapid hover restores the native viewport');after=await nativeGeometry(page,nativeSelector);assertSameRect(after.global,before!.global);assert.deepEqual(after.host.bounds,before!.host.bounds);}
  return{before,after,anchor,latestTarget:firstName,lateTooltipCount:0,expiredTicketRejected:!!nativeSelector};
}
async function selectionTip(fixture:Page,viewId:string){
  // Real mouse selection marks the browser context as human, replacing the
  // preceding Agent input. Nothing is forged in the reader context/snapshot.
  const text=fixture.locator('#selectable');await text.scrollIntoViewIfNeeded();const box=await text.boundingBox();assert.ok(box);
  await fixture.mouse.move(box.x+2,box.y+box.height/2);await fixture.mouse.down();await fixture.mouse.move(box.x+Math.min(220,box.width-3),box.y+box.height/2,{steps:8});await fixture.mouse.up();
  await until(async()=>{const context=await invoke<ReadingContext>(main,'context',{viewId});return context.actor==='human'&&context.selection.text.length>5;},'real human webpage selection');
  await until(async()=>app.context().pages().some(page=>page.url().includes('#/selection-toolbar')),'native selection surface');
  const selection=app.context().pages().find(page=>page.url().includes('#/selection-toolbar'))!;await selection.getByRole('toolbar',{name:'选区工具'}).waitFor();await selection.waitForTimeout(460);
  const target=selection.getByRole('button',{name:'复制选区',exact:true}),before=await nativeGeometry(selection,'.selection-tools');
  const initial=await invoke<{viewId:string;selection:{snapshot:{id:string;context:{selection:{text:string}}}}}>(selection,'toolbar-state');assert.equal(initial.viewId,viewId);
  await beginFrames(selection);await target.hover();await readyTip(selection,'复制选区');await selection.waitForTimeout(460);
  const anchor=await checkGap(selection,target),opened=await nativeGeometry(selection,'.selection-tools');assertSameRect(opened.global,before.global);const frames=await checkAtomic(selection);
  assert.equal(await selection.locator('#app-tooltip .liquid-glass-surface').getAttribute('data-glass-effect'),'frosted');assert.equal(await selection.locator('#app-tooltip svg').count(),0);
  const current=await invoke<typeof initial>(selection,'toolbar-state');assert.equal(current.selection.snapshot.id,initial.selection.snapshot.id);assert.equal(current.selection.snapshot.context.selection.text,initial.selection.snapshot.context.selection.text,'hover preserves the original human selection');
  await selection.screenshot({path:join(evidence,'native-selection-tooltip-'+scale+'.png'),omitBackground:true,scale:'css'});
  await selection.mouse.move(1,1);await selection.locator('#app-tooltip').waitFor({state:'detached'});await until(async()=>(await nativeGeometry(selection,'.selection-tools')).host.bounds.height===before.host.bounds.height,'selection transparent gutter restores');
  assertSameRect((await nativeGeometry(selection,'.selection-tools')).global,before.global);
  const rapid=await rapidTargets(selection,'复制选区','复制引用','.selection-tools');
  await selection.getByRole('button',{name:'关闭选区工具',exact:true}).click();await selection.getByRole('toolbar',{name:'选区工具'}).waitFor({state:'hidden'});
  return{before,opened,anchor,frames,rapid,snapshotId:initial.selection.snapshot.id,sourceText:initial.selection.snapshot.context.selection.text};
}
try{
  await main.locator('.prose h1').waitFor();await main.waitForTimeout(900);
  const left=main.getByRole('button',{name:'目录与结构',exact:true});await main.mouse.move(700,500);await beginFrames(main);await left.hover();await readyTip(main,'目录与结构');await main.waitForTimeout(470);results.localLeft={geometry:await checkGap(main,left),frames:await checkAtomic(main)};
  assert.equal(await main.locator('#app-tooltip .liquid-glass-surface').getAttribute('data-glass-effect'),'frosted');assert.equal(await main.locator('#app-tooltip svg').count(),0);await main.mouse.move(700,500);await main.getByRole('tooltip').waitFor({state:'detached'});
  const help=main.getByRole('button',{name:'帮助',exact:true});await help.hover();await readyTip(main,'帮助');results.localBottom=await checkGap(main,help);await main.mouse.move(700,500);await main.getByRole('tooltip').waitFor({state:'detached'});
  await main.locator('.tab').filter({hasText:'交互测试页'}).locator('.tab-select').click();await until(async()=>app.context().pages().some(page=>page.url().includes('#/web-toolbar')),'native navigation');const nav=app.context().pages().find(page=>page.url().includes('#/web-toolbar'))!;await until(async()=>!!(await invoke<ToolbarState>(nav,'toolbar-state')).backdropSample,'native sample');results.nativeNavigation=await nativeTip(nav,'.navigation-capsule','后退');
  const workspace=await invoke<WorkspaceState>(main,'state'),view=workspace.views.find(item=>item.id===workspace.activeViewId)!,context=await invoke<ReadingContext>(main,'context',{viewId:view.id}),viewport=context.viewport!;
  const connection=JSON.parse(await readFile(join(directory,'runtime/connection.json'),'utf8'))as{endpoint:string;token:string};
  const response=await fetch(connection.endpoint+'/v1/browser/input',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.token},body:JSON.stringify({viewId:view.id,expectedNavigationId:viewport.navigationId,expectedLayoutRevision:viewport.layoutRevision,expectedViewport:{width:viewport.width,height:viewport.height,scrollX:viewport.scrollX,scrollY:viewport.scrollY},action:{kind:'move',x:100,y:220,modifiers:[]},idempotencyKey:crypto.randomUUID()})});assert.equal(response.status,200);
  await until(async()=>app.context().pages().some(page=>page.url().includes('#/agent-toolbar')),'native Agent');const agent=app.context().pages().find(page=>page.url().includes('#/agent-toolbar'))!;await until(async()=>!!(await invoke<ToolbarState>(agent,'toolbar-state')).backdropSample,'Agent sample');results.nativeAgent=await nativeTip(agent,'.agent-operation-capsule','停止 Agent');
  // Finish all baseline scenarios before the additional cancellation checks.
  results.nativeRapidTargets=await rapidTargets(nav,'后退','前进','.navigation-capsule');
  const fixture=app.context().pages().find(page=>page.url().includes('/fixtures/interaction.html'))!;assert.ok(fixture);results.nativeSelection=await selectionTip(fixture,view.id);
  await main.locator('.tab').filter({hasText:'欢迎.md'}).locator('.tab-select').click();await main.locator('.prose h1').waitFor();results.localRapidTargets=await rapidTargets(main,'目录与结构','查找');
  assert.deepEqual(errors,[]);await writeFile(join(evidence,'results.json'),JSON.stringify({scale,...results,errors},null,2));console.log('Synchronized frosted tooltip / measured 7px anchor / native geometry and true pixels / gutter restore: PASS',evidence);
}catch(error){await main.screenshot({path:join(evidence,'failure-main.png'),scale:'css'}).catch(()=>{});const traces=[];for(const page of app.context().pages().filter(page=>page.url().includes('-toolbar'))){await page.screenshot({path:join(evidence,'failure-'+page.url().split('/').at(-1)?.split('?')[0]+'.png'),omitBackground:true,scale:'css'}).catch(()=>{});traces.push({url:page.url(),state:await invoke(page,'toolbar-state').catch(()=>undefined),trace:await page.evaluate(`(()=>({clock:performance.now(),pointer:window.__tipPointerLog,state:window.__tipStateLog,frames:window.__tipFrames,target:[...document.querySelectorAll('button')].map(e=>({name:e.getAttribute('aria-label'),hover:e.matches(':hover'),rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}}))}))()`).catch(()=>undefined)});}await writeFile(join(evidence,'failure.json'),JSON.stringify({error:String(error),results,errors,traces},null,2));throw error;}finally{await app.close();}
