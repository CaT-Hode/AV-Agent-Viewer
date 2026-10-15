import assert from 'node:assert/strict';
import { _electron as electron, type Page } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
import type { OfficeSurfaceState, OfficeSurfaceWindowPaintReply } from '../packages/contracts/src/office-surface';
import { officeTileRgba } from '../apps/desktop/src/renderer/lib/office-surface-pixels';
import { officePresentationFit } from '../apps/desktop/src/renderer/lib/office-presentation-fit';
import {installOfficeOpenReceiptGate,officeOpenReceiptGate,installOfficeRuntimeRpcObserver,officeRuntimeRpcPhases} from './office-open-receipt-gate';

// Real Electron + shipped MCP + the direct DLL writer. Every editable file and profile is a TEMP copy.
// Playwright is used because a Browser plugin/browser skill is not available in this test runner.
// CDP Input is genuine Chromium composition, not a synthetic DOM event or a claim of OS Pinyin coverage.
const require = createRequire(import.meta.url), releaseExecutable = process.env.AGENTVIEWER_QA_EXE?.trim(), executable = releaseExecutable ? resolve(releaseExecutable) : require('electron') as string, run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-embedded-office-'));
const evidence = process.env.AGENTVIEWER_QA_DIR ? join(resolve(process.env.AGENTVIEWER_QA_DIR), 'embedded-office') : join(directory, 'evidence'); await mkdir(evidence, { recursive: true });
const names = { docx: '03-潮灯町的第十三夜.docx', pptx: '04-故事介绍.pptx', xlsx: '02-编年表.xlsx' } as const;
const originals = new Map<string, Buffer>();
for (const name of Object.values(names)) { const bytes = await readFile(resolve('examples/moon-tide', name)); originals.set(name, bytes); await writeFile(join(directory, name), bytes); }
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_CONNECTION_FILE: join(directory, 'runtime', 'connection.json') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'AGENTVIEWER_TEST_MODE', 'AGENTVIEWER_TEST_TRANSLATOR', 'AGENTVIEWER_VITE_URL', 'AGENTVIEWER_OFFICE_WORKER_MODE']) delete (env as Record<string, string>)[key];
const scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? 1), token = randomUUID().slice(0, 8), marker = 'Kit人类编辑-' + token;
const calcOnly = process.env.AGENTVIEWER_QA_ONLY === 'calc';
const pptDialogs=process.env.AGENTVIEWER_QA_ONLY==='ppt-dialog';
const pptOnly = process.env.AGENTVIEWER_QA_ONLY === 'ppt'||pptDialogs;
const scrollOnly=process.env.AGENTVIEWER_QA_ONLY==='scroll';
const loadingOnly=process.env.AGENTVIEWER_QA_ONLY==='loading';
const firstPaintOnly=process.env.AGENTVIEWER_QA_ONLY==='firstpaint';
const previewOnly=process.env.AGENTVIEWER_QA_ONLY==='preview';
const renderOnly=process.env.AGENTVIEWER_QA_ONLY==='render'||scrollOnly||loadingOnly||firstPaintOnly||previewOnly;
const app = await electron.launch({ executablePath: executable, args: [...(releaseExecutable ? [] : ['.']), '--force-device-scale-factor=' + scale], cwd: resolve('.'), env, timeout: 60000 });
const main = await app.firstWindow(), primary = app.process(), mcp = new Client({ name: 'agentviewer-embedded-office-ui', version: '1.0' });
const qaWidth=Number(process.env.AGENTVIEWER_QA_WIDTH??1440),qaHeight=Number(process.env.AGENTVIEWER_QA_HEIGHT??900);
assert.ok(qaWidth>=900&&qaHeight>=600,'QA stays within the supported desktop client size');
await app.evaluate(({BrowserWindow},value)=>{const root=BrowserWindow.getAllWindows()[0];root.setContentSize(value.width,value.height);root.show();root.focus();},{width:qaWidth,height:qaHeight});
const mcpTransport = new StdioClientTransport({ command: process.execPath, args: ['plugins/agent-viewer/server/launch.mjs'], env, cwd: resolve('.') });
const errors: string[] = [], stderr: string[] = [], results: Record<string, unknown> = {clientSize:{width:qaWidth,height:qaHeight}}, workerPids = new Set<number>();
await installOfficeRuntimeRpcObserver(app);
primary.stderr?.on('data', value => stderr.push(String(value)));
const watch = (page: Page) => { page.on('pageerror', error => errors.push(page.url() + ': ' + error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(page.url() + ': ' + entry.text()); }); };
app.context().pages().forEach(watch); app.context().on('page', watch);
// Trace real IPC metadata without changing any arguments, return values or engine calls.
await app.evaluate(({ipcMain,BrowserWindow})=>{
  const handlers=(ipcMain as unknown as {_invokeHandlers:Map<string,(...args:any[])=>Promise<any>>})._invokeHandlers, original=handlers.get('agentviewer:command');
  if(!original)throw new Error('actual command handler missing');
  const trace:any[]=[];(ipcMain as any).__officeQaTrace=trace;
  handlers.set('agentviewer:command',async(event:any,request:any)=>{
    const method=request.method,args=request.args;
    const isInput=method==='office-surface-input';
    const item:any={method,at:Date.now(),viewId:args?.viewId,args:isInput?{streamId:args.streamId,sequence:args.sequence,layoutRevision:args.layoutRevision,expectedPartIndex:args.expectedPartIndex,event:{kind:args.event?.kind,phase:args.event?.phase,key:args.event?.key,code:args.event?.code,button:args.event?.button,buttons:args.event?.buttons,textLength:args.event?.text?.length,pointTwips:args.event?.pointTwips}}:['office-surface-layout','office-layout','office-surface-window-paint','zoom'].includes(method)?args:undefined};
    const isTile=method==='office-surface-tiles',observed=isInput||isTile||['office-surface-layout','office-layout','office-surface-state','office-surface-window-paint','office-flush','zoom'].includes(method);
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
// Observe the actual runtime's bootstrap receipt before the first Office load.
// This hook only records allowlisted diagnostic codes and preserves emit's result.
await app.evaluate(()=>{
  const emitter=(process.getBuiltinModule('node:events') as unknown as {EventEmitter:{prototype:{emit:(type:string,...args:unknown[])=>boolean}}}).EventEmitter.prototype,original=emitter.emit;
  const receipts:{code:string;at:number}[]=[];(globalThis as any).__officeQaBootstrap=receipts;
  emitter.emit=function(this:unknown,type:string,...args:unknown[]){const message=args[0] as {code?:unknown}|undefined;if(type==='diagnostic'&&typeof message?.code==='string'&&message.code.startsWith('OFFICE_KIT_BOOTSTRAP_'))receipts.push({code:message.code,at:Date.now()});return original.call(this,type,...args);};
});
const until = async (check: () => Promise<boolean>, label: string, timeout = 30000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 90)); } throw new Error('Embedded Office acceptance timed out: ' + label); };
const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => main.evaluate(value => window.agentViewer!.call(value.method, value.args), { method, args }) as Promise<T>;
const tool = async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => { const result = await mcp.callTool({ name, arguments: args }); const text = (result.content as { type: string; text?: string }[]).find(entry => entry.type === 'text')?.text; assert.notEqual(result.isError, true, `${name}: ${text}`); assert.ok(text, name + ' returns actual JSON'); return JSON.parse(text) as T; };
const workspace = () => tool<WorkspaceState>('workspace_list');
const status = (view: ViewInfo) => invoke<OfficeSurfaceState>('office-surface-state', { viewId: view.id });
// A DOM scroll can enqueue one final native layout after the state read that
// triggered it. Coordinate tools must keep their strict version check, so the
// acceptance path waits for two identical live layout receipts before sending
// the coordinate action instead of retrying a stale action with changed bounds.
const stableStatus = async (view: ViewInfo) => {
  let previous: OfficeSurfaceState | undefined;
  await until(async () => {
    const next = await status(view);
    const stable = !!previous && next.layoutRevision === previous.layoutRevision && next.eventSequence === previous.eventSequence;
    previous = next;
    return stable;
  }, 'native Office layout settles before coordinate input', 10000);
  return previous!;
};
const version = (state: NativeOfficeState) => ({ expectedEngineEpoch: state.engineEpoch, expectedEngineRevision: state.engineRevision, expectedSelectionEpoch: state.selectionEpoch });
const model = (view: ViewInfo) => tool<DocumentModel>('document_read', { documentId: view.documentId });
const navigate = async (view: ViewInfo, target: Record<string, unknown>) => { const current = await status(view); await tool('office_navigate', { viewId: view.id, ...version(current), target, idempotencyKey: randomUUID() }); };
const ready = async (view: ViewInfo) => {
  await main.locator(`.embedded-office-document[data-office-ready="true"] .embedded-office-content[data-office-surface="${view.id}"]`).waitFor({ timeout: 120000 });
  let actual: OfficeSurfaceState | undefined, diagnosed=false; const start=Date.now();
  try { await until(async () => { actual = await status(view); const valid=actual.surfaceKind === 'tiled' && actual.status === 'ready' && actual.nativeGeometry === true && actual.visible === true && actual.layoutRevision > 0;if(!valid&&!diagnosed&&Date.now()-start>5000){diagnosed=true;await writeFile(join(evidence,'pending-layout.json'),JSON.stringify({viewId:view.id,state:actual,dom:await main.locator('.embedded-office-content').evaluate(node=>({bounds:node.getBoundingClientRect().toJSON(),hidden:document.hidden,scrollTop:node.scrollTop,scrollLeft:node.scrollLeft})),trace:await app.evaluate(({ipcMain})=>(ipcMain as any).__officeQaTrace)},null,2));}return valid; }, 'actual tiled layout: ' + view.id, 120000); }
  catch(cause) { results.unreadySurface={viewId:view.id,state:actual,dom:await main.locator('.embedded-office-content').evaluate(node=>({bounds:node.getBoundingClientRect().toJSON(),hidden:document.hidden,scrollTop:node.scrollTop,scrollLeft:node.scrollLeft}))}; throw cause; }
  assert.equal(actual!.viewId, view.id); assert.equal(actual!.documentId, view.documentId); assert.equal(actual!.nativeHwnd, '0', 'renderer body must be DOM/Canvas rather than an embedded Office frame');
  assert.ok(actual!.nativePid! > 0); workerPids.add(actual!.nativePid!);
  (results.readySurfaces??=[] as unknown[]);(results.readySurfaces as unknown[]).push({viewId:view.id,state:actual});
  assert.equal(await main.locator('.native-office-surface,.native-office-placeholder,.office-editing-ribbon').count(), 0);
  await until(async () => main.locator('.embedded-office-canvas').evaluate(canvas => { const target = canvas as HTMLCanvasElement, context = target.getContext('2d'); if (!context || !target.width || !target.height) return false; const pixels = context.getImageData(0, 0, target.width, target.height).data, colors = new Set<number>(); for (let i = 0; i < pixels.length; i += Math.max(4, Math.floor(pixels.length / 100000 / 4) * 4)) if (pixels[i + 3]) { colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]); if (colors.size > 12) return true; } return false; }), 'paintTile contains actual text and lines');
  return actual!;
};
const open = async (format: keyof typeof names) => {const start=performance.now();const view = await tool<ViewInfo>('reader_open', { uri: join(directory, names[format]) }),readApiMs=performance.now()-start; await until(async () => (await workspace()).activeViewId === view.id, 'MCP opened view'); const surface=await ready(view);(results.openTimings??=[] as unknown[]);(results.openTimings as unknown[]).push({format,viewId:view.id,sessionId:surface.sessionId,readApiMs,firstEditablePaintMs:performance.now()-start});return view; };
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
    try { const result = await tool<{ state: NativeOfficeState; data: NativeOfficeStyleInspection }>('office_query', { viewId: view.id, target: { kind: 'style', target } }); if (result.state.engineEpoch === before.engineEpoch && result.state.engineRevision === before.engineRevision && result.state.selectionEpoch === before.selectionEpoch) return result; }
    catch (cause) { if (!String(cause).includes('STALE_NATIVE_QUERY')) throw cause; }
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error('Actual Office style query did not settle after four read-only attempts. No mutation was retried.');
};
const leftCategory = async (name: string, category: string) => { const entry = main.getByRole('button', { name, exact: true }); if (await entry.getAttribute('aria-pressed') !== 'true') await entry.click(); await main.locator(`.native-office-tools[data-office-category="${category}"]`).waitFor(); };
const verifyToolIcons=async(format:string,category:string)=>{
  const pane=main.locator(`.native-office-tools[data-native-office-format="${format}"][data-office-category="${category}"]`);await pane.locator('.native-office-command-grid [data-uno-command]').first().waitFor();
  const commands=await pane.locator('.native-office-command-grid [data-uno-command]').evaluateAll(nodes=>nodes.map(node=>{const button=node as HTMLButtonElement,box=button.getBoundingClientRect();return {command:button.dataset.unoCommand,label:button.getAttribute('aria-label'),title:button.getAttribute('title'),text:button.innerText.trim(),svg:!!button.querySelector('svg'),width:box.width,height:box.height};}));
  assert.ok(commands.length>0);for(const command of commands){assert.equal(command.text,'','common tool presents its glyph rather than a visible text label');assert.equal(command.svg,true);assert.ok(command.label?.trim());assert.ok(command.title?.trim());assert.ok(Math.abs(command.width-32)<.6&&Math.abs(command.height-32)<.6,`${format} ${command.command} remains 32px`);}
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
    await until(async()=>!!await tip.textContent().then(text=>text?.includes(label!)),'icon tool retains its actual hover description');assert.equal(await tip.locator('[data-glass-effect="frosted"]').count(),1);await main.screenshot({path:join(evidence,`${format}-${category}-icon-tooltip.png`),scale:'css'});
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
  // file. Check disk immediately so a later MCP save cannot mask a broken UI.
  await main.keyboard.press('Control+s');await until(async()=>await bar.getAttribute('data-dirty').then(value=>value==='false'),'hidden navigation formula draft commits on actual CtrlS');
  await until(async()=>{const state=await workspace();return state.documents.find(item=>item.id===view.documentId)?.dirty===false&&!(await status(view)).pendingInput;},'hidden formula is saved after its native model receipt');
  const disk=await createRegistry().resolve('xlsx').open(new Uint8Array(await readFile(join(directory,names.xlsx))),'xlsx'),cell=disk.sheets!.find(sheet=>sheet.name===sheetName)!.rows[49][25];assert.equal(cell.formula,'SUM(18,24)');assert.equal(Number(cell.value),42);
  const reader=(await read()).reader;await main.mouse.move(reader.x+reader.width/2,reader.y+1);await until(async()=>!await main.locator('.navigation-toolbar').getAttribute('class').then(value=>value?.includes('is-hidden')),'reading edge reveals the same navigation formula');assert.equal(await field.getAttribute('data-qa-formula-node'),nodeToken);
  const hit=await main.locator('.embedded-office-sheet-tabs [role="tab"]').nth(1).evaluate(button=>{const box=button.getBoundingClientRect(),top=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return top===button||button.contains(top);});assert.equal(hit,true,'the real tab is the native mouse hit target');results.sheetControlLane=samples;
  results.navigationFormula={nodeToken,closed,reopened,diskFormula:cell.formula,diskValue:cell.value};
};
const verifyCalcScrollEndpoints=async(view:ViewInfo,sheetName:string)=>{
  const read=async()=>{const native=await status(view),layout=await app.evaluate(({ipcMain},viewId)=>(ipcMain as any).__officeQaTrace.findLast((entry:any)=>entry.method==='office-surface-layout'&&entry.viewId===viewId&&!entry.error)?.args,view.id);assert.ok(layout?.canvasOffsetCss,'native sheet uses the actual DOM layout tuple');return main.locator('.embedded-office-content').evaluate((host,value)=>{const stage=host.querySelector('.embedded-office-stage')!.getBoundingClientRect(),width=value.size.width*value.zoom/15,height=value.size.height*value.zoom/15;return {box:host.getBoundingClientRect().toJSON(),stage:stage.toJSON(),x:host.scrollLeft,y:host.scrollTop,maxX:host.scrollWidth-host.clientWidth,maxY:host.scrollHeight-host.clientHeight,width:host.clientWidth,height:host.clientHeight,paper:{left:stage.left+value.offset.x,top:stage.top+value.offset.y,right:stage.left+value.offset.x+width,bottom:stage.top+value.offset.y+height},sizeTwips:value.size,offset:value.offset};},{size:native.sizeTwips,zoom:native.zoom??1,offset:layout.canvasOffsetCss as {x:number;y:number}});};
  const before=await status(view);await tool('office_input',{viewId:view.id,...version(before),expectedLayoutRevision:before.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'scroll',x:before.viewport!.width/2,y:before.viewport!.height/2,deltaX:1000000,deltaY:1000000}});
  await until(async()=>{const actual=await read();return Math.abs(actual.x-actual.maxX)<1&&Math.abs(actual.y-actual.maxY)<1;},'actual sheet scroll reaches both bounded DOM endpoints');
  const end=await read();assert.ok(end.box.x+end.width-end.paper.right>=10&&end.box.y+end.height-end.paper.bottom>=10,'native sheet bounds keep the actual trailing scrollbar clearance');
  await navigate(view,{kind:'cell',sheetName,address:'AA50'});await until(async()=>{const box=await main.locator('.embedded-office-cell-cursor').boundingBox(),actual=await read();return !!box&&box.x>=actual.box.left+5&&box.x+box.width<=actual.box.x+actual.width-5&&box.y>=actual.box.top+5&&box.y+box.height<=actual.box.y+actual.height-5;},'actual AA50 cursor is revealed inside the bounded sheet frame');
  const selected=await status(view);assert.equal(selected.selection?.text,marker);const source=await read(),sourceCursor=(await main.locator('.embedded-office-cell-cursor').boundingBox())!,deltaX=Math.round(sourceCursor.x-source.box.left-Math.min(200,source.width*.3));
  await tool('office_input',{viewId:view.id,...version(selected),expectedLayoutRevision:selected.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'scroll',x:selected.viewport!.width/2,y:selected.viewport!.height/2,deltaX,deltaY:0}});await main.waitForTimeout(180);
  const visible=await read(),cursor=await main.locator('.embedded-office-cell-cursor').boundingBox();assert.ok(cursor&&cursor.x>=visible.box.left&&cursor.x+cursor.width<=visible.box.x+visible.width-120,'the actual grid can scroll the long selected value away from the right clipping edge');
  results.calcScrollEndpoints={end,visible,state:await status(view),cursor,pixels:await screenshot('calc-bounded-frame-scroll')};
};
const verifyLoadingNavigation=async()=>{
  await installOfficeOpenReceiptGate(app);
  const previewStarted=performance.now(),office=await tool<ViewInfo>('reader_open',{uri:join(directory,names.docx)});
  const preview=main.getByTestId('office-startup-preview');await preview.waitFor({timeout:2000});const previewMs=performance.now()-previewStarted;assert.ok((await preview.innerText()).includes('潮灯町的第十三夜'));assert.equal(await main.getByText('正在初始化内置文档核心…',{exact:true}).count(),0);await main.screenshot({path:join(evidence,'office-immediate-preview.png'),scale:'css'});
  await until(async()=>!!(await officeOpenReceiptGate(app)).held,'the real Kit open receipt reaches the private five-second gate',120000);
  const held=await officeOpenReceiptGate(app);assert.equal(held.receipt?.viewId,office.id);assert.equal(held.receipt?.status,'ready');assert.equal(held.receipt?.surfaceKind,'tiled');assert.ok(held.receipt!.nativePid>0);workerPids.add(held.receipt!.nativePid);
  const steps:{name:string;ms:number;held:boolean}[]=[];
  const step=async(name:string,action:()=>Promise<void>,confirm:()=>Promise<boolean>)=>{
    assert.equal((await officeOpenReceiptGate(app)).released,false,name+' starts while the genuine open receipt is held');const start=performance.now();await action();await until(confirm,name+' responds during Office loading',2000);const gate=await officeOpenReceiptGate(app);assert.equal(gate.released,false,name+' finishes before the open receipt is released');steps.push({name,ms:performance.now()-start,held:!gate.released});
  };
  await step('Markdown',async()=>{await main.getByRole('button',{name:'欢迎.md',exact:true}).click();},async()=>main.locator('.document-content.format-markdown').isVisible());
  await step('PDF',async()=>{await main.getByRole('button',{name:'示例.pdf',exact:true}).click();},async()=>main.locator('.document-content.format-pdf').isVisible());
  await step('New home tab',async()=>{await main.getByRole('button',{name:'新建标签页',exact:true}).click();},async()=>main.locator('.home-search-input').isVisible());
  await step('Close the loading Office',async()=>{await main.getByRole('button',{name:'关闭 '+names.docx,exact:true}).click();},async()=>!(await workspace()).views.some(view=>view.id===office.id));
  const foreground=await workspace(),homeLabel=await main.locator('.tab.active').textContent();
  await step('Settings window',async()=>{await main.getByRole('button',{name:'设置',exact:true}).click();},async()=>app.context().pages().some(page=>page.url().includes('/#/settings')));
  const preferences=app.context().pages().find(page=>page.url().includes('/#/settings'))!;await preferences.locator('.settings-shell').waitFor({timeout:2000});await preferences.screenshot({path:join(evidence,'office-loading-settings.png'),scale:'css'});await preferences.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await until(async()=>!!(await officeOpenReceiptGate(app)).released,'the unchanged native open receipt is released');
  await until(async()=>{const gate=await officeOpenReceiptGate(app);return gate.retirement?.method==='close'&&gate.retirement.ok;},'the late, newly created native writer is actually closed by its real RPC receipt');
  assert.ok((await officeOpenReceiptGate(app)).releasedAt!-held.receiptAt!>=5000,'hold duration is real and the native result is unchanged');
  await until(async()=>{const events=await invoke<{type:string;data:{viewId?:string}}[]>('events',{after:0});return events.some(event=>event.type==='view.closed'&&event.data.viewId===office.id);},'the actual loading view remains closed');
  await main.waitForTimeout(350);const late=await workspace();assert.equal(late.views.some(view=>view.id===office.id),false,'late native completion never resurrects its closed view');assert.equal(late.activeViewId,foreground.activeViewId,'late completion cannot retarget the reading page');assert.equal(await main.locator('.tab.active').textContent(),homeLabel);assert.equal(await main.locator('.home-search-input').isVisible(),true);
  assert.equal(late.documents.find(document=>document.id===office.documentId)?.nativeOffice,undefined,'a canceled new writer is not registered as a fresh document mirror');
  await assert.rejects(invoke('office-surface-state',{viewId:office.id}),/TARGET_NOT_FOUND/);
  results.loadingNavigation={office,previewMs,held,steps,released:await officeOpenReceiptGate(app),foregroundViewId:foreground.activeViewId,lateViewId:late.activeViewId,homeLabel};await main.screenshot({path:join(evidence,'office-loading-late-close.png'),scale:'css'});
};
const verifyStartupPreviews=async()=>{
  // Expected content is parsed independently from the untouched TEMP source.
  // No document_read/snapshot call may initialize a mirror ahead of the view.
  const sourceModels=new Map<keyof typeof names,DocumentModel>();
  for(const format of ['docx','pptx','xlsx'] as const)sourceModels.set(format,await createRegistry().resolve(format).open(new Uint8Array(originals.get(names[format])!),format));
  const trials:unknown[]=[];results.startupPreviews=trials;
  for(const format of ['docx','pptx','xlsx'] as const){
    await installOfficeOpenReceiptGate(app,format);
    const started=performance.now(),opened=await tool<ViewInfo>('reader_open',{uri:join(directory,names[format])});
    const preview=main.getByTestId('office-startup-preview');await preview.waitFor({timeout:2000});const previewMs=performance.now()-started;
    const source=(await workspace()).documents.find(document=>document.id===opened.documentId)!,parsed=sourceModels.get(format)!;
    assert.ok(source);assert.equal(source.format,format);assert.equal(await preview.getAttribute('data-preview-document-id'),opened.documentId);assert.equal(await preview.getAttribute('data-preview-view-id'),opened.id);assert.equal(Number(await preview.getAttribute('data-preview-source-revision')),source.revision);
    assert.equal(await main.locator('.embedded-office-document').getAttribute('data-office-render-mode'),'preview');assert.equal(await main.locator('.embedded-office-document').getAttribute('data-office-ready'),'false');assert.equal(await main.getByText('正在初始化内置文档核心…',{exact:true}).count(),0);
    await until(async()=>!!(await officeOpenReceiptGate(app)).held,'genuine '+format+' native open reaches its receipt gate',120000);
    const held=await officeOpenReceiptGate(app);assert.equal(held.receipt?.viewId,opened.id);assert.equal(held.receipt?.documentId,opened.documentId);assert.equal(held.receipt?.surfaceKind,'tiled');assert.equal(held.receipt?.status,'ready');assert.ok(held.receipt!.nativePid>0);workerPids.add(held.receipt!.nativePid);
    let readingTarget:Record<string,unknown>={kind:'initial'},sourceContent='';
    if(format==='docx'){
      const first=parsed.blocks!.findIndex(block=>!!block.text.trim());assert.ok(first>=0);sourceContent=parsed.blocks![first].text;
      assert.equal(await preview.locator('[data-preview-paragraph-index="'+first+'"]').textContent(),sourceContent);
      const reader=preview.locator('.office-startup-preview-scroll'),box=(await reader.boundingBox())!;
      await main.mouse.move(box.x+box.width*.6,box.y+box.height*.5);await main.mouse.wheel(0,400);
      await until(async()=>reader.evaluate(node=>node.scrollTop>50),'human reads farther into the actual Word preview');
      const visible=await reader.evaluate(host=>{const box=host.getBoundingClientRect(),node=[...host.querySelectorAll<HTMLElement>('[data-preview-paragraph-index]')].find(node=>{const rect=node.getBoundingClientRect();return rect.bottom>box.top&&rect.top<box.bottom;});return {paragraphIndex:Number(node?.dataset.previewParagraphIndex),text:node?.textContent,scrollTop:host.scrollTop};});
      assert.ok(visible.paragraphIndex>0);assert.equal(visible.text,parsed.blocks![visible.paragraphIndex].text);readingTarget={kind:'paragraph',paragraphIndex:visible.paragraphIndex,textLength:visible.text!.length,scrollTop:visible.scrollTop};
    }else if(format==='pptx'){
      assert.ok(parsed.slides&&parsed.slides.length>1,'the real fixture has another readable slide');
      sourceContent=parsed.slides[0].blocks.find(block=>!!block.text.trim())!.text;assert.ok((await preview.innerText()).includes(sourceContent));
      await preview.getByRole('button',{name:'下一页',exact:true}).click();const second=preview.getByRole('article',{name:'幻灯片 2 快速预览',exact:true});await second.waitFor();
      sourceContent=parsed.slides[1].blocks.find(block=>!!block.text.trim())!.text;assert.ok((await second.innerText()).includes(sourceContent));readingTarget={kind:'slide',index:1};
    }else{
      const visibleSheets=parsed.sheets!.filter(sheet=>!['hidden','veryHidden'].includes(sheet.state??''));assert.ok(visibleSheets.length>1,'the real fixture has a second visible worksheet');const sheet=visibleSheets[1];
      await preview.getByRole('button',{name:sheet.name,exact:true}).click();
      const sourceCell=sheet.rows.slice(0,8).flatMap(row=>row.slice(0,8)).find(cell=>typeof cell.value==='string'&&!!cell.value.trim());assert.ok(sourceCell?.address);sourceContent=String(sourceCell.value);
      assert.equal(await preview.locator('[data-preview-cell-address="'+sourceCell.address+'"]').textContent(),sourceContent);readingTarget={kind:'cell',sheetName:sheet.name,address:sheet.rows[0][0].address,verifiedCell:sourceCell.address};
    }
    assert.equal((await officeOpenReceiptGate(app)).released,false,'preview content and human reading are verified before native readiness reaches the app');
    const beforeContext=await tool<ReadingContext>('reader_get_context',{viewId:opened.id});assert.equal(beforeContext.quality,'not-ready','source preview never publishes a confirmed native reading context');assert.ok(!beforeContext.nativeOffice,'held real import is not registered as a native reading session');assert.equal(beforeContext.selection.kind,'none');assert.ok(!beforeContext.selection.rect);assert.ok(!beforeContext.viewport,'preview scrolling never supplies native viewport coordinates');
    const beforeCapture=await mcp.callTool({name:'office_capture',arguments:{viewId:opened.id}});assert.equal(beforeCapture.isError,true,'a preview cannot be captured through native-coordinate tools');
    await main.screenshot({path:join(evidence,format+'-source-preview.png'),scale:'css'});
    await until(async()=>!!(await officeOpenReceiptGate(app)).released,'the unchanged genuine '+format+' native result is released',15000);const released=await officeOpenReceiptGate(app);assert.ok(released.releasedAt!-held.receiptAt!>=5000);
    await ready(opened);await preview.waitFor({state:'detached'});assert.equal(await main.locator('.embedded-office-document').getAttribute('data-office-render-mode'),'native');
    const actual=await status(opened),publicState=await tool<NativeOfficeState>('office_status',{viewId:opened.id});assert.equal(actual.sessionId,held.receipt!.sessionId);assert.equal(actual.engineEpoch,held.receipt!.engineEpoch);assert.equal(publicState.nativeGeometry,true);assert.equal(publicState.visible,true);assert.equal(publicState.sessionId,actual.sessionId);
    if(format==='pptx')assert.equal(actual.partIndex,1,'native handoff preserves the actual second slide chosen in the preview');
    if(format==='xlsx'){assert.equal(actual.parts.find(part=>part.index===actual.partIndex)?.name,readingTarget.sheetName,'native handoff preserves the actual worksheet chosen in the preview');assert.equal(actual.selection?.sheetName,readingTarget.sheetName);assert.equal(actual.selection?.range,readingTarget.address,'native handoff targets the exact source cell, without inventing preview coordinates');}
    const captured=await mcp.callTool({name:'office_capture',arguments:{viewId:opened.id,expectedEngineEpoch:actual.engineEpoch,expectedEngineRevision:actual.engineRevision}});assert.notEqual(captured.isError,true,'only the presented native body now supplies an actual engine capture');assert.ok((captured.content as {type:string;data?:string}[]).some(item=>item.type==='image'&&!!item.data));
    const phases=await officeRuntimeRpcPhases(app),opening=phases.find(phase=>phase.method==='open'&&phase.viewId===opened.id);assert.equal(opening?.format,format);assert.ok(opening?.endedAt&&opening.endedAt<=held.receiptAt!);
    assert.deepEqual(await readFile(join(directory,names[format])),originals.get(names[format]),'read-only preview and handoff never write the original source copy');
    trials.push({format,viewId:opened.id,documentId:opened.documentId,sourceRevision:source.revision,sourceContentSha256:createHash('sha256').update(sourceContent).digest('hex'),previewMs,readingTarget,held,released,beforeContext:{quality:beforeContext.quality,selectionKind:beforeContext.selection.kind},native:{sessionId:actual.sessionId,engineEpoch:actual.engineEpoch,partIndex:actual.partIndex,layoutRevision:actual.layoutRevision,nativeGeometry:publicState.nativeGeometry},pixels:await screenshot(format+'-preview-native-handoff')});
  }
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
  const initial=await fitted(),beforeScroll=await status(view);
  await tool('office_input',{viewId:view.id,...version(beforeScroll),expectedLayoutRevision:beforeScroll.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'scroll',x:initial.content.width/2,y:initial.content.height/2,deltaX:0,deltaY:180}});
  await fitted();assert.equal(await main.locator('.embedded-office-content').evaluate(node=>node.scrollTop),0,'scrolling an already fitted full slide clamps to zero');
  const captureState=await status(view),capture=await mcp.callTool({name:'office_capture',arguments:{viewId:view.id,expectedEngineEpoch:captureState.engineEpoch,expectedEngineRevision:captureState.engineRevision,expectedLayoutRevision:captureState.layoutRevision}});
  assert.notEqual(capture.isError,true,'the real MCP capture succeeds after a clamped scroll');const image=(capture.content as {type:string;data?:string}[]).find(item=>item.type==='image');assert.ok(image?.data);
  await writeFile(join(evidence,'impress-mcp-clamped-capture.png'),Buffer.from(image.data,'base64'));
  const opaque=await app.evaluate(({nativeImage},data)=>{
    const image=nativeImage.createFromBuffer(Buffer.from(data,'base64')),size=image.getSize(),pixels=image.toBitmap();let left=size.width,top=size.height,right=-1,bottom=-1;
    for(let y=0;y<size.height;y++)for(let x=0;x<size.width;x++)if(pixels[(y*size.width+x)*4+3]>245){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
    return {...size,left,top,right,bottom};
  },image.data),clamped=await safe();
  assert.ok(opaque.right>=opaque.left&&opaque.bottom>=opaque.top,'the capture contains actual native slide pixels');
  assert.ok(Math.abs(opaque.top/scale-(clamped.paper.top-clamped.content.top))<2&&Math.abs(opaque.left/scale-(clamped.paper.left-clamped.content.left))<2,'MCP capture retains the same real centered document origin as the Canvas after a clamped scroll');
  results.presentationClampedCapture={opaque,dom:clamped,state:await status(view)};
  const queried=await tool<{data:{unit:string;objects:{name:string;text:string;bounds:{x:number;y:number;width:number;height:number}}[]}}>('office_query',{viewId:view.id,target:{kind:'shapes',slideIndex:0}}),title=queried.data.objects.find(shape=>shape.text.trim())!;
  assert.equal(queried.data.unit,'1/100mm');assert.ok(title);const currentZoom=(await workspace()).views.find(item=>item.id===view.id)!.zoom??1,twipsPerHmm=1440/2540;
  // The fixture's real title primitive accepts this glyph strip; its empty
  // bounding-box center is correctly click-through. Coordinates stay local to
  // the actual safe viewport, including positive vertical centering.
  const point={x:clamped.paper.left-clamped.content.left+(title.bounds.x*twipsPerHmm+Math.min(2200,title.bounds.width*twipsPerHmm/4))*currentZoom/15,y:clamped.paper.top-clamped.content.top+(title.bounds.y+title.bounds.height/2)*twipsPerHmm*currentZoom/15},beforeClick=await status(view);
  await tool('office_input',{viewId:view.id,...version(beforeClick),expectedLayoutRevision:beforeClick.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'click',...point}});
  const clicked=await status(view);assert.ok(clicked.selection?.objectNames?.includes(title.name)||clicked.selection?.text===title.text,'MCP glyph click after the clamped scroll reaches the same actual title rather than an offset position');
  const beforeEscape=await status(view);await tool('office_input',{viewId:view.id,...version(beforeEscape),idempotencyKey:randomUUID(),action:{kind:'press',key:'Escape'}});await settleInput(view);results.presentationClampedClick={point,titleName:title.name,state:clicked};
  await invoke('settings-set',{id:'appearance.motion',value:'elegant'});await main.locator('.ai-rail > button').nth(1).click();await main.locator('#ai-tools').waitFor();
  for(let frame=0;frame<6;frame++){await main.waitForTimeout(90);await safe();}await fitted();
  const resize=main.getByRole('separator',{name:'调整左侧工具栏宽度',exact:true});await resize.focus();await resize.press('ArrowRight');await main.waitForTimeout(100);await fitted();
  await main.getByRole('button',{name:'关闭 AI 抽屉',exact:true}).click();for(let frame=0;frame<6;frame++){await main.waitForTimeout(90);await safe();}await main.locator('#ai-tools').waitFor({state:'hidden'});await fitted();
  const viewport=(await read()).content;await main.mouse.move(viewport.x+viewport.width/2,viewport.y+viewport.height/2);const before=(await workspace()).views.find(item=>item.id===view.id)!.zoom??1;
  await main.keyboard.down('Control');await main.mouse.wheel(0,-60);await main.keyboard.up('Control');await until(async()=>{const actual=await read(),current=(await workspace()).views.find(item=>item.id===view.id)!;return actual.mode==='manual'&&(current.zoom??1)>before;},'a real Ctrlwheel gesture leaves automatic fit');
  const manual=(await workspace()).views.find(item=>item.id===view.id)!.zoom;await resize.focus();await resize.press('ArrowRight');await main.waitForTimeout(700);assert.equal((await workspace()).views.find(item=>item.id===view.id)!.zoom,manual,'manual zoom survives a subsequent live sidebar resize');await safe();
  // Set an explicit editable scale through the real navigation field, rather
  // than forcing a CSS transform or an MCP-only mouse coordinate workaround.
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
const verifyManualSlideScrolling=async(view:ViewInfo)=>{
  await leftCategory('开始','home');await main.locator('.ai-rail > button').nth(1).click();await main.locator('#ai-tools').waitFor();await main.waitForTimeout(250);
  const manualZoom=Number(process.env.AGENTVIEWER_QA_ZOOM??2);assert.ok(manualZoom>=.25&&manualZoom<=4);
  await main.getByRole('spinbutton',{name:'正文缩放比例',exact:true}).fill(String(manualZoom*100));await main.getByRole('spinbutton',{name:'正文缩放比例',exact:true}).press('Enter');
  await until(async()=>(await workspace()).views.find(item=>item.id===view.id)?.zoom===manualZoom,'manual slide zoom extends the real canvas');
  const bar=main.getByRole('scrollbar',{name:'幻灯片横向滚动',exact:true});await bar.waitFor();
  const material=await bar.evaluate(track=>{const canvas=new OffscreenCanvas(1,1),context=canvas.getContext('2d')!,thumb=track.querySelector<HTMLElement>('.office-horizontal-scrollbar-thumb')!;context.fillStyle=getComputedStyle(track).backgroundColor;context.fillRect(0,0,1,1);const trackRgba=[...context.getImageData(0,0,1,1).data];context.clearRect(0,0,1,1);context.fillStyle=getComputedStyle(thumb).backgroundColor;context.fillRect(0,0,1,1);return {track:trackRgba,thumb:[...context.getImageData(0,0,1,1).data],bounds:track.getBoundingClientRect().toJSON(),thumbWidth:thumb.getBoundingClientRect().width,visible:track.checkVisibility(),dpr:devicePixelRatio};});
  assert.ok(material.visible&&material.track[3]>0&&material.thumb[3]>0,'the actual scroll track and thumb are painted rather than transparent variable fallbacks');assert.ok(material.thumbWidth>=Math.min(32,material.bounds.width-2));assert.ok(material.bounds.top>=0&&material.bounds.bottom<=await main.evaluate(()=>innerHeight),'the real scroll control stays inside the visible client');
  const read=()=>main.locator('.embedded-office-content').evaluate(host=>{const box=host.getBoundingClientRect(),paper=host.querySelector('.embedded-office-paper-base')!.getBoundingClientRect(),reader=host.closest('.reader-panel')!.getBoundingClientRect();return {box:box.toJSON(),paper:paper.toJSON(),reader:reader.toJSON(),x:host.scrollLeft,maximum:host.scrollWidth-host.clientWidth,panes:[...host.closest('.workbench')!.querySelectorAll<HTMLElement>(':scope > .floating-side-panel')].map(panel=>({side:panel.dataset.side,box:panel.getBoundingClientRect().toJSON()}))};});
  await bar.focus();await bar.press('Home');let first=await read();assert.ok(first.maximum>0);assert.equal(first.x,0);assert.ok(first.box.left<first.panes.find(pane=>pane.side==='left')!.box.right,'manual canvas genuinely extends underneath the floating left tools');assert.ok(first.paper.left>=first.panes.find(pane=>pane.side==='left')!.box.right+5,'Home uncovers the left page edge');
  await bar.press('End');const last=await read();assert.ok(Math.abs(last.x-last.maximum)<=1);assert.ok(last.paper.right<=last.panes.find(pane=>pane.side==='right')!.box.left-5,'End uncovers the right page edge');
  await bar.press('Home');const thumb=main.locator('.office-horizontal-scrollbar-thumb'),thumbBox=(await thumb.boundingBox())!,barBox=(await bar.boundingBox())!;
  assert.equal(await thumb.evaluate(node=>{const box=node.getBoundingClientRect();return node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));}),true,'the thumb is an actual unobstructed mouse hit target');
  await main.mouse.move(thumbBox.x+thumbBox.width/2,thumbBox.y+thumbBox.height/2);await main.mouse.down();await main.mouse.move(barBox.x+barBox.width*.72,barBox.y+barBox.height/2,{steps:10});await main.mouse.up();const dragged=await read();assert.ok(dragged.x>0&&dragged.x<dragged.maximum,'actual pointer dragging changes DOM scrollLeft');
  await bar.press('Home');const before=await stableStatus(view);await tool('office_input',{viewId:view.id,...version(before),expectedLayoutRevision:before.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'scroll',x:first.box.width/2,y:first.box.height/2,deltaX:100,deltaY:0}});await until(async()=>Math.abs((await read()).x-100)<=1,'MCP can scroll inside leading space whose clipped visibleTwips starts at zero');
  const state=await status(view);assert.ok(Math.abs((state.viewport?.scrollX??-1)-100)<=1,'MCP state reports the actual padded DOM scroll');
  const captured=await mcp.callTool({name:'office_capture',arguments:{viewId:view.id,expectedEngineEpoch:state.engineEpoch,expectedEngineRevision:state.engineRevision,expectedLayoutRevision:state.layoutRevision}});assert.notEqual(captured.isError,true);const image=(captured.content as {type:string;data?:string}[]).find(item=>item.type==='image');assert.ok(image?.data);await writeFile(join(evidence,'impress-manual-padded-capture.png'),Buffer.from(image.data,'base64'));
  const current=await read(),opaque=await app.evaluate(({nativeImage},data)=>{const image=nativeImage.createFromBuffer(Buffer.from(data,'base64')),size=image.getSize(),pixels=image.toBitmap();let left=size.width,top=size.height;for(let y=0;y<size.height;y++)for(let x=0;x<size.width;x++)if(pixels[(y*size.width+x)*4+3]>245){left=Math.min(left,x);top=Math.min(top,y);}return {...size,left,top};},image.data);
  assert.ok(Math.abs(opaque.left/scale-Math.max(0,current.paper.left-current.box.left))<2&&Math.abs(opaque.top/scale-Math.max(0,current.paper.top-current.box.top))<2,'actual MCP capture preserves the padded scroll origin');
  const queried=await tool<{data:{unit:string;objects:{name:string;text:string;bounds:{x:number;y:number;width:number;height:number}}[]}}>('office_query',{viewId:view.id,target:{kind:'shapes',slideIndex:0}}),title=queried.data.objects.find(shape=>shape.text.trim())!;assert.equal(queried.data.unit,'1/100mm');
  const twipsPerHmm=1440/2540,glyph={x:title.bounds.x*twipsPerHmm+Math.min(2200,title.bounds.width*twipsPerHmm/4),y:(title.bounds.y+title.bounds.height/2)*twipsPerHmm},left=Math.max(current.box.left,...current.panes.filter(pane=>pane.side==='left').map(pane=>pane.box.right)),right=Math.min(current.box.right,...current.panes.filter(pane=>pane.side==='right').map(pane=>pane.box.left));
  const beforeReveal=await status(view);await tool('office_input',{viewId:view.id,...version(beforeReveal),expectedLayoutRevision:beforeReveal.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'scroll',x:current.box.width/2,y:current.box.height/2,deltaX:Math.round(current.paper.left+glyph.x*manualZoom/15-(left+right)/2),deltaY:Math.round(current.paper.top+glyph.y*manualZoom/15-(current.box.top+current.box.height*.4))}});
  await until(async()=>{const actual=await read(),x=actual.paper.left+glyph.x*manualZoom/15,y=actual.paper.top+glyph.y*manualZoom/15;return x>left&&x<right&&y>actual.box.top&&y<actual.box.bottom;},'actual scrolling reveals the native glyph inside the unobstructed tools lane');const clickGeometry=await read();
  const point={x:clickGeometry.paper.left-clickGeometry.box.left+glyph.x*manualZoom/15,y:clickGeometry.paper.top-clickGeometry.box.top+glyph.y*manualZoom/15},beforeClick=await status(view);
  await tool('office_input',{viewId:view.id,...version(beforeClick),expectedLayoutRevision:beforeClick.layoutRevision,idempotencyKey:randomUUID(),action:{kind:'click',...point}});const clicked=await status(view);assert.ok(clicked.selection?.objectNames?.includes(title.name)||clicked.selection?.text===title.text,'MCP click uses the same actual padded origin');
  const beforeEscape=await status(view);await tool('office_input',{viewId:view.id,...version(beforeEscape),idempotencyKey:randomUUID(),action:{kind:'press',key:'Escape'}});await settleInput(view);
  results.manualSlideScrolling={first,last,dragged,mcp:current,state,opaque,material,manualZoom,click:{point,state:clicked}};await screenshot('impress-visible-scrollbar-'+String(manualZoom*100));
  await main.getByRole('button',{name:'关闭 AI 抽屉',exact:true}).click();await main.locator('#ai-tools').waitFor({state:'hidden'});
};
const saveViaHumanShortcut = async (view: ViewInfo) => {
  const diagnostics = { viewId:view.id, before:await status(view), focus:await main.evaluate(()=>({tag:document.activeElement?.tagName,className:document.activeElement?.className})), feedback:[] as string[] };
  (results.saveShortcuts ??= [] as unknown[]); (results.saveShortcuts as unknown[]).push(diagnostics);
  await main.keyboard.press('Control+s');
  const saveStarted=Date.now();let diagnosed=false;
  await until(async () => {
    const toast=await main.locator('.toast').allTextContents();for(const text of toast)if(!diagnostics.feedback.includes(text))diagnostics.feedback.push(text);
    const state=await invoke<WorkspaceState>('state'),document=state.documents.find(value=>value.id===view.documentId),actual=await status(view),saved=document?.dirty===false&&!actual.pendingInput;
    if(!saved&&!diagnosed&&Date.now()-saveStarted>5000){diagnosed=true;const pending={viewId:view.id,document,views:await Promise.all(state.views.filter(item=>item.documentId===view.documentId).map(item=>status(item))),feedback:diagnostics.feedback,trace:await app.evaluate(({ipcMain})=>(ipcMain as any).__officeQaTrace)};await writeFile(join(evidence,'pending-save-'+actual.format+'.json'),JSON.stringify(pending,null,2));if(calcOnly&&diagnostics.feedback.some(text=>text.includes('未完成输入')))throw new Error('Actual Calc CtrlS was rejected: '+diagnostics.feedback.join(' | '));}
    return saved;
  }, 'human save commits stable engine buffer', 60000);
};
const saveReopen = async (view: ViewInfo, format: keyof typeof names, validate: (model: DocumentModel) => void) => {
  await tool('document_save', { documentId: view.documentId }); const bytes = await readFile(join(directory, names[format])); assert.notDeepEqual(bytes, originals.get(names[format]));
  const disk = await createRegistry().resolve(format).open(new Uint8Array(bytes), format); validate(disk);
  await tool('reader_manage_views', { action: 'close', viewId: view.id }); const reopened = await open(format); assert.equal(reopened.documentId, view.documentId); assert.notEqual(reopened.id, view.id);
  validate(await model(reopened)); return { view: reopened, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const processes = async () => {
  const output = await run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{Name='CreationTicks';Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 10000 });
  const list = JSON.parse(output.stdout) as { ProcessId: number; ParentProcessId: number; Name: string; ExecutablePath: string; CreationTicks: string }[], owned = new Set<number>([primary.pid!]);
  for (let changed = true; changed;) { changed = false; for (const item of list) if (owned.has(item.ParentProcessId) && !owned.has(item.ProcessId)) { owned.add(item.ProcessId); changed = true; } }
  return list.filter(item => owned.has(item.ProcessId));
};
let passed = false;
try {
  await main.locator('#root .tab-strip').waitFor(); assert.match(main.url(), new RegExp('127\\.0\\.0\\.1:' + port)); assert.equal(await main.title(), 'AgentViewer');
  await app.evaluate(({ BrowserWindow }) => { const owner = BrowserWindow.getAllWindows()[0]; owner.hide(); owner.show(); owner.focus(); });
  await until(async () => { try { return JSON.parse(await readFile(env.AGENTVIEWER_CONNECTION_FILE, 'utf8')).protocolVersion === '1.0'; } catch { return false; } }, 'isolated MCP discovery');
  await mcp.connect(mcpTransport);
  const identity = await app.evaluate(({ app }) => ({ profile: app.getPath('userData'), pid: process.pid, lock: app.hasSingleInstanceLock(), packaged:app.isPackaged, executable:process.execPath, appPath:app.getAppPath() })); assert.equal(resolve(identity.profile), resolve(directory)); assert.equal(identity.lock, true); if (releaseExecutable) { assert.equal(identity.packaged,true,'release QA must exercise the packaged application'); assert.equal(resolve(identity.executable).toLowerCase(),executable.toLowerCase()); } results.identity = identity;
  await invoke('settings-set', { id: 'appearance.autoHideToolbar', value: false }); await invoke('settings-set', { id: 'appearance.motion', value: 'off' }); await invoke('settings-set', { id: 'appearance.theme', value: 'light' }); await invoke('settings-set', { id: 'appearance.documentPaperColor', value: '#ffffff' });

  let word!: ViewInfo;
  if(loadingOnly)await verifyLoadingNavigation();
  else if(previewOnly)await verifyStartupPreviews();
  else if(firstPaintOnly){const previous:ViewInfo[]=[];for(const format of ['docx','pptx','xlsx'] as const){const opened=await open(format);(results.firstPaintPixels??=[] as unknown[]);(results.firstPaintPixels as unknown[]).push({format,pixels:await screenshot(format+'-first-paint')});if(process.env.AGENTVIEWER_QA_EXPECT_DEFERRED==='1')for(const old of previous){const hidden=await status(old);assert.equal(hidden.visible,false,'leaving an Office tab withdraws the actual display');assert.equal(hidden.focused,false,'a hidden native focus cannot pull the reader back');assert.equal(hidden.nativeGeometry,false,'hidden document coordinates are unavailable');(results.withdrawnDisplays??=[] as unknown[]);(results.withdrawnDisplays as unknown[]).push({viewId:old.id,state:hidden});}previous.push(opened);}await main.waitForTimeout(900);assert.equal((await workspace()).activeViewId,previous.at(-1)!.id,'idle native state cannot steal the foreground from the last visible document');}
  else if(renderOnly){if(!scrollOnly){const word=await open('docx');await verifyContinuousZoomFrames(word,'docx');}const slides=await open('pptx');if(!scrollOnly)await verifyContinuousZoomFrames(slides,'pptx');await verifyManualSlideScrolling(slides);}
  if (!calcOnly && !pptOnly&&!renderOnly) {
  word = await open('docx'); results.writerInitial = { state: await status(word), pixels: await screenshot('writer-light-white') };
  await navigate(word, { kind: 'paragraph', paragraphIndex: 0 }); await humanFocus(word); await main.keyboard.press('Control+Home'); await main.keyboard.press('Shift+End');
  await until(async () => { const context = await tool<ReadingContext>('reader_get_context', { viewId: word.id }); return context.actor === 'human' && context.quality === 'confirmed' && !!context.selection.text && !!context.selection.rect; }, 'human Writer selection lease');
  await main.locator('.selection-tools[role="toolbar"]').waitFor(); const chosen = (await status(word)).selection!.text;
  await main.mouse.move((await main.locator('.embedded-office-content').boundingBox())!.x + 200, 550); await main.mouse.wheel(0, 28); await main.waitForTimeout(180);
  assert.equal((await status(word)).selection?.text, chosen); results.writerSelection = { text: chosen, toolbar: await main.locator('.selection-tools').boundingBox(), pixels: await screenshot('writer-selection') };
  await leftCategory('开始', 'home'); const inspector = main.locator('[data-native-style-target="text"]'); await inspector.getByRole('spinbutton', { name: '文字 · 字号' }).fill('23'); await inspector.getByRole('button', { name: '应用修改', exact: true }).click();
  await until(async () => (await style(word, 'text')).data.fields.fontSize?.value === 23, 'left Writer tools edit the same native model');
  const beforeObscured=await status(word);
  await main.getByRole('button',{name:'关闭 '+names.docx,exact:true}).click();
  const closeConfirmation=main.getByRole('dialog',{name:'保存文档更改？',exact:true});await closeConfirmation.waitFor();
  const withdrawnForDialog=await status(word);assert.equal(withdrawnForDialog.visible,false);assert.equal(withdrawnForDialog.nativeGeometry,false);
  await closeConfirmation.getByRole('button',{name:'取消',exact:true}).click();await closeConfirmation.waitFor({state:'hidden'});
  const afterObscured=await ready(word);assert.equal(afterObscured.sessionId,beforeObscured.sessionId);assert.equal(afterObscured.engineEpoch,beforeObscured.engineEpoch);
  await main.locator('.selection-tools[role="toolbar"]').waitFor();assert.equal((await status(word)).selection?.text,chosen,'canceling close restores the same real selection tools');
  results.displayObscuredRestored={before:beforeObscured,withdrawn:withdrawnForDialog,restored:afterObscured};
  await humanFocus(word); await main.keyboard.press('Control+Home'); await main.keyboard.press('End'); await main.keyboard.press('Enter'); await main.keyboard.insertText(marker);
  const cdp = await app.context().newCDPSession(main); await cdp.send('Input.imeSetComposition', { text: '潮灯', selectionStart: 2, selectionEnd: 2 });
  await until(async () => (await status(word)).pendingInput === true, 'actual Chromium preedit reaches engine composition barrier'); results.imePending = await status(word);
  await cdp.send('Input.imeSetComposition', { text: '潮灯町', selectionStart: 3, selectionEnd: 3 }); await cdp.send('Input.insertText', { text: '潮灯町' }); await settleInput(word); await cdp.detach();
  await saveViaHumanShortcut(word);
  await until(async () => JSON.stringify(await model(word)).includes(marker + '潮灯町'), 'ASCII plus Chinese appear once in real model');
  const writtenWord = (await model(word)).blocks!.map(block => block.text).join('\n'); assert.equal(writtenWord.split(marker + '潮灯町').length - 1, 1, 'IME does not double commit');
  const viewport = (await main.locator('.embedded-office-content').boundingBox())!; await main.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2); await main.mouse.wheel(0, 480);
  await until(async () => main.locator('.embedded-office-content').evaluate(node => node.scrollTop > 100), 'body scrolls'); const readPosition = await tool<ReadingContext>('reader_get_context', { viewId: word.id }); assert.ok(readPosition.viewport && readPosition.viewport.scrollY > 0); results.writerScroll = readPosition;
  const beforeZoom = (await workspace()).views.find(value => value.id === word.id)!.zoom ?? 1; await main.keyboard.down('Control'); await main.mouse.wheel(0, -120); await main.keyboard.up('Control'); await until(async () => ((await workspace()).views.find(value => value.id === word.id)!.zoom ?? 1) > beforeZoom, 'Ctrlwheel changes body zoom');
  await tool('reader_set_zoom', { viewId: word.id, factor: 1 }); await navigate(word, { kind: 'paragraph', paragraphIndex: 0 }); await ready(word);
  await invoke('settings-set', { id: 'appearance.theme', value: 'dark' }); await invoke('settings-set', { id: 'appearance.documentPaperColor', value: '#ffffff' }); await main.waitForTimeout(500); const darkWhite = await screenshot('writer-dark-white'); assert.ok(darkWhite.whiteFraction > .65 && darkWhite.blackFraction < .15, 'dark chrome must not force the actual paper black');
  await invoke('settings-set', { id: 'appearance.documentPaperColor', value: '#fff4dc' }); await main.waitForTimeout(500); const warm = await screenshot('writer-dark-warm'); assert.ok(warm.warmFraction > .5, 'blank paper color is independent of chrome and existing text'); results.paper = { darkWhite, warm };
  await invoke('settings-set', { id: 'appearance.documentPaperColor', value: '#ffffff' }); await invoke('settings-set', { id: 'appearance.theme', value: 'light' });
  const wordSaved = await saveReopen(word, 'docx', value => assert.ok(value.blocks?.some(block => block.text.includes(marker + '潮灯町')))); word = wordSaved.view; results.writerSaved = wordSaved;
  await navigate(word, { kind: 'paragraph', paragraphIndex: 0 }); await humanFocus(word); await main.keyboard.press('Control+Home'); await main.keyboard.press('Shift+End'); await main.locator('.selection-tools').waitFor();
  const control = await tool<{ controlId: string }>('reader_agent_acquire', { viewId: word.id, documentId: word.documentId, phase: 'editing', agentId: 'embedded-office-ui' });
  const engineLease = await status(word); await tool('office_execute', { viewId: word.id, ...version(engineLease), style: { target: 'text', values: { italic: true } }, controlId: control.controlId, idempotencyKey: randomUUID() });
  await until(async () => main.locator('.embedded-office-document').getAttribute('data-office-actor').then(value => value === 'agent'), 'engine reports actual Agent edit actor'); await main.locator('.agent-operation-capsule').waitFor();
  await until(async () => main.locator('.embedded-office-document').getAttribute('data-office-agent-active').then(value => value === 'true'), 'actual selected target is highlighted during acquired Agent control'); results.agent = { controlId: control.controlId, state: await status(word), pixels: await screenshot('writer-agent-target') };
  await tool('reader_agent_release', { viewId: word.id, controlId: control.controlId }); await main.locator('.agent-operation-capsule').waitFor({ state: 'hidden' }); await until(async () => main.locator('.embedded-office-document').getAttribute('data-office-agent-active').then(value => value === 'false'), 'Agent release removes target treatment');
  await tool('document_save', { documentId: word.documentId });
  console.log('Embedded Office actual UI: Writer input, IME, selection, left tools, scroll, zoom, paper + save/reopen PASS');
  }

  if (!pptOnly&&!renderOnly) {
  let calc = await open('xlsx'); const sheet = (await status(calc)).parts[0]; await navigate(calc, { kind: 'cell', sheetName: sheet.name, address: 'Z50' }); await humanFocus(calc, 'cell'); await main.keyboard.press('F2'); const nativeFormulaInput='=SUM(20;22)';results.nativeFormulaInput=nativeFormulaInput;await main.keyboard.insertText(nativeFormulaInput); await main.keyboard.press('Enter');
  await until(async () => { try { const result = await tool<{ data: { values: unknown[][]; formulas: string[][] } }>('office_query', { viewId: calc.id, target: { kind: 'cell-range', sheetName: sheet.name, range: 'Z50' } });results.calcFormulaReadback=result; return result.data.values?.[0]?.[0] === 42 && result.data.formulas?.[0]?.[0].includes('SUM(20,22)'); } catch(cause) { if(!String(cause).includes('STALE_NATIVE_QUERY'))throw cause;return false; } }, 'native Canvas Calc formula calculates 42');
  await navigate(calc, { kind: 'cell', sheetName: sheet.name, address: 'AA50' }); await humanFocus(calc, 'cell'); await main.keyboard.press('F2'); await main.keyboard.insertText(marker); await saveViaHumanShortcut(calc);
  assert.ok(await main.locator('.native-office-formula-bar').isVisible());await leftCategory('开始','home');await verifyToolIcons('xlsx','home'); const tabs = await main.locator('.embedded-office-sheet-tabs').boundingBox(); assert.ok(tabs && tabs.height <= 32); const calcBefore = await status(calc);
  await verifySheetControlLane(calc,sheet.name);await verifyCalcScrollEndpoints(calc,sheet.name);await verifyContinuousZoomFrames(calc,'xlsx');
  if (calcBefore.parts.length > 1) { await main.locator('.embedded-office-sheet-tabs [role="tab"]').nth(1).click(); await until(async () => (await status(calc)).partIndex === calcBefore.parts[1].index, 'compact sheet tabs navigate actual part'); }
  results.calc = { state: await status(calc), pixels: await screenshot('calc-canvas'), tabHeight: tabs.height };
  const calcSaved = await saveReopen(calc, 'xlsx', value => { const parsed = value.sheets!.find(item => item.name === sheet.name)!; assert.equal(parsed.rows[49][25].formula, 'SUM(18,24)'); assert.equal(Number(parsed.rows[49][25].value), 42); assert.equal(parsed.rows[49][26].value, marker); }); calc = calcSaved.view; results.calcSaved = calcSaved;
  await navigate(calc,{kind:'cell',sheetName:sheet.name,address:'A1'});await leftCategory('开始','home');await ready(calc);await until(async()=>main.locator('.embedded-office-canvas').getAttribute('data-office-frame-reused').then(value=>value==='false'),'actual first-cell grid finishes its native tiles');results.calcFirstCells={state:await status(calc),pixels:await screenshot('calc-frame-firstcells')};
  console.log('Embedded Office actual UI: Calc cell text/formula, human save barrier, parts + reopened bytes PASS');
  }

  if (!calcOnly&&!renderOnly) {
  let slides = await open('pptx');await verifyPresentationViewport(slides); const shapes = await tool<{ data: { objects: { name: string; text?: string }[] } }>('office_query', { viewId: slides.id, target: { kind: 'shapes', slideIndex: 0 } });results.impressInitialShapes=shapes;const shape = shapes.data.objects.find(value => !!value.text?.trim())!; assert.ok(shape?.name);
  await navigate(slides, { kind: 'shape', slideIndex: 0, name: shape.name }); await humanFocus(slides, 'object'); await main.keyboard.press('F2');await until(async()=>{const state=await status(slides);results.impressEditEntry=state;return state.pendingInput===true;},'native F2 enters actual Impress text edit',4000);await main.keyboard.press('Control+Home'); await main.keyboard.press('Control+Shift+End'); await main.keyboard.insertText(marker); await saveViaHumanShortcut(slides);
  await until(async () => { const value = await tool<{ data: { text: string } }>('office_query', { viewId: slides.id, target: { kind: 'shape', slideIndex: 0, name: shape.name } });results.impressTextReadback=value;return value.data.text === marker; }, 'Canvas Impress editing commits to same named model');
  await leftCategory('开始','home');await verifyToolIcons('pptx','home');await leftCategory('幻灯片', 'slides'); const totalParts = (await status(slides)).parts.length; await until(async () => (await main.locator('.native-office-slide-list > button').count()) === totalParts, 'real slides live in the left sidebar');
  if (totalParts > 1) { await main.getByRole('button', { name: '第 2 张幻灯片', exact: true }).click(); await until(async () => (await status(slides)).partIndex === 1, 'left slide previews navigate actual page'); }
  assert.equal(await main.locator('.office-slide-strip,.office-presentation-footer').count(), 0); results.impress = { shapeName: shape.name, state: await status(slides), pixels: await screenshot('impress-canvas') };
  const slidesSaved = await saveReopen(slides, 'pptx', value => assert.ok(value.slides?.some(slide => slide.blocks.some(block => block.text === marker)))); slides = slidesSaved.view; results.impressSaved = slidesSaved;
  console.log('Embedded Office actual UI: Impress text mode, native commit, left slides + save/reopen PASS');

  if ((!pptOnly||pptDialogs)&&!renderOnly) {
  if(pptDialogs)word=await open('docx');
  await main.getByRole('button',{name:names.docx,exact:true}).click();await ready(word);
  // Writer's official InsertTable path converts selected text immediately.
  // Clear the real selection first so the native insertion dialog is requested.
  await humanFocus(word); await main.keyboard.press('ArrowRight'); await until(async()=>!(await status(word)).selection?.text,'dialog target is a real unselected Writer caret');
  await leftCategory('表格', 'table');await verifyToolIcons('docx','table'); await main.locator('[data-uno-command=".uno:InsertTable"]').click(); await main.locator('.embedded-office-dialog-window canvas').last().waitFor({ timeout: 15000 });
  const dialogState = await status(word), dialog = dialogState.windows!.find(window => window.visible && window.kind === 'dialog')!; assert.ok(dialog?.instanceId); const dialogCanvas = main.locator(`[data-office-window-instance="${dialog.instanceId}"] canvas`);
  const raw=await invoke<OfficeSurfaceWindowPaintReply>('office-surface-window-paint',{viewId:word.id,sessionId:dialogState.sessionId,engineEpoch:dialogState.engineEpoch,windowId:dialog.id,windowInstanceId:dialog.instanceId,generation:dialog.generation,width:dialog.width,height:dialog.height,deviceScaleFactor:1});const rgba=officeTileRgba(raw.tile);let alphaPixels=0,nonzeroChannels=0;for(let index=0;index<rgba.length;index++){if(rgba[index])nonzeroChannels++;if(index%4===3&&rgba[index])alphaPixels++;}
  results.dialogAttempt={window:dialog,requestGeneration:dialog.generation,replyGeneration:raw.generation,replyStateWindow:raw.state.windows?.find(window=>window.instanceId===dialog.instanceId),alphaPixels,nonzeroChannels,tileWidth:raw.tile.width,tileHeight:raw.tile.height};
  await until(async () => dialogCanvas.evaluate(canvas => { const c = canvas as HTMLCanvasElement; return c.width > 100 && c.height > 100 && c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((value, index) => index % 4 === 3 && value > 0); }), 'actual native dialog is painted');
  await main.screenshot({ path: join(evidence, 'writer-native-dialog.png'), scale: 'css' }); const dialogBox = (await dialogCanvas.boundingBox())!; await main.mouse.click(dialogBox.x + Math.min(30, dialogBox.width / 3), dialogBox.y + Math.min(30, dialogBox.height / 3)); await main.keyboard.press('Tab'); await main.keyboard.press('Escape');
  await until(async () => !(await status(word)).windows?.some(window => window.instanceId === dialog.instanceId && window.visible), 'real window key Escape closes its own dialog');
  await main.locator('[data-uno-command=".uno:InsertTable"]').click(); await main.locator('.embedded-office-dialog-window canvas').last().waitFor(); await main.locator('.embedded-office-window-close').last().click(); await until(async () => !(await status(word)).windows?.some(window => window.visible && window.kind === 'dialog'), 'project shell cancellation closes native window'); results.dialog = { command:'.uno:InsertTable',instanceId: dialog.instanceId, kind: dialog.kind, width: dialog.width, height: dialog.height };
  }
  }
  const owned = await processes(); assert.ok([...workerPids].every(pid => owned.some(item => item.ProcessId === pid)), 'tested document writers belong to this isolated reader'); assert.ok(owned.every(item => !/^soffice(?:\.bin|\.exe)?$/i.test(item.Name)), 'no dedicated Office executable is spawned'); assert.equal(workerPids.size, 1, 'documents share one direct DLL worker'); results.processes = owned;
  const bootstrap=await app.evaluate(()=>(globalThis as any).__officeQaBootstrap) as {code:string;at:number}[];results.bootstrapDiagnostics=bootstrap;results.ipcTrace=await app.evaluate(({ipcMain})=>(ipcMain as any).__officeQaTrace);results.runtimeRpcPhases=await officeRuntimeRpcPhases(app);
  if(firstPaintOnly&&process.env.AGENTVIEWER_QA_EXPECT_DEFERRED==='1')for(const item of results.openTimings as {viewId:string;sessionId:string;format:string}[]){const phases=await officeRuntimeRpcPhases(app),tile=phases.find(phase=>phase.method==='surfaceTiles'&&phase.viewId===item.viewId&&phase.sessionId===item.sessionId&&!phase.error),snapshot=phases.find(phase=>phase.method==='snapshot'&&phase.sessionId===item.sessionId);assert.ok(tile?.endedAt,item.format+' has a real successful native tile receipt');assert.ok(!snapshot||snapshot.startedAt>=tile.endedAt!,item.format+' first native pixels arrive before the document-level background mirror exporter');}
  if(releaseExecutable)assert.ok(bootstrap.some(receipt=>receipt.code==='OFFICE_KIT_BOOTSTRAP_SEED_REUSED'),'the staged built-in docless bootstrap seed is actually validated and reused');
  for (const name of Object.values(names)) assert.deepEqual(await readFile(resolve('examples/moon-tide', name)), originals.get(name), 'authored source stays unchanged');
  assert.deepEqual(errors, []); assert.doesNotMatch(stderr.join(''), /Object has been destroyed|UnhandledPromiseRejection|Uncaught (?:Exception|TypeError|Error)/i);
  passed = true; await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed, directory, evidence, scale, port, testScope:previewOnly?'parsed-source-preview,three-formats,human-part-handoff,public-native-presentation':firstPaintOnly?'native-first-paint,three-formats,no-edit':loadingOnly?'real-native-open,nonblocking-ui,canceled-late-open':renderOnly?'native-rendering,paddedscroll,mcp':calcOnly?'calc':pptDialogs?'impress,native-dialog':pptOnly?'impress':'writer,calc,impress,native-dialog', ...results, errors, rendererScreenshotsIncludeActualEnginePixels: !loadingOnly, imeCoverage:calcOnly||pptOnly||renderOnly?'not tested':'Chromium CDP composition, not OS Pinyin' }, null, 2)); console.log(previewOnly?'Actual parsed Word, Impress and Calc preview + native handoff and coordinate gating: PASS':firstPaintOnly?'Real native first paint in Writer, Impress and Calc: PASS':loadingOnly?'Real held native open receipt + responsive reader navigation + late cancellation: PASS':renderOnly?'Real slow-tile Office zoom frames + manual slide scrolling: PASS':calcOnly?'Real Calc-only human input / save / disk + reopen: PASS':pptOnly?'Real Impress human input / save / disk + reopen / scoped dialog: PASS':'Real Embedded Office Electron / native DLL tiles / stdio MCP / human Canvas input + Chromium IME / selection + styles / native dialog / save + reopen: PASS', evidence);
} catch (cause) {
  results.runtimeRpcPhases=await officeRuntimeRpcPhases(app).catch(()=>undefined);
  results.ipcTrace=await app.evaluate(({ipcMain})=>(ipcMain as any).__officeQaTrace).catch(()=>undefined);results.lastState = await workspace().catch(() => undefined); await main.screenshot({ path: join(evidence, 'failure.png'), scale: 'css' }).catch(() => {}); await writeFile(join(evidence, 'failure.json'), JSON.stringify({ passed: false, cause: String(cause), directory, evidence, scale, results, errors, stderr: stderr.join('').slice(-20000) }, null, 2)); console.error('Embedded Office actual UI evidence:', evidence); throw cause;
} finally {
  await writeFile(join(evidence, 'main-stderr.log'), stderr.join(''));
  const ownedAtClose = await processes().catch(() => []), transportPid = mcpTransport.pid;
  const exited = new Promise<void>(done => { if (primary.exitCode !== null || primary.signalCode !== null) done(); else primary.once('exit', () => done()); });
  // The deadline covers both transports. SDK/engine shutdown must not leave this isolated run hanging forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>(done => { timer = setTimeout(() => {
    process.exitCode = 1;
    void (async () => {
      // Recheck the exact PID + creation timestamp + parent before stopping only this QA's DLL worker.
      for (const child of ownedAtClose.filter(item => /^python(?:\.exe)?$/i.test(item.Name))) {
        if (!/^\d+$/.test(child.CreationTicks)) continue;
        await run('powershell.exe', ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.ProcessId}'; if ($p -and $p.ParentProcessId -eq ${child.ParentProcessId} -and $p.CreationDate.ToUniversalTime().Ticks -eq ${child.CreationTicks} -and $p.Name -eq '${child.Name}') { Stop-Process -Id ${child.ProcessId} }`], { windowsHide: true, timeout: 5000 }).catch(() => {});
      }
      // A packaged Electron launcher may have a separate actual main process.
      // Its verified identity is still an owned descendant; stopping only the
      // launcher would leave this TEMP profile's unsaved-error window behind.
      const identity=results.identity as {pid?:number}|undefined;
      const owner=ownedAtClose.find(item=>item.ProcessId===identity?.pid&&resolve(item.ExecutablePath??'').toLowerCase()===executable.toLowerCase());
      if(owner&&/^\d+$/.test(owner.CreationTicks)){
        const literalPath=owner.ExecutablePath.replace(/'/g,"''");
        await run('powershell.exe',['-NoProfile','-Command',`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.ProcessId}'; if ($p -and $p.ParentProcessId -eq ${owner.ParentProcessId} -and $p.CreationDate.ToUniversalTime().Ticks -eq ${owner.CreationTicks} -and $p.ExecutablePath -eq '${literalPath}') { Stop-Process -Id ${owner.ProcessId} }`],{windowsHide:true,timeout:5000}).catch(()=>{});
      }
      primary.kill(); if (transportPid) { try { process.kill(transportPid); } catch {} }
      done();
    })();
  }, 15000); });
  try { await Promise.race([Promise.allSettled([mcp.close(), app.close().finally(() => exited)]).then(() => {}), deadline]); } finally { clearTimeout(timer); }
  await writeFile(join(evidence, 'qa-exit.json'), JSON.stringify({ pid:primary.pid,exitCode:primary.exitCode,signal:primary.signalCode,cleanupFailed:process.exitCode===1 },null,2));
}
