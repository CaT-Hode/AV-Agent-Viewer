import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { _electron as electron, type Page } from 'playwright';
import type { ViewInfo, WorkspaceState } from '../packages/contracts/src/index';

// This suite owns its TEMP source, profile and Electron process. It never
// attaches to the installed reader or opens an authored user document.
// Run only after the matching build is staged, with no simultaneous UI QA.
const require = createRequire(import.meta.url), repository = resolve('.');
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-pdf-viewport-'));
const evidence = process.env.AGENTVIEWER_QA_DIR
  ? join(resolve(process.env.AGENTVIEWER_QA_DIR), 'pdf-viewport') : join(directory, 'evidence');
const evidenceRelative = relative(repository, evidence);
assert.ok(isAbsolute(evidenceRelative) || evidenceRelative === '..' || evidenceRelative.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')), 'PDF screenshots and QA evidence must stay outside the repository');
await mkdir(evidence, { recursive: true });
const fixture = join(directory, 'pdf-page-edge-markers.pdf');
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
const paper = pdf.addPage([720, 360]), markerY = 120, markerSize = 18;
paper.drawRectangle({ x: 1, y: 1, width: 718, height: 358, borderWidth: 1, borderColor: rgb(.2, .35, .65) });
paper.drawText('LEFT', { x: 4, y: markerY, font, size: markerSize, color: rgb(.75, .05, .05) });
paper.drawText('RIGHT', { x: 716 - font.widthOfTextAtSize('RIGHT', markerSize), y: markerY, font, size: markerSize, color: rgb(.05, .25, .75) });
paper.drawText('PDF viewport — real page-edge access', { x: 120, y: 250, font, size: 20 });
paper.drawText('Both edge markers belong to the actual PDF text layer and canvas.', { x: 120, y: 200, font, size: 13 });
await writeFile(fixture, await pdf.save());
const sourceBytes = await readFile(fixture), sourceSha = createHash('sha256').update(sourceBytes).digest('hex');
const port = await new Promise<number>((done, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); });
});
const scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? 1);
assert.ok([1, 1.5, 2].includes(scale), 'Use AGENTVIEWER_QA_SCALE=1, 1.5 or 2 for the DPI matrix');
const width = Number(process.env.AGENTVIEWER_QA_WIDTH ?? (scale >= 2 ? 1080 : 1440));
const height = Number(process.env.AGENTVIEWER_QA_HEIGHT ?? (scale >= 2 ? 676 : 900));
const releaseExecutable = process.env.AGENTVIEWER_QA_EXE?.trim();
const executable = releaseExecutable ? resolve(releaseExecutable) : require('electron') as string;
const assetRoot = releaseExecutable ? join(dirname(executable), 'resources/app/dist') : resolve('dist');
const assets = { executable, mainSha: createHash('sha256').update(await readFile(join(assetRoot, 'main/index.cjs'))).digest('hex'), rendererIndex: await readFile(join(assetRoot, 'renderer/index.html'), 'utf8') };
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'AGENTVIEWER_VITE_URL']) delete env[key];
const app = await electron.launch({ executablePath: executable, args: [...(releaseExecutable ? [] : ['.']), '--force-device-scale-factor=' + scale], cwd: repository, env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], stderr: string[] = [], results: Record<string, unknown> = {};
const processHandle = app.process(); processHandle.stderr?.on('data', data => stderr.push(String(data)));
const watch = (target: Page) => {
  target.on('pageerror', error => errors.push(`${target.url()}: ${error.message}`));
  target.on('console', message => { if (message.type() === 'error') errors.push(`${target.url()}: ${message.text()}`); });
};
app.context().pages().forEach(watch); app.context().on('page', watch);
const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => main.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const state = () => invoke<WorkspaceState>('state');
const until = async (check: () => Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 150; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error('等待失败：' + label);
};
const frames = () => main.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const bar = main.getByRole('scrollbar', { name: 'PDF 横向滚动', exact: true });
const host = main.locator('.document-content.format-pdf');
const setPanels = async (open: boolean) => {
  const left = main.getByRole('button', { name: '目录与结构', exact: true });
  if ((await left.getAttribute('aria-pressed') === 'true') !== open) await left.click();
  const right = main.locator('.ai-rail > button').nth(1);
  if ((await right.getAttribute('aria-expanded') === 'true') !== open) await right.click();
  await until(async () => await main.locator('.floating-side-panel').count() === (open ? 2 : 0), open ? 'both PDF tool panels are present' : 'both PDF tool panels are removed');
  await frames();
};
const markerLineIntoView = async () => {
  await host.evaluate(element => {
    const span = [...element.querySelectorAll<HTMLElement>('.textLayer span')].find(node => node.textContent === 'LEFT');
    if (!span) throw new Error('The real PDF LEFT marker is not rendered');
    const viewport = element.getBoundingClientRect(), glyph = span.getBoundingClientRect();
    element.scrollTop = Math.max(0, element.scrollTop + glyph.top - viewport.top - Math.max(130, viewport.height * .3));
  });
  await frames();
};
type Box = { x: number; y: number; left: number; right: number; top: number; bottom: number; width: number; height: number };
type Obstacle = { side: string; box: Box };
type Geometry = {
  reader: Box; workbench: Box; host: Box; paper: Box; canvas: Box; layer: Box;
  bitmap: { width: number; height: number }; dpr: number; x: number; maximum: number; y: number;
  obstacles: Obstacle[];
  markers: { text: 'LEFT' | 'RIGHT'; glyph: Box; point: { x: number; y: number }; hit: boolean; inkPixels:number; occluders: Obstacle[] }[];
};
// Keep this browser-side program as raw JavaScript. tsx's keepNames transform
// wraps named local arrows in a Node-only __name helper during serialization.
const geometry = () => main.evaluate(`(() => {
  const element = document.querySelector('.document-content.format-pdf');
  const reader = element.closest('.reader-panel'), workbench = element.closest('.workbench');
  const page = element.querySelector('.pdf-page'), canvas = page.querySelector('canvas'), layer = page.querySelector('.textLayer');
  const rect = node => node.getBoundingClientRect().toJSON();
  const obstacles = [...workbench.querySelectorAll(':scope > .activity-rail,:scope > .ai-rail,:scope > .floating-side-panel')].filter(node => node.checkVisibility()).map(node => ({ side: node.dataset.side ?? (node.classList.contains('activity-rail') ? 'left' : 'right'), box: rect(node) }));
  const markers = ['LEFT', 'RIGHT'].map(text => {
    const span = [...layer.querySelectorAll('span')].find(node => node.textContent === text);
    if (!span?.firstChild) throw new Error('The actual PDF marker ' + text + ' is missing');
    const range = document.createRange(), node = span.firstChild;
    const start = text === 'LEFT' ? 0 : node.textContent.length - 1;
    range.setStart(node, start); range.setEnd(node, start + 1);
    const glyph = range.getBoundingClientRect(), point = { x: glyph.left + glyph.width / 2, y: glyph.top + glyph.height / 2 };
    const box=canvas.getBoundingClientRect(),sx=canvas.width/box.width,sy=canvas.height/box.height;
    const pixels=canvas.getContext('2d').getImageData(Math.max(0,Math.floor((glyph.left-box.left)*sx)),Math.max(0,Math.floor((glyph.top-box.top)*sy)),Math.max(1,Math.ceil(glyph.width*sx)),Math.max(1,Math.ceil(glyph.height*sy))).data;
    let inkPixels=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>200&&(text==='LEFT'?pixels[i]>pixels[i+1]*1.5&&pixels[i]>pixels[i+2]*1.5:pixels[i+2]>pixels[i]*1.5&&pixels[i+2]>pixels[i+1]*1.5))inkPixels++;
    return { text, glyph: glyph.toJSON(), point, hit: page.contains(document.elementFromPoint(point.x, point.y)), inkPixels, occluders: obstacles.filter(item => point.x >= item.box.left && point.x <= item.box.right && point.y >= item.box.top && point.y <= item.box.bottom) };
  });
  return { reader: rect(reader), workbench: rect(workbench), host: rect(element), paper: rect(page), canvas: rect(canvas), layer: rect(layer), bitmap: { width: canvas.width, height: canvas.height }, dpr: devicePixelRatio, x: element.scrollLeft, maximum: Math.max(0, element.scrollWidth - element.clientWidth), y: element.scrollTop, obstacles, markers };
})()`) as Promise<Geometry>;
const assertDimensions = (value: Geometry) => {
  assert.ok(Math.abs(value.reader.left - value.workbench.left) <= 1 && Math.abs(value.reader.right - value.workbench.right) <= 1, 'PDF reader occupies the whole workbench instead of a rail-clipped rectangle');
  for (const name of ['canvas', 'layer'] as const) {
    assert.ok(Math.abs(value[name].width - value.paper.width) <= 1 && Math.abs(value[name].height - value.paper.height) <= 1, name + ' CSS dimensions match the real PDF page');
    assert.ok(Math.abs(value[name].left - value.paper.left) <= 1 && Math.abs(value[name].top - value.paper.top) <= 1, name + ' coordinates match the real PDF page');
  }
  assert.ok(Math.abs(value.bitmap.width - value.canvas.width * value.dpr) <= 1.1 && Math.abs(value.bitmap.height - value.canvas.height * value.dpr) <= 1.1, 'PDF bitmap uses actual device pixels while text stays in matching CSS coordinates');
  assert.ok(Math.abs(value.dpr - scale) < .01, 'the requested DPI matrix is active');
};
const assertMarker = (value: Geometry, text: 'LEFT' | 'RIGHT') => {
  const marker = value.markers.find(item => item.text === text)!;
  assert.ok(marker.glyph.left >= value.host.left - .5 && marker.glyph.right <= value.host.right + .5, text + ' edge glyph is fully inside the scroll viewport');
  assert.ok(marker.glyph.top >= value.host.top && marker.glyph.bottom <= value.host.bottom, text + ' edge glyph is vertically in view');
  assert.deepEqual(marker.occluders, [], text + ' edge glyph is uncovered by both rails and expanded tools');
  assert.equal(marker.hit, true, text + ' edge glyph accepts a real pointer hit on the PDF rather than an overlaid panel');
  assert.ok(marker.inkPixels>4,text+' edge glyph exists in the real PDF canvas, not only the selectable text layer');
};
const endpointsAndDrag = async (label: string) => {
  await markerLineIntoView(); await bar.waitFor();
  assert.equal(await bar.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(await bar.evaluate(node => node.classList.contains('pdf-horizontal-scrollbar')), true, 'PDF uses the shared scrollbar with its format-specific class');
  await bar.focus(); await bar.press('Home'); await frames();
  const first = await geometry(); assertDimensions(first); assert.ok(first.maximum > 0, label + ' exposes horizontal overflow'); assert.equal(first.x, 0); assertMarker(first, 'LEFT');
  await main.screenshot({ path: join(evidence, label + '-left.png'), scale: 'css' });
  await bar.press('End'); await frames();
  const last = await geometry(); assert.ok(Math.abs(last.x - last.maximum) <= 1); assertMarker(last, 'RIGHT');
  await main.screenshot({ path: join(evidence, label + '-right.png'), scale: 'css' });
  await bar.press('Home');
  assert.equal(await bar.getAttribute('aria-valuenow'), '0', 'Home moves the thumb before the next actual pointer gesture');
  const thumb = bar.locator(':scope > span').first(), thumbBox = await thumb.boundingBox(), trackBox = await bar.boundingBox(); assert.ok(thumbBox && trackBox);
  assert.equal(await thumb.evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)); }), true, 'the actual shared scrollbar thumb is an unobstructed mouse target');
  const travel = await bar.evaluate((node, thumbWidth) => node.clientWidth - thumbWidth, thumbBox.width); assert.ok(travel > 0);
  await main.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2); await main.mouse.down();
  try { await main.mouse.move(thumbBox.x + thumbBox.width / 2 + travel / 2, trackBox.y + trackBox.height / 2, { steps: 12 }); } finally { await main.mouse.up(); }
  await frames(); const middle = await geometry();
  assert.ok(middle.x > 0 && middle.x < middle.maximum, 'actual mouse dragging changes the real PDF scrollLeft');
  assert.ok(Math.abs(middle.x - middle.maximum / 2) <= 1 + middle.maximum / travel, 'half the actual thumb travel reaches the PDF midpoint within one pointer pixel');
  results[label] = { first, last, middle, thumbBox, trackBox, travel };
};

