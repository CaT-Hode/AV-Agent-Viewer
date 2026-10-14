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
const pptOnly = process.env.AGENTVIEWER_QA_ONLY === 'ppt';
const app = await electron.launch({ executablePath: executable, args: [...(releaseExecutable ? [] : ['.']), '--force-device-scale-factor=' + scale], cwd: resolve('.'), env, timeout: 60000 });
const main = await app.firstWindow(), primary = app.process(), mcp = new Client({ name: 'agentviewer-embedded-office-ui', version: '1.0' });
const mcpTransport = new StdioClientTransport({ command: process.execPath, args: ['plugins/agent-viewer/server/launch.mjs'], env, cwd: resolve('.') });
const errors: string[] = [], stderr: string[] = [], results: Record<string, unknown> = {}, workerPids = new Set<number>();
primary.stderr?.on('data', value => stderr.push(String(value)));
const watch = (page: Page) => { page.on('pageerror', error => errors.push(page.url() + ': ' + error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(page.url() + ': ' + entry.text()); }); };
app.context().pages().forEach(watch); app.context().on('page', watch);
// Trace real IPC metadata without changing any arguments, return values or engine calls.
await app.evaluate(({ipcMain})=>{
  const handlers=(ipcMain as unknown as {_invokeHandlers:Map<string,(...args:any[])=>Promise<any>>})._invokeHandlers, original=handlers.get('agentviewer:command');
  if(!original)throw new Error('actual command handler missing');
  const trace:any[]=[];(ipcMain as any).__officeQaTrace=trace;
  handlers.set('agentviewer:command',async(event:any,request:any)=>{
    const method=request.method,args=request.args;
    const isInput=method==='office-surface-input';
    const item:any={method,at:Date.now(),viewId:args?.viewId,args:isInput?{streamId:args.streamId,sequence:args.sequence,layoutRevision:args.layoutRevision,expectedPartIndex:args.expectedPartIndex,event:{kind:args.event?.kind,phase:args.event?.phase,key:args.event?.key,code:args.event?.code,button:args.event?.button,buttons:args.event?.buttons,textLength:args.event?.text?.length,pointTwips:args.event?.pointTwips}}:['office-surface-layout','office-layout','office-surface-window-paint','zoom'].includes(method)?args:undefined};
    const observed=isInput||['office-surface-layout','office-layout','office-surface-state','office-surface-window-paint','office-flush','zoom'].includes(method);
    try {
      const result=await original!(event,request);
      if(observed){
        const state=result?.state??result;
        item.result={viewId:state?.viewId,sessionId:state?.sessionId,nativeGeometry:state?.nativeGeometry,visible:state?.visible,layoutRevision:state?.layoutRevision,eventSequence:state?.eventSequence,engineRevision:state?.engineRevision,pendingInput:state?.pendingInput,caretVisible:state?.caretVisible,formulaLength:state?.formula?.length,selection:state?.selection?{kind:state.selection.kind,range:state.selection.range,textLength:state.selection.text?.length}:undefined,ackSequence:result?.ackSequence,composing:result?.composing,discarded:result?.discarded,windows:state?.windows?.map((window:any)=>({id:window.id,generation:window.generation,width:window.width,height:window.height}))};
        trace.push(item);if(trace.length>2000)trace.shift();
      }
      return result;
    } catch(cause){if(observed){item.error=String(cause);trace.push(item);}throw cause;}
  });
});
const until = async (check: () => Promise<boolean>, label: string, timeout = 30000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 90)); } throw new Error('Embedded Office acceptance timed out: ' + label); };
const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => main.evaluate(value => window.agentViewer!.call(value.method, value.args), { method, args }) as Promise<T>;
const tool = async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => { const result = await mcp.callTool({ name, arguments: args }); const text = (result.content as { type: string; text?: string }[]).find(entry => entry.type === 'text')?.text; assert.notEqual(result.isError, true, `${name}: ${text}`); assert.ok(text, name + ' returns actual JSON'); return JSON.parse(text) as T; };
const workspace = () => tool<WorkspaceState>('workspace_list');
const status = (view: ViewInfo) => invoke<OfficeSurfaceState>('office-surface-state', { viewId: view.id });
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
const open = async (format: keyof typeof names) => { const view = await tool<ViewInfo>('reader_open', { uri: join(directory, names[format]) }); await until(async () => (await workspace()).activeViewId === view.id, 'MCP opened view'); await ready(view); return view; };
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
  const enabled=pane.locator('.native-office-command-grid [data-uno-command]:not(:disabled)').first();await enabled.waitFor();const label=await enabled.getAttribute('aria-label');await enabled.hover();const tip=main.getByRole('tooltip');await tip.waitFor();await until(async()=>!!await tip.textContent().then(text=>text?.includes(label!)),'icon tool retains its actual hover description');assert.equal(await tip.locator('[data-glass-effect="frosted"]').count(),1);await main.screenshot({path:join(evidence,`${format}-${category}-icon-tooltip.png`),scale:'css'});await main.mouse.move(700,480);
  (results.toolIcons??=[] as unknown[]);(results.toolIcons as unknown[]).push({format,category,commands,tooltipLabel:label,retainedPropertyInputs:await pane.locator('input,select').count()});
};
const verifySheetControlLane=async()=>{
  const read=()=>main.locator('.embedded-office-document').evaluate(host=>{
    const content=host.querySelector('.embedded-office-content')!.getBoundingClientRect(),panes=[...host.closest('.workbench')!.querySelectorAll<HTMLElement>(':scope > .floating-side-panel')].map(pane=>({side:pane.dataset.side,box:pane.getBoundingClientRect().toJSON()}));
    const rows=[...host.querySelectorAll<HTMLElement>(':scope > .native-office-formula-bar,:scope > .embedded-office-sheet-tabs')].map(row=>({name:row.className,box:row.getBoundingClientRect().toJSON()}));
    return {content:content.toJSON(),panes,rows};
  });
  const samples:unknown[]=[],baseline=await read();
  const check=async()=>{const actual=await read();samples.push(actual);assert.equal(actual.content.width,baseline.content.width,'pane changes leave the document viewport full width');for(const row of actual.rows)for(const pane of actual.panes){if(pane.box.bottom<=row.box.top||pane.box.top>=row.box.bottom)continue;assert.ok(pane.side==='left'?row.box.left>=pane.box.right+5:row.box.right<=pane.box.left-5,'actual sheet controls avoid each live pane');}};
  await check();await invoke('settings-set',{id:'appearance.motion',value:'elegant'});await main.locator('.ai-rail > button').nth(1).click();await main.locator('#ai-tools').waitFor();
  for(let frame=0;frame<6;frame++){await main.waitForTimeout(90);await check();}
  const resize=main.getByRole('separator',{name:'调整左侧工具栏宽度',exact:true});await resize.focus();await resize.press('ArrowRight');await main.waitForTimeout(90);await check();
  await main.getByRole('button',{name:'关闭 AI 抽屉',exact:true}).click();for(let frame=0;frame<6;frame++){await main.waitForTimeout(90);await check();}await main.locator('#ai-tools').waitFor({state:'hidden'});await invoke('settings-set',{id:'appearance.motion',value:'off'});await check();
  const hit=await main.locator('.embedded-office-sheet-tabs [role="tab"]').nth(1).evaluate(button=>{const box=button.getBoundingClientRect(),top=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return top===button||button.contains(top);});assert.equal(hit,true,'the real tab is the native mouse hit target');results.sheetControlLane=samples;
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
    for(const pane of actual.panes){if(pane.box.bottom<=actual.content.top||pane.box.top>=actual.content.bottom)continue;assert.ok(pane.side==='left'?actual.content.left>=pane.box.right+5:actual.content.right<=pane.box.left-5,'the real editable presentation viewport avoids the live expanded panes');}
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
  if (!calcOnly && !pptOnly) {
  word = await open('docx'); results.writerInitial = { state: await status(word), pixels: await screenshot('writer-light-white') };
  await navigate(word, { kind: 'paragraph', paragraphIndex: 0 }); await humanFocus(word); await main.keyboard.press('Control+Home'); await main.keyboard.press('Shift+End');
  await until(async () => { const context = await tool<ReadingContext>('reader_get_context', { viewId: word.id }); return context.actor === 'human' && context.quality === 'confirmed' && !!context.selection.text && !!context.selection.rect; }, 'human Writer selection lease');
  await main.locator('.selection-tools[role="toolbar"]').waitFor(); const chosen = (await status(word)).selection!.text;
  await main.mouse.move((await main.locator('.embedded-office-content').boundingBox())!.x + 200, 550); await main.mouse.wheel(0, 28); await main.waitForTimeout(180);
  assert.equal((await status(word)).selection?.text, chosen); results.writerSelection = { text: chosen, toolbar: await main.locator('.selection-tools').boundingBox(), pixels: await screenshot('writer-selection') };
  await leftCategory('开始', 'home'); const inspector = main.locator('[data-native-style-target="text"]'); await inspector.getByRole('spinbutton', { name: '文字 · 字号' }).fill('23'); await inspector.getByRole('button', { name: '应用修改', exact: true }).click();
  await until(async () => (await style(word, 'text')).data.fields.fontSize?.value === 23, 'left Writer tools edit the same native model');
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

  if (!pptOnly) {
  let calc = await open('xlsx'); const sheet = (await status(calc)).parts[0]; await navigate(calc, { kind: 'cell', sheetName: sheet.name, address: 'Z50' }); await humanFocus(calc, 'cell'); await main.keyboard.press('F2'); const nativeFormulaInput='=SUM(20;22)';results.nativeFormulaInput=nativeFormulaInput;await main.keyboard.insertText(nativeFormulaInput); await main.keyboard.press('Enter');
  await until(async () => { try { const result = await tool<{ data: { values: unknown[][]; formulas: string[][] } }>('office_query', { viewId: calc.id, target: { kind: 'cell-range', sheetName: sheet.name, range: 'Z50' } });results.calcFormulaReadback=result; return result.data.values?.[0]?.[0] === 42 && result.data.formulas?.[0]?.[0].includes('SUM(20,22)'); } catch(cause) { if(!String(cause).includes('STALE_NATIVE_QUERY'))throw cause;return false; } }, 'native Canvas Calc formula calculates 42');
  await navigate(calc, { kind: 'cell', sheetName: sheet.name, address: 'AA50' }); await humanFocus(calc, 'cell'); await main.keyboard.press('F2'); await main.keyboard.insertText(marker); await saveViaHumanShortcut(calc);
  assert.ok(await main.locator('.native-office-formula-bar').isVisible());await leftCategory('开始','home');await verifyToolIcons('xlsx','home'); const tabs = await main.locator('.embedded-office-sheet-tabs').boundingBox(); assert.ok(tabs && tabs.height <= 32); const calcBefore = await status(calc);
  if (calcBefore.parts.length > 1) { await verifySheetControlLane();await main.locator('.embedded-office-sheet-tabs [role="tab"]').nth(1).click(); await until(async () => (await status(calc)).partIndex === calcBefore.parts[1].index, 'compact sheet tabs navigate actual part'); }
  results.calc = { state: await status(calc), pixels: await screenshot('calc-canvas'), tabHeight: tabs.height };
  const calcSaved = await saveReopen(calc, 'xlsx', value => { const parsed = value.sheets!.find(item => item.name === sheet.name)!; assert.equal(parsed.rows[49][25].formula, 'SUM(20,22)'); assert.equal(Number(parsed.rows[49][25].value), 42); assert.equal(parsed.rows[49][26].value, marker); }); calc = calcSaved.view; results.calcSaved = calcSaved;
  console.log('Embedded Office actual UI: Calc cell text/formula, human save barrier, parts + reopened bytes PASS');
  }

  if (!calcOnly) {
  let slides = await open('pptx');await verifyPresentationViewport(slides); const shapes = await tool<{ data: { objects: { name: string; text?: string }[] } }>('office_query', { viewId: slides.id, target: { kind: 'shapes', slideIndex: 0 } });results.impressInitialShapes=shapes;const shape = shapes.data.objects.find(value => !!value.text?.trim())!; assert.ok(shape?.name);
  await navigate(slides, { kind: 'shape', slideIndex: 0, name: shape.name }); await humanFocus(slides, 'object'); await main.keyboard.press('F2');await until(async()=>{const state=await status(slides);results.impressEditEntry=state;return state.pendingInput===true;},'native F2 enters actual Impress text edit',4000);await main.keyboard.press('Control+Home'); await main.keyboard.press('Control+Shift+End'); await main.keyboard.insertText(marker); await saveViaHumanShortcut(slides);
  await until(async () => { const value = await tool<{ data: { text: string } }>('office_query', { viewId: slides.id, target: { kind: 'shape', slideIndex: 0, name: shape.name } });results.impressTextReadback=value;return value.data.text === marker; }, 'Canvas Impress editing commits to same named model');
  await leftCategory('开始','home');await verifyToolIcons('pptx','home');await leftCategory('幻灯片', 'slides'); const totalParts = (await status(slides)).parts.length; await until(async () => (await main.locator('.native-office-slide-list > button').count()) === totalParts, 'real slides live in the left sidebar');
  if (totalParts > 1) { await main.getByRole('button', { name: '第 2 张幻灯片', exact: true }).click(); await until(async () => (await status(slides)).partIndex === 1, 'left slide previews navigate actual page'); }
  assert.equal(await main.locator('.office-slide-strip,.office-presentation-footer').count(), 0); results.impress = { shapeName: shape.name, state: await status(slides), pixels: await screenshot('impress-canvas') };
  const slidesSaved = await saveReopen(slides, 'pptx', value => assert.ok(value.slides?.some(slide => slide.blocks.some(block => block.text === marker)))); slides = slidesSaved.view; results.impressSaved = slidesSaved;
  console.log('Embedded Office actual UI: Impress text mode, native commit, left slides + save/reopen PASS');

  if (!pptOnly) {
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
  for (const name of Object.values(names)) assert.deepEqual(await readFile(resolve('examples/moon-tide', name)), originals.get(name), 'authored source stays unchanged');
  assert.deepEqual(errors, []); assert.doesNotMatch(stderr.join(''), /Object has been destroyed|UnhandledPromiseRejection|Uncaught (?:Exception|TypeError|Error)/i);
  passed = true; await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed, directory, evidence, scale, port, testScope:calcOnly?'calc':pptOnly?'impress':'writer,calc,impress,native-dialog', ...results, errors, rendererScreenshotsIncludeActualEnginePixels: true, imeCoverage:calcOnly||pptOnly?'not tested':'Chromium CDP composition, not OS Pinyin' }, null, 2)); console.log(calcOnly?'Real Calc-only human input / save / disk + reopen: PASS':pptOnly?'Real Impress-only human input / save / disk + reopen: PASS':'Real Embedded Office Electron / native DLL tiles / stdio MCP / human Canvas input + Chromium IME / selection + styles / native dialog / save + reopen: PASS', evidence);
} catch (cause) {
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
