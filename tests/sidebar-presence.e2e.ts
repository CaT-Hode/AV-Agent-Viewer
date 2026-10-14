import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

type Box = { x:number;y:number;width:number;height:number };
type Frame = { time:number;box:Box|null;phase:string|null;canvas?:Box;nav?:Box;panes?:Box[];visibility:string;scale:string|null;translate:string|null };
type SampleWindow = Window & { __sidebarSpringFrames:Frame[];__sidebarSpringFrame:number };
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(),'agentviewer-sidebar-spring-')), evidence = join(directory,'evidence');
await mkdir(evidence);
await writeFile(join(directory,'settings.json'),JSON.stringify({schemaVersion:1,revision:0,values:{'appearance.theme':'light','appearance.motion':'standard','appearance.glass':'standard','appearance.autoHideToolbar':false,'appearance.backgroundMotion':'still'}}));
const port = await new Promise<number>((done,reject) => { const server = createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address = server.address();assert.ok(address && typeof address !== 'string');server.close(error => error ? reject(error) : done(address.port));}); });
const env:Record<string,string> = {...Object.fromEntries(Object.entries(process.env).filter((value):value is [string,string]=>typeof value[1]==='string')),AGENTVIEWER_DATA_DIR:directory,AGENTVIEWER_PORT:String(port),AGENTVIEWER_TEST_MODE:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? 1);
const rendererIndex = await readFile(resolve('dist/renderer/index.html'),'utf8');
const results:Record<string,unknown> = {scale,privateProfile:directory,sourceMainSha:createHash('sha256').update(await readFile(resolve('dist/main/index.cjs'))).digest('hex'),rendererIndex,noOfficeOpened:true,checks:[]};
const checks = results.checks as Record<string,unknown>[], errors:string[] = [];
const app = await electron.launch({executablePath:require('electron'),args:['.','--force-device-scale-factor='+scale,'--disable-backgrounding-occluded-windows'],cwd:resolve('.'),env,timeout:45000}), main = await app.firstWindow();
const watch = (page:Page) => page.on('pageerror',error => errors.push(page.url()+': '+error.message));watch(main);app.context().on('page',watch);
const invoke = (method:string,args:Record<string,unknown>={}) => main.evaluate(value=>window.agentViewer!.call(value.method,value.args),{method,args});
const until = async (check:()=>Promise<boolean>,label:string,limit=160) => { for(let i=0;i<limit;i++){if(await check())return;await main.waitForTimeout(50);}throw new Error('等待失败：'+label); };
const pane = (side:'left'|'right') => '.floating-side-panel[data-side="'+side+'"]:not([data-panel-anchor="true"])';
const canvas = () => main.locator('.workbench > .reader-panel').boundingBox();
const same = (before:Box,after:Box,label:string) => { for(const key of ['x','y','width','height'] as const) assert.ok(Math.abs(before[key]-after[key])<.4,label+' 正文 '+key); };
const overlap = (a:Box,b:Box) => Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>.4 && Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>.4;
async function start(page:Page,side:'left'|'right') {
  // Raw browser code keeps tsx's Node-only keepNames helper out of CDP.
  await page.evaluate(`(() => {
    const selector=${JSON.stringify(pane(side))},state=window;state.__sidebarSpringFrames=[];
    const rect=node=>{const b=node.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};
    const tick=time=>{
      const element=document.querySelector(selector),reader=document.querySelector('.workbench > .reader-panel'),nav=document.querySelector('.reader-toolbar > .navigation-capsule');
      state.__sidebarSpringFrames.push({time,box:element?rect(element):null,phase:element?.dataset.motionPhase??null,canvas:reader?rect(reader):undefined,nav:nav?rect(nav):undefined,panes:reader?[...document.querySelectorAll('.workbench > .floating-side-panel')].map(rect):undefined,visibility:document.visibilityState,scale:element?getComputedStyle(element).scale:null,translate:element?getComputedStyle(element).translate:null});
      state.__sidebarSpringFrame=requestAnimationFrame(tick);
    };state.__sidebarSpringFrame=requestAnimationFrame(tick);
  })()`);
  await page.waitForFunction(()=>((window as unknown as SampleWindow).__sidebarSpringFrames?.length??0)>=2,undefined,{timeout:8000});
}
async function stop(page:Page,label:string,baseline?:Box) {
  const frames = await page.evaluate(()=>{const state=window as unknown as SampleWindow;cancelAnimationFrame(state.__sidebarSpringFrame);return state.__sidebarSpringFrames;});
  assert.ok(frames.length>=5,label+' 实际绘制样本不足');
  if(baseline)for(const frame of frames){if(frame.canvas)same(baseline,frame.canvas,label);if(frame.nav)for(const box of frame.panes??[])assert.ok(!overlap(frame.nav,box),label+' 导航与实际侧栏交叠');}
  checks.push({label,frames});return frames;
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
  await settled(main,side);await start(main,side);await toggle.click();
  await main.waitForFunction(selector=>{const node=document.querySelector<HTMLElement>(selector);return node?.dataset.motionPhase==='exit'&&Number(getComputedStyle(node).getPropertyValue('--sidebar-spring-alpha'))<.95;},pane(side),{timeout:3000});
  const before=await main.locator(pane(side)).boundingBox();assert.ok(before);await toggle.click();
  const after=await main.locator(pane(side)).boundingBox();assert.ok(after);
  assert.ok(Math.abs(after.width-before.width)<8,mode+' '+side+' 途中反向不能跳到终点');await settled(main,side);await main.waitForTimeout(100);const frames=await stop(main,mode+' '+side+' continuous reversal',baseline);
  assert.ok(frames.some(frame=>frame.phase==='exit')&&frames.some(frame=>frame.phase==='enter'),mode+' '+side+' 保留出入两个阶段');
}
let failure:unknown;
try {
  await main.locator('.prose h1').waitFor();await app.evaluate(({BrowserWindow},url)=>{const root=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===url)!;root.setContentSize(1440,900);root.webContents.setBackgroundThrottling(false);root.show();root.focus();},main.url());
  const baseline=(await canvas())!;assert.ok(baseline.width>1100);const sourceBefore=await main.locator('.prose').innerText();
  for(const mode of ['standard','elegant']) {
    await invoke('settings-set',{id:'appearance.motion',value:mode});await settled(main,'left');
    for(const side of ['left','right'] as const) {
      const toggle=main.getByRole('button',{name:side==='left'?'目录与结构':'AI 工具',exact:true});
      if(await main.locator(pane(side)).count()){await start(main,side);await toggle.click();await main.locator(pane(side)).waitFor({state:'detached',timeout:10000});await main.waitForTimeout(100);const closed=await stop(main,mode+' '+side+' close/unmount',baseline);assert.ok(closed.some(frame=>frame.box&&frame.phase==='exit'));assert.equal(closed.at(-1)!.box,null);}
      await start(main,side);await toggle.click();await settled(main,side);await main.waitForTimeout(100);const open=await stop(main,mode+' '+side+' enter/bounce',baseline),rest=(await main.locator(pane(side)).boundingBox())!;bounce(open,side,rest,mode+' '+side);
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
  const web=await invoke('open',{uri:'http://127.0.0.1:'+port+'/fixtures/interaction.html'}) as {id:string};await invoke('activate',{viewId:web.id});const webCanvas=(await canvas())!;
  const route='#/reader-panel?side=right&view='+encodeURIComponent(web.id);await main.getByRole('button',{name:'AI 工具',exact:true}).click();await until(async()=>app.context().pages().some(page=>page.url().includes(route)),'原生网页侧栏');const right=app.context().pages().find(page=>page.url().includes(route))!;await settled(right,'right');
  const nativeGeometry=()=>app.evaluate(({BrowserWindow},input)=>{const root=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===input.root)!,origin=root.getContentBounds(),popup=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===input.popup);return popup?{owner:origin,popup:popup.getContentBounds()}:null;},{root:main.url(),popup:right.url()});
  await start(right,'right');const destroyed=right.waitForEvent('close',{timeout:10000});await right.getByRole('button',{name:'关闭 AI 抽屉',exact:true}).click();
  await right.waitForFunction(selector=>{const node=document.querySelector<HTMLElement>(selector);return node?.dataset.motionPhase==='exit'&&Number(getComputedStyle(node).getPropertyValue('--sidebar-spring-alpha'))<.1;},pane('right'),{timeout:5000});
  const nativeClose=await stop(right,'web real popup exit before teardown');assert.ok(nativeClose.some(frame=>frame.phase==='exit'));await until(async()=>await main.locator('.workbench > .floating-side-panel[data-side="right"]').count()===0,'原生侧栏settle后关闭');await destroyed;
  await main.getByRole('button',{name:'AI 工具',exact:true}).click();await until(async()=>app.context().pages().some(page=>!page.isClosed()&&page.url().includes(route)),'重新创建原生侧栏');const reopened=app.context().pages().find(page=>!page.isClosed()&&page.url().includes(route))!;await reopened.locator(pane('right')).waitFor();await start(reopened,'right');await settled(reopened,'right');await reopened.waitForTimeout(100);const nativeFrames=await stop(reopened,'web real popup enter/bounce'),rest=(await reopened.locator(pane('right')).boundingBox())!;bounce(nativeFrames,'right',rest,'web real popup');same(webCanvas,(await canvas())!,'web popup');
  const geometry=await nativeGeometry();checks.push({label:'web popup actual screen geometry',geometry});
  const popupWidth=await reopened.evaluate(()=>innerWidth);assert.ok(nativeFrames.every(frame=>!frame.box||frame.box.x+frame.box.width<=popupWidth+.6),'原生侧栏实际边缘应位于透明窗体范围内');
  await main.screenshot({path:join(evidence,'web-popup-spring.png'),scale:'css'});await reopened.screenshot({path:join(evidence,'web-popup-material.png'),scale:'css'});
  assert.deepEqual(errors,[]);console.log('真实左右栏弹簧、过冲回弹、反向连续性、关闭卸载、降级及正文/导航范围：PASS');
} catch(error) { failure=error;results.failure=String(error instanceof Error?error.stack:error);try{await main.screenshot({path:join(evidence,'failure.png'),scale:'css'});}catch{} }
finally { await writeFile(join(evidence,'results.json'),JSON.stringify({passed:!failure,errors,results},null,2));await app.close();console.log(evidence); }
if(failure)throw failure;
