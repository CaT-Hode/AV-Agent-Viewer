import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { SettingsSnapshot } from '../packages/settings/src/index';

// Run only after the coordinated source/build freeze, with the UI lock. The
// installed app is never attached to, restarted, or closed by this test.
const require=createRequire(import.meta.url),directory=await mkdtemp(join(tmpdir(),'agentviewer-elegant-motion-')),evidence=join(directory,'evidence');await mkdir(evidence);
await writeFile(join(directory,'settings.json'),JSON.stringify({schemaVersion:1,revision:0,values:{'appearance.motion':'elegant','appearance.glass':'standard','appearance.autoHideToolbar':false,'appearance.theme':'light'}}));
const port=await new Promise<number>((done,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();assert.ok(address&&typeof address!=='string');server.close(error=>error?reject(error):done(address.port));});});
const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is[string,string]=>typeof entry[1]==='string')),AGENTVIEWER_DATA_DIR:directory,AGENTVIEWER_PORT:String(port),AGENTVIEWER_TEST_MODE:'1',AGENTVIEWER_TEST_TRANSLATOR:'1'};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:['.'],cwd:resolve('.'),env,timeout:45000}),main=await app.firstWindow(),errors:string[]=[],results:Record<string,unknown>={};
app.context().on('page',page=>page.on('pageerror',error=>errors.push(error.message)));main.on('pageerror',error=>errors.push(error.message));
const invoke=<T>(page:Page,method:string,args:Record<string,unknown>={})=>page.evaluate(input=>window.agentViewer!.call(input.method,input.args),{method,args})as Promise<T>;
const until=async(predicate:()=>Promise<boolean>,label:string)=>{for(let i=0;i<160;i++){if(await predicate())return;await new Promise(done=>setTimeout(done,40));}throw new Error(label);};
const settingsState=async(page:Page)=>(await invoke<{snapshot:SettingsSnapshot}>(page,'settings-read')).snapshot;
try{
  await main.locator('.prose h1').waitFor();await main.locator('html[data-motion="elegant"]').waitFor();
  const toggle=main.getByRole('button',{name:'目录与结构',exact:true});
  if(!await main.locator('.format-sidebar').count()){await toggle.click();await main.locator('.format-sidebar[data-motion-phase="open"]').waitFor();}
  const shellBefore=await main.locator('.tab-strip').boundingBox();
  await toggle.click();const exiting=main.locator('.format-sidebar');
  assert.equal(await exiting.getAttribute('data-motion-phase'),'exit');assert.notEqual(await exiting.getAttribute('inert'),null);
  assert.equal(await exiting.evaluate(node=>getComputedStyle(node).getPropertyValue('--motion-duration').trim()),'572ms');
  await main.waitForTimeout(110);assert.equal(await exiting.count(),1,'slow exit retains the pane for a visible intermediate frame');
  await main.screenshot({path:join(evidence,'sidebar-mid-exit.png'),scale:'css'});
  await toggle.click();await main.locator('.format-sidebar[data-motion-phase="open"]').waitFor();
  assert.equal(await exiting.getAttribute('inert'),null,'reopening immediately restores interaction');
  await main.waitForTimeout(650);assert.equal(await exiting.count(),1,'the cancelled exit timer cannot later detach the reopened pane');
  assert.deepEqual(await main.locator('.tab-strip').boundingBox(),shellBefore);results.sidebarReversal=true;

  await main.getByRole('button',{name:'新建标签页',exact:true}).click();
  const newDocument=main.getByRole('button',{name:'新建文档',exact:true});await newDocument.click();
  const modal=main.locator('.modal-backdrop');await modal.waitFor();await main.locator('.modal-backdrop[data-motion-phase="open"]').waitFor();
  assert.equal(await modal.evaluate(node=>getComputedStyle(node).getPropertyValue('--motion-duration').trim()),'520ms');
  await modal.locator('.modal-heading button').click();assert.equal(await modal.getAttribute('data-motion-phase'),'exit');
  await main.waitForTimeout(100);assert.equal(await modal.count(),1);
  await newDocument.click();await main.locator('.modal-backdrop[data-motion-phase="open"]').waitFor();
  assert.equal(await modal.getAttribute('inert'),null);await main.waitForTimeout(580);assert.equal(await modal.count(),1);
  await main.keyboard.press('Escape');await modal.waitFor({state:'detached'});results.modalReversalAndKeyboardClose=true;

  await invoke(main,'settings-open',{category:'外观与布局'});await until(async()=>app.context().pages().some(page=>page.url().includes('#/settings')),'settings opens');
  const settings=app.context().pages().find(page=>page.url().includes('#/settings'))!;
  await settings.getByRole('button',{name:'外观与布局',exact:true}).click();
  const motion=settings.getByRole('radiogroup',{name:'动效',exact:true});assert.equal(await motion.getByRole('radio',{name:'优雅',exact:true}).getAttribute('aria-checked'),'true');
  let snapshot=await settingsState(settings),revision=snapshot.revision;
  await motion.getByRole('radio',{name:'标准',exact:true}).click();await settings.locator('html[data-motion="standard"]').waitFor();snapshot=await settingsState(settings);assert.equal(snapshot.revision,revision+1);
  revision=snapshot.revision;await motion.getByRole('radio',{name:'优雅',exact:true}).click();await settings.locator('html[data-motion="elegant"]').waitFor();snapshot=await settingsState(settings);assert.equal(snapshot.revision,revision+1);results.elegantSettingUI=true;
  const autoHide=settings.getByRole('switch',{name:'顶部胶囊自动隐藏',exact:true});await autoHide.scrollIntoViewIfNeeded();await settings.waitForTimeout(800);
  const box=await autoHide.boundingBox();assert.ok(box);const thumb=autoHide.locator('.glass-switch-thumb');
  const initialThumb=await thumb.boundingBox();assert.ok(initialThumb);const initialCenter=initialThumb.x+initialThumb.width/2;
  const startX=initialCenter,y=box.y+box.height/2;
  snapshot=await settingsState(settings);revision=snapshot.revision;const original=snapshot.values['appearance.autoHideToolbar'];
  await settings.mouse.move(startX,y);await settings.mouse.down();await settings.mouse.move(startX+18,y,{steps:3});
  const directThumb=await thumb.boundingBox();assert.ok(directThumb);
  assert.ok(Math.abs((directThumb.x+directThumb.width/2)-initialCenter-18)<1,'switch visual center follows the pointer directly, independently of elastic scale');
  await settings.mouse.move(box.x+46.30375,y,{steps:3});await settings.mouse.up();
  await until(async()=>(await settingsState(settings)).values['appearance.autoHideToolbar']!==original,'switch drag commits');snapshot=await settingsState(settings);assert.equal(snapshot.revision,revision+1,'one drag is one setting transaction');
  await settings.getByRole('button',{name:'撤销上一次设置更改',exact:true}).click();await until(async()=>(await settingsState(settings)).values['appearance.autoHideToolbar']===original,'global undo restores switch');
  await motion.getByRole('radio',{name:'关闭',exact:true}).click();await settings.locator('html[data-motion="off"]').waitFor();
  await settings.waitForTimeout(40);assert.ok(await settings.locator('.glass-elastic').evaluateAll(nodes=>nodes.every(node=>!/(scale|translate)/.test((node as HTMLElement).style.willChange))),'turning motion off releases every temporary compositor hint');
  const offThumb=await thumb.boundingBox();assert.ok(offThumb);const offPosition=offThumb.x+offThumb.width/2;await settings.waitForTimeout(100);const stableThumb=await thumb.boundingBox();assert.ok(stableThumb);assert.ok(Math.abs(stableThumb.x+stableThumb.width/2-offPosition)<.05,'off cancels the running position spring');
  assert.ok(await autoHide.locator('feDisplacementMap').count()>0,'actual compact switch retains its optical field');
  assert.ok(await settings.locator('.liquid-glass-surface').evaluateAll(nodes=>nodes.every(node=>!node.querySelector('feDisplacementMap')||!!node.closest('.glass-switch-thumb,.glass-segmented-thumb,.glass-range-thumb,.glass-preview-lens'))),'ordinary settings surfaces remain frosted; switch/segmented/range thumbs and expanded lens are explicit optical exceptions');
  await motion.getByRole('radio',{name:'优雅',exact:true}).click();await settings.locator('html[data-motion="elegant"]').waitFor();await settings.screenshot({path:join(evidence,'settings-elegant.png'),scale:'css'});await settings.close();results.directDragOneUndoAndOffCancellation=true;

  await main.locator('.tab').filter({hasText:'欢迎.md'}).locator('.tab-select').click();await main.locator('html[data-motion="elegant"]').waitFor();
  await main.locator('.prose p').first().evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
  const tools=main.getByRole('toolbar',{name:'选区工具'});await tools.waitFor();await tools.getByRole('button',{name:'翻译选区',exact:true}).click();
  await main.locator('.translation-result').waitFor();
  // Explicit selection translation presents the same card in the drawer.
  // Closing that drawer exercises the production floating-card path.
  if(await main.locator('.ai-drawer').count()){await main.getByRole('button',{name:'关闭 AI 抽屉',exact:true}).click();await main.locator('.ai-drawer').waitFor({state:'detached'});}
  const popover=main.locator('.translation-popover');await popover.waitFor();await popover.locator('[data-glass-displacement]').waitFor({state:'attached'});await main.locator('.translation-popover[data-motion-phase="open"]').waitFor();
  assert.ok(await popover.locator('.liquid-glass-edge').evaluate(node=>getComputedStyle(node).backdropFilter.includes('url(')),'real floating card uses the attached SVG displacement filter');
  const disclosure=popover.getByRole('button',{name:'查看原文',exact:true});await disclosure.click();await main.locator('.disclosure-body[data-motion-phase="open"]').waitFor();await disclosure.click();
  const body=popover.locator('.disclosure-body');assert.equal(await body.getAttribute('data-motion-phase'),'exit');assert.equal(await disclosure.getAttribute('aria-expanded'),'false');
  await main.waitForTimeout(100);assert.ok(await body.evaluate(node=>node.getBoundingClientRect().height)>10);await disclosure.click();await body.locator(':scope > div').waitFor();await main.waitForTimeout(580);assert.equal(await disclosure.getAttribute('aria-expanded'),'true');
  const transitions=await body.evaluate(node=>getComputedStyle(node).transitionProperty);assert.ok(!/(grid-template-rows|height)/.test(transitions),'disclosure animates presentation, not document geometry');
  await main.getByRole('button',{name:'AI 工具',exact:true}).click();assert.equal(await popover.getAttribute('data-motion-phase'),'exit');await main.waitForTimeout(100);
  const opacityChain=await popover.evaluate(node=>{const chain:{className:string;opacity:number}[]=[];for(let current:Element|null=node;current;current=current.parentElement)chain.push({className:current.className,opacity:Number(getComputedStyle(current).opacity)});return chain;});
  assert.ok(opacityChain.every(item=>item.opacity===1),'real refraction keeps its whole sampling ancestor chain at full opacity during exit');
  const leaves=await popover.locator('.liquid-glass-center,.liquid-glass-edge,.liquid-glass-tint').evaluateAll(nodes=>nodes.map(node=>Number(getComputedStyle(node).opacity)));assert.ok(leaves.some(opacity=>opacity>0&&opacity<1),'optical leaves, rather than their backdrop ancestor, actually fade');
  await main.screenshot({path:join(evidence,'refractive-popover-mid-exit.png'),scale:'css'});await popover.waitFor({state:'detached'});results.disclosureReversalAndLiveBackdropFade={opacityChain,leaves};
  assert.deepEqual(errors,[]);await writeFile(join(evidence,'results.json'),JSON.stringify({...results,errors},null,2));console.log('Elegant UI, direct tracking, reversals, global undo, off cancellation and live backdrop fade: PASS',evidence);
}catch(error){await main.screenshot({path:join(evidence,'failure-main.png'),scale:'css'}).catch(()=>{});for(const page of app.context().pages().filter(page=>page.url().includes('#/settings')))await page.screenshot({path:join(evidence,'failure-settings.png'),scale:'css'}).catch(()=>{});await writeFile(join(evidence,'failure.json'),JSON.stringify({error:String(error),results,errors},null,2));throw error;}finally{await app.close();}
