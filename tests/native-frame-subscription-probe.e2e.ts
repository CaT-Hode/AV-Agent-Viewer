import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Standalone source-frame experiment. Run with the coordinated UI lock only:
// AGENTVIEWER_QA_SCALE=1/1.5/2. Never attaches to the installed application.
type Rect = { x: number; y: number; width: number; height: number };
type Sample = { sourceContentsId: number; navigationId: string; layoutRevision: number; captureBounds: Rect; pixelSize: { width: number; height: number }; density: { x: number; y: number } };
type ToolbarState = { backdropImage?: string; backdropSample?: Sample; backdropDiagnostics?: Record<string, number> };
type ProbeStats = { started: number; ended: number; frames: number; processed: number; frameAt: number[]; processingAt: number[]; cropMs: number[]; bitmapMs: number[]; encodeMs: number[]; wholeBitmapMs?: number; frameGeometry?: unknown; lastGeometry?: unknown; errors: string[]; memoryBefore: unknown; memoryAfter?: unknown };
const require = createRequire(import.meta.url), scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? '1');
assert.ok([1, 1.5, 2].includes(scale));
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-frame-subscription-')), evidence = join(directory, 'evidence'); await mkdir(evidence);
await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, revision: 0, values: { 'appearance.glass': 'standard', 'appearance.motion': 'off', 'appearance.autoHideToolbar': false, 'appearance.theme': 'light', 'translation.selectionAuto': false } }));
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: ['--force-device-scale-factor=' + scale, '.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], results: Record<string, unknown> = {};
app.context().on('page', page => page.on('pageerror', error => errors.push(error.message))); main.on('pageerror', error => errors.push(error.message));
const invoke = <T>(page: Page, method: string, args: Record<string, unknown> = {}) => page.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const until = async (check: () => Promise<boolean>, label: string) => { for (let index = 0; index < 180; index++) { if (await check()) return; await new Promise(done => setTimeout(done, 50)); } throw new Error(label); };
const percentile = (values: number[], fraction: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0; };
const cost = (values: number[]) => ({ count: values.length, totalMs: values.reduce((sum, value) => sum + value, 0), p50Ms: percentile(values, .5), p95Ms: percentile(values, .95) });
const intervals = (times: number[]) => times.slice(1).map((time, index) => time - times[index]);
let fixture: Page | undefined, sourceId: number | undefined;
try {
  await main.locator('.prose h1').waitFor(); await main.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click();
  await until(async () => app.context().pages().some(page => page.url().includes('#/web-toolbar')) && app.context().pages().some(page => page.url() === `http://127.0.0.1:${port}/fixtures/interaction.html`), 'native fixture and toolbar ready');
  fixture = app.context().pages().find(page => page.url() === `http://127.0.0.1:${port}/fixtures/interaction.html`)!;
  const toolbar = app.context().pages().find(page => page.url().includes('#/web-toolbar'))!, toolbarState = () => invoke<ToolbarState>(toolbar, 'toolbar-state');
  assert.equal(await fixture.evaluate(() => typeof window.agentViewer), 'undefined');
  await until(async () => !!(await toolbarState()).backdropSample, 'actual crop identity ready');
  const first = (await toolbarState()).backdropSample!; sourceId = first.sourceContentsId;
  results.build = await main.evaluate(() => [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map(node => node.getAttribute('src') ?? node.getAttribute('href')));

  // Paint in the actual untrusted page, directly under the navbar. A canvas
  // animation has no per-frame DOM mutation; it exposes the watchdog bottleneck.
  await fixture.evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.id = 'qa-compositor-canvas';
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:240px;z-index:10000;pointer-events:none';
    canvas.width = Math.ceil(innerWidth * devicePixelRatio); canvas.height = Math.ceil(240 * devicePixelRatio); document.body.append(canvas);
    const context = canvas.getContext('2d'); context.scale(devicePixelRatio, devicePixelRatio);
    window.__qaFrameScene = { running:true, sequence:0, times:[], last:0 };
    function paint(now) {
      const state = window.__qaFrameScene; if (!state.running) return;
      state.sequence++; state.last = now; state.times.push(now);
      context.fillStyle = state.sequence % 2 ? '#ffffff' : '#111111'; context.fillRect(0,0,innerWidth,240);
      for (let x=0; x<innerWidth; x+=16) { context.fillStyle = ((x/16+state.sequence)%3) ? '#08c4ff' : '#ef304d'; context.fillRect(x+state.sequence%8,0,8,240); }
      context.fillStyle='#ffffff'; context.font='bold 26px sans-serif'; context.fillText('Actual compositor frame '+state.sequence,80,58);
      requestAnimationFrame(paint);
    }
    requestAnimationFrame(paint);
  })()`);
  await toolbar.evaluate(() => {
    const value = { started: performance.now(), times: [] as number[], images: 0, previous: '' }; (window as any).__qaBaseline = value;
    window.agentViewer!.onToolbar(event => { if (event.action === 'backdrop' && typeof event.backdropImage === 'string' && event.backdropImage !== value.previous) { value.previous = event.backdropImage; value.images++; value.times.push(performance.now()); } });
  });
  await toolbar.waitForTimeout(3500);
  const baseline = await toolbar.evaluate(() => { const value = (window as any).__qaBaseline; return { ...value, previous: undefined, ended: performance.now() }; });
  const baseState = await toolbarState(); assert.ok(baseState.backdropSample && baseState.backdropImage);
  results.baseline = { ...baseline, receivedPngFPS: baseline.images * 1000 / (baseline.ended - baseline.started), intervals: cost(intervals(baseline.times)), diagnostics: baseState.backdropDiagnostics, sample: baseState.backdropSample };
  await writeFile(join(evidence, 'baseline-last-crop.png'), Buffer.from(baseState.backdropImage.split(',')[1], 'base64'));

  await app.evaluate(({ app, webContents, BrowserWindow, screen }, args) => {
    const source = webContents.fromId(args.id)!;
    const probe: any = { source, capture: args.capture, started: performance.now(), ended: 0, frames: 0, processed: 0, frameAt: [], processingAt: [], cropMs: [], bitmapMs: [], encodeMs: [], errors: [], memoryBefore: { rss: process.memoryUsage().rss, metrics: app.getAppMetrics().map(metric => ({ type: metric.type, pid: metric.pid, memory: metric.memory })) } };
    (globalThis as any).__qaFrameProbe = probe;
    source.beginFrameSubscription(false, (image, dirtyRect) => {
      const now = performance.now(); probe.frames++; probe.frameAt.push(now); probe.latest = image; probe.latestDirty = dirtyRect;
      // Latest frame only with a 16ms processing budget. Electron 44's normal
      // subscription itself caps presentation at 30Hz. No encode backlog.
      if (now - (probe.lastProcessed ?? -Infinity) < 16) return;
      probe.lastProcessed = now; probe.processingAt.push(now);
      try {
        const owner = BrowserWindow.getAllWindows().find(window => window.contentView.children.some(view => (view as any).webContents?.id === args.id))!;
        const frameSize = image.getSize(), factors = image.getScaleFactors(), bounds = owner.contentView.children.find(view => (view as any).webContents?.id === args.id)!.getBounds();
        // Whole-frame physical dimensions have ceil rounding. Their quotient
        // is not the exact density (2033/1355 != 1.5). Native representations
        // determine crop coordinates; this probe's forced display scale is known.
        const displayDensity = screen.getDisplayMatching(owner.getBounds()).scaleFactor, imageFactor = factors[0] ?? 1, ratioX = displayDensity / imageFactor, ratioY = displayDensity / imageFactor;
        const cropCoordinates = { x: Math.floor(args.capture.x * ratioX), y: Math.floor(args.capture.y * ratioY), width: Math.ceil((args.capture.x + args.capture.width) * ratioX) - Math.floor(args.capture.x * ratioX), height: Math.ceil((args.capture.y + args.capture.height) * ratioY) - Math.floor(args.capture.y * ratioY) };
        const cropStart = performance.now(), crop = image.crop(cropCoordinates); probe.cropMs.push(performance.now() - cropStart);
        const bitmapStart = performance.now(), bitmap = crop.toBitmap(); probe.bitmapMs.push(performance.now() - bitmapStart);
        const encodeStart = performance.now(), png = crop.toPNG(); probe.encodeMs.push(performance.now() - encodeStart); probe.processed++;
        probe.lastPng = png; probe.lastGeometry = { frameSize, factors, bounds, dirtyRect, cropCoordinates, cropSize: crop.getSize(), cropFactors: crop.getScaleFactors(), cropBitmapBytes: bitmap.byteLength, cropPngPixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } };
        if (!probe.frameGeometry) { const wholeStarted = performance.now(), full = image.toBitmap(); probe.wholeBitmapMs = performance.now() - wholeStarted; probe.frameGeometry = { frameSize, factors, bounds, dirtyRect, wholeBitmapBytes: full.byteLength, observedRatio: { x: frameSize.width / bounds.width, y: frameSize.height / bounds.height }, displayDensity, pageZoom: source.getZoomFactor(), cropCoordinateScale: ratioX }; }
      } catch (error) { probe.errors.push(String(error)); }
    });
  }, { id: sourceId, capture: baseState.backdropSample.captureBounds, scale });
  await toolbar.waitForTimeout(3500);
  const dynamic = await app.evaluate(({ app }) => { const probe = (globalThis as any).__qaFrameProbe; probe.ended = performance.now(); probe.memoryAfter = { rss: process.memoryUsage().rss, metrics: app.getAppMetrics().map(metric => ({ type: metric.type, pid: metric.pid, memory: metric.memory })) }; const { source, latest, lastPng, ...stats } = probe; return stats; }) as ProbeStats;
  const producer = await fixture.evaluate(() => { const scene = (window as any).__qaFrameScene; return { sequence: scene.sequence, times: scene.times, dpr: devicePixelRatio }; });
  results.subscription = { ...dynamic, presentedFPS: dynamic.frames * 1000 / (dynamic.ended - dynamic.started), croppedEncodedFPS: dynamic.processed * 1000 / (dynamic.ended - dynamic.started), presentationIntervals: cost(intervals(dynamic.frameAt)), crop: cost(dynamic.cropMs), bitmap: cost(dynamic.bitmapMs), encode: cost(dynamic.encodeMs), producer };
  assert.equal(producer.dpr, scale); assert.ok(dynamic.frames >= 8 && dynamic.processed >= 4, 'actual compositor presentation callbacks deliver usable frames'); assert.deepEqual(dynamic.errors, []);

  const stopped = await fixture.evaluate(() => { const scene = (window as any).__qaFrameScene; scene.running = false; return { sequence: scene.sequence, at: performance.now() }; }); await toolbar.waitForTimeout(300);
  const beforeRefresh = await app.evaluate(() => { const probe = (globalThis as any).__qaFrameProbe; const frames = probe.frames; probe.source.invalidate(); return { frames, at: performance.now() }; });
  // invalidate() is not a guaranteed onscreen repaint. Damage a pixel outside
  // every compared ROI; their frozen content remains byte-identical.
  await fixture.evaluate(() => { const canvas = document.querySelector<HTMLCanvasElement>('#qa-compositor-canvas')!; const context = canvas.getContext('2d')!; context.fillStyle = '#37ed93'; context.fillRect(innerWidth - 4, 230, 2, 2); });
  await until(async () => await app.evaluate(() => (globalThis as any).__qaFrameProbe.frames) > beforeRefresh.frames, 'a real final frozen-canvas presentation arrives after stop');
  results.trailingRefresh = { stopped, beforeRefresh, afterRefresh: await app.evaluate(() => { const probe = (globalThis as any).__qaFrameProbe; return { frames: probe.frames, at: performance.now() }; }) };
  const exact = await app.evaluate(async ({ nativeImage, BrowserWindow, screen }, args) => {
    const probe = (globalThis as any).__qaFrameProbe, image = probe.latest as Electron.NativeImage, source = probe.source as Electron.WebContents;
    const owner = BrowserWindow.getAllWindows().find(window => window.contentView.children.some(view => (view as any).webContents?.id === args.id))!;
    const frameSize = image.getSize(), bounds = owner.contentView.children.find(view => (view as any).webContents?.id === args.id)!.getBounds(), displayDensity = screen.getDisplayMatching(owner.getBounds()).scaleFactor, imageFactor = image.getScaleFactors()[0] ?? 1, ratioX = displayDensity / imageFactor, ratioY = displayDensity / imageFactor;
    const adjusted = { x: Math.floor(args.capture.x * ratioX), y: Math.floor(args.capture.y * ratioY), width: Math.ceil((args.capture.x + args.capture.width) * ratioX) - Math.floor(args.capture.x * ratioX), height: Math.ceil((args.capture.y + args.capture.height) * ratioY) - Math.floor(args.capture.y * ratioY) };
    const started = performance.now(), reference = await source.capturePage(args.capture), captureMs = performance.now() - started;
    const directPng = image.crop(args.capture).toPNG(), adjustedPng = image.crop(adjusted).toPNG(), referencePng = reference.toPNG();
    const expected = nativeImage.createFromBuffer(referencePng).toBitmap(), direct = nativeImage.createFromBuffer(directPng).toBitmap(), actual = nativeImage.createFromBuffer(adjustedPng).toBitmap();
    let mismatchedBytes = Math.abs(expected.byteLength - actual.byteLength); for (let index = 0; index < Math.min(actual.byteLength, expected.byteLength); index++) if (actual[index] !== expected[index]) mismatchedBytes++;
    return { directEqual: direct.equals(expected), adjustedEqual: actual.equals(expected), mismatchedBytes, adjusted, ratioX, ratioY, displayDensity, pageZoom: source.getZoomFactor(), captureMs, frameSize, frameFactors: image.getScaleFactors(), referenceSize: reference.getSize(), referenceFactors: reference.getScaleFactors(), directPixels: { width: directPng.readUInt32BE(16), height: directPng.readUInt32BE(20) }, adjustedPixels: { width: adjustedPng.readUInt32BE(16), height: adjustedPng.readUInt32BE(20) }, referencePixels: { width: referencePng.readUInt32BE(16), height: referencePng.readUInt32BE(20) }, adjustedPng: adjustedPng.toString('base64'), referencePng: referencePng.toString('base64') };
  }, { id: sourceId, capture: baseState.backdropSample.captureBounds, scale });
  await writeFile(join(evidence, 'subscription-stable-crop.png'), Buffer.from(exact.adjustedPng, 'base64')); await writeFile(join(evidence, 'capture-page-stable-crop.png'), Buffer.from(exact.referencePng, 'base64'));
  results.precision = { ...exact, adjustedPng: undefined, referencePng: undefined };
  assert.equal(exact.adjustedEqual, true, 'stable actual compositor crop equals capturePage at every physical pixel'); assert.deepEqual(exact.adjustedPixels, exact.referencePixels);
  const coordinateCases: unknown[] = [];
  for (const pageZoom of scale === 1.5 ? [1, 1.25, 2] : [1]) {
    const zoomChange = await app.evaluate((_electron, zoom) => { const probe = (globalThis as any).__qaFrameProbe; const before = { frames: probe.frames, changed: probe.source.getZoomFactor() !== zoom }; if (before.changed) { probe.source.setZoomFactor(zoom); probe.source.invalidate(); } return before; }, pageZoom);
    if (zoomChange.changed) {
      await toolbar.waitForTimeout(300);
      const framesBeforeDamage = await app.evaluate(() => (globalThis as any).__qaFrameProbe.frames);
      await fixture.evaluate(zoom => { const canvas = document.querySelector<HTMLCanvasElement>('#qa-compositor-canvas')!; const context = canvas.getContext('2d')!; context.fillStyle = zoom === 1.25 ? '#fa911b' : '#37ed93'; context.fillRect(innerWidth - 4, 230, 2, 2); }, pageZoom);
      await until(async () => await app.evaluate(() => (globalThis as any).__qaFrameProbe.frames) > framesBeforeDamage, 'actual zoom presentation');
    }
    const pageMetadata = await fixture.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight }));
    for (const rectangle of [baseState.backdropSample.captureBounds, { x: 13, y: 17, width: 73, height: 39 }, { x: 12, y: 16, width: 74, height: 40 }]) {
      const comparison = await app.evaluate(async ({ BrowserWindow, screen, nativeImage }, args) => {
        const probe = (globalThis as any).__qaFrameProbe, source = probe.source as Electron.WebContents, image = probe.latest as Electron.NativeImage;
        const owner = BrowserWindow.getAllWindows().find(window => window.contentView.children.some(view => (view as any).webContents?.id === args.id))!, density = screen.getDisplayMatching(owner.getBounds()).scaleFactor, factor = image.getScaleFactors()[0] ?? 1, coordinateScale = density / factor;
        const reference = await source.capturePage(args.rectangle), png = reference.toPNG(), expected = nativeImage.createFromBuffer(png).toBitmap(), width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        const candidates: { origin: string; x: number; y: number; equal: boolean; mismatchedBytes: number; diffP50: number; diffP95: number; diffMax: number }[] = [];
        for (const rounding of ['floor', 'round', 'ceil']) {
          const x = rounding === 'floor' ? Math.floor(args.rectangle.x * coordinateScale) : rounding === 'ceil' ? Math.ceil(args.rectangle.x * coordinateScale) : Math.round(args.rectangle.x * coordinateScale), y = rounding === 'floor' ? Math.floor(args.rectangle.y * coordinateScale) : rounding === 'ceil' ? Math.ceil(args.rectangle.y * coordinateScale) : Math.round(args.rectangle.y * coordinateScale);
          const candidate = nativeImage.createFromBuffer(image.crop({ x, y, width, height }).toPNG()).toBitmap(), differences: number[] = []; let mismatchedBytes = Math.abs(candidate.byteLength - expected.byteLength);
          for (let index = 0; index < Math.min(candidate.byteLength, expected.byteLength); index++) { const difference = Math.abs(candidate[index] - expected[index]); if (difference) mismatchedBytes++; if (index % 4 !== 3) differences.push(difference); }
          differences.sort((a, b) => a - b); candidates.push({ origin: rounding, x, y, equal: candidate.equals(expected), mismatchedBytes, diffP50: differences[Math.floor(differences.length * .5)] ?? 0, diffP95: differences[Math.floor(differences.length * .95)] ?? 0, diffMax: differences.at(-1) ?? 0 });
        }
        const baseX = Math.floor(args.rectangle.x * coordinateScale), baseY = Math.floor(args.rectangle.y * coordinateScale), basePng = image.crop({ x: baseX, y: baseY, width, height }).toPNG(), base = nativeImage.createFromBuffer(basePng).toBitmap();
        let bestShift = { x: 0, y: 0, mismatchedBytes: candidates[0].mismatchedBytes, equal: candidates[0].equal };
        if (args.rectangle.width < 100) for (let shiftY = -3; shiftY <= 3; shiftY++) for (let shiftX = -3; shiftX <= 3; shiftX++) {
          const shifted = nativeImage.createFromBuffer(image.crop({ x: baseX + shiftX, y: baseY + shiftY, width, height }).toPNG()).toBitmap(); let mismatches = Math.abs(shifted.byteLength - expected.byteLength);
          for (let index = 0; index < Math.min(shifted.byteLength, expected.byteLength); index++) if (shifted[index] !== expected[index]) mismatches++;
          if (mismatches < bestShift.mismatchedBytes) bestShift = { x: shiftX, y: shiftY, mismatchedBytes: mismatches, equal: shifted.equals(expected) };
        }
        let flatPixels = 0, flatRgbMismatches = 0; const colours = new Map<string, number>();
        for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
          const index = (y * width + x) * 4, colour = `${base[index]},${base[index + 1]},${base[index + 2]}`; colours.set(colour, (colours.get(colour) ?? 0) + 1);
          let flat = true; for (let yy = -2; yy <= 2; yy++) for (let xx = -2; xx <= 2; xx++) for (let channel = 0; channel < 3; channel++) if (base[((y + yy) * width + x + xx) * 4 + channel] !== base[index + channel]) flat = false;
          if (flat) { flatPixels++; for (let channel = 0; channel < 3; channel++) if (base[index + channel] !== expected[index + channel]) flatRgbMismatches++; }
        }
        return { rectangle: args.rectangle, density, pageZoom: source.getZoomFactor(), frameSize: image.getSize(), frameFactors: image.getScaleFactors(), referencePixels: { width, height }, candidates, bestShift, flatPixels, flatRgbMismatches, dominantColours: [...colours].sort((a, b) => b[1] - a[1]).slice(0, 5), basePng: basePng.toString('base64'), referencePng: png.toString('base64') };
      }, { id: sourceId, rectangle });
      const imageStem = `zoom-${pageZoom}-x${rectangle.x}-y${rectangle.y}`;
      await writeFile(join(evidence, imageStem + '-subscription.png'), Buffer.from(comparison.basePng, 'base64')); await writeFile(join(evidence, imageStem + '-capture.png'), Buffer.from(comparison.referencePng, 'base64'));
      coordinateCases.push({ pageMetadata, ...comparison, basePng: undefined, referencePng: undefined }); results.coordinateCases = coordinateCases;
    }
  }
  const retired = await app.evaluate(() => { const probe = (globalThis as any).__qaFrameProbe; probe.source.endFrameSubscription(); const count = probe.frames; probe.source.invalidate(); return count; }); await toolbar.waitForTimeout(150); assert.equal(await app.evaluate(() => (globalThis as any).__qaFrameProbe.frames), retired, 'retired subscription cannot deliver callbacks'); results.retired = { callbacksAfterRetire: 0 };
  assert.ok(coordinateCases.every(comparison => (comparison as { candidates: { equal: boolean }[] }).candidates.some(candidate => candidate.equal)), 'at least one explicit physical origin rounding exactly matches every odd ROI/zoom capturePage; retain failures for geometry investigation');
  assert.deepEqual(errors, []); await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, scale, port, ...results, errors }, null, 2)); console.log('Native compositor subscription / actual PNG baseline / crop-DPI exact pixels / p95 costs and memory: PASS', evidence);
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), scale, ...results, errors }, null, 2)); await main.screenshot({ path: join(evidence, 'failure-main.png') }).catch(() => {}); throw error;
} finally {
  await app.evaluate(() => { const probe = (globalThis as any).__qaFrameProbe; if (probe?.source && !probe.source.isDestroyed()) probe.source.endFrameSubscription(); delete (globalThis as any).__qaFrameProbe; }).catch(() => {});
  await app.close();
}
