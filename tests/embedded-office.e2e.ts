import assert from 'node:assert/strict';
import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRegistry } from '../packages/format-adapters/src/index';

import type { DocumentModel, NativeOfficeState, NativeOfficeStyleInspection, NativeOfficeStyleTarget, ReadingContext, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';
import type { OfficeSurfaceDialogNode, OfficeSurfaceState, OfficeSurfaceWindow, OfficeSurfaceWindowPaintReply } from '../packages/contracts/src/office-surface';
import { officeTileRgba } from '../apps/desktop/src/renderer/lib/office-surface-pixels';
import { officePresentationFit } from '../apps/desktop/src/renderer/lib/office-presentation-fit';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

import { ownedProcessTree, type OwnedProcessIdentity } from './helpers/owned-process-tree';
import { recordCurrentBuild } from './helpers/current-build';
import { verifyOfficeElasticity } from './helpers/reader-motion';

const qaOnly = process.env.AGENTVIEWER_QA_ONLY ?? '';
assert.ok(qaOnly === '' || qaOnly === 'theme' || qaOnly === 'ppt-selection', 'AGENTVIEWER_QA_ONLY supports an empty default flow, theme or ppt-selection diagnostic');
const themeOnly = qaOnly === 'theme';

// Real Electron + desktop IPC + the direct DLL writer. Every editable file and profile is a TEMP copy.
// Playwright is used because a Browser plugin/browser skill is not available in this test runner.
// CDP Input is genuine Chromium composition, not a synthetic DOM event or a claim of OS Pinyin coverage.
const require = createRequire(import.meta.url), executable = require('electron') as string, run = promisify(execFile);
if (process.env.AGENTVIEWER_QA_EXE?.trim()) throw new Error('UNVERIFIED_DESKTOP_TARGET: this suite only accepts the current production build.');
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-embedded-office-'));
const evidence = process.env.AGENTVIEWER_QA_DIR ? join(resolve(process.env.AGENTVIEWER_QA_DIR), 'embedded-office') : join(directory, 'evidence'); await mkdir(evidence, { recursive: true });
await recordCurrentBuild(evidence);
const names = { docx: '03-潮灯町的第十三夜.docx', pptx: '04-故事介绍.pptx', xlsx: '02-编年表.xlsx' } as const;

const originals = new Map<string, Buffer>();
const originalPaths = new Map<string, string>();
for (const name of Object.values(names)) { const source = resolve('examples/moon-tide', name); const bytes = await readFile(source); originalPaths.set(name, source); originals.set(name, bytes); await writeFile(join(directory, name), bytes); }
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_ISOLATED_QA:'1', AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_CONNECTION_FILE: join(directory, 'runtime', 'connection.json') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'AGENTVIEWER_TEST_MODE', 'AGENTVIEWER_TEST_TRANSLATOR', 'AGENTVIEWER_VITE_URL', 'AGENTVIEWER_OFFICE_WORKER_MODE']) delete (env as Record<string, string>)[key];
const scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? 1), token = randomUUID().slice(0, 8), marker = 'Kit人类编辑-' + token;

const launchedAt=Date.now(),app = await electron.launch({ executablePath: executable, args: ['.', '--force-device-scale-factor=' + scale], cwd: resolve('.'), env, timeout: 60000 });
const main = await app.firstWindow(), primary = app.process();
const qaWidth=Number(process.env.AGENTVIEWER_QA_WIDTH??1440),qaHeight=Number(process.env.AGENTVIEWER_QA_HEIGHT??900);
assert.ok(qaWidth>=900&&qaHeight>=600,'QA stays within the supported desktop client size');
await app.evaluate(({BrowserWindow},value)=>{const root=BrowserWindow.getAllWindows()[0];root.setContentSize(value.width,value.height);root.show();root.focus();},{width:qaWidth,height:qaHeight});
const errors: string[] = [], stderr: string[] = [], results: Record<string, unknown> = {clientSize:{width:qaWidth,height:qaHeight}}, workerPids = new Set<number>();

