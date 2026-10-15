import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

type Box = { x:number;y:number;width:number;height:number };
type Frame = { time:number;box:Box|null;phase:string|null;canvas?:Box;nav?:Box;panes?:Box[];visibility:string;scale:string|null;translate:string|null;alpha?:number;originRatio?:number;rawOriginRatio?:number;rawScale?:string;rawTranslate?:string;sameNode?:boolean };
type SampleWindow = Window & { __sidebarSpringFrames:Frame[];__sidebarSpringFrame:number };
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(),'agentviewer-sidebar-spring-')), evidence = join(directory,'evidence');
await mkdir(evidence);
await writeFile(join(directory,'settings.json'),JSON.stringify({schemaVersion:1,revision:0,values:{'appearance.theme':'light','appearance.motion':'standard','appearance.glass':'standard','appearance.autoHideToolbar':false,'appearance.backgroundMotion':'still'}}));
const port = await new Promise<number>((done,reject) => { const server = createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address = server.address();assert.ok(address && typeof address !== 'string');server.close(error => error ? reject(error) : done(address.port));}); });
const env:Record<string,string> = {...Object.fromEntries(Object.entries(process.env).filter((value):value is [string,string]=>typeof value[1]==='string')),AGENTVIEWER_DATA_DIR:directory,AGENTVIEWER_PORT:String(port),AGENTVIEWER_TEST_MODE:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? 1);
const releaseExecutable=process.env.AGENTVIEWER_QA_EXE?.trim(),executable=releaseExecutable?resolve(releaseExecutable):require('electron') as string,assetRoot=releaseExecutable?join(dirname(executable),'resources/app/dist'):resolve('dist');
const rendererIndex = await readFile(join(assetRoot,'renderer/index.html'),'utf8');
const results:Record<string,unknown> = {scale,executable,privateProfile:directory,mainSha:createHash('sha256').update(await readFile(join(assetRoot,'main/index.cjs'))).digest('hex'),rendererIndex,noOfficeOpened:true,checks:[]};
const checks = results.checks as Record<string,unknown>[], errors:string[] = [];
const app = await electron.launch({executablePath:executable,args:[...(releaseExecutable?[]:['.']),'--force-device-scale-factor='+scale,'--disable-backgrounding-occluded-windows'],cwd:resolve('.'),env,timeout:45000}), main = await app.firstWindow();
results.launchPid=app.process().pid;results.mainPid=await app.evaluate(()=>process.pid);console.log('Sidebar QA started',JSON.stringify({directory,launchPid:results.launchPid,mainPid:results.mainPid,scale,mainSha:results.mainSha}));
const watch = (page:Page) => page.on('pageerror',error => errors.push(page.url()+': '+error.message));watch(main);app.context().on('page',watch);
const invoke = (method:string,args:Record<string,unknown>={}) => main.evaluate(value=>window.agentViewer!.call(value.method,value.args),{method,args});
const until = async (check:()=>Promise<boolean>,label:string,limit=160) => { for(let i=0;i<limit;i++){if(await check())return;await main.waitForTimeout(50);}throw new Error('等待失败：'+label); };
const pane = (side:'left'|'right') => '.floating-side-panel[data-side="'+side+'"]:not([data-panel-anchor="true"])';
const canvas = () => main.locator('.workbench > .reader-panel').boundingBox();
const same = (before:Box,after:Box,label:string) => { for(const key of ['x','y','width','height'] as const) assert.ok(Math.abs(before[key]-after[key])<.4,label+' 正文 '+key); };
const overlap = (a:Box,b:Box) => Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>.4 && Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>.4;
async function start(page:Page,side:'left'|'right',popupOffset?:{x:number;y:number}) {
  // Raw browser code keeps tsx's Node-only keepNames helper out of CDP.
  await page.evaluate(`(() => {
    const selector=${JSON.stringify(pane(side))},state=window,offset=${JSON.stringify(popupOffset??null)};state.__sidebarSpringFrames=[];state.__sidebarSpringNode=document.querySelector(selector);
    const rect=node=>{const b=node.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};
    const tick=time=>{
      const element=document.querySelector(selector),owner=offset?window.opener:window,reader=owner?.document.querySelector('.workbench > .reader-panel'),nav=owner?.document.querySelector('.reader-toolbar > .navigation-capsule'),style=element?getComputedStyle(element):null,raw=document.querySelector('.reader-panel-backdrop');
      const readerBox=reader?rect(reader):undefined,left=reader?parseFloat(reader.style.getPropertyValue('--navigation-reservation-left')):NaN,right=reader?parseFloat(reader.style.getPropertyValue('--navigation-reservation-right')):NaN;
      const capsule=nav?rect(nav):readerBox&&Number.isFinite(left)&&Number.isFinite(right)?{x:readerBox.x+left,y:readerBox.y+12,width:right-left,height:60}:undefined;
      const panelBox=element?rect(element):null,panes=offset&&panelBox?[{...panelBox,x:panelBox.x+offset.x,y:panelBox.y+offset.y}]:reader?[...owner.document.querySelectorAll('.workbench > .floating-side-panel:not([data-panel-anchor="true"])')].map(rect):undefined;
      state.__sidebarSpringFrames.push({time,box:panelBox,phase:element?.dataset.motionPhase??null,canvas:readerBox,nav:capsule,panes,visibility:document.visibilityState,scale:style?.scale??null,translate:style?.translate??null,alpha:style?Number(style.getPropertyValue('--sidebar-spring-alpha')):undefined,originRatio:element&&style?parseFloat(style.transformOrigin)/(parseFloat(style.width)||1):undefined,rawOriginRatio:raw?parseFloat(getComputedStyle(raw).transformOrigin)/(parseFloat(getComputedStyle(raw).width)||1):undefined,sameNode:!state.__sidebarSpringNode||element===state.__sidebarSpringNode,rawScale:raw?getComputedStyle(raw).scale:undefined,rawTranslate:raw?getComputedStyle(raw).translate:undefined});
      state.__sidebarSpringFrame=requestAnimationFrame(tick);
    };state.__sidebarSpringFrame=requestAnimationFrame(tick);
  })()`);
  await page.waitForFunction(()=>((window as unknown as SampleWindow).__sidebarSpringFrames?.length??0)>=2,undefined,{timeout:8000});
}
async function stop(page:Page,label:string,baseline?:Box) {
  const frames = await page.evaluate(()=>{const state=window as unknown as SampleWindow;cancelAnimationFrame(state.__sidebarSpringFrame);return state.__sidebarSpringFrames;});
  checks.push({label,frames});
  assert.ok(frames.length>=5,label+' 实际绘制样本不足');
  const side=label.includes('left')?'left':label.includes('right')||label.startsWith('web real popup')?'right':undefined;
  if(side)for(const frame of frames)if(frame.box&&frame.scale&&frame.scale!=='none'){assert.ok(Math.abs(frame.originRatio!-(side==='right'?1:0))<.002,label+' 应围绕外侧真实边缘缩放');if(frame.rawOriginRatio!==undefined)assert.ok(Math.abs(frame.rawOriginRatio!-(side==='right'?1:0))<.002,label+' 网页源拷贝与材料使用同一侧缩放原点');}
  for(const frame of frames){if(baseline&&frame.canvas)same(baseline,frame.canvas,label);if(frame.nav){assert.ok(Math.abs(frame.nav.height-60)<.4,label+' 导航高度恒60px');for(const box of frame.panes??[])assert.ok(!overlap(frame.nav,box),label+' 导航与实际侧栏交叠');}}
  return frames;
}
async function settled(page:Page,side:'left'|'right') { await page.waitForFunction(selector=>document.querySelector<HTMLElement>(selector)?.dataset.motionPhase==='open',pane(side),{timeout:10000}); }
function bounce(frames:Frame[],side:'left'|'right',rest:Box,label:string) {
  const boxes=frames.flatMap(frame=>frame.box?[frame.box]:[]), edges=boxes.map(box=>side==='left'?box.x+box.width:box.x), endpoint=side==='left'?rest.x+rest.width:rest.x;
  assert.ok(boxes.length>=5,label+' 动作需要真实边界序列');
  assert.ok(Math.max(...boxes.map(box=>box.width))-Math.min(...boxes.map(box=>box.width))>1,label+' 尺寸应实际变化');
  assert.ok(side==='left'?Math.max(...edges)>endpoint+.15:Math.min(...edges)<endpoint-.15,label+' 应有轻微物理过冲');
  assert.ok(Math.abs(edges.at(-1)!-endpoint)<.4,label+' 回到稳定边界');
}
async function reverse(side:'left'|'right',baseline:Box,mode:string) {
  const toggle=main.getByRole('button',{name:side==='left'?'目录与结构':'AI 工具',exact:true});
  await settled(main,side);const button=(await toggle.boundingBox())!;await start(main,side);await toggle.click();
  await main.waitForFunction(selector=>{const node=document.querySelector<HTMLElement>(selector);return node?.dataset.motionPhase==='exit'&&Number(getComputedStyle(node).getPropertyValue('--sidebar-spring-alpha'))<.6;},pane(side),{timeout:3000});
  await main.mouse.click(button.x+button.width/2,button.y+button.height/2);
  await settled(main,side);await main.waitForTimeout(100);const frames=await stop(main,mode+' '+side+' continuous reversal',baseline);
  assert.ok(frames.some(frame=>frame.phase==='exit')&&frames.some(frame=>frame.phase==='enter'),mode+' '+side+' 保留出入两个阶段');
  assert.ok(frames.filter(frame=>frame.box).every(frame=>frame.sameNode),mode+' '+side+' 反向保留同一DOM和编辑controller');
  const reversed=frames.findIndex((frame,index)=>index>0&&frame.phase==='enter'&&frames[index-1].phase==='exit');assert.ok(reversed>0);
  const before=frames[reversed-1],after=frames[reversed];assert.ok(before.alpha!>0&&after.alpha!<.9,'可见途中反向，不能重置为展开端点');
  assert.ok(Math.abs(after.box!.width-before.box!.width)<Math.max(12,(after.time-before.time)/1000*baseline.width*12),'反向保持逐帧位置连续');
}
function continuousNavigation(frames:Frame[],label:string) {
  const widths=frames.flatMap(frame=>frame.nav?[frame.nav.width]:[]),minimum=Math.min(...widths),maximum=Math.max(...widths);
  if(maximum-minimum<40) { const positions=frames.flatMap(frame=>frame.nav?[frame.nav.x]:[]);assert.ok(Math.max(...positions)-Math.min(...positions)>20,label+' 空间充足时以连续平移避让');assert.ok(new Set(positions.map(x=>Math.round(x))).size>=5,label+' 连续平移应保留多个中间位置');return; }
  const interior=widths.filter(width=>width>minimum+2&&width<maximum-2);
  assert.ok(new Set(interior.map(width=>Math.round(width))).size>=5,label+' 需至少五个真实中间宽度，而非一步裁切');
  for(let i=1;i<frames.length;i++)if(frames[i].nav&&frames[i-1].nav&&frames[i].time-frames[i-1].time<45)assert.ok(Math.abs(frames[i].nav!.width-frames[i-1].nav!.width)<(maximum-minimum)*.4,label+' 逐帧不能跳完整压缩距离');
}
let failure:unknown;
try {
  const width=Number(process.env.AGENTVIEWER_QA_WIDTH??(scale>=2?1080:1440)),height=Number(process.env.AGENTVIEWER_QA_HEIGHT??(scale>=2?676:900));results.clientSize={width,height};
  await main.locator('.prose h1').waitFor();await app.evaluate(({BrowserWindow},input)=>{const root=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===input.url)!;root.setContentSize(input.width,input.height);root.webContents.setBackgroundThrottling(false);root.show();root.focus();},{url:main.url(),width,height});
  const baseline=(await canvas())!;assert.ok(baseline.width>700);const sourceBefore=await main.locator('.prose').innerText();
  for(const mode of ['standard','elegant']) {
    await invoke('settings-set',{id:'appearance.motion',value:mode});await settled(main,'left');
    for(const side of ['left','right'] as const) {
      const toggle=main.getByRole('button',{name:side==='left'?'目录与结构':'AI 工具',exact:true});
      if(await main.locator(pane(side)).count()){await start(main,side);await toggle.click();await main.locator(pane(side)).waitFor({state:'detached',timeout:10000});await main.waitForTimeout(100);const closed=await stop(main,mode+' '+side+' close/unmount',baseline);assert.ok(closed.some(frame=>frame.box&&frame.phase==='exit'));assert.equal(closed.at(-1)!.box,null);}
      await start(main,side);await toggle.click();await settled(main,side);await main.waitForTimeout(500);const open=await stop(main,mode+' '+side+' enter/bounce',baseline),rest=(await main.locator(pane(side)).boundingBox())!;bounce(open,side,rest,mode+' '+side);continuousNavigation(open,mode+' '+side+' 连续nav避让');
      await reverse(side,baseline,mode);
    }
    await main.screenshot({path:join(evidence,mode+'-both-open.png'),scale:'css'});
  }
  for(const mode of ['reduced','off']) {
    await invoke('settings-set',{id:'appearance.motion',value:mode});
    for(const side of ['left','right'] as const) {
      const toggle=main.getByRole('button',{name:side==='left'?'目录与结构':'AI 工具',exact:true});await toggle.click();await main.locator(pane(side)).waitFor({state:'detached',timeout:3000});await toggle.click();await settled(main,side);
      const style=await main.locator(pane(side)).evaluate(node=>({spring:node.getAttribute('data-sidebar-spring'),translate:getComputedStyle(node).translate,scale:getComputedStyle(node).scale}));assert.equal(style.spring,null);assert.equal(style.translate,'none');assert.ok(style.scale==='none'||style.scale==='1');same(baseline,(await canvas())!,mode+' '+side);checks.push({label:mode+' '+side+' fallback',style});
    }
  }
  assert.equal(await main.locator('.prose').innerText(),sourceBefore,'动效不改变文档内容');
  await main.getByRole('button',{name:'AI 工具',exact:true}).click();await main.locator(pane('right')).waitFor({state:'detached'});
  await invoke('settings-set',{id:'appearance.motion',value:'elegant'});
  const web=await invoke('open',{uri:'http://127.0.0.1:'+port+'/fixtures/interaction.html'}) as {id:string};await invoke('activate',{viewId:web.id});await main.locator('.reader-format-web').waitFor();const webCanvas=(await canvas())!;
  await until(async()=>app.context().pages().some(page=>!page.isClosed()&&page.url().includes('#/web-toolbar')),'真实网页导航宿主');const webToolbar=app.context().pages().find(page=>!page.isClosed()&&page.url().includes('#/web-toolbar'))!;await webToolbar.locator('.navigation-capsule').waitFor();
  const route='#/reader-panel?side=right&view='+encodeURIComponent(web.id);await main.getByRole('button',{name:'AI 工具',exact:true}).click();await until(async()=>app.context().pages().some(page=>page.url().includes(route)),'原生网页侧栏');const right=app.context().pages().find(page=>page.url().includes(route))!;await settled(right,'right');
  const nativeGeometry=(target:Page)=>app.evaluate(({BrowserWindow},input)=>{const root=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===input.root)!,origin=root.getContentBounds(),popup=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===input.popup);return popup?{owner:origin,popup:popup.getContentBounds(),zoom:root.webContents.getZoomFactor()}:null;},{root:main.url(),popup:target.url()});
  const firstGeometry=(await nativeGeometry(right))!;await start(webToolbar,'right');await start(right,'right',{x:(firstGeometry.popup.x-firstGeometry.owner.x)/firstGeometry.zoom,y:(firstGeometry.popup.y-firstGeometry.owner.y)/firstGeometry.zoom});const destroyed=right.waitForEvent('close',{timeout:10000});await right.getByRole('button',{name:'关闭 AI 抽屉',exact:true}).click();
  await right.waitForFunction(selector=>{const node=document.querySelector<HTMLElement>(selector);return node?.dataset.motionPhase==='exit'&&Number(getComputedStyle(node).getPropertyValue('--sidebar-spring-alpha'))<.1;},pane('right'),{timeout:5000});
  const nativeClose=await stop(right,'web real popup exit before teardown',webCanvas);assert.ok(nativeClose.some(frame=>frame.phase==='exit'));await until(async()=>await main.locator('.workbench > .floating-side-panel[data-side="right"]').count()===0,'原生侧栏settle后关闭');await destroyed;await webToolbar.waitForTimeout(500);await stop(webToolbar,'web native capsule actual height through closing');
  await start(webToolbar,'right');await main.getByRole('button',{name:'AI 工具',exact:true}).click();await until(async()=>app.context().pages().some(page=>!page.isClosed()&&page.url().includes(route)),'重新创建原生侧栏');const reopened=app.context().pages().find(page=>!page.isClosed()&&page.url().includes(route))!;await reopened.locator(pane('right')).waitFor();const reopenGeometry=(await nativeGeometry(reopened))!;await start(reopened,'right',{x:(reopenGeometry.popup.x-reopenGeometry.owner.x)/reopenGeometry.zoom,y:(reopenGeometry.popup.y-reopenGeometry.owner.y)/reopenGeometry.zoom});await settled(reopened,'right');await reopened.waitForTimeout(500);const nativeFrames=await stop(reopened,'web real popup enter/bounce',webCanvas),rest=(await reopened.locator(pane('right')).boundingBox())!;bounce(nativeFrames,'right',rest,'web real popup');continuousNavigation(await stop(webToolbar,'web native capsule actual continuous geometry'),'web 统一nav连续避让');same(webCanvas,(await canvas())!,'web popup');
  const geometry=(await nativeGeometry(reopened))!,anchor=(await main.locator('.floating-side-panel[data-side="right"][data-panel-anchor="true"]').boundingBox())!;
  assert.ok(Math.abs(rest.x+(geometry.popup.x-geometry.owner.x)/geometry.zoom-anchor.x)<.6,'真实popup与owner anchor横向对齐');assert.ok(Math.abs(rest.y+(geometry.popup.y-geometry.owner.y)/geometry.zoom-anchor.y)<.6,'真实popup与owner anchor纵向对齐');
  for(const frame of nativeFrames)if(frame.box&&frame.rawScale){assert.equal(frame.rawScale,frame.scale,'网页正文源拷贝与侧栏变形一致');assert.equal(frame.rawTranslate,frame.translate,'网页正文源拷贝与侧栏位置一致');}
  checks.push({label:'web popup actual screen geometry',geometry,anchor,rest});
  const popupWidth=await reopened.evaluate(()=>innerWidth);assert.ok(nativeFrames.every(frame=>!frame.box||frame.box.x>=-.6&&frame.box.x+frame.box.width<=popupWidth+.6),'原生侧栏两侧实际圆角边缘应位于透明窗体范围内');
  await main.screenshot({path:join(evidence,'web-popup-spring.png'),scale:'css'});await reopened.screenshot({path:join(evidence,'web-popup-material.png'),scale:'css'});
  assert.ok(checks.some(check=>{const frames=check.frames as Frame[]|undefined,widths=frames?.flatMap(frame=>frame.nav?[frame.nav.width]:[])??[];return widths.length>5&&Math.max(...widths)-Math.min(...widths)>40;}),'至少一组真实wide→compressed width过渡得到逐帧验收');
  assert.deepEqual(errors,[]);console.log('真实左右栏弹簧、过冲回弹、反向连续性、关闭卸载、降级及正文/导航范围：PASS');
} catch(error) { failure=error;results.failure=String(error instanceof Error?error.stack:error);try{await main.screenshot({path:join(evidence,'failure.png'),scale:'css'});}catch{} }
finally {
  const child=app.process(),exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((done,reject)=>{if(child.exitCode!==null){done({code:child.exitCode,signal:child.signalCode});return;}const timer=setTimeout(()=>reject(new Error('私有弹簧QA未自然退出')),20000);child.once('exit',(code,signal)=>{clearTimeout(timer);done({code,signal});});});
  await app.close();results.exit=await exit;const status=results.exit as {code:number|null;signal:NodeJS.Signals|null};assert.equal(status.code,0);assert.equal(status.signal,null);
  await writeFile(join(evidence,'results.json'),JSON.stringify({passed:!failure,errors,results},null,2));console.log(evidence);
}
if(failure)throw failure;
