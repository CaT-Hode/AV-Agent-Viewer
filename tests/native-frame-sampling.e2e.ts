import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ReadingContext, WorkspaceState } from '../packages/contracts/src/index';
import type { NavigationBackdropSample, NavigationBounds } from '../apps/desktop/src/renderer/lib/navigation-optics';
import type { BackdropCacheStatistics } from '../apps/desktop/src/main/backdrop-cache';
import type { NativeBackdropFrameHubStats } from '../apps/desktop/src/main/backdrop-frame-hub';

// Actual Host integration, not a second prototype subscriber. Run only after
// the coordinated UI lock and frozen dist are supplied. Fresh isolated profiles
// per AGENTVIEWER_QA_SCALE=1/1.5/2; never connects to the installed application.
type Sample = NavigationBackdropSample & { captureBounds: NavigationBounds; sourceRevision: number };
type SurfaceState = { visible?: boolean; viewId?: string; backdropImage?: string; backdropSample?: Sample; backdropDiagnostics: BackdropCacheStatistics; backdropFrameHub: NativeBackdropFrameHubStats; task?: { status: string } };
type Monitor = { started: number; ended: number; received: number; displayed: number; receivedAt: number[]; displayedAt: number[]; sequences: number[] };
const require = createRequire(import.meta.url), scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? '1'); assert.ok([1, 1.5, 2].includes(scale));
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-frame-sampling-')), evidence = join(directory, 'evidence'); await mkdir(evidence);
await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, revision: 0, values: { 'appearance.glass': 'standard', 'appearance.motion': 'off', 'appearance.autoHideToolbar': false, 'appearance.theme': 'light', 'translation.selectionAuto': false } }));
const port = await new Promise<number>((done, reject) => { const server = createNetServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
let modelRequests = 0;
const model = createHttpServer((request, response) => { let body = ''; request.on('data', chunk => { body += String(chunk); }); request.on('end', () => { JSON.parse(body); modelRequests++; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: '共享网页像素采样回归：当前可见材料的独立分析结果。' } }] })); }); });
await new Promise<void>(done => model.listen(0, '127.0.0.1', done)); const modelAddress = model.address(); assert.ok(modelAddress && typeof modelAddress !== 'string');
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: ['--force-device-scale-factor=' + scale, '.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], results: Record<string, unknown> = {};
main.on('pageerror', error => errors.push(error.message)); app.context().on('page', page => page.on('pageerror', error => errors.push(error.message)));
const invoke = <T = unknown>(page: Page, method: string, args: Record<string, unknown> = {}) => page.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const workspace = () => invoke<WorkspaceState>(main, 'state');
const wait = (duration: number) => new Promise<void>(done => setTimeout(done, duration));
const until = async (check: () => Promise<boolean>, label: string) => { for (let attempt = 0; attempt < 180; attempt++) { if (await check()) return; await wait(50); } throw new Error(label); };
let sourceId: number | undefined, pulseRunning = false, pulse: Promise<void> | undefined, pulseError: unknown;
const surfaces = new Map<string, Page>();
const surfaceState = (name: string) => invoke<SurfaceState>(surfaces.get(name)!, 'toolbar-state');
const allStates = async () => Object.fromEntries(await Promise.all([...surfaces.keys()].map(async name => [name, await surfaceState(name)] as const)));
const stopPulse = async () => { pulseRunning = false; await pulse; pulse = undefined; if (pulseError) throw pulseError; };

try {
  await main.locator('.prose h1').waitFor();
  results.build = await main.evaluate(() => [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map(node => node.getAttribute('src') ?? node.getAttribute('href')));
  const connection = JSON.parse(await readFile(join(directory, 'runtime/connection.json'), 'utf8')) as { endpoint: string; token: string };
  const configured = await invoke<{ profiles: { id: string }[] }>(main, 'connections-upsert', { name: 'Isolated frame sampling', protocol: 'chat-completions', modelId: 'test-model', baseUrl: 'http://127.0.0.1:' + modelAddress.port }); await invoke(main, 'connections-route', { tool: 'chat', id: configured.profiles[0].id });
  await main.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click();
  await until(async () => (await invoke<ReadingContext>(main, 'context')).quality === 'confirmed' && app.context().pages().some(page => page.url().includes('#/web-toolbar')), 'actual native source and navigation ready');
  const before = await workspace(), view = before.views.find(view => view.id === before.activeViewId)!, fixture = app.context().pages().find(page => page.url() === `http://127.0.0.1:${port}/fixtures/interaction.html`)!; assert.ok(fixture);
  assert.equal(await fixture.evaluate(() => typeof window.agentViewer), 'undefined', 'untrusted page has no privileged bridge');
  surfaces.set('navigation', app.context().pages().find(page => page.url().includes('#/web-toolbar'))!);
  await until(async () => !!(await surfaceState('navigation')).backdropSample, 'actual navigation crop ready'); sourceId = (await surfaceState('navigation')).backdropSample!.sourceContentsId;
  const browserInput = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const context = await invoke<ReadingContext>(main, 'context', { viewId: view.id }), viewport = context.viewport;
      if (context.quality !== 'confirmed' || !viewport) { await wait(80); continue; }
      const response = await fetch(connection.endpoint + '/v1/browser/input', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + connection.token }, body: JSON.stringify({ viewId: view.id, expectedNavigationId: viewport.navigationId, expectedLayoutRevision: viewport.layoutRevision, expectedViewport: { width: viewport.width, height: viewport.height, scrollX: viewport.scrollX, scrollY: viewport.scrollY }, action: { kind: 'move', x: 8, y: 140, modifiers: [] }, idempotencyKey: crypto.randomUUID() }) });
      const answer = await response.json() as { error?: { code?: string } }; if (response.status === 200) return;
      // A concurrent real zoom may invalidate the just-read snapshot. Retry
      // only documented guards with a fresh context; never suppress other errors.
      if (response.status === 400 && ['STALE_LAYOUT', 'STALE_VIEWPORT', 'STALE_NAVIGATION'].includes(answer.error?.code ?? '')) { await wait(80); continue; }
      assert.equal(response.status, 200, JSON.stringify(answer));
    }
    throw new Error('Actual Agent input never obtained a current viewport');
  };
  await main.getByRole('button', { name: 'AI 工具', exact: true }).click(); await main.getByRole('radio', { name: '当前可见', exact: true }).click(); await main.locator('button[data-ai-tool="summary"]').click();
  await until(async () => app.context().pages().some(page => page.url().includes('#/ai-result-toolbar')), 'actual AI consumer route ready'); surfaces.set('analysis', app.context().pages().find(page => page.url().includes('#/ai-result-toolbar'))!);
  await until(async () => { const state = await surfaceState('analysis'); return !!state.visible && state.task?.status === 'completed' && !!state.backdropSample; }, 'genuine provider result and actual AI backdrop');
  await browserInput(); await until(async () => app.context().pages().some(page => page.url().includes('#/agent-toolbar')), 'actual Agent consumer route ready'); surfaces.set('agent', app.context().pages().find(page => page.url().includes('#/agent-toolbar'))!);
  pulseRunning = true; pulse = (async () => { while (pulseRunning) { await browserInput(); await wait(500); } })().catch(error => { pulseError = error; pulseRunning = false; });
  await until(async () => { const states = await allStates(); return Object.values(states).every(state => state.visible && !!state.backdropSample && !!state.backdropImage) && states.navigation.backdropFrameHub.activeSubscriptions === 1 && states.navigation.backdropFrameHub.activeConsumers === 3; }, 'three real consumers share exactly one page subscription');

  // Wrap only this isolated page's subscription before its next registration.
  // Later suppress one actual final presentation to verify the production
  // watchdog catches it, rather than relying on lucky frame timing.
  await invoke(main, 'settings-set', { id: 'appearance.glass', value: 'off' }); await until(async () => (await surfaceState('navigation')).backdropFrameHub.activeSubscriptions === 0, 'glass off releases the real shared subscription');
  await app.evaluate(({ webContents }, id) => {
    const source = webContents.fromId(id)! as any, original = source.beginFrameSubscription.bind(source); source.__qaSampling = { original, drop: false, dropped: 0, callbacks: 0 };
    source.beginFrameSubscription = (dirty: boolean, callback: (image: Electron.NativeImage, rectangle: Electron.Rectangle) => void) => original(dirty, (image: Electron.NativeImage, rectangle: Electron.Rectangle) => { const probe = source.__qaSampling; probe.callbacks++; if (probe.drop) { probe.dropped++; return; } callback(image, rectangle); });
  }, sourceId);
  await invoke(main, 'settings-set', { id: 'appearance.glass', value: 'standard' }); await until(async () => (await surfaceState('navigation')).backdropFrameHub.activeSubscriptions === 1 && (await surfaceState('navigation')).backdropFrameHub.activeConsumers === 3, 'shared subscription resumes after preference change');

  await fixture.evaluate(`(() => {
    const canvas=document.createElement('canvas');canvas.id='qa-host-frame-canvas';canvas.style.cssText='position:fixed;inset:0;width:100%;height:100%;z-index:10000;pointer-events:none';document.body.append(canvas);
    const context=canvas.getContext('2d');const state={running:true,sequence:0,painted:0};window.__qaHostScene=state;
    function draw(){const dpr=devicePixelRatio,w=Math.ceil(innerWidth*dpr),h=Math.ceil(innerHeight*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;context.setTransform(dpr,0,0,dpr,0,0);}state.sequence++;state.painted=performance.now();
      for(let x=0;x<innerWidth;x+=8){const bit=(state.sequence>>(Math.floor(x/8)%8))&1;context.fillStyle=bit?'#08c4ff':'#ef304d';context.fillRect(x,0,8,innerHeight);}
      context.fillStyle='#fff';context.font='bold 24px sans-serif';for(const y of [52,innerHeight/2,innerHeight-40])context.fillText('Actual source frame '+state.sequence,40,y);return state.sequence;}
    state.paintOnce=draw;function frame(){if(!state.running)return;draw();requestAnimationFrame(frame);}requestAnimationFrame(frame);
  })()`);
  await until(async () => Object.values(await allStates()).every(state => state.backdropDiagnostics.frameCrops > 3), 'real canvas presentation reaches all production consumers');
  for (const page of surfaces.values()) await page.evaluate(`(() => {
    const state={running:true,started:performance.now(),received:0,displayed:0,receivedAt:[],displayedAt:[],sequences:[],previousImage:'',previousDisplayed:''};window.__qaHostMonitor=state;
    state.off=window.agentViewer.onToolbar(event=>{if(state.running&&event.action==='backdrop'&&typeof event.backdropImage==='string'&&event.backdropImage!==state.previousImage){state.previousImage=event.backdropImage;state.received++;state.receivedAt.push(performance.now());state.sequences.push(event.backdropSample.sequence);}});
    function frame(){if(!state.running)return;const image=document.querySelector('.liquid-glass-edge')?.style.backgroundImage;if(image&&image!==state.previousDisplayed){state.previousDisplayed=image;state.displayed++;state.displayedAt.push(performance.now());}requestAnimationFrame(frame);}requestAnimationFrame(frame);
  })()`);
  const dynamicBefore = await allStates(); await wait(3500); assert.equal(pulseError, undefined); const dynamicAfter = await allStates(), dynamic: Record<string, unknown> = {};
  for (const [name, page] of surfaces) {
    const monitor = await page.evaluate(() => { const state = (window as any).__qaHostMonitor; state.running = false; state.off(); return { started: state.started, ended: performance.now(), received: state.received, displayed: state.displayed, receivedAt: state.receivedAt, displayedAt: state.displayedAt, sequences: state.sequences }; }) as Monitor;
    const duration = (monitor.ended - monitor.started) / 1000, pngFPS = monitor.received / duration, displayedImageFPS = monitor.displayed / duration;
    assert.ok(pngFPS >= 20, `${name}: actual PNG update rate ${pngFPS.toFixed(2)}Hz must exceed the old 2.5Hz watchdog`); assert.ok(displayedImageFPS >= 18, `${name}: current DOM background image must actually advance`);
    assert.ok(monitor.sequences.length >= 60 && monitor.sequences.slice(1).every((sequence, index) => sequence > monitor.sequences[index]), `${name}: delivered source sample sequences increase`);
    assert.ok(dynamicAfter[name].backdropDiagnostics.frameCrops - dynamicBefore[name].backdropDiagnostics.frameCrops >= 60, `${name}: real production compositor crops are exercised`);
    dynamic[name] = { monitor, pngFPS, displayedImageFPS, before: dynamicBefore[name].backdropDiagnostics, after: dynamicAfter[name].backdropDiagnostics };
  }
  assert.equal(dynamicAfter.navigation.backdropFrameHub.activeSubscriptions, 1); assert.equal(dynamicAfter.navigation.backdropFrameHub.activeConsumers, 3); assert.equal(dynamicAfter.navigation.backdropFrameHub.pageSubscriptions, dynamicBefore.navigation.backdropFrameHub.pageSubscriptions, 'scroll/source readback cannot repeatedly restart the shared subscriber');
  assert.ok(dynamicAfter.navigation.backdropFrameHub.receivedFrames - dynamicBefore.navigation.backdropFrameHub.receivedFrames >= 60); results.dynamic = { consumers: dynamic, hubBefore: dynamicBefore.navigation.backdropFrameHub, hubAfter: dynamicAfter.navigation.backdropFrameHub };
  const gaussian: Record<string, unknown> = {};
  for (const [name, page] of [['main', main] as const, ...surfaces]) { const values = await page.locator('feGaussianBlur').evaluateAll(nodes => nodes.map(node => node.getAttribute('stdDeviation'))); assert.ok(values.every(value => Number(value) === 0), name + ': every actual SVG Gaussian blur is zero'); if (name !== 'main') assert.ok(values.length >= 2); gaussian[name] = values; } results.gaussian = gaussian;

  // Simulate the documented 30Hz subscriber dropping a terminal dirty frame.
  // The real capturePage watchdog must publish it without any DOM hint.
  await fixture.evaluate(() => { (window as any).__qaHostScene.running = false; }); await wait(300);
  await app.evaluate(({ webContents }, id) => { (webContents.fromId(id)! as any).__qaSampling.drop = true; }, sourceId);
  const tailBefore = await allStates();
  await fixture.evaluate(() => { const canvas = document.querySelector<HTMLCanvasElement>('#qa-host-frame-canvas')!, context = canvas.getContext('2d')!; context.fillStyle = '#67e5af'; context.fillRect(0, 0, innerWidth, innerHeight); });
  await until(async () => Object.entries(await allStates()).every(([name, state]) => state.backdropImage !== tailBefore[name].backdropImage && state.backdropDiagnostics.captures > tailBefore[name].backdropDiagnostics.captures), 'shared source terminal pixels reach every consumer through the real screenshot watchdog');
  const dropped = await app.evaluate(({ webContents }, id) => { const source = webContents.fromId(id)! as any; source.__qaSampling.drop = false; return { callbacks: source.__qaSampling.callbacks, dropped: source.__qaSampling.dropped }; }, sourceId); assert.ok(dropped.dropped >= 1, 'the test actually suppressed a presented frame'); results.trailingFallback = { before: tailBefore, after: await allStates(), dropped };
  await wait(500); const idleBefore = await allStates(); await wait(1300); const idleAfter = await allStates();
  for (const name of surfaces.keys()) { assert.ok(idleAfter[name].backdropDiagnostics.captures >= idleBefore[name].backdropDiagnostics.captures + 2, name + ': stationary watchdog is really exercised'); assert.equal(idleAfter[name].backdropDiagnostics.pngEncodes, idleBefore[name].backdropDiagnostics.pngEncodes, name + ': stationary pixels are not re-encoded'); assert.equal(idleAfter[name].backdropDiagnostics.backdropImageFrames, idleBefore[name].backdropDiagnostics.backdropImageFrames, name + ': identical PNGs are not resent'); assert.equal(idleAfter[name].backdropImage, idleBefore[name].backdropImage); } results.idle = { before: idleBefore, after: idleAfter };

  const precision: unknown[] = [];
  for (const pageZoom of [1, 1.25, 2]) {
    await invoke(main, 'zoom', { viewId: view.id, factor: pageZoom });
    await until(async () => Math.abs(await fixture.evaluate(() => devicePixelRatio) - scale * pageZoom) < .001, 'actual webpage zoom/DPR applied');
    const previousImages = await allStates(); await fixture.evaluate(() => (window as any).__qaHostScene.paintOnce());
    await until(async () => Object.entries(await allStates()).every(([name, state]) => state.backdropImage !== previousImages[name].backdropImage), 'new actual static scene enters every aligned crop'); await wait(450);
    for (const [name, page] of surfaces) {
      const state = await surfaceState(name); assert.ok(state.backdropImage && state.backdropSample);
      const pixels = await app.evaluate(async ({ webContents, BrowserWindow, screen, nativeImage }, args) => {
        const source = webContents.fromId(args.sample.sourceContentsId)!, overlay = webContents.getAllWebContents().find(contents => contents.getURL() === args.overlayUrl)!;
        const owner = BrowserWindow.getAllWindows().find(window => window.contentView.children.some(view => (view as any).webContents?.id === source.id))!, sourceBounds = owner.contentView.children.find(view => (view as any).webContents?.id === source.id)!.getBounds(), overlayBounds = owner.contentView.children.find(view => (view as any).webContents?.id === overlay.id)!.getBounds(), overlayZoom = overlay.getZoomFactor(), density = screen.getDisplayMatching(owner.getBounds()).scaleFactor;
        const current = await source.capturePage(args.sample.captureBounds), png = current.toPNG(), received = nativeImage.createFromDataURL(args.image).toBitmap(), expected = nativeImage.createFromBuffer(png).toBitmap(); let mismatchedBytes = Math.abs(expected.byteLength - received.byteLength); for (let index = 0; index < Math.min(expected.byteLength, received.byteLength); index++) if (expected[index] !== received[index]) mismatchedBytes++;
        return { equal: received.equals(expected), mismatchedBytes, sourceZoom: source.getZoomFactor(), density, overlayZoom, sourceBounds, overlayBounds, pixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, expectedOrigin: { x: (sourceBounds.x + args.sample.captureBounds.x - overlayBounds.x) / overlayZoom, y: (sourceBounds.y + args.sample.captureBounds.y - overlayBounds.y) / overlayZoom } };
      }, { sample: state.backdropSample, image: state.backdropImage, overlayUrl: page.url() });
      for (const value of Object.values(state.backdropSample.captureBounds)) assert.ok(Math.abs(value * pixels.density - Math.round(value * pixels.density)) < 1e-6, name + ': ROI edges and extent are physical-pixel aligned');
      assert.equal(pixels.sourceZoom, pageZoom); assert.equal(pixels.density, scale); assert.ok(Math.abs(state.backdropSample.density.x - scale * pixels.overlayZoom) < 1e-6 && Math.abs(state.backdropSample.density.y - scale * pixels.overlayZoom) < 1e-6);
      assert.deepEqual(pixels.pixels, state.backdropSample.pixelSize); assert.equal(pixels.equal, true, name + ': current body crop matches every physical pixel, without resizing'); assert.deepEqual(pixels.expectedOrigin, state.backdropSample.origin);
      precision.push({ name, pageZoom, sample: state.backdropSample, pixels }); await writeFile(join(evidence, `${name}-zoom-${pageZoom}.png`), Buffer.from(state.backdropImage.split(',')[1], 'base64'));
    }
  } results.precision = precision;

  // A real DOM damage hint must advance the source epoch and pixels together;
  // canvas animation above exercised the complementary no-DOM-hint path.
  const damageBefore = await allStates();
  await fixture.evaluate(() => { const node = document.createElement('div'); node.id = 'qa-source-damage'; node.style.cssText = 'position:fixed;inset:0;z-index:10001;pointer-events:none;background:repeating-linear-gradient(135deg,#12aeb4 0 13px,#fa8a2f 13px 27px);color:white;font:700 28px sans-serif'; node.textContent = 'Actual DOM damage / authoritative source epoch'; document.body.append(node); });
  await until(async () => Object.entries(await allStates()).every(([name, state]) => !!state.backdropSample && state.backdropSample.sourceRevision > damageBefore[name].backdropSample!.sourceRevision && state.backdropImage !== damageBefore[name].backdropImage), 'actual DOM damage advances every declared source epoch and visible image');
  results.damageHint = { before: damageBefore, after: await allStates() };

  await stopPulse(); await surfaces.get('analysis')!.getByRole('button', { name: '关闭分析结果', exact: true }).click(); await until(async () => (await surfaceState('navigation')).backdropFrameHub.activeConsumers === 1, 'closed AI and expired Agent release consumers while navigation remains');
  const hiddenConsumers = await allStates(); await wait(900); const afterHiddenConsumers = await allStates(); for (const name of ['analysis', 'agent']) { assert.equal(afterHiddenConsumers[name].backdropDiagnostics.captures, hiddenConsumers[name].backdropDiagnostics.captures); assert.equal(afterHiddenConsumers[name].backdropDiagnostics.frameCrops, hiddenConsumers[name].backdropDiagnostics.frameCrops); } results.hiddenConsumers = { before: hiddenConsumers, after: afterHiddenConsumers };
  for (const action of ['hide', 'minimize'] as const) {
    await app.evaluate(({ BrowserWindow }, input) => { const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === input.mainUrl)!; if (input.action === 'hide') owner.hide(); else owner.minimize(); }, { action, mainUrl: main.url() });
    await until(async () => (await surfaceState('navigation')).backdropFrameHub.activeSubscriptions === 0, action + ': shared subscription releases');
    const suspended = await surfaceState('navigation'); await wait(850); assert.equal((await surfaceState('navigation')).backdropDiagnostics.captures, suspended.backdropDiagnostics.captures, action + ': hidden/minimized source is not captured');
    await app.evaluate(({ BrowserWindow }, mainUrl) => { const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === mainUrl)!; owner.restore(); owner.show(); owner.focus(); }, main.url());
    await until(async () => (await surfaceState('navigation')).backdropFrameHub.activeSubscriptions === 1, action + ': visible source resumes one subscriber');
  }
  await invoke(main, 'settings-set', { id: 'appearance.glass', value: 'off' }); await until(async () => (await surfaceState('navigation')).backdropFrameHub.activeSubscriptions === 0, 'glass off has zero live subscriptions'); const off = await surfaceState('navigation'); await wait(850); assert.equal((await surfaceState('navigation')).backdropDiagnostics.captures, off.backdropDiagnostics.captures); await invoke(main, 'settings-set', { id: 'appearance.glass', value: 'standard' }); await until(async () => (await surfaceState('navigation')).backdropFrameHub.activeSubscriptions === 1, 'glass resumes after enabling');
  await main.locator('.tab').filter({ hasText: '欢迎.md' }).locator('.tab-select').click(); await main.locator('.prose h1').waitFor(); await until(async () => (await surfaceState('navigation')).backdropFrameHub.activeSubscriptions === 0 && (await surfaceState('navigation')).backdropFrameHub.activeConsumers === 0, 'switching to a document retires the unused page subscriber');
  results.retired = (await surfaceState('navigation')).backdropFrameHub; assert.equal((results.retired as NativeBackdropFrameHubStats).listenerErrors, 0); assert.equal((results.retired as NativeBackdropFrameHubStats).startErrors, 0); assert.equal((results.retired as NativeBackdropFrameHubStats).endErrors, 0); assert.ok(modelRequests >= 1); assert.equal((await workspace()).documents.find(document => document.id === view.documentId)!.dirty, false, 'AI result and pointer operation do not mark the source document modified'); assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, scale, port, ...results, errors }, null, 2)); console.log('Actual native shared frame sampling / three consumers / PNG and displayed updates / exact aligned zoom / trailing fallback / idle and retirement: PASS', evidence);
} catch (error) {
  await main.screenshot({ path: join(evidence, 'failure-main.png'), scale: 'css' }).catch(() => {}); results.current = await allStates().catch(() => undefined); await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), scale, ...results, errors }, null, 2)); console.error('Native frame sampling evidence:', evidence); throw error;
} finally {
  await stopPulse().catch(() => {}); if (sourceId) await app.evaluate(({ webContents }, id) => { const source = webContents.fromId(id) as any; if (source?.__qaSampling) source.beginFrameSubscription = source.__qaSampling.original; }, sourceId).catch(() => {});
  await app.close(); await new Promise<void>(done => model.close(() => done()));
}