primary.stderr?.on('data', value => stderr.push(String(value)));
const watch = (page: Page) => { page.on('pageerror', error => errors.push(page.url() + ': ' + error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(page.url() + ': ' + entry.text()); }); };
app.context().pages().forEach(watch); app.context().on('page', watch);
// Trace real IPC metadata without changing any arguments, return values or engine calls.
await app.evaluate(({ipcMain,BrowserWindow,app})=>{
  const handlers=(ipcMain as unknown as {_invokeHandlers:Map<string,(...args:any[])=>Promise<any>>})._invokeHandlers, original=handlers.get('agentviewer:command');
  if(!original)throw new Error('actual command handler missing');
  const trace:any[]=[];(ipcMain as any).__officeQaTrace=trace;
  const lifecycle={write(kind:string,details:Record<string,unknown>={}){process.stderr.write('Office QA lifecycle '+JSON.stringify({kind,at:Date.now(),...details})+'\n');}};
  app.on('before-quit',()=>lifecycle.write('before-quit'));
  for(const window of BrowserWindow.getAllWindows()){
    window.on('close',()=>lifecycle.write('window-close',{windowId:window.id,trace:trace.slice(-10)}));
    window.webContents.on('render-process-gone',(_event,details)=>lifecycle.write('renderer-gone',{windowId:window.id,...details}));
  }
  handlers.set('agentviewer:command',async(event:any,request:any)=>{
    const method=request.method,args=request.args;
    if(method==='window-control')lifecycle.write('window-control',{action:args?.action});
    const isInput=method==='office-surface-input';
    const item:any={method,at:Date.now(),viewId:args?.viewId,args:isInput?{streamId:args.streamId,sequence:args.sequence,layoutRevision:args.layoutRevision,expectedPartIndex:args.expectedPartIndex,event:{kind:args.event?.kind,phase:args.event?.phase,key:args.event?.key,code:args.event?.code,button:args.event?.button,buttons:args.event?.buttons,textLength:args.event?.text?.length,pointTwips:args.event?.pointTwips}}:['office-surface-layout','office-layout','office-surface-window-paint','zoom'].includes(method)?args:undefined};
    const isTile=method==='office-surface-tiles',observed=isInput||isTile||['office-surface-layout','office-layout','office-surface-state','office-surface-window-paint','office-flush','office-query','office-command-status','office-execute','selection-context','selection-tools','selection-action','zoom'].includes(method);
    try {
      const result=await original!(event,request);
      // Only delay genuine read-only replies. Native buffers and all mutation
      // arguments/results remain unchanged; the UI must survive slow delivery.
      if(isTile&&(ipcMain as any).__officeQaTileDelay)await new Promise(done=>setTimeout(done,Math.min(2000,(ipcMain as any).__officeQaTileDelay)));
      if(observed){
        const state=result?.state??result;
        item.elapsedMs=Date.now()-item.at;if(isTile)item.args={layoutRevision:args?.layoutRevision,renderGeneration:args?.renderGeneration,partIndex:args?.partIndex,tileCount:args?.tiles?.length};
        item.result={viewId:state?.viewId,sessionId:state?.sessionId,nativeGeometry:state?.nativeGeometry,visible:state?.visible,layoutRevision:state?.layoutRevision,eventSequence:state?.eventSequence,engineRevision:state?.engineRevision,pendingInput:state?.pendingInput,caretVisible:state?.caretVisible,formulaLength:state?.formula?.length,selection:state?.selection?{kind:state.selection.kind,range:state.selection.range,textLength:state.selection.text?.length}:undefined,ackSequence:result?.ackSequence,composing:result?.composing,discarded:result?.discarded,windows:state?.windows?.map((window:any)=>({id:window.id,generation:window.generation,width:window.width,height:window.height}))};
        trace.push(item);if(trace.length>2000)trace.shift();
      }
      return result;
    } catch(cause){if(observed){item.error=String(cause);if(String(cause).includes('INVALID_NATIVE_LAYOUT')){const receiver=BrowserWindow.fromWebContents(event.sender);item.owner=receiver?{id:receiver.id,bounds:receiver.getBounds(),content:receiver.getContentBounds(),visible:receiver.isVisible(),minimized:receiver.isMinimized(),zoom:event.sender.getZoomFactor(),url:event.sender.getURL()}:undefined;}trace.push(item);}throw cause;}
  });
});
await main.evaluate(()=>{
  const performanceLog:{longTasks:{at:number;duration:number}[];selection:{viewId:string;lease:string;projectedAt?:number;readyAt:number;paintedAt?:number}[]}={longTasks:[],selection:[]};
  (window as any).__officeQaPerformance=performanceLog;
  try{new PerformanceObserver(list=>{for(const entry of list.getEntries()){performanceLog.longTasks.push({at:entry.startTime,duration:entry.duration});if(performanceLog.longTasks.length>300)performanceLog.longTasks.shift();}}).observe({entryTypes:['longtask']});}catch{}
  const projections=new Map<string,{key:string;at:number}>();
  window.addEventListener('agentviewer:office-surface-selection',(event:Event)=>{const data=(event as CustomEvent).detail;if(!data?.viewId)return;const key=JSON.stringify([data.sessionId,data.engineEpoch,data.engineRevision,data.selectionEpoch]);if(projections.get(data.viewId)?.key!==key)projections.set(data.viewId,{key,at:performance.now()});});
  window.addEventListener('agentviewer:office-surface-selection-tools',(event:Event)=>{const data=(event as CustomEvent).detail;if(!data?.visible||!data.state||performanceLog.selection.at(-1)?.lease===data.lease)return;const sample={viewId:data.viewId,lease:data.lease,projectedAt:projections.get(data.viewId)?.at,readyAt:performance.now(),paintedAt:undefined as number|undefined};performanceLog.selection.push(sample);if(performanceLog.selection.length>100)performanceLog.selection.shift();requestAnimationFrame(()=>requestAnimationFrame(()=>{const toolbar=document.querySelector('.selection-tools[role="toolbar"]');if(toolbar&&getComputedStyle(toolbar).visibility!=='hidden'&&toolbar.querySelector('button:not(:disabled)'))sample.paintedAt=performance.now();}));});
});
// Observe the actual runtime's bootstrap receipt before the first Office load.
// This hook only records allowlisted diagnostic codes and preserves emit's result.
await app.evaluate(()=>{
  const emitter=(process.getBuiltinModule('node:events') as unknown as {EventEmitter:{prototype:{emit:(type:string,...args:unknown[])=>boolean}}}).EventEmitter.prototype,original=emitter.emit;
  const receipts:{code:string;at:number;elapsedMs?:number}[]=[];(globalThis as any).__officeQaBootstrap=receipts;
  emitter.emit=function(this:unknown,type:string,...args:unknown[]){const message=args[0] as {code?:unknown;elapsedMs?:number}|undefined;if(type==='diagnostic'&&typeof message?.code==='string'&&message.code.startsWith('OFFICE_KIT_'))receipts.push({code:message.code,at:Date.now(),elapsedMs:message.elapsedMs});return original.call(this,type,...args);};
});
const until = async (check: () => Promise<boolean>, label: string, timeout = 30000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 90)); } throw new Error('Embedded Office acceptance timed out: ' + label); };
const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => main.evaluate(value => window.agentViewer!.call(value.method, value.args), { method, args }) as Promise<T>;
const workspace = () => invoke<WorkspaceState>('state');
const status = (view: ViewInfo) => invoke<OfficeSurfaceState>('office-surface-state', { viewId: view.id });
// A DOM scroll can enqueue one final native layout after the state read that
// triggered it. Coordinate tools must keep their strict version check, so the
// acceptance path waits for two identical live layout receipts before sending
// the coordinate action instead of retrying a stale action with changed bounds.
const stableStatus = async (view: ViewInfo) => {
  let previous: OfficeSurfaceState | undefined, stableSince=0;
  await until(async () => {
    const next = await status(view);
    // A DOM Home/End or scrollbar drag emits `scroll` before the renderer's
    // serialized surface layout reaches the native session. Two identical
    // status receipts alone can therefore still describe the previous
    // scroll position. Wait until the native viewport agrees with the live
    // DOM scroll offsets as well, then keep the existing revision guard.
    const domScroll = await main.locator(`.embedded-office-content[data-office-surface="${view.id}"]`).evaluate(node => ({ x: node.scrollLeft, y: node.scrollTop, width:node.clientWidth, height:node.clientHeight }));
    const nativeScroll = next.viewport ? { x: next.viewport.scrollX, y: next.viewport.scrollY } : undefined;
    const sameScroll = typeof nativeScroll?.x === 'number' && typeof nativeScroll.y === 'number' && Math.abs(nativeScroll.x - domScroll.x) <= 1 && Math.abs(nativeScroll.y - domScroll.y) <= 1;
    const sameViewport=!!next.viewport&&Math.abs(next.viewport.width-domScroll.width)<=1&&Math.abs(next.viewport.height-domScroll.height)<=1;
    const stable = !!previous && next.layoutRevision === previous.layoutRevision && next.eventSequence === previous.eventSequence && sameScroll&&sameViewport;
    if(!stable)stableSince=Date.now();
    previous = next;
    return stable&&Date.now()-stableSince>=200;
  }, 'native Office layout settles before coordinate input', 10000);
  return previous!;
};
const version = (state: NativeOfficeState) => ({ expectedEngineEpoch: state.engineEpoch, expectedEngineRevision: state.engineRevision, expectedSelectionEpoch: state.selectionEpoch });
const model = (view: ViewInfo) => invoke<DocumentModel>('read', { documentId: view.documentId });
const navigate = async (view: ViewInfo, target: Record<string, unknown>) => { const current = await status(view); await invoke('office-navigate', { viewId: view.id, ...version(current), target, idempotencyKey: randomUUID() }); };
const ready = async (view: ViewInfo) => {
  await main.locator(`.embedded-office-document[data-office-ready="true"] .embedded-office-content[data-office-surface="${view.id}"]`).waitFor({ timeout: 120000 });
  let actual: OfficeSurfaceState | undefined, diagnosed=false; const start=Date.now();
  try { await until(async () => { actual = await status(view); const valid=actual.surfaceKind === 'tiled' && actual.status === 'ready' && actual.nativeGeometry === true && actual.visible === true && actual.layoutRevision > 0;if(!valid&&!diagnosed&&Date.now()-start>5000){diagnosed=true;await writeFile(join(evidence,'pending-layout.json'),JSON.stringify({viewId:view.id,state:actual,dom:await main.locator('.embedded-office-content').evaluate(node=>({bounds:node.getBoundingClientRect().toJSON(),hidden:document.hidden,scrollTop:node.scrollTop,scrollLeft:node.scrollLeft})),trace:await app.evaluate(({ipcMain})=>(ipcMain as any).__officeQaTrace)},null,2));}return valid; }, 'actual tiled layout: ' + view.id, 120000); }
  catch(cause) { results.unreadySurface={viewId:view.id,state:actual,dom:await main.locator('.embedded-office-content').evaluate(node=>({bounds:node.getBoundingClientRect().toJSON(),hidden:document.hidden,scrollTop:node.scrollTop,scrollLeft:node.scrollLeft}))}; throw cause; }
  assert.equal(actual!.viewId, view.id); assert.equal(actual!.documentId, view.documentId); assert.equal(actual!.nativeHwnd, '0', 'renderer body must be DOM/Canvas rather than an embedded Office frame');
  assert.ok(actual!.nativePid! > 0); workerPids.add(actual!.nativePid!);
  const transport = (await invoke<{ transport?: string }>('office-statistics')).transport;
  assert.equal(transport, 'binary', 'The current production build must present actual native tiles through v2');
  results.nativeTransport = transport;
  (results.readySurfaces??=[] as unknown[]);(results.readySurfaces as unknown[]).push({viewId:view.id,state:actual});
  assert.equal(await main.locator('.native-office-surface,.native-office-placeholder,.office-editing-ribbon').count(), 0);
  await until(async () => main.locator('.embedded-office-canvas').evaluate(canvas => { const target = canvas as HTMLCanvasElement, context = target.getContext('2d'); if (!context || !target.width || !target.height || !target.dataset.officeFrameRevision) return false; const pixels = context.getImageData(0, 0, target.width, target.height).data, colors = new Set<number>(); for (let i = 0; i < pixels.length; i += Math.max(4, Math.floor(pixels.length / 100000 / 4) * 4)) if (pixels[i + 3]) { colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]); if (colors.size > 12) return true; } return false; }), 'paintTile contains actual text and lines');
  return actual!;
};
const open = async (format: keyof typeof names) => {
  const before=await invoke<any>('office-statistics'),started=Date.now(),view=await invoke<ViewInfo>('open', { uri: join(directory, names[format]) }),openedAt=Date.now();
  await until(async () => (await workspace()).activeViewId === view.id, 'desktop IPC opened view');const activeAt=Date.now();
  await main.locator(`.embedded-office-document[data-office-ready="true"] .embedded-office-content[data-office-surface="${view.id}"]`).waitFor({timeout:120000});const canvasReadyAt=Date.now();
  await ready(view);const paintedAt=Date.now(),runtime=await invoke<any>('office-statistics');
  const firstLayout=await app.evaluate(({ipcMain},viewId)=>((ipcMain as any).__officeQaTrace as any[]).find(item=>item.viewId===viewId&&item.method==='office-surface-layout'&&item.args?.visible===true),view.id);
  assert.ok(firstLayout?.result?.visible&&firstLayout.result.nativeGeometry,'the mounted renderer receives drawable geometry before its first presentation, without waiting for a heartbeat refresh');
  ((results.openTimings??=[]) as unknown[]).push({format,viewId:view.id,sampleBytes:originals.get(names[format])!.length,engineProcessStarted:before.started,engineWasReady:typeof before.startupMs==='number',appElapsedAtOpenMs:started-launchedAt,rpcMs:openedAt-started,activeMs:activeAt-started,canvasReadyMs:canvasReadyAt-started,verifiedPaintMs:paintedAt-started,runtime});
  return view;
};
const settleInput = async (view: ViewInfo) => until(async () => { const state = await status(view); return state.inputAck?.composing !== true && !state.pendingInput; }, 'actual input/IME settled');
const humanFocus = async (view: ViewInfo, cursor: 'caret' | 'cell' | 'object' = 'caret') => {
  results.focusAttempt={viewId:view.id,cursor,state:await status(view),dom:await main.locator('.embedded-office-content').evaluate(node=>({bounds:node.getBoundingClientRect().toJSON(),hidden:document.hidden,scrollTop:node.scrollTop,scrollLeft:node.scrollLeft,scrollWidth:node.scrollWidth,scrollHeight:node.scrollHeight,clientWidth:node.clientWidth,clientHeight:node.clientHeight}))};
  const selector = cursor === 'cell' ? '.embedded-office-cell-cursor' : cursor === 'object' ? '.embedded-office-object-selection' : '.embedded-office-caret,.embedded-office-selection';
  await until(async () => { const box = await main.locator(selector).first().boundingBox(), viewport = await main.locator('.embedded-office-content').boundingBox(); return !!box && !!viewport && box.y >= viewport.y && box.y + Math.min(20, box.height) < viewport.y + viewport.height && box.x >= viewport.x && box.x < viewport.x + viewport.width; }, 'visible actual ' + cursor);
  const box = (await main.locator(selector).first().boundingBox())!,point={x:cursor==='object'?box.x+Math.min(30,box.width/10):box.x+Math.min(8,Math.max(.5,box.width/2)),y:box.y+(cursor==='object'?box.height/2:Math.min(10,Math.max(.5,box.height/2)))};
  // This fixture's transparent title shape only accepts its text primitives;
  // its wide, empty bounding-box center is correctly click-through in Impress.
  // Use its first visible glyphs in the real pane-safe presentation viewport.
  assert.ok(point.x>=box.x&&point.x<box.x+box.width);
  assert.equal(await main.evaluate(point=>!!document.elementFromPoint(point.x,point.y)?.closest('.embedded-office-content'),point),true,'human click reaches the actual visible document rather than an overlay');await main.mouse.click(point.x,point.y);
  await until(async () => main.locator('.embedded-office-input').evaluate(input => document.activeElement === input), 'body owns real keyboard focus');
  results.lastHumanFocus = { viewId: view.id, cursor, box };
};
const screenshot = async (label: string) => { await main.screenshot({ path: join(evidence, label + '.png'), scale: 'css' }); return main.locator('.embedded-office-canvas').evaluate(canvas => { const c = canvas as HTMLCanvasElement, data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let opaque = 0, white = 0, black = 0, warm = 0; for (let i = 0; i < data.length; i += 16) if (data[i + 3] > 245) { opaque++; if (data[i] > 238 && data[i + 1] > 238 && data[i + 2] > 238) white++; if (data[i] < 24 && data[i + 1] < 24 && data[i + 2] < 24) black++; if (data[i] > 235 && data[i + 1] > 220 && data[i + 2] > 195 && data[i] - data[i + 2] > 10) warm++; } return { width: c.width, height: c.height, opaque, whiteFraction: white / Math.max(1, opaque), blackFraction: black / Math.max(1, opaque), warmFraction: warm / Math.max(1, opaque) }; }); };
const style = async (view: ViewInfo, target: NativeOfficeStyleTarget) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await status(view);
    try { const result = await invoke<{ state: NativeOfficeState; data: NativeOfficeStyleInspection }>('office-query', { viewId: view.id, target: { kind: 'style', target } }); if (result.state.engineEpoch === before.engineEpoch && result.state.engineRevision === before.engineRevision && result.state.selectionEpoch === before.selectionEpoch) return result; }
    catch (cause) { if (!String(cause).includes('STALE_NATIVE_QUERY')) throw cause; }
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error('Actual Office style query did not settle after four read-only attempts. No mutation was retried.');
};
const leftCategory = async (name: string, category: string) => { const entry = main.getByRole('button', { name, exact: true }); if (await entry.getAttribute('aria-pressed') !== 'true') await entry.click(); await main.locator(`.native-office-tools[data-office-category="${category}"]`).waitFor(); };
const verifyToolIcons=async(format:string,category:string)=>{
  const pane=main.locator(`.native-office-tools[data-native-office-format="${format}"][data-office-category="${category}"]`);await pane.locator('.native-office-command-grid [data-uno-command]').first().waitFor();
  const commands=await pane.locator('.native-office-command-grid [data-uno-command]').evaluateAll(nodes=>nodes.map(node=>{const button=node as HTMLButtonElement,box=button.getBoundingClientRect();return {command:button.dataset.unoCommand,label:button.getAttribute('aria-label'),title:button.getAttribute('title'),text:button.innerText.trim(),svg:!!button.querySelector('svg'),width:box.width,height:box.height};}));
  assert.ok(commands.length>0);for(const command of commands){assert.equal(command.text,'','common tool presents its glyph rather than a visible text label');assert.equal(command.svg,true);assert.ok(command.label?.trim());assert.ok(command.title?.trim());assert.doesNotMatch(command.title!,/\.uno:/,'Office hover describes the function instead of showing its engine identifier');assert.notEqual(command.label,command.command);assert.ok(Math.abs(command.width-32)<.6&&Math.abs(command.height-32)<.6,`${format} ${command.command} remains 32px`);}
  const enabled=pane.locator('.native-office-command-grid [data-uno-command]:not(:disabled)').first();await enabled.waitFor();const label=await enabled.getAttribute('aria-label');
  // A pane can reuse the previous physical pointer position, and Playwright's
  // hover may scroll it into view after pointerover. A real subsequent pointer
  // entry is needed after that scroll has finished (scroll correctly dismisses
  // the application's tooltip). Do not synthesize DOM hover/focus events.
  await enabled.scrollIntoViewIfNeeded();await main.mouse.move(700,25);
  let previousBox='',stableBoxes=0;await until(async()=>{const box=await enabled.boundingBox(),serialized=JSON.stringify(box);stableBoxes=serialized===previousBox?stableBoxes+1:0;previousBox=serialized;return !!box&&stableBoxes>=2;},'icon finishes its actual scrolling and pane motion');
  await main.evaluate(()=>{const trace:any[]=[];(globalThis as any).__officeQaHover=trace;(globalThis as any).__officeQaHoverRecord=(event:Event)=>{const element=event.target instanceof Element?event.target.closest('[data-uno-command]'):null;trace.push({type:event.type,at:performance.now(),command:element?.getAttribute('data-uno-command'),target:(event.target as Element)?.tagName});if(trace.length>80)trace.shift();};for(const type of ['pointerover','pointerout','scroll'])document.addEventListener(type,(globalThis as any).__officeQaHoverRecord,true);(globalThis as any).__officeQaHoverCleanup=()=>{for(const type of ['pointerover','pointerout','scroll'])document.removeEventListener(type,(globalThis as any).__officeQaHoverRecord,true);};});
  const tip=main.getByRole('tooltip');
  try {
    for(let attempt=0;attempt<2;attempt++){
      if(attempt){await main.mouse.move(700,25);await main.waitForTimeout(90);}
      const box=(await enabled.boundingBox())!,point={x:box.x+box.width/2,y:box.y+box.height/2};
      assert.equal(await enabled.evaluate((button,point)=>{const hit=document.elementFromPoint(point.x,point.y);return hit===button||button.contains(hit);},point),true,'visible tool glyph owns the actual pointer target');
      await main.mouse.move(point.x,point.y,{steps:3});
      try{await tip.waitFor({timeout:2000});break;}catch(cause){if(attempt===1)throw cause;}
    }
    await until(async()=>!!await tip.textContent().then(text=>text?.includes(label!)),'icon tool retains its actual hover description');assert.doesNotMatch((await tip.textContent())!,/\.uno:/);assert.equal(await tip.locator('[data-glass-effect="frosted"]').count(),1);await main.screenshot({path:join(evidence,`${format}-${category}-icon-tooltip.png`),scale:'css'});
  } finally {
    const trace=await main.evaluate(()=>{(globalThis as any).__officeQaHoverCleanup?.();return (globalThis as any).__officeQaHover;});
    (results.toolHoverTrace??=[] as unknown[]);(results.toolHoverTrace as unknown[]).push({format,category,label,trace,tooltipCount:await tip.count(),tooltipText:await tip.textContent().catch(()=>null),button:await enabled.evaluate(node=>({box:node.getBoundingClientRect().toJSON(),title:node.getAttribute('title'),describedBy:node.getAttribute('aria-describedby')}))});
  }
  await main.mouse.move(700,480);
  (results.toolIcons??=[] as unknown[]);(results.toolIcons as unknown[]).push({format,category,commands,tooltipLabel:label,retainedPropertyInputs:await pane.locator('input,select').count()});
};
const verifySheetControlLane=async(view:ViewInfo,sheetName:string)=>{
  const read=()=>main.locator('.embedded-office-document').evaluate(host=>{
    const content=host.querySelector('.embedded-office-content')!.getBoundingClientRect(),panes=[...host.closest('.workbench')!.querySelectorAll<HTMLElement>(':scope > .floating-side-panel')].map(pane=>({side:pane.dataset.side,box:pane.getBoundingClientRect().toJSON()})),reader=host.closest('.reader-panel')!.getBoundingClientRect();
    const rows=[...host.querySelectorAll<HTMLElement>(':scope > .embedded-office-sheet-tabs')].map(row=>({name:row.className,box:row.getBoundingClientRect().toJSON()}));
    return {frame:host.getBoundingClientRect().toJSON(),radius:parseFloat(getComputedStyle(host).borderTopLeftRadius),reader:reader.toJSON(),content:content.toJSON(),panes,rows};
  });
  const samples:unknown[]=[],baseline=await read();
  const check=async()=>{const actual=await read();samples.push(actual);assert.ok(actual.radius>=14,'Calc has its own rounded, bounded sheet frame');assert.ok(actual.frame.left>=actual.reader.left&&actual.frame.right<=actual.reader.right+.5,'the entire sheet frame stays between the thin rails');for(const pane of actual.panes)assert.ok(pane.side==='left'?actual.frame.left>=pane.box.right+5:actual.frame.right<=pane.box.left-5,'the entire sheet frame avoids each actual expanded pane');for(const row of actual.rows){assert.ok(row.box.left>=actual.frame.left-.5&&row.box.right<=actual.frame.right+.5);assert.ok(row.box.height<=32,'sheet tabs share the bounded frame without a tall footer');}};
  await navigate(view,{kind:'cell',sheetName,address:'Z50'});
  const bar=main.locator('.native-office-formula-bar'),field=bar.locator('input[aria-label="单元格内容或公式"]');
  await until(async()=>await field.inputValue().then(value=>value.includes('SUM')),'navigation formula loads the actual selected cell');
  assert.equal(await bar.count(),1,'there is exactly one actual formula editor');assert.equal(await main.locator('.navigation-toolbar [data-navigation-module="formula"] > .native-office-formula-bar').count(),1,'the actual cell draft is inside the shared navigation');
  const nodeToken=randomUUID();await field.evaluate((input,token)=>input.setAttribute('data-qa-formula-node',token),nodeToken);await field.click();await main.keyboard.press('Control+a');await main.keyboard.insertText('=SUM(18,24)');
  const draft=async()=>{assert.equal(await field.getAttribute('data-qa-formula-node'),nodeToken,'layout changes preserve the exact mounted formula input');assert.equal(await field.inputValue(),'=SUM(18,24)','layout changes retain the real pending draft');assert.equal(await bar.getAttribute('data-dirty'),'true');};
  await draft();await check();
  await main.getByRole('button',{name:'开始',exact:true}).click();await main.locator('.floating-side-panel[data-side="left"]').waitFor({state:'hidden'});await check();const closed=await read();assert.ok(closed.frame.width>baseline.frame.width+100,'closing the tools restores sheet width');await draft();
  await leftCategory('开始','home');await main.waitForTimeout(120);await check();await draft();const reopened=await read();assert.ok(reopened.frame.width<closed.frame.width-100,'opening tools narrows the dedicated sheet viewport');
  await check();await invoke('settings-set',{id:'appearance.motion',value:'elegant'});await main.locator('.ai-rail > button').nth(1).click();await main.locator('#ai-tools').waitFor();
  for(let frame=0;frame<6;frame++){await main.waitForTimeout(90);await check();await draft();}
  const resize=main.getByRole('separator',{name:'调整左侧工具栏宽度',exact:true});await resize.focus();await resize.press('ArrowRight');await main.waitForTimeout(90);await check();await draft();
  await main.getByRole('button',{name:'关闭 AI 抽屉',exact:true}).click();for(let frame=0;frame<6;frame++){await main.waitForTimeout(90);await check();await draft();}await main.locator('#ai-tools').waitFor({state:'hidden'});await invoke('settings-set',{id:'appearance.motion',value:'off'});await check();
  await main.getByRole('button',{name:'关闭导航栏',exact:true}).click();await main.locator('.navigation-toolbar.is-hidden').waitFor({state:'attached'});await draft();
  // CtrlS must commit this hidden, still mounted owner draft before writing the
  // file. Check disk immediately so a later IPC save cannot mask a broken UI.
  await main.keyboard.press('Control+s');await until(async()=>await bar.getAttribute('data-dirty').then(value=>value==='false'),'hidden navigation formula draft commits on actual CtrlS');
  await until(async()=>{const state=await workspace();return state.documents.find(item=>item.id===view.documentId)?.dirty===false&&!(await status(view)).pendingInput;},'hidden formula is saved after its native model receipt');
  const disk=await createRegistry().resolve('xlsx').open(new Uint8Array(await readFile(join(directory,names.xlsx))),'xlsx'),cell=disk.sheets!.find(sheet=>sheet.name===sheetName)!.rows[49][25];assert.equal(cell.formula,'SUM(18,24)');assert.equal(Number(cell.value),42);
  const reader=(await read()).reader;await main.mouse.move(reader.x+reader.width/2,reader.y+1);await until(async()=>!await main.locator('.navigation-toolbar').getAttribute('class').then(value=>value?.includes('is-hidden')),'reading edge reveals the same navigation formula');assert.equal(await field.getAttribute('data-qa-formula-node'),nodeToken);
  const sheetTabs=main.locator('.embedded-office-sheet-tabs [role="tab"]'),sheetTabCount=await sheetTabs.count();assert.ok(sheetTabCount>0,'the actual workbook has at least one sheet tab');
  const hit=await sheetTabs.nth(Math.min(1,sheetTabCount-1)).evaluate(button=>{const box=button.getBoundingClientRect(),top=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return top===button||button.contains(top);});assert.equal(hit,true,'the real tab is the native mouse hit target');results.sheetControlLane=samples;
  results.navigationFormula={nodeToken,closed,reopened,diskFormula:cell.formula,diskValue:cell.value};
};
const verifyCalcScrollEndpoints=async(view:ViewInfo,sheetName:string)=>{
  const read=async()=>{const native=await status(view),layout=await app.evaluate(({ipcMain},viewId)=>(ipcMain as any).__officeQaTrace.findLast((entry:any)=>entry.method==='office-surface-layout'&&entry.viewId===viewId&&!entry.error)?.args,view.id);assert.ok(layout?.canvasOffsetCss,'native sheet uses the actual DOM layout tuple');return main.locator('.embedded-office-content').evaluate((host,value)=>{const stage=host.querySelector('.embedded-office-stage')!.getBoundingClientRect(),width=value.size.width*value.zoom/15,height=value.size.height*value.zoom/15;return {box:host.getBoundingClientRect().toJSON(),stage:stage.toJSON(),x:host.scrollLeft,y:host.scrollTop,maxX:host.scrollWidth-host.clientWidth,maxY:host.scrollHeight-host.clientHeight,width:host.clientWidth,height:host.clientHeight,paper:{left:stage.left+value.offset.x,top:stage.top+value.offset.y,right:stage.left+value.offset.x+width,bottom:stage.top+value.offset.y+height},sizeTwips:value.size,offset:value.offset};},{size:native.sizeTwips,zoom:native.zoom??1,offset:layout.canvasOffsetCss as {x:number;y:number}});};
  const before=await stableStatus(view);await invoke('office-input',{viewId:view.id,...version(before),expectedLayoutRevision:before.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'scroll',x:before.viewport!.width/2,y:before.viewport!.height/2,deltaX:1000000,deltaY:1000000}});
  await until(async()=>{const actual=await read();return Math.abs(actual.x-actual.maxX)<1&&Math.abs(actual.y-actual.maxY)<1;},'actual sheet scroll reaches both bounded DOM endpoints');
  const end=await read();assert.ok(end.box.x+end.width-end.paper.right>=10&&end.box.y+end.height-end.paper.bottom>=10,'native sheet bounds keep the actual trailing scrollbar clearance');
  await navigate(view,{kind:'cell',sheetName,address:'AA50'});await until(async()=>{const box=await main.locator('.embedded-office-cell-cursor').boundingBox(),actual=await read();return !!box&&box.x>=actual.box.left+5&&box.x+box.width<=actual.box.x+actual.width-5&&box.y>=actual.box.top+5&&box.y+box.height<=actual.box.y+actual.height-5;},'actual AA50 cursor is revealed inside the bounded sheet frame');
  const source=await read(),sourceCursor=(await main.locator('.embedded-office-cell-cursor').boundingBox())!,deltaX=Math.round(sourceCursor.x-source.box.left-Math.min(200,source.width*.3));
  const selected=await stableStatus(view);assert.equal(selected.selection?.text,marker);
  await invoke('office-input',{viewId:view.id,...version(selected),expectedLayoutRevision:selected.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'scroll',x:selected.viewport!.width/2,y:selected.viewport!.height/2,deltaX,deltaY:0}});await main.waitForTimeout(180);
  const visible=await read(),cursor=await main.locator('.embedded-office-cell-cursor').boundingBox();assert.ok(cursor&&cursor.x>=visible.box.left&&cursor.x+cursor.width<=visible.box.x+visible.width-120,'the actual grid can scroll the long selected value away from the right clipping edge');
  results.calcScrollEndpoints={end,visible,state:await status(view),cursor,pixels:await screenshot('calc-bounded-frame-scroll')};
};