try {
  const identity = await app.evaluate(({ BrowserWindow }, size) => { const root = BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!; root.setContentSize(size.width, size.height); root.show(); root.focus(); return { pid: process.pid, bounds: root.getContentBounds() }; }, { width, height });
  await writeFile(join(evidence, 'startup-receipt.json'), JSON.stringify({ directory, evidence, scale, port, identity, assets }, null, 2));
  console.log('PDF viewport QA started', JSON.stringify({ directory, evidence, scale, pid: identity.pid }));
  await main.locator('.prose h1').waitFor();
  for (const [id, value] of [['appearance.autoHideToolbar', false], ['appearance.motion', 'off'], ['appearance.theme', 'light']] as const) await invoke('settings-set', { id, value });
  await main.locator('html[data-motion="off"][data-theme="light"]').waitFor();
  const view = await invoke<ViewInfo>('open', { uri: fixture, windowId: 'main' });
  await until(async () => (await state()).activeViewId === view.id, 'the private PDF is the active view');
  await main.locator('.pdf-page .textLayer span').filter({ hasText: /^RIGHT$/ }).waitFor();
  await setPanels(false); await frames();
  const fit = await geometry(); assertDimensions(fit);
  assert.ok(fit.paper.left >= Math.max(fit.host.left, ...fit.obstacles.filter(item => item.side === 'left').map(item => item.box.right)) - .5, '100% paper fits to the right of the left rail');
  assert.ok(fit.paper.right <= Math.min(fit.host.right, ...fit.obstacles.filter(item => item.side === 'right').map(item => item.box.left)) + .5, '100% paper fits to the left of the right rail');
  assert.ok(fit.maximum <= 1, '100% PDF fits the stable rail-safe width without horizontal clipping');
  results.fit100 = fit; await main.screenshot({ path: join(evidence, 'pdf-100-fit.png'), scale: 'css' });
  const zoom = main.getByRole('spinbutton', { name: '正文缩放比例', exact: true });
  await zoom.fill('400'); await zoom.press('Enter');
  await until(async () => (await state()).views.find(item => item.id === view.id)?.zoom === 4 && await main.locator('.pdf-page').evaluate((page, baseline) => Math.abs(page.getBoundingClientRect().width / baseline - 4) < .01, fit.paper.width), '400% regenerates the actual PDF page and text layer');
  await main.locator('.pdf-page .textLayer span').filter({ hasText: /^RIGHT$/ }).waitFor();
  await endpointsAndDrag('pdf-400-panels-closed');
  await main.evaluate(() => { (window as unknown as { __pdfQaCanvas?: Element | null }).__pdfQaCanvas = document.querySelector('.pdf-page canvas'); });
  await setPanels(true);
  assert.equal(await main.evaluate(() => (window as unknown as { __pdfQaCanvas?: Element | null }).__pdfQaCanvas === document.querySelector('.pdf-page canvas')), true, 'opening tools changes safe padding without reloading or repainting the PDF');
  assert.ok(Math.abs((await geometry()).paper.width - fit.paper.width * 4) <= 1, 'expanded panels preserve the explicit 400% document zoom');
  await endpointsAndDrag('pdf-400-panels-open');
  await setPanels(false); await endpointsAndDrag('pdf-400-panels-reclosed');
  await setPanels(true);
  await invoke('settings-set', { id: 'appearance.theme', value: 'dark' });
  await invoke('settings-set', { id: 'appearance.documentBackground', value: 'spectrum' });
  await main.locator('html[data-theme="dark"][data-document-background="spectrum"]').waitFor();
  await frames(); await endpointsAndDrag('pdf-400-dark-panels-open');
  await setPanels(false);
  const resizedWidth=900;
  await app.evaluate(({BrowserWindow},size)=>{BrowserWindow.getAllWindows().find(window=>!window.getParentWindow())!.setContentSize(size.width,size.height);},{width:resizedWidth,height});
  await until(async()=>{const reader=await main.locator('.reader-format-pdf').boundingBox(),page=await main.locator('.pdf-page').first().boundingBox();return !!reader&&!!page&&Math.abs(reader.width-resizedWidth)<=1.1&&page.width<fit.paper.width*4-5;},'actual narrower window refits PDF without unreachable negative overflow');
  await main.locator('.pdf-page .textLayer span').filter({hasText:/^RIGHT$/}).waitFor();
  await endpointsAndDrag('pdf-400-window-resized');
  assert.deepEqual(await readFile(fixture), sourceBytes, 'zoom, scrolling and panel transitions never modify source PDF bytes');
  const current = await state(), currentDocument = current.documents.find(item => item.id === view.documentId)!;
  assert.equal(currentDocument.dirty, false, 'view manipulation never marks the PDF modified');
  assert.deepEqual(errors, [], 'PDF and reader emit no renderer or console errors');
  assert.doesNotMatch(stderr.join(''), /UnhandledPromiseRejection|Uncaught (?:Exception|TypeError|Error)/i, 'private reader has no uncaught main-process error');
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, directory, evidence, scale, width, height, sourceSha, assets, ...results, errors }, null, 2));
  console.log('PDF full canvas, rail-safe 400% endpoints, actual scrollbar drag, matching text/bitmap and source integrity: PASS', evidence);
} catch (cause) {
  await main.screenshot({ path: join(evidence, 'failure.png'), scale: 'css' }).catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ passed: false, cause: String(cause), directory, evidence, scale, assets, results, current: await geometry().catch(() => undefined), errors }, null, 2));
  console.error('PDF viewport failure evidence:', evidence); throw cause;
} finally {
  await writeFile(join(evidence, 'main-stderr.log'), stderr.join(''));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) { done({ code: processHandle.exitCode, signal: processHandle.signalCode }); return; }
    const timer = setTimeout(() => reject(new Error('The private PDF QA process did not exit naturally')), 20000);
    processHandle.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }); });
  });
  await app.close(); const exited = await exit;
  await writeFile(join(evidence, 'qa-exit.json'), JSON.stringify({ pid: processHandle.pid, ...exited }, null, 2));
  assert.equal(exited.code, 0); assert.equal(exited.signal, null);
}