const verifyPresentationViewport=async(view:ViewInfo)=>{
  const read=()=>main.locator('.embedded-office-document').evaluate(host=>{
    const content=host.querySelector('.embedded-office-content')!.getBoundingClientRect(),reader=host.closest('.reader-panel')!.getBoundingClientRect();
    const panes=[...host.closest('.workbench')!.querySelectorAll<HTMLElement>(':scope > .floating-side-panel')].map(pane=>({side:pane.dataset.side,box:pane.getBoundingClientRect().toJSON()}));
    const paper=host.querySelector('.embedded-office-paper-base')!.getBoundingClientRect(),navigation=host.closest('.reader-panel')!.querySelector('.navigation-capsule')?.getBoundingClientRect();
    return {mode:host.getAttribute('data-office-fit-mode'),content:content.toJSON(),reader:reader.toJSON(),panes,paper:paper.toJSON(),navigation:navigation?.toJSON()};
  });
  const samples:unknown[]=[];
  const safe=async()=>{
    const actual=await read();samples.push(actual);assert.ok(actual.content.left>=actual.reader.left&&actual.content.right<=actual.reader.right+.5,'the presentation stays between the actual thin rails');
    if(actual.mode==='page')for(const pane of actual.panes){if(pane.box.bottom<=actual.content.top||pane.box.top>=actual.content.bottom)continue;assert.ok(pane.side==='left'?actual.content.left>=pane.box.right+5:actual.content.right<=pane.box.left-5,'automatic fit avoids each live expanded pane');}
    else{const bar=await main.getByRole('scrollbar',{name:'幻灯片横向滚动',exact:true}).boundingBox();assert.ok(bar);for(const pane of actual.panes)assert.ok(pane.side==='left'?bar.x>=pane.box.right+5:bar.x+bar.width<=pane.box.left-5,'manual scroll controls stay in the unoccluded lane');}
    if(actual.navigation)assert.ok(actual.content.top>=actual.navigation.bottom+5,'the slide starts below the actual navigation capsule');return actual;
  };
  const fitted=async()=>{
    await until(async()=>{const actual=await read(),state=await status(view),current=(await workspace()).views.find(item=>item.id===view.id)!;
      const size=state.parts.find(part=>part.index===state.partIndex)?.sizeTwips??state.sizeTwips,expected=officePresentationFit(size,{width:actual.content.width,height:actual.content.height});
      return actual.mode==='page'&&expected!==undefined&&Math.abs((current.zoom??1)-expected)<.00001&&Math.abs((state.zoom??1)-expected)<.00001&&actual.paper.width<=actual.content.width+1&&actual.paper.height<=actual.content.height+1;
    },'actual native presentation zoom fits the pane-safe viewport');return safe();
  };
  const initial=await fitted(),beforeScroll=await stableStatus(view);
  await invoke('office-input',{viewId:view.id,...version(beforeScroll),expectedLayoutRevision:beforeScroll.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'scroll',x:initial.content.width/2,y:initial.content.height/2,deltaX:0,deltaY:180}});
  await fitted();assert.equal(await main.locator('.embedded-office-content').evaluate(node=>node.scrollTop),0,'scrolling an already fitted full slide clamps to zero');
  const captureState=await stableStatus(view),image=await invoke<{mimeType:string;data:string}>('office-capture',{viewId:view.id,expectedEngineEpoch:captureState.engineEpoch,expectedEngineRevision:captureState.engineRevision,expectedLayoutRevision:captureState.layoutRevision});
  assert.equal(image.mimeType,'image/png','the desktop IPC capture succeeds after a clamped scroll');assert.ok(image.data);
  await writeFile(join(evidence,'impress-ipc-clamped-capture.png'),Buffer.from(image.data,'base64'));
  const opaque=await app.evaluate(({nativeImage},data)=>{
    const image=nativeImage.createFromBuffer(Buffer.from(data,'base64')),size=image.getSize(),pixels=image.toBitmap();let left=size.width,top=size.height,right=-1,bottom=-1;
    for(let y=0;y<size.height;y++)for(let x=0;x<size.width;x++)if(pixels[(y*size.width+x)*4+3]>245){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
    return {...size,left,top,right,bottom};
  },image.data),clamped=await safe();
  assert.ok(opaque.right>=opaque.left&&opaque.bottom>=opaque.top,'the capture contains actual native slide pixels');
  assert.ok(Math.abs(opaque.top/scale-(clamped.paper.top-clamped.content.top))<2&&Math.abs(opaque.left/scale-(clamped.paper.left-clamped.content.left))<2,'desktop IPC capture retains the same real centered document origin as the Canvas after a clamped scroll');
  results.presentationClampedCapture={opaque,dom:clamped,state:await status(view)};
  const queried=await invoke<{data:{unit:string;objects:{name:string;text:string;bounds:{x:number;y:number;width:number;height:number}}[]}}>('office-query',{viewId:view.id,target:{kind:'shapes',slideIndex:0}}),title=queried.data.objects.find(shape=>shape.text.trim())!;
  assert.equal(queried.data.unit,'1/100mm');assert.ok(title);await stableStatus(view);const clickGeometry=await safe(),currentZoom=(await workspace()).views.find(item=>item.id===view.id)!.zoom??1,twipsPerHmm=1440/2540;
  // The fixture's real title primitive accepts this glyph strip; its empty
  // bounding-box center is correctly click-through. Coordinates stay local to
  // the actual safe viewport, including positive vertical centering.
  const point={x:clickGeometry.paper.left-clickGeometry.content.left+(title.bounds.x*twipsPerHmm+Math.min(2200,title.bounds.width*twipsPerHmm/4))*currentZoom/15,y:clickGeometry.paper.top-clickGeometry.content.top+(title.bounds.y+title.bounds.height/2)*twipsPerHmm*currentZoom/15},beforeClick=await stableStatus(view);
  await invoke('office-input',{viewId:view.id,...version(beforeClick),expectedLayoutRevision:beforeClick.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'click',...point}});
  const clicked=await status(view);results.presentationGlyphClickAttempt={point,title,clicked};
  if(clicked.inputState?.editing==='text'&&clicked.selection?.kind==='none'){
    // A glyph click may directly place an Outliner caret. Its marked-shape
    // fallback is intentionally not exposed as a selected object. Select only
    // within that same active editor to prove which actual text was hit.
    assert.equal(clicked.focusedParagraph,title.text);
    await invoke('office-input',{viewId:view.id,...version(clicked),idempotencyKey:randomUUID(),action:{kind:'press',key:'Home',modifiers:['control']}});
    const caret=await status(view);await invoke('office-input',{viewId:view.id,...version(caret),idempotencyKey:randomUUID(),action:{kind:'press',key:'End',modifiers:['control','shift']}});
    await until(async()=>{const value=await status(view);return value.inputState?.editing==='text'&&value.selection?.kind==='text'&&value.selection.text===title.text;},'the clicked active Outliner belongs to the same actual title');
  }else assert.ok(clicked.selection?.objectNames?.includes(title.name)||clicked.selection?.text===title.text,'desktop IPC glyph click after the clamped scroll reaches the same actual title rather than an offset position');
  const beforeEscape=await status(view);await invoke('office-input',{viewId:view.id,...version(beforeEscape),idempotencyKey:randomUUID(),action:{kind:'press',key:'Escape'}});await settleInput(view);results.presentationClampedClick={point,titleName:title.name,state:clicked};
  await invoke('settings-set',{id:'appearance.motion',value:'elegant'});await main.locator('.ai-rail > button').nth(1).click();await main.locator('#ai-tools').waitFor();
  for(let frame=0;frame<6;frame++){await main.waitForTimeout(90);await safe();}await fitted();
  const resize=main.getByRole('separator',{name:'调整左侧工具栏宽度',exact:true});await resize.focus();await resize.press('ArrowRight');await main.waitForTimeout(100);await fitted();
  await main.getByRole('button',{name:'关闭 AI 抽屉',exact:true}).click();for(let frame=0;frame<6;frame++){await main.waitForTimeout(90);await safe();}await main.locator('#ai-tools').waitFor({state:'hidden'});await fitted();
  const viewport=(await read()).content;await main.mouse.move(viewport.x+viewport.width/2,viewport.y+viewport.height/2);const before=(await workspace()).views.find(item=>item.id===view.id)!.zoom??1;
  await main.keyboard.down('Control');await main.mouse.wheel(0,-60);await main.keyboard.up('Control');await until(async()=>{const actual=await read(),current=(await workspace()).views.find(item=>item.id===view.id)!;return actual.mode==='manual'&&(current.zoom??1)>before;},'a real Ctrlwheel gesture leaves automatic fit');
  const manual=(await workspace()).views.find(item=>item.id===view.id)!.zoom;await resize.focus();await resize.press('ArrowRight');await main.waitForTimeout(700);assert.equal((await workspace()).views.find(item=>item.id===view.id)!.zoom,manual,'manual zoom survives a subsequent live sidebar resize');await safe();
  // Set an explicit editable scale through the real navigation field, rather
  // than forcing a CSS transform or an transport-only mouse coordinate workaround.
  const zoomField=main.getByRole('spinbutton',{name:'正文缩放比例',exact:true});await zoomField.fill('100');await zoomField.press('Enter');await until(async()=>(await workspace()).views.find(item=>item.id===view.id)!.zoom===1,'native presentation accepts the explicit navigation zoom');
  assert.equal((await read()).mode,'manual');await invoke('settings-set',{id:'appearance.motion',value:'off'});results.presentationViewport=samples;
};
const verifyContinuousZoomFrames=async(view:ViewInfo,format:string)=>{
  await ready(view);await app.evaluate(({ipcMain})=>{(ipcMain as any).__officeQaTileDelay=250;});
  await main.evaluate(()=>{
    const target=new OffscreenCanvas(64,48),context=target.getContext('2d',{willReadFrequently:true})!,state={samples:[] as {at:number;ink:number;alpha:number;zoom:string|null;reused:string|null}[],stopped:false,frame:0,tick:undefined as (()=>void)|undefined};
    (window as any).__officeQaFrames=state;
    state.tick=()=>{
      if(state.stopped)return;const canvas=document.querySelector<HTMLCanvasElement>('.embedded-office-canvas');
      if(canvas?.width&&canvas.height){context.clearRect(0,0,64,48);context.drawImage(canvas,0,0,64,48);const pixels=context.getImageData(0,0,64,48).data;let ink=0,alpha=0;
        for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>180){alpha++;if(pixels[i]<253||pixels[i+1]<253||pixels[i+2]<253)ink++;}
        if(state.samples.length<1200)state.samples.push({at:performance.now(),ink,alpha,zoom:canvas.dataset.officeFrameZoom??null,reused:canvas.dataset.officeFrameReused??null});
      }
      state.frame=requestAnimationFrame(state.tick!);
    };state.frame=requestAnimationFrame(state.tick);
  });
  const point=await main.locator('.embedded-office-content').evaluate(host=>{const box=host.getBoundingClientRect();let left=box.left,right=box.right;for(const panel of host.closest('.workbench')!.querySelectorAll<HTMLElement>(':scope > .floating-side-panel')){const bounds=panel.getBoundingClientRect();if(panel.dataset.side==='left')left=Math.max(left,bounds.right);else right=Math.min(right,bounds.left);}return {x:(left+right)/2,y:box.top+box.height*.3};});
  await main.mouse.move(point.x,point.y);assert.equal(await main.evaluate(point=>!!document.elementFromPoint(point.x,point.y)?.closest('.embedded-office-content'),point),true);
  await main.keyboard.down('Control');for(const delta of [-70,90,-80,95,-110,90]){await main.mouse.wheel(0,delta);await main.waitForTimeout(150);}await main.keyboard.up('Control');await main.waitForTimeout(800);
  const samples=await main.evaluate(()=>{const state=(window as any).__officeQaFrames;state.stopped=true;cancelAnimationFrame(state.frame);return state.samples;}) as {at:number;ink:number;alpha:number;zoom:string|null;reused:string|null}[];
  await app.evaluate(({ipcMain})=>{(ipcMain as any).__officeQaTileDelay=0;});
  assert.ok(samples.length>=15,'sample actual Canvas RGBA over continuous real Ctrlwheel gestures');assert.ok(new Set(samples.map(sample=>sample.zoom)).size>=3,'the compositor actually presents several native zoom levels');
  assert.ok(samples.some(sample=>sample.reused==='true'),'same-content native pixels are used during delayed tile delivery');
  assert.ok(samples.every(sample=>sample.ink>0&&sample.alpha>0),'no sampled Canvas frame loses all real content while zooming');
  await until(async()=>{const actual=(await workspace()).views.find(item=>item.id===view.id)!;return main.locator('.embedded-office-canvas').evaluate((canvas,zoom)=>canvas.getAttribute('data-office-frame-reused')==='false'&&Math.abs(Number(canvas.getAttribute('data-office-frame-zoom'))-zoom)<.0001,actual.zoom??1);},'the final visible native tiles replace the retained zoom frame',15000);
  (results.zoomFrames??=[] as unknown[]);(results.zoomFrames as unknown[]).push({format,samples,slowReadOnlyTileReplyMs:250});await screenshot(format+'-continuous-zoom');
};

const saveViaHumanShortcut = async (view: ViewInfo) => {
  const diagnostics = { viewId:view.id, before:await status(view), focus:await main.evaluate(()=>({tag:document.activeElement?.tagName,className:document.activeElement?.className})), feedback:[] as string[] };
  (results.saveShortcuts ??= [] as unknown[]); (results.saveShortcuts as unknown[]).push(diagnostics);
  await main.keyboard.press('Control+s');
  const saveStarted=Date.now();let diagnosed=false;
  await until(async () => {
    const toast=await main.locator('.toast').allTextContents();for(const text of toast)if(!diagnostics.feedback.includes(text))diagnostics.feedback.push(text);
    const state=await invoke<WorkspaceState>('state'),document=state.documents.find(value=>value.id===view.documentId),actual=await status(view),saved=document?.dirty===false&&!actual.pendingInput;
    if(!saved&&!diagnosed&&Date.now()-saveStarted>5000){diagnosed=true;const pending={viewId:view.id,document,views:await Promise.all(state.views.filter(item=>item.documentId===view.documentId).map(item=>status(item))),feedback:diagnostics.feedback,trace:await app.evaluate(({ipcMain})=>(ipcMain as any).__officeQaTrace)};await writeFile(join(evidence,'pending-save-'+actual.format+'.json'),JSON.stringify(pending,null,2));}
    return saved;
  }, 'human save commits stable engine buffer', 60000);
};
const saveReopen = async (view: ViewInfo, format: keyof typeof names, validate: (model: DocumentModel) => void) => {
  await invoke('save', { documentId: view.documentId }); const bytes = await readFile(join(directory, names[format])); assert.notDeepEqual(bytes, originals.get(names[format]));
  const disk = await createRegistry().resolve(format).open(new Uint8Array(bytes), format); validate(disk);
  await invoke('close', { viewId: view.id }); const reopened = await open(format); assert.equal(reopened.documentId, view.documentId); assert.notEqual(reopened.id, view.id);
  validate(await model(reopened)); return { view: reopened, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};

let ownedProcessRoots: OwnedProcessIdentity[] = [];
const processSnapshot = async () => {
  const output = await run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{Name='CreationTicks';Expression={if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString()}else{''}}} | ConvertTo-Json -Compress"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 10000 });
  const parsed = JSON.parse(output.stdout) as { ProcessId: number; ParentProcessId: number; Name: string; ExecutablePath: string; CreationTicks: string }[];
  return parsed.map(item => ({ ...item, pid: item.ProcessId, parentPid: item.ParentProcessId, startedTicks: item.CreationTicks }));
};
const captureProcessRoots = async (mainPid: number) => {
  assert.ok(Number.isSafeInteger(primary.pid) && primary.pid! > 0, 'the launched desktop process has a real PID');
  const snapshot = await processSnapshot(), pids = [...new Set([mainPid, primary.pid!])];
  assert.equal(await app.evaluate(() => process.pid), mainPid, 'the original app channel remains live after root discovery');
  const roots = pids.map(pid => { const row = snapshot.find(item => item.pid === pid); assert.ok(row, 'actual launched app/main process is present'); return { pid, startedTicks: row.startedTicks }; });
  ownedProcessTree(snapshot, roots); ownedProcessRoots = roots; results.ownedProcessRoots = roots;
};
const processes = async () => ownedProcessRoots.length ? ownedProcessTree(await processSnapshot(), ownedProcessRoots, { allowMissingRoots: true }) : [];
const verifyImpressEditing=async(slides:ViewInfo)=>{
const shapes = await invoke<{ data: { objects: { name: string; text?: string }[] } }>('office-query', { viewId: slides.id, target: { kind: 'shapes', slideIndex: 0 } });
results.impressInitialShapes=shapes;
const shape = shapes.data.objects.find(value => !!value.text?.trim())!;
assert.ok(shape?.name);
await navigate(slides, { kind: 'shape', slideIndex: 0, name: shape.name });
await humanFocus(slides, 'object');
await main.keyboard.press('F2');
await until(async()=>{const state=await status(slides);results.impressEditEntry=state;return state.pendingInput===true;},'native F2 enters actual Impress text edit',4000);
await main.keyboard.press('Control+Home');
await main.keyboard.press('Control+Shift+End');
await until(async()=>{const state=await status(slides);return state.selection?.kind==='text'&&!!state.selection.text&&state.inputState?.editing==='text';},'Impress reports a real selected text range while its Outliner is active');
const selectedText=await status(slides);
assert.equal(selectedText.pendingInput,true,'checkpoint protection remains active while text-format controls are usable');
const selectionContext=await invoke<any>('selection-context',{viewId:slides.id,expected:{sessionId:selectedText.sessionId,engineEpoch:selectedText.engineEpoch,engineRevision:selectedText.engineRevision,selectionEpoch:selectedText.selectionEpoch}});
assert.equal(selectionContext.selectionContext.context.selection.kind,'text');assert.equal('model' in selectionContext.selectionContext.document,false);
await leftCategory('开始','home');
const impressInspector=main.locator('[data-native-style-target="text"]'),bold=impressInspector.getByRole('button',{name:'粗体',exact:true});
await until(()=>bold.isEnabled(),'left text-format controls read the active Impress selection');
const wasBold=(await style(slides,'text')).data.fields.bold.value===true;
const impressStyleStarted=Date.now();
await bold.click();
await until(async()=>(await status(slides)).engineRevision>selectedText.engineRevision,'one click applies the actual Impress text style');
results.impressStyleConfirmedMs=Date.now()-impressStyleStarted;
await until(async()=>{const state=await status(slides);return state.selection?.kind==='text'&&state.selection.text===selectedText.selection!.text&&state.inputState?.editing==='text';},'formatting restores the same actual Outliner text range');
const textUndo=main.getByRole('button',{name:'撤销最近修改',exact:true});await until(()=>textUndo.isEnabled(),'top toolbar enables the real Outliner undo capability');await textUndo.click();
await until(async()=>{const state=await status(slides);results.impressAfterTextUndo=state;return state.engineRevision>selectedText.engineRevision&&state.inputState?.editing==='text';},'top toolbar text Undo remains inside the active Outliner');
// Native text Undo may collapse a range to its caret. SdUnoDrawView then
// returns the marked shape, even while Outliner remains active. Re-select via
// real keys; do not claim the fallback object proves a selected text range.
await main.locator('.embedded-office-input').focus();await main.keyboard.press('Control+Home');await main.keyboard.press('Control+Shift+End');
await until(async()=>{const state=await status(slides);return state.selection?.kind==='text'&&state.selection.text===selectedText.selection!.text&&(await style(slides,'text')).data.fields.bold.value===wasBold;},'real reselected text confirms top toolbar Undo restored its format');
await main.keyboard.press('Control+y');
await until(async()=>(await status(slides)).inputState?.editing==='text','native text Redo remains inside Outliner');
await main.keyboard.press('Control+Home');await main.keyboard.press('Control+Shift+End');
await until(async()=>{const state=await status(slides);return state.selection?.kind==='text'&&state.selection.text===selectedText.selection!.text&&(await style(slides,'text')).data.fields.bold.value===!wasBold;},'native text redo restores the original format receipt');
await navigate(slides,{kind:'shape',slideIndex:0,name:shape.name});await humanFocus(slides,'object');await main.keyboard.press('F2');
await until(async()=>(await status(slides)).inputState?.editing==='text','reenter the styled real text object');
await main.keyboard.press('Control+Home');await main.keyboard.press('Control+Shift+End');
await until(async()=>(await style(slides,'text')).data.fields.bold.value===!wasBold,'Impress style persists without a separate apply button');
// Produce a real mixed range, then explicitly unify it through the same left
// control. This checks native assignment semantics rather than a Boolean toggle.
await main.keyboard.press('Control+Home');await main.keyboard.press('Shift+ArrowRight');
await until(async()=>{const state=await status(slides);return state.selection?.kind==='text'&&state.selection.text===selectedText.selection!.text[0];},'select an actual first glyph for a mixed-format range');
const beforeMixed=await status(slides);await until(()=>bold.isEnabled(),'partial real text selection enables its style');await bold.click();
await until(async()=>(await status(slides)).engineRevision>beforeMixed.engineRevision,'a partial format creates real native mixed content');
await main.locator('.embedded-office-input').focus();await main.keyboard.press('Control+Home');await main.keyboard.press('Control+Shift+End');
await until(async()=>{const field=(await style(slides,'text')).data.fields.bold;return field.available&&field.state==='mixed';},'mixed selected text remains an editable native style target');
await until(async()=>await bold.getAttribute('aria-pressed')==='mixed'&&await bold.isEnabled(),'left control recognizes the real mixed selection');
const mixedStarted=Date.now();await bold.click();
await until(async()=>{const field=(await style(slides,'text')).data.fields.bold,state=await status(slides);return field.available&&field.state!=='mixed'&&field.value===true&&state.selection?.kind==='text'&&state.selection.text===selectedText.selection!.text;},'one explicit assignment unifies the actual mixed range without losing it');
results.impressMixedStyleConfirmedMs=Date.now()-mixedStarted;
for(const [field,label] of [['italic','斜体'],['underline','下划线'],['strike','删除线']] as const){
  const before=(await style(slides,'text')).data.fields[field],wanted=before.value!==true,control=impressInspector.getByRole('button',{name:label,exact:true});
  assert.equal(before.available,true);await until(()=>control.isEnabled(),'native '+field+' field is ready');await control.click();
  await until(async()=>{const value=(await style(slides,'text')).data.fields[field],state=await status(slides);return value.available&&value.state!=='mixed'&&value.value===wanted&&state.selection?.kind==='text'&&state.selection.text===selectedText.selection!.text;},'explicit native '+field+' applies to the same selected text');
}
results.impressSelectedText={state:await status(slides),selectionContext};
await main.keyboard.insertText(marker);
await saveViaHumanShortcut(slides);
await until(async () => { const value = await invoke<{ data: { text: string } }>('office-query', { viewId: slides.id, target: { kind: 'shape', slideIndex: 0, name: shape.name } });results.impressTextReadback=value;return value.data.text === marker; }, 'Canvas Impress editing commits to same named model');
await leftCategory('开始','home');
await verifyToolIcons('pptx','home');
await leftCategory('幻灯片', 'slides');
const totalParts = (await status(slides)).parts.length;
await until(async () => (await main.locator('.native-office-slide-list > button').count()) === totalParts, 'real slides live in the left sidebar');
if (totalParts > 1) { await main.getByRole('button', { name: '第 2 张幻灯片', exact: true }).click(); await until(async () => (await status(slides)).partIndex === 1, 'left slide previews navigate actual page'); }
await ready(slides); // A changed part index precedes the actual replacement tiles.
assert.equal(await main.locator('.office-slide-strip,.office-presentation-footer').count(), 0);
results.impress = { shapeName: shape.name, state: await status(slides), pixels: await screenshot('impress-canvas') };
const slidesSaved = await saveReopen(slides, 'pptx', value => assert.ok(value.slides?.some(slide => slide.blocks.some(block => block.text === marker))));
slides = slidesSaved.view;
results.impressSaved = slidesSaved;
console.log('Embedded Office actual UI: Impress text mode, native commit, left slides + save/reopen PASS');
return slides;
};
let passed = false;
try {
  await main.locator('#root .tab-strip').waitFor(); assert.match(main.url(), new RegExp('127\\.0\\.0\\.1:' + port)); assert.equal(await main.title(), 'AgentViewer');
  await app.evaluate(({ BrowserWindow }) => { const owner = BrowserWindow.getAllWindows()[0]; owner.hide(); owner.show(); owner.focus(); });
  await until(async () => { try { return JSON.parse(await readFile(env.AGENTVIEWER_CONNECTION_FILE, 'utf8')).protocolVersion === '1.0'; } catch { return false; } }, 'isolated desktop service discovery');
  const identity = await app.evaluate(({ app }) => ({ profile: app.getPath('userData'), pid: process.pid, lock: app.hasSingleInstanceLock(), packaged:app.isPackaged, executable:process.execPath, appPath:app.getAppPath() })); assert.equal(resolve(identity.profile), resolve(directory)); assert.equal(identity.lock, true); assert.equal(resolve(identity.executable).toLowerCase(),executable.toLowerCase()); assert.equal(resolve(identity.appPath),resolve('.')); results.identity = identity;
  await captureProcessRoots(identity.pid);
  await invoke('settings-set', { id: 'appearance.autoHideToolbar', value: false }); await invoke('settings-set', { id: 'appearance.motion', value: 'off' }); await invoke('settings-set', { id: 'appearance.theme', value: 'light' }); await invoke('settings-set', { id: 'appearance.documentPaperColor', value: '#ffffff' });

  let word!: ViewInfo;
  if (themeOnly) {
    word=await open('docx');await leftCategory('表格','table');
    for(const [index,theme] of ['light','dark','light'].entries()){
      await invoke('settings-set',{id:'appearance.theme',value:theme});await ready(word);
      await main.locator('[data-uno-command=".uno:InsertTable"]').click();const form=main.locator('.office-dialog-form');await form.waitFor();
      assert.equal(await main.locator('.embedded-office-dialog-window canvas').count(),0,'the document dialog uses real DOM controls rather than repainted native widgets');
      assert.equal(await main.locator('.office-dialog-compatibility').count(),0,'the fully adapted table form must not warn about its internal anonymous spinner edits');
      await form.locator('[data-office-control-id="colspin"] input').waitFor();
      const layout=await form.evaluate(node=>{
        const boxes:Record<string,DOMRect>={};
        for(const id of ['nameedit','colspin','rowspin','help','cancel'])boxes[id]=node.querySelector<HTMLElement>('[data-office-control-id="'+id+'"]')!.getBoundingClientRect();
        const viewport=node.querySelector<HTMLElement>('.office-dialog-fields')!;
        return {kind:node.getAttribute('data-office-dialog-kind'),name:boxes.nameedit.toJSON(),columns:boxes.colspin.toJSON(),rows:boxes.rowspin.toJSON(),help:boxes.help.toJSON(),cancel:boxes.cancel.toJSON(),sections:node.querySelectorAll('.office-dialog-group.is-section').length,overflowX:viewport.scrollWidth-viewport.clientWidth};
      });
      assert.equal(layout.kind,'InsertTableDialog');assert.ok(layout.sections>=2,'real native frame labels become distinct form sections');
      assert.ok(Math.abs(layout.columns.y-layout.rows.y)<2&&layout.columns.right<=layout.rows.x,'row and column fields share one compact row');
      assert.ok(layout.name.width>layout.columns.width*1.8,'the table name spans the full section');
      assert.ok(layout.help.right<layout.cancel.x&&layout.help.width<=36,'help is a compact separate action');
      assert.ok(layout.overflowX<=1,'the themed form never hides fields in horizontal overflow');
      (results.dialogLayouts??=[] as unknown[]);(results.dialogLayouts as unknown[]).push({theme,layout});
      const focusBounds=await form.locator('input').first().evaluate(input=>{const field=input.getBoundingClientRect(),viewport=input.closest('.office-dialog-fields')!,box=viewport.getBoundingClientRect(),style=getComputedStyle(input),ring=parseFloat(style.outlineWidth)+parseFloat(style.outlineOffset);return {left:field.left-ring>=box.left,top:field.top-ring>=box.top,right:field.right+ring<=box.left+(viewport as HTMLElement).clientWidth,bottom:field.bottom+ring<=box.top+(viewport as HTMLElement).clientHeight};});
      assert.ok(Object.values(focusBounds).every(Boolean),'the focused field outline stays inside the form scroll viewport');
      const presentation=await form.evaluate(node=>{const input=node.querySelector('input')!,surface=node.closest('.office-structured-dialog')!.querySelector('.liquid-glass-surface')!,tint=surface.querySelector('.liquid-glass-tint')!;return {source:node.getAttribute('data-office-dialog-source'),color:getComputedStyle(node).color,inputColor:getComputedStyle(input).color,inputBackground:getComputedStyle(input).backgroundColor,materialTint:getComputedStyle(tint).backgroundColor,materialBlur:getComputedStyle(surface).getPropertyValue('--liquid-glass-frosted-blur'),switches:node.querySelectorAll('[role="switch"]').length};});
      assert.equal(presentation.source,'native-uno-uitest');assert.ok(presentation.switches>=3);assert.equal(presentation.materialBlur.trim(),'16px');assert.match(presentation.materialTint,/(?:\/\s*0?\.94\s*\)|,\s*0?\.94\s*\))$/,'the readable dialog material survives the common material cascade');
      await main.screenshot({path:join(evidence,`writer-dialog-${index}-${theme}.png`),scale:'css'});(results.dialogThemes??=[] as unknown[]);(results.dialogThemes as unknown[]).push({theme,presentation});
      if(index===0){
        await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('agentviewer:command');(ipcMain as any).__dialogCloseQa={original,calls:0};handlers.set('agentviewer:command',async(event:any,request:any)=>{if(request.method==='office-surface-window-close'){(ipcMain as any).__dialogCloseQa.calls++;await new Promise(done=>setTimeout(done,350));}return original(event,request);});});
        try{
          await main.locator('.embedded-office-window-close').last().click();await form.locator('[data-office-control-id="cancel"]').focus();assert.equal(await form.evaluate(node=>node.contains(document.activeElement)),true,'repeated Escape is sent from inside the pending dialog');await main.keyboard.press('Escape');await main.keyboard.press('Escape');
          await until(async()=>!(await status(word)).windows?.some(window=>window.visible&&window.kind==='dialog'),'the guarded close reaches the actual native window');
          await form.waitFor({state:'hidden'});const requests=await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogCloseQa.calls);assert.equal(requests,1,'X followed by repeated Escape shares one in-flight native close');results.dialogCloseGuard={requests,delayMs:350};
        }finally{await app.evaluate(({ipcMain})=>{const qa=(ipcMain as any).__dialogCloseQa;(ipcMain as any)._invokeHandlers.set('agentviewer:command',qa.original);delete (ipcMain as any).__dialogCloseQa;});}
      }else{await main.locator('.embedded-office-window-close').last().click();await until(async()=>!(await status(word)).windows?.some(window=>window.visible&&window.kind==='dialog'),'theme dialog closes');}
      const paper=await screenshot(`writer-paper-${index}-${theme}`);assert.ok(paper.whiteFraction>.65&&paper.blackFraction<.15,'theme does not darken the independent document paper');
    }
    // Hold only a genuine native field reply. Cancel must wait for that issued
    // action, suppress the not-yet-issued Insert, and close the exact window.
    await main.locator('[data-uno-command=".uno:InsertTable"]').click();
    const dismissForm=main.locator('.office-dialog-form');await dismissForm.waitFor();
    const dismissState=await status(word),dismissWindow=dismissState.windows!.find(window=>window.visible&&window.kind==='dialog')!;
    const dismissControls=await invoke<{dialog:NonNullable<OfficeSurfaceWindow['dialog']>}>('office-surface-window-controls',{viewId:word.id,sessionId:dismissState.sessionId,engineEpoch:dismissState.engineEpoch,windowId:dismissWindow.id,windowInstanceId:dismissWindow.instanceId});
    const findDismissNode=(node:OfficeSurfaceDialogNode,nativeId:string):OfficeSurfaceDialogNode|undefined=>node.nativeId===nativeId?node:(node.children??[]).map(child=>findDismissNode(child,nativeId)).find(Boolean);
    await app.evaluate(({ipcMain},ids)=>{
      const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('agentviewer:command');
      const qa:any={original,entered:false,trace:[]};(ipcMain as any).__dialogDismissQa=qa;
      qa.gate=new Promise<void>(done=>{qa.release=done;});
      handlers.set('agentviewer:command',async(event:any,request:any)=>{
        if(request.method==='office-surface-window-action'&&request.args?.nodeId===ids.confirm)qa.trace.push('confirm');
        if(request.method==='office-surface-window-close')qa.trace.push('close');
        const result=await original(event,request);
        if(request.method==='office-surface-window-action'&&request.args?.nodeId===ids.field){qa.entered=true;qa.trace.push('field-native-complete');await qa.gate;qa.trace.push('field-reply-released');}
        return result;
      });
    },{field:findDismissNode(dismissControls.dialog.root,'colspin')!.id,confirm:findDismissNode(dismissControls.dialog.root,'ok')!.id});
    try{
      await dismissForm.locator('[data-office-control-id="colspin"] input').fill('3');await dismissForm.locator('[data-office-control-id="ok"]').click();
      await until(async()=>await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogDismissQa.entered),'the actual field reply is held while Insert waits');
      await dismissForm.locator('[data-office-control-id="cancel"]').click();await main.waitForTimeout(80);
      assert.deepEqual(await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogDismissQa.trace),['field-native-complete'],'cancel waits for the issued field and never races a native close');
      await app.evaluate(({ipcMain})=>{(ipcMain as any).__dialogDismissQa.release();});
      await dismissForm.waitFor({state:'hidden'});
      const trace=await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogDismissQa.trace);
      assert.deepEqual(trace,['field-native-complete','field-reply-released','close'],'no stale Insert is sent after the user dismisses the dialog');
      assert.equal((await status(word)).dirty,false,'canceling a pending confirmation does not insert a table');results.dialogDismissal={trace,nativeDirty:false};
    }finally{await app.evaluate(({ipcMain})=>{const qa=(ipcMain as any).__dialogDismissQa;qa.release();(ipcMain as any)._invokeHandlers.set('agentviewer:command',qa.original);delete (ipcMain as any).__dialogDismissQa;});}
    // A controls read failure must stay in the themed UI rather than exposing
    // an unrequested native bitmap. Retrying only repeats the read operation.
    await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('agentviewer:command');(ipcMain as any).__dialogReadQa={original,reject:true,calls:0};handlers.set('agentviewer:command',async(event:any,request:any)=>{const qa=(ipcMain as any).__dialogReadQa;if(request.method==='office-surface-window-controls'){qa.calls++;if(qa.reject)throw Error('QA_NATIVE_CONTROL_READ_FAILED');}return original(event,request);});});
    try{
      await main.locator('[data-uno-command=".uno:InsertTable"]').click();await main.locator('.office-dialog-unavailable').waitFor();
      assert.equal(await main.locator('.embedded-office-dialog-window canvas').count(),0,'a failed read never silently reverts to the raw Office bitmap');
      const failedReadState=await status(word),failedReadWindow=failedReadState.windows?.find(window=>window.visible&&window.kind==='dialog');
      await main.getByRole('button',{name:'设置',exact:true}).focus();
      assert.equal(await main.locator('.office-structured-dialog').evaluate(node=>node.contains(document.activeElement)),failedReadWindow?.modal===true,'focus trapping follows actual known native modality; an unread window never invents a native modal lock');
      await app.evaluate(({ipcMain})=>{(ipcMain as any).__dialogReadQa.reject=false;});await main.getByRole('button',{name:'重新读取',exact:true}).click();await main.locator('.office-dialog-form').waitFor();
      assert.equal(await main.locator('[data-office-control-id="colspin"] input').inputValue(),'2');
      const recoveredDialog=main.locator('.office-structured-dialog');await main.getByRole('button',{name:'设置',exact:true}).focus();
      assert.equal(await recoveredDialog.evaluate(node=>node.contains(document.activeElement)),await recoveredDialog.getAttribute('aria-modal')==='true','recovered native modal forms contain focus without trapping modeless forms');
      results.dialogReadRecovery={calls:await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogReadQa.calls),keptThemed:true,failedReadModality:failedReadWindow?.modal??'unknown'};await main.locator('.embedded-office-window-close').last().click();await main.locator('.office-dialog-form').waitFor({state:'hidden'});
    }finally{await app.evaluate(({ipcMain})=>{const qa=(ipcMain as any).__dialogReadQa;(ipcMain as any)._invokeHandlers.set('agentviewer:command',qa.original);delete (ipcMain as any).__dialogReadQa;});}
    await main.locator('[data-uno-command=".uno:InsertTable"]').click();const form=main.locator('.office-dialog-form');await form.waitFor();
    // Chromium supplies actual composition state and keyboard events. Confirming
    // or canceling an IME candidate must neither commit a preedit native field
    // nor close its parent document dialog.
    const imeState=await status(word),imeWindow=imeState.windows!.find(window=>window.visible&&window.kind==='dialog')!;
    const readImeDialog=async()=>invoke<{dialog:NonNullable<OfficeSurfaceWindow['dialog']>}>('office-surface-window-controls',{viewId:word.id,sessionId:imeState.sessionId,engineEpoch:imeState.engineEpoch,windowId:imeWindow.id,windowInstanceId:imeWindow.instanceId});
    const findImeNode=(node:OfficeSurfaceDialogNode,nativeId:string):OfficeSurfaceDialogNode|undefined=>node.nativeId===nativeId?node:(node.children??[]).map(child=>findImeNode(child,nativeId)).find(Boolean);
    const imeNode=findImeNode((await readImeDialog()).dialog.root,'nameedit')!;assert.ok(imeNode);
    await app.evaluate(({ipcMain},nodeId)=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('agentviewer:command');(ipcMain as any).__dialogImeQa={original,actions:[]};handlers.set('agentviewer:command',async(event:any,request:any)=>{if(request.method==='office-surface-window-close'||request.method==='office-surface-window-action'&&request.args?.nodeId===nodeId)(ipcMain as any).__dialogImeQa.actions.push({method:request.method,action:request.args?.action});return original(event,request);});},imeNode.id);
    await main.evaluate(()=>{const state={keys:[] as {key:string;isComposing:boolean;keyCode:number}[],listener:undefined as ((event:KeyboardEvent)=>void)|undefined};state.listener=event=>{if((event.target as Element)?.closest('.office-dialog-form'))state.keys.push({key:event.key,isComposing:event.isComposing,keyCode:event.keyCode});};(window as any).__dialogImeQa=state;document.addEventListener('keydown',state.listener,true);});
    const imeCdp=await app.context().newCDPSession(main),imeField=form.locator('[data-office-control-id="nameedit"] input'),finalImeName='潮灯表格';
    try{
      await imeField.fill('');
      for(const [key,code] of [['Enter',13],['Escape',27]] as const){
        await imeCdp.send('Input.imeSetComposition',{text:'潮灯预编辑',selectionStart:5,selectionEnd:5});
        await imeCdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code});
        await imeCdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code});
        await main.waitForTimeout(120);assert.equal(await form.isVisible(),true,'IME '+key+' preserves its real document dialog');
        assert.deepEqual(await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogImeQa.actions),[],'IME '+key+' never sends preedit text or closes the native dialog');
      }
      await imeField.fill('');await imeCdp.send('Input.imeSetComposition',{text:finalImeName,selectionStart:finalImeName.length,selectionEnd:finalImeName.length});await imeCdp.send('Input.insertText',{text:finalImeName});
      assert.equal(await imeField.inputValue(),finalImeName);assert.deepEqual(await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogImeQa.actions),[],'composition end leaves the final text as a local draft');
      await imeField.press('Tab');await until(async()=>findImeNode((await readImeDialog()).dialog.root,'nameedit')?.value===finalImeName,'blur commits the final Chinese dialog field to actual VCL');
      const keys=await main.evaluate(()=>(window as any).__dialogImeQa.keys) as {key:string;isComposing:boolean;keyCode:number}[];
      for(const key of ['Enter','Escape'])assert.ok(keys.some(event=>event.key===key&&(event.isComposing||event.keyCode===229)),'actual Chromium '+key+' occurs during IME composition');
      results.dialogIme={keys,actions:await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogImeQa.actions),nativeValue:findImeNode((await readImeDialog()).dialog.root,'nameedit')?.value,coverage:'Chromium CDP composition and native VCL readback, not OS Pinyin'};
    }finally{
      await imeCdp.detach();await main.evaluate(()=>{const state=(window as any).__dialogImeQa;if(state?.listener)document.removeEventListener('keydown',state.listener,true);delete (window as any).__dialogImeQa;});
      await app.evaluate(({ipcMain})=>{const state=(ipcMain as any).__dialogImeQa;if(state?.original)(ipcMain as any)._invokeHandlers.set('agentviewer:command',state.original);delete (ipcMain as any).__dialogImeQa;});
    }
    await form.locator('[data-office-control-id="cancel"]').click();await form.waitFor({state:'hidden'});await main.locator('[data-uno-command=".uno:InsertTable"]').click();await form.waitFor();
    // Delay a genuine native field receipt, then immediately reverse the local
    // edit before that receipt is accepted. The second intent must reach VCL.
    await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('agentviewer:command');(ipcMain as any).__dialogQa={delayed:false,values:[],rejectNext:false};handlers.set('agentviewer:command',async(event:any,request:any)=>{const qa=(ipcMain as any).__dialogQa;if(request.method==='office-surface-window-action'&&request.args?.action?.kind==='set-text'){qa.values.push(request.args.action.value);if(qa.rejectNext){qa.rejectNext=false;throw Error('QA_NATIVE_FIELD_REJECTED');}const result=await original(event,request);if(!qa.delayed){qa.delayed=true;await new Promise(done=>setTimeout(done,700));}return result;}return original(event,request);});});
    const column=form.locator('[data-office-control-id="colspin"] input');await column.fill('3');await column.press('Enter');await column.fill('2');await column.press('Tab');
    await until(async()=>{const qa=await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogQa);return qa.values.includes('3')&&qa.values.includes('2')&&await form.getAttribute('aria-busy')==='false';},'reversed field intent survives a delayed actual native receipt');
    const readDialog=async()=>{const state=await status(word),window=state.windows!.find(window=>window.visible&&window.kind==='dialog')!;return invoke<{dialog:NonNullable<OfficeSurfaceWindow['dialog']>}>('office-surface-window-controls',{viewId:word.id,sessionId:state.sessionId,engineEpoch:state.engineEpoch,windowId:window.id,windowInstanceId:window.instanceId});};
    const findNode=(node:any,nativeId:string):any=>node.nativeId===nativeId?node:(node.children??[]).map((child:any)=>findNode(child,nativeId)).find(Boolean);
    assert.equal(findNode((await readDialog()).dialog.root,'colspin').value,'2','VCL receives the final reversed value');
    await app.evaluate(({ipcMain})=>{(ipcMain as any).__dialogQa.rejectNext=true;});await column.fill('4');await form.locator('[data-office-control-id="ok"]').click();
    await until(async()=>form.locator('[role="alert"]').count().then(count=>count>0),'a rejected field remains visible instead of confirming stale values');assert.equal((await status(word)).dirty,false,'failed field input cannot fall through into Insert');assert.equal(findNode((await readDialog()).dialog.root,'colspin').value,'2');
    await form.locator('[data-office-control-id="cancel"]').click();await form.waitFor({state:'hidden'});results.dialogIntentGuards=await app.evaluate(({ipcMain})=>(ipcMain as any).__dialogQa);
    await main.locator('[data-uno-command=".uno:InsertTable"]').click();await form.waitFor();
    await form.locator('[data-office-control-id="colspin"] input').fill('3');await form.locator('[data-office-control-id="rowspin"] input').fill('2');await form.locator('[data-office-control-id="nameedit"] input').fill('AgentViewerTable');await form.locator('[data-office-control-id="nameedit"] input').press('Tab');
    const header=form.locator('[data-office-control-id="headercb"] [role="switch"]');if(await header.getAttribute('aria-checked')!=='true')await header.click();await until(async()=>header.getAttribute('aria-checked').then(value=>value==='true'),'project switch changes the actual native header option');
    await form.locator('[data-office-control-id="ok"]').click();await form.waitFor({state:'hidden'});await until(async()=>(await status(word)).dirty===true,'project dialog inserts a real native table');
    await invoke('save',{documentId:word.documentId});const zip=await JSZip.loadAsync(await readFile(join(directory,names.docx))),xml=await zip.file('word/document.xml')!.async('string'),tables=[...xml.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g)].map(match=>match[0]);assert.ok(tables.some(table=>(table.match(/<w:gridCol\b/g)??[]).length===3&&(table.match(/<w:tr(?:\s|>)/g)??[]).length===2),'saved DOCX contains the requested 3-column, 2-row table');results.structuredDialogInsert={tableCount:tables.length,savedBytes:(await readFile(join(directory,names.docx))).length};
    await invoke('settings-set',{id:'appearance.theme',value:'dark'});await humanFocus(word);await leftCategory('开始','home');
    // Common font properties use the inspector. The full dialog remains in the
    // discovered command menu, so exercise that actual user route.
    await main.locator('.native-office-search > summary').click();await main.getByRole('textbox',{name:'搜索原生 Office 命令'}).fill('.uno:FontDialog');await main.locator('.native-office-search-results [data-uno-command=".uno:FontDialog"]').click();await main.getByRole('button',{name:'运行命令',exact:true}).click();const font=main.locator('.office-dialog-form');await font.waitFor();
    await font.locator('[data-office-control-id="tabcontrol"]').getByRole('radio',{name:'字体效果',exact:true}).click();const overline=font.locator('[data-office-control-id="overlinelb"]');await overline.waitFor();
    assert.equal(await font.getByRole('heading',{name:'文字颜色',exact:true}).count(),1,'native frame wrappers do not duplicate the same section heading');
    const overlineChoice=overline.getByRole('combobox');await overlineChoice.focus();await overlineChoice.press('Enter');
    assert.equal(await overlineChoice.getAttribute('aria-expanded'),'true','Enter opens the actual non-editable choice');
    const activeChoice=()=>overlineChoice.getAttribute('aria-activedescendant');
    await overlineChoice.press('End');await until(async()=>{const id=await activeChoice();if(!id)return false;return main.locator('[role="option"]').evaluateAll((nodes,activeId)=>{const option=nodes.find(node=>node.id===activeId);if(!option)return false;const box=option.getBoundingClientRect(),parent=option.parentElement!.getBoundingClientRect();return box.top>=parent.top-1&&box.bottom<=parent.bottom+1;},id);},'keyboard highlights scroll inside the actual themed list');
    await overlineChoice.press('Escape');assert.equal(await font.isVisible(),true,'Escape closes its menu rather than the native dialog');assert.equal(await overlineChoice.getAttribute('aria-expanded'),'false');
    await overline.getByRole('button',{name:/^展开/}).click();await main.getByRole('option',{name:'单线',exact:true}).click();
    await until(async()=>{const state=await status(word),window=state.windows?.find(window=>window.visible&&window.kind==='dialog');if(!window)return false;const read=await invoke<{dialog?:OfficeSurfaceWindow['dialog']}>('office-surface-window-controls',{viewId:word.id,sessionId:state.sessionId,engineEpoch:state.engineEpoch,windowId:window.id,windowInstanceId:window.instanceId});const visit=(node:any):boolean=>node.nativeId==='overlinelb'&&node.options?.some((option:any)=>option.selected&&option.text==='Single')||(node.children??[]).some(visit);return !!read.dialog&&visit(read.dialog.root);},'project font tab and dropdown change the actual native overline selection');
    await overlineChoice.focus();await overlineChoice.press('Enter');
    const selectedId=await activeChoice();assert.ok(selectedId);assert.equal(await main.locator('[role="option"]').evaluateAll((nodes,id)=>nodes.find(node=>node.id===id)?.textContent?.trim(),selectedId),'单线','reopening starts at the real selected option');
    const overlineList=main.getByRole('listbox');await overlineList.waitFor();assert.equal(await overlineList.count(),1);assert.equal(await overlineList.getAttribute('id'),await overlineChoice.getAttribute('aria-controls'),'the open native choice owns exactly this listbox');
    const optionTabs=await overlineList.getByRole('option').evaluateAll(nodes=>nodes.map(node=>({id:node.id,tabIndex:(node as HTMLElement).tabIndex,attribute:node.getAttribute('tabindex')}))),nativeOptions=findNode((await readDialog()).dialog.root,'overlinelb').options;
    assert.ok(optionTabs.length>0);assert.equal(optionTabs.length,nativeOptions.length,'the open menu renders every actual native overline option');assert.ok(optionTabs.every(option=>option.tabIndex===-1&&option.attribute==='-1'),'list items do not create a second modal Tab loop');
    results.fontChoiceTabOrder={options:optionTabs.length,outsideOptions:await main.getByRole('option').evaluateAll((nodes,id)=>nodes.filter(node=>node.closest('[role="listbox"]')?.id!==id).map(node=>({tag:node.tagName,text:node.textContent,select:node.closest('select')?.getAttribute('aria-label')})),await overlineList.getAttribute('id'))};
    await main.screenshot({path:join(evidence,'writer-font-choice-dark.png'),scale:'css'});await overlineChoice.press('Tab');assert.equal(await overlineChoice.getAttribute('aria-expanded'),'false');
    const fontWindow=font.locator('..');if(await fontWindow.getAttribute('aria-modal')==='true'){
      await main.locator('.tab-select').first().evaluate(node=>(node as HTMLElement).focus());assert.equal(await fontWindow.evaluate(node=>node.contains(document.activeElement)),true,'a true modal keeps focus inside its own form');
    }
    await main.screenshot({path:join(evidence,'writer-font-effects-dark.png'),scale:'css'});await font.locator('[data-office-control-id="cancel"]').click();await font.waitFor({state:'hidden'});results.structuredFontDialog={tab:'Font Effects',overline:'Single',cancelled:true,keyboardChoice:true};
    const nativeSearch=main.locator('.native-office-search');if(await nativeSearch.getAttribute('open')===null)await nativeSearch.locator(':scope > summary').click();
    await main.getByRole('textbox',{name:'搜索原生 Office 命令'}).fill('.uno:SetDocumentProperties');await main.locator('.native-office-search-results [data-uno-command=".uno:SetDocumentProperties"]').click();await main.getByRole('button',{name:'运行命令',exact:true}).click();
    const properties=main.locator('.office-dialog-form');await properties.waitFor();await properties.locator('[data-office-control-id="tabcontrol"]').getByRole('radio',{name:'描述',exact:true}).click();
    const comments=properties.locator('[data-office-control-id="comments"] textarea');await comments.waitFor();assert.equal(await properties.getByText('说明',{exact:true}).count(),1,'a top-aligned multiline field has only its one functional label');assert.equal(await main.locator('.office-structured-dialog h2').textContent(),'文档属性','native snapshot UUID stays out of the modal heading');await comments.fill('第一行说明');await comments.press('End');await comments.press('Enter');await main.keyboard.insertText('Second line');
    const multilineText='第一行说明\nSecond line';assert.equal(await comments.inputValue(),multilineText,'the native multiline field uses an actual DOM textarea and Enter inserts a newline');await comments.press('Tab');
    await until(async()=>{const state=await status(word),window=state.windows?.find(window=>window.visible&&window.kind==='dialog');if(!window)return false;const read=await invoke<{dialog?:OfficeSurfaceWindow['dialog']}>('office-surface-window-controls',{viewId:word.id,sessionId:state.sessionId,engineEpoch:state.engineEpoch,windowId:window.id,windowInstanceId:window.instanceId});const visit=(node:OfficeSurfaceDialogNode):boolean=>node.nativeId==='comments'&&node.multiline===true&&node.value?.replace(/\r\n/g,'\n')===multilineText||(node.children??[]).some(visit);return !!read.dialog&&visit(read.dialog.root);},'multiline Chinese and newline content reaches the actual native properties control');
    await main.screenshot({path:join(evidence,'writer-properties-multiline-dark.png'),scale:'css'});await properties.locator('[data-office-control-id="ok"]').click();await properties.waitFor({state:'hidden'});await invoke('save',{documentId:word.documentId});
    const metadataZip=await JSZip.loadAsync(await readFile(join(directory,names.docx))),metadataXml=await metadataZip.file('docProps/core.xml')!.async('string'),metadata=new DOMParser().parseFromString(metadataXml,'application/xml'),savedDescription=metadata.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/','description')[0]?.textContent;
    assert.equal(savedDescription?.replace(/\r\n/g,'\n'),multilineText,'the actual saved DOCX metadata preserves both lines');results.structuredMultiline={nativeReadback:true,text:multilineText,savedDescription,saved:true};
  } else if(qaOnly==='ppt-selection') {
    await verifyImpressEditing(await open('pptx'));
  } else {
word = await open('docx');
results.wordElasticity = await verifyOfficeElasticity(main);
results.writerInitial = { state: await status(word), pixels: await screenshot('writer-light-white') };
await navigate(word, { kind: 'paragraph', paragraphIndex: 0 });
await humanFocus(word);
await main.keyboard.press('Control+Home');
const writerSelectionStarted=Date.now();
await main.keyboard.press('Shift+End');
await until(async () => { const context = await invoke<ReadingContext>('context', { viewId: word.id }); return context.actor === 'human' && context.quality === 'confirmed' && !!context.selection.text && !!context.selection.rect; }, 'human Writer selection lease');
await main.locator('.selection-tools[role="toolbar"]').waitFor();
results.writerSelectionReadyMs=Date.now()-writerSelectionStarted;
const chosen = (await status(word)).selection!.text;
await main.mouse.move((await main.locator('.embedded-office-content').boundingBox())!.x + 200, 550);
await main.mouse.wheel(0, 28);
await main.waitForTimeout(180);
assert.equal((await status(word)).selection?.text, chosen);
results.writerSelection = { text: chosen, toolbar: await main.locator('.selection-tools').boundingBox(), pixels: await screenshot('writer-selection') };
await leftCategory('开始', 'home');
await verifyToolIcons('docx','home');
const inspector = main.locator('[data-native-style-target="text"]');
await inspector.getByRole('spinbutton', { name: '文字 · 字号' }).fill('23');
const writerStyleStarted=Date.now();
await inspector.getByRole('spinbutton', { name: '文字 · 字号' }).press('Enter');
await until(async () => (await style(word, 'text')).data.fields.fontSize?.value === 23, 'left Writer tools edit the same native model');
results.writerStyleConfirmedMs=Date.now()-writerStyleStarted;
const beforeObscured=await status(word);
const beforeObscuredLease=await app.evaluate(({ipcMain},viewId)=>[...((ipcMain as any).__officeQaTrace as any[])].reverse().find(item=>item.viewId===viewId&&item.method==='office-surface-layout')?.args?.leaseId,word.id);
assert.ok(beforeObscuredLease,'the mounted renderer has an actual display lease');
await main.getByRole('button',{name:'关闭 '+names.docx,exact:true}).click();
const closeConfirmation=main.getByRole('dialog',{name:'保存文档更改？',exact:true});
await closeConfirmation.waitFor();
const withdrawnForDialog=await status(word);
assert.equal(withdrawnForDialog.visible,false);
assert.equal(withdrawnForDialog.nativeGeometry,false);
const publicWithdrawnForDialog=await invoke<NativeOfficeState>('office-status',{viewId:word.id});
assert.equal(publicWithdrawnForDialog.visible,false);assert.equal(publicWithdrawnForDialog.nativeGeometry,false,'public SDK geometry remains withdrawn while an overlay obscures the renderer');
await assert.rejects(()=>invoke('office-surface-input',{viewId:word.id,leaseId:beforeObscuredLease,streamId:'qa-obscured-'+randomUUID(),sequence:1,layoutRevision:beforeObscured.layoutRevision,expectedPartIndex:beforeObscured.partIndex,event:{kind:'pointer',phase:'down',pointTwips:{x:0,y:0},button:0,buttons:1,clickCount:1,modifiers:{shift:false,control:false,alt:false,meta:false}}}),/OFFICE_DISPLAY_EXPIRED|OFFICE_DISPLAY_NOT_PRESENTED/,'the same pre-overlay lease cannot deliver a native click while presentation is withdrawn');
assert.equal((await status(word)).engineRevision,beforeObscured.engineRevision,'the rejected old-lease input never reaches the native model');
await closeConfirmation.getByRole('button',{name:'取消',exact:true}).click();
await closeConfirmation.waitFor({state:'hidden'});
const afterObscured=await ready(word);
assert.equal(afterObscured.sessionId,beforeObscured.sessionId);
assert.equal(afterObscured.engineEpoch,beforeObscured.engineEpoch);
await main.locator('.selection-tools[role="toolbar"]').waitFor();
assert.equal((await status(word)).selection?.text,chosen,'canceling close restores the same real selection tools');
results.displayObscuredRestored={before:beforeObscured,withdrawn:withdrawnForDialog,publicWithdrawn:publicWithdrawnForDialog,oldLeaseInputRejected:true,restored:afterObscured};
await humanFocus(word);
await main.keyboard.press('Control+Home');
await main.keyboard.press('End');
await main.keyboard.press('Enter');
await main.keyboard.insertText(marker);
const cdp = await app.context().newCDPSession(main);
await cdp.send('Input.imeSetComposition', { text: '潮灯', selectionStart: 2, selectionEnd: 2 });
await until(async () => (await status(word)).pendingInput === true, 'actual Chromium preedit reaches engine composition barrier');
results.imePending = await status(word);
await cdp.send('Input.imeSetComposition', { text: '潮灯町', selectionStart: 3, selectionEnd: 3 });
await cdp.send('Input.insertText', { text: '潮灯町' });
await settleInput(word);
await cdp.detach();
await saveViaHumanShortcut(word);
await until(async () => JSON.stringify(await model(word)).includes(marker + '潮灯町'), 'ASCII plus Chinese appear once in real model');
const writtenWord = (await model(word)).blocks!.map(block => block.text).join('\n');
assert.equal(writtenWord.split(marker + '潮灯町').length - 1, 1, 'IME does not double commit');
const viewport = (await main.locator('.embedded-office-content').boundingBox())!;
await main.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
await main.mouse.wheel(0, 480);
await until(async () => main.locator('.embedded-office-content').evaluate(node => node.scrollTop > 100), 'body scrolls');
const readPosition = await invoke<ReadingContext>('context', { viewId: word.id });
assert.ok(readPosition.viewport && readPosition.viewport.scrollY > 0);
results.writerScroll = readPosition;
const beforeZoom = (await workspace()).views.find(value => value.id === word.id)!.zoom ?? 1;
await main.keyboard.down('Control');
await main.mouse.wheel(0, -120);
await main.keyboard.up('Control');
await until(async () => ((await workspace()).views.find(value => value.id === word.id)!.zoom ?? 1) > beforeZoom, 'Ctrlwheel changes body zoom');
await invoke('zoom', { viewId: word.id, factor: 1 });
await navigate(word, { kind: 'paragraph', paragraphIndex: 0 });
await ready(word);
await invoke('settings-set', { id: 'appearance.theme', value: 'dark' });
await invoke('settings-set', { id: 'appearance.documentPaperColor', value: '#ffffff' });
await main.waitForTimeout(500);
const darkWhite = await screenshot('writer-dark-white');
assert.ok(darkWhite.whiteFraction > .65 && darkWhite.blackFraction < .15, 'dark chrome must not force the actual paper black');
await invoke('settings-set', { id: 'appearance.documentPaperColor', value: '#fff4dc' });
await main.waitForTimeout(500);
const warm = await screenshot('writer-dark-warm');
assert.ok(warm.warmFraction > .5, 'blank paper color is independent of chrome and existing text');
results.paper = { darkWhite, warm };
await invoke('settings-set', { id: 'appearance.documentPaperColor', value: '#ffffff' });
await invoke('settings-set', { id: 'appearance.theme', value: 'light' });
const wordSaved = await saveReopen(word, 'docx', value => assert.ok(value.blocks?.some(block => block.text.includes(marker + '潮灯町'))));
word = wordSaved.view;
results.writerSaved = wordSaved;
await navigate(word, { kind: 'paragraph', paragraphIndex: 0 });
await humanFocus(word);
await main.keyboard.press('Control+Home');
await main.keyboard.press('Shift+End');
await main.locator('.selection-tools').waitFor();
const control = await invoke<{ controlId: string }>('agent-acquire', { viewId: word.id, documentId: word.documentId, phase: 'editing', agentId: 'embedded-office-ui' });
const engineLease = await status(word);
await invoke('office-execute', { viewId: word.id, ...version(engineLease), style: { target: 'text', values: { italic: true } }, controlId: control.controlId, idempotencyKey: randomUUID() });
await until(async () => main.locator('.embedded-office-document').getAttribute('data-office-actor').then(value => value === 'human'), 'internal desktop edit retains the human IPC actor');
await main.locator('.agent-operation-capsule').waitFor();
await until(async () => main.locator('.embedded-office-document').getAttribute('data-office-agent-active').then(value => value === 'true'), 'actual selected target is highlighted during acquired Agent control');
results.agent = { controlId: control.controlId, state: await status(word), pixels: await screenshot('writer-agent-target') };
await invoke('agent-release', { viewId: word.id, controlId: control.controlId });
await main.locator('.agent-operation-capsule').waitFor({ state: 'hidden' });
await until(async () => main.locator('.embedded-office-document').getAttribute('data-office-agent-active').then(value => value === 'false'), 'Agent release removes target treatment');
await invoke('save', { documentId: word.documentId });
console.log('Embedded Office actual UI: Writer input, IME, selection, left tools, scroll, zoom, paper + save/reopen PASS');

const retiringWordCanvas = !!word;
if (retiringWordCanvas) await main.locator('.embedded-office-canvas').evaluate(node => {
    if (!(node instanceof HTMLCanvasElement) || node.width <= 1 || node.height <= 1) throw new Error('actual Writer backing is missing before tab handoff');
    (window as any).__officeRetiredCanvasQa = node;
  });
let calc = await open('xlsx');
results.sheetElasticity = await verifyOfficeElasticity(main);
if (retiringWordCanvas) {
    const retirement = await main.evaluate(() => {
      const node = (window as any).__officeRetiredCanvasQa as HTMLCanvasElement;
      const result = { connected: node.isConnected, width: node.width, height: node.height };
      delete (window as any).__officeRetiredCanvasQa;
      return result;
    });
    assert.deepEqual(retirement, { connected: false, width: 1, height: 1 }, 'only the detached Writer backing is retired while the actual Calc Canvas remains usable');
    results.retiredCanvas = retirement;
  }
const sheet = (await status(calc)).parts[0];
await navigate(calc, { kind: 'cell', sheetName: sheet.name, address: 'Z50' });
await humanFocus(calc, 'cell');
await main.keyboard.press('F2');
const nativeFormulaInput='=SUM(20;22)';
results.nativeFormulaInput=nativeFormulaInput;
await main.keyboard.insertText(nativeFormulaInput);
await main.keyboard.press('Enter');
await until(async () => { try { const result = await invoke<{ data: { values: unknown[][]; formulas: string[][] } }>('office-query', { viewId: calc.id, target: { kind: 'cell-range', sheetName: sheet.name, range: 'Z50' } });results.calcFormulaReadback=result; return result.data.values?.[0]?.[0] === 42 && result.data.formulas?.[0]?.[0].includes('SUM(20,22)'); } catch(cause) { if(!String(cause).includes('STALE_NATIVE_QUERY'))throw cause;return false; } }, 'native Canvas Calc formula calculates 42');
await navigate(calc, { kind: 'cell', sheetName: sheet.name, address: 'AA50' });
await humanFocus(calc, 'cell');
await main.keyboard.press('F2');
await main.keyboard.insertText(marker);
await saveViaHumanShortcut(calc);
assert.ok(await main.locator('.native-office-formula-bar').isVisible());
await leftCategory('开始','home');
await verifyToolIcons('xlsx','home');
const tabs = await main.locator('.embedded-office-sheet-tabs').boundingBox();
assert.ok(tabs && tabs.height <= 32);
const calcBefore = await status(calc);
await verifySheetControlLane(calc,sheet.name);
await verifyCalcScrollEndpoints(calc,sheet.name);
await verifyContinuousZoomFrames(calc,'xlsx');
if (calcBefore.parts.length > 1) { await main.locator('.embedded-office-sheet-tabs [role="tab"]').nth(1).click(); await until(async () => (await status(calc)).partIndex === calcBefore.parts[1].index, 'compact sheet tabs navigate actual part'); }
results.calc = { state: await status(calc), pixels: await screenshot('calc-canvas'), tabHeight: tabs.height };
const calcSaved = await saveReopen(calc, 'xlsx', value => { const parsed = value.sheets!.find(item => item.name === sheet.name)!; assert.equal(parsed.rows[49][25].formula, 'SUM(18,24)'); assert.equal(Number(parsed.rows[49][25].value), 42); assert.equal(parsed.rows[49][26].value, marker); });
calc = calcSaved.view;
results.calcSaved = calcSaved;
await navigate(calc,{kind:'cell',sheetName:sheet.name,address:'A1'});
await leftCategory('开始','home');
await ready(calc);
await until(async()=>main.locator('.embedded-office-canvas').getAttribute('data-office-frame-reused').then(value=>value==='false'),'actual first-cell grid finishes its native tiles');
results.calcFirstCells={state:await status(calc),pixels:await screenshot('calc-frame-firstcells')};
console.log('Embedded Office actual UI: Calc cell text/formula, human save barrier, parts + reopened bytes PASS');

let slides = await open('pptx');
await verifyPresentationViewport(slides);
slides = await verifyImpressEditing(slides);
await main.getByRole('button',{name:names.docx,exact:true}).click();
await ready(word);
await humanFocus(word);
await main.keyboard.press('ArrowRight');
await until(async()=>!(await status(word)).selection?.text,'dialog target is a real unselected Writer caret');
await leftCategory('表格', 'table');
await verifyToolIcons('docx','table');
await main.locator('[data-uno-command=".uno:InsertTable"]').click();
// The first dispatch also discovers the native command catalog. Use the same
// 30-second cold-start allowance as the dedicated dialog flow.
await main.locator('.office-dialog-form').waitFor({ timeout: 30000 });
const dialogState = await status(word), dialog = dialogState.windows!.find(window => window.visible && window.kind === 'dialog')!;
assert.ok(dialog?.instanceId);
const dialogForm = main.locator(`[data-office-window-instance="${dialog.instanceId}"] .office-dialog-form`);
const raw=await invoke<OfficeSurfaceWindowPaintReply>('office-surface-window-paint',{viewId:word.id,sessionId:dialogState.sessionId,engineEpoch:dialogState.engineEpoch,windowId:dialog.id,windowInstanceId:dialog.instanceId,generation:dialog.generation,width:dialog.width,height:dialog.height,deviceScaleFactor:1});
const rgba=officeTileRgba(raw.tile);
let alphaPixels=0,nonzeroChannels=0;
for(let index=0;index<rgba.length;index++){if(rgba[index])nonzeroChannels++;if(index%4===3&&rgba[index])alphaPixels++;}
results.dialogAttempt={window:dialog,requestGeneration:dialog.generation,replyGeneration:raw.generation,replyStateWindow:raw.state.windows?.find(window=>window.instanceId===dialog.instanceId),alphaPixels,nonzeroChannels,tileWidth:raw.tile.width,tileHeight:raw.tile.height};
assert.equal(await dialogForm.getAttribute('data-office-dialog-source'),'native-uno-uitest');
assert.equal(await main.locator('.embedded-office-dialog-window canvas').count(),0);
await main.screenshot({ path: join(evidence, 'writer-native-dialog.png'), scale: 'css' });
await dialogForm.locator('input').first().focus();
await main.keyboard.press('Tab');
await main.keyboard.press('Escape');
await until(async () => !(await status(word)).windows?.some(window => window.instanceId === dialog.instanceId && window.visible), 'real window key Escape closes its own dialog');
await main.locator('[data-uno-command=".uno:InsertTable"]').click();
await main.locator('.office-dialog-form').waitFor();
await main.locator('.embedded-office-window-close').last().click();
await until(async () => !(await status(word)).windows?.some(window => window.visible && window.kind === 'dialog'), 'project shell cancellation closes native window');
results.dialog = { command:'.uno:InsertTable',instanceId: dialog.instanceId, kind: dialog.kind, width: dialog.width, height: dialog.height };
}

  const owned = await processes(); assert.ok([...workerPids].every(pid => owned.some(item => item.ProcessId === pid)), 'tested document writers belong to this isolated reader'); assert.ok(owned.every(item => !/^soffice(?:\.bin|\.exe)?$/i.test(item.Name)), 'no dedicated Office executable is spawned'); assert.equal(workerPids.size, 1, 'documents share one direct DLL worker'); results.processes = owned;
  const bootstrap=await app.evaluate(()=>(globalThis as any).__officeQaBootstrap) as {code:string;at:number}[];results.bootstrapDiagnostics=bootstrap;results.ipcTrace=await app.evaluate(({ipcMain})=>(ipcMain as any).__officeQaTrace);results.rendererPerformance=await main.evaluate(()=>(window as any).__officeQaPerformance);

  for (const name of Object.values(names)) assert.deepEqual(await readFile(originalPaths.get(name)!), originals.get(name), 'authored source stays unchanged');
  assert.deepEqual(errors, []); assert.doesNotMatch(stderr.join(''), /Object has been destroyed|UnhandledPromiseRejection|Uncaught (?:Exception|TypeError|Error)/i);
  passed = true; await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed, directory, evidence, scale, port, testScope: themeOnly ? 'structured-native-dialog,light-dark-light,real-table-save' : qaOnly==='ppt-selection'?'impress-selection,live-format,text-undo,save-reopen':'writer,calc,impress,native-dialog', ...results, errors, rendererScreenshotsIncludeActualEnginePixels: true, imeCoverage: themeOnly ? 'Chromium CDP dialog composition, not OS Pinyin' : 'Chromium CDP composition, not OS Pinyin' }, null, 2)); console.log(qaOnly==='ppt-selection'?'Real Impress selected text, live format, toolbar text Undo, redo and save/reopen: PASS':themeOnly ? 'Real native controls, themed DOM dialogs and saved 3x2 table: PASS' : 'Real Embedded Office Electron / native DLL tiles / desktop IPC / human Canvas input + Chromium IME / selection + styles / native dialog / save + reopen: PASS', evidence);
} catch (cause) {
  results.bootstrapDiagnostics=await app.evaluate(()=>(globalThis as any).__officeQaBootstrap).catch(()=>undefined);results.runtimeAtFailure=await invoke('office-statistics').catch(()=>undefined);results.rendererPerformance=await main.evaluate(()=>(window as any).__officeQaPerformance).catch(()=>undefined);results.ipcTrace=await app.evaluate(({ipcMain})=>(ipcMain as any).__officeQaTrace).catch(()=>undefined);results.lastState = await workspace().catch(() => undefined); await main.screenshot({ path: join(evidence, 'failure.png'), scale: 'css' }).catch(() => {}); await writeFile(join(evidence, 'failure.json'), JSON.stringify({ passed: false, cause: String(cause), directory, evidence, scale, results, errors, stderr: stderr.join('').slice(-20000) }, null, 2)); console.error('Embedded Office actual UI evidence:', evidence); throw cause;
} finally {

  await writeFile(join(evidence, 'main-stderr.log'), stderr.join(''));
  const ownedAtClose = await processes().catch(() => []);
  const exited = new Promise<void>(done => { if (primary.exitCode !== null || primary.signalCode !== null) done(); else primary.once('exit', () => done()); });
  // Desktop/engine shutdown must not leave this isolated run hanging forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>(done => { timer = setTimeout(() => {
    process.exitCode = 1;
    void (async () => {
      // Every candidate came from the creation-verified ownership graph. Recheck
      // that exact lifetime immediately before any emergency stop: PPIDs and
      // numeric child handles alone can refer to a newly reused user process.
      const stopCaptured = async (child: typeof ownedAtClose[number]) => {
        if (!Number.isSafeInteger(child.ProcessId) || child.ProcessId <= 0 || !/^\d+$/.test(child.CreationTicks) || !child.ExecutablePath) return;
        const literalPath = child.ExecutablePath.replace(/'/g, "''"), literalName = child.Name.replace(/'/g, "''");
        await run('powershell.exe', ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.ProcessId}'; if ($p -and $p.ParentProcessId -eq ${child.ParentProcessId} -and $p.CreationDate.ToUniversalTime().Ticks -eq ${child.CreationTicks} -and $p.Name -eq '${literalName}' -and $p.ExecutablePath -eq '${literalPath}') { Stop-Process -Id ${child.ProcessId} }`], { windowsHide: true, timeout: 5000 }).catch(() => {});
      };
      for (const child of ownedAtClose.filter(item => /^python(?:\.exe)?$/i.test(item.Name))) {
        await stopCaptured(child);
      }
      // A packaged Electron launcher may have a separate actual main process.
      // Its verified identity is still an owned descendant; stopping only the
      // launcher would leave this TEMP profile's unsaved-error window behind.
      const identity=results.identity as {pid?:number}|undefined;
      for (const child of ownedAtClose.filter(item => [identity?.pid, primary.pid].includes(item.ProcessId))) {
        const expected = executable;
        if (resolve(child.ExecutablePath ?? '').toLowerCase() === expected.toLowerCase()) await stopCaptured(child);
      }
      done();
    })();
  }, 15000); });
  try { await Promise.race([app.close().then(() => exited), deadline]); } finally { clearTimeout(timer); }
  await writeFile(join(evidence, 'qa-exit.json'), JSON.stringify({ pid:primary.pid,exitCode:primary.exitCode,signal:primary.signalCode,cleanupFailed:process.exitCode===1 },null,2));
}
