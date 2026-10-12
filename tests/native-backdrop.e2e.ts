import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { NAVIGATION_METRICS } from '../apps/desktop/src/renderer/lib/navigation-optics';

type BackdropSample = {
  sequence: number; capturedAt: number; sourceContentsId: number; navigationId: string; geometryRevision: number;
  scrollY: number; origin: { x: number; y: number }; cssSize: { width: number; height: number };
  pixelSize: { width: number; height: number }; density: { x: number; y: number };
  captureBounds: { x: number; y: number; width: number; height: number };
  capsuleBounds: { x: number; y: number; width: number; height: number };
};
type ToolbarState = { backdropImage?: string; backdropSample?: BackdropSample; visible?: boolean; hideProgress?: number };
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-backdrop-'));
const qa = join(directory, 'evidence'); await mkdir(qa);
const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : resolvePort(address.port)); });
});
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? 1.5); assert.ok([1, 1.5, 2].includes(scale));
const app = await electron.launch({ executablePath: require('electron'), args: ['--force-device-scale-factor=' + scale, '.'], cwd: resolve('.'), env, timeout: 45000 });
const page = await app.firstWindow(), errors: string[] = [];
app.context().on('page', target => target.on('pageerror', error => errors.push(error.message))); page.on('pageerror', error => errors.push(error.message));
const invoke = (method: string, args: Record<string, unknown> = {}) => page.evaluate(value => window.agentViewer!.call(value.method, value.args), { method, args });
const until = async (check: () => Promise<boolean>, label: string) => { for (let attempt = 0; attempt < 150; attempt++) { if (await check()) return; await new Promise(resolveWait => setTimeout(resolveWait, 40)); } throw new Error(`等待失败：${label}`); };
const fixtureUrl = `http://127.0.0.1:${port}/fixtures/interaction.html`;
try {
  await page.locator('.prose h1').waitFor();
  await invoke('settings-set', { id: 'appearance.autoHideToolbar', value: false });
  await invoke('settings-set', { id: 'appearance.toolbarDelayMs', value: 10000 });
  await invoke('settings-set', { id: 'appearance.theme', value: 'light' });
  await page.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click();
  await until(async () => app.context().pages().some(target => target.url().startsWith(fixtureUrl)) && app.context().pages().some(target => target.url().includes('#/web-toolbar')), 'native page and toolbar');
  const fixture = app.context().pages().find(target => target.url().startsWith(fixtureUrl))!, toolbar = app.context().pages().find(target => target.url().includes('#/web-toolbar'))!;
  const toolbarState = () => toolbar.evaluate(() => window.agentViewer!.call('toolbar-state', {})) as Promise<ToolbarState>;
  await until(async () => !!(await toolbarState()).backdropSample, 'initial native sample');
  assert.equal(await fixture.evaluate(() => typeof window.agentViewer), 'undefined', 'page receives no privileged command bridge');
  const initial = (await toolbarState()).backdropSample!;
  assert.equal(initial.capsuleBounds.height, NAVIGATION_METRICS.height);
  assert.ok(Math.abs(initial.density.x - scale) < .07 && Math.abs(initial.density.y - scale) < .07, 'capture has matching physical/CSS density');
  await page.evaluate(() => {
    (window as Window & { surfaceEvents?: Record<string, unknown>[] }).surfaceEvents = [];
    window.agentViewer!.onToolbar(event => { if (event.action === 'scroll') (window as Window & { surfaceEvents?: Record<string, unknown>[] }).surfaceEvents!.push({ scrollY: event.scrollY, scrollAt: event.scrollAt }); });
  });

  // Move real prose through the lower glass band; no generated checkerboard is involved.
  const paragraphY = await fixture.locator('#selectable').evaluate(element => element.getBoundingClientRect().top + scrollY);
  await fixture.evaluate(y => scrollTo(0, y - 58), paragraphY);
  await fixture.mouse.move(70, 250);
  for (let index = 0; index < 8; index++) { await fixture.mouse.wheel(0, 8); await fixture.waitForTimeout(40); }
  const at = await fixture.evaluate(() => scrollY);
  await until(async () => (await toolbarState()).backdropSample?.scrollY === at, 'latest sample follows real wheel scroll');
  const moved = await toolbarState(); assert.ok(moved.backdropSample!.sequence > initial.sequence);
  const eventData = await page.evaluate(() => (window as Window & { surfaceEvents?: { scrollY: number; scrollAt: number }[] }).surfaceEvents!);
  assert.ok(eventData.length >= 4, 'real scroll has multiple events before the 650ms context poll');
  const deltas = eventData.slice(1).map((event, index) => event.scrollAt - eventData[index].scrollAt);
  assert.ok(deltas.every(delta => delta >= 0) && deltas.some(delta => delta > 0 && delta < 200), 'scroll clock is monotonic and live');

  const assertCurrentPixels = async () => {
    await fixture.waitForTimeout(150);
    const current = await toolbarState(); assert.ok(current.backdropImage && current.backdropSample);
    const result = await app.evaluate(async ({ nativeImage, webContents }, args) => {
      const source = webContents.fromId(args.sample.sourceContentsId)!;
      const fresh = await source.capturePage(args.sample.captureBounds);
      const freshPng = fresh.toPNG(), expected = nativeImage.createFromDataURL(args.image), actual = nativeImage.createFromBuffer(freshPng);
      return { equal: expected.toBitmap().equals(actual.toBitmap()), pixelSize: { width: freshPng.readUInt32BE(16), height: freshPng.readUInt32BE(20) } };
    }, { sample: current.backdropSample, image: current.backdropImage });
    assert.equal(result.equal, true, 'sample pixels come from the current prose at the declared coordinates');
    assert.deepEqual(result.pixelSize, current.backdropSample.pixelSize);
    return current.backdropSample;
  };
  const proseSample = await assertCurrentPixels();
  const previousImage = (await toolbarState()).backdropImage;
  await fixture.locator('#selectable').evaluate(element => { element.textContent = '正文更新验证：动态文字必须进入当前胶囊背景。'; });
  await until(async () => (await toolbarState()).backdropSample!.sequence > proseSample.sequence, 'actual DOM content invalidates sample');
  await fixture.evaluate(y => scrollTo(0, y - 36), paragraphY);
  await until(async () => (await toolbarState()).backdropImage !== previousImage, 'changing prose changes the bounded background image');
  await assertCurrentPixels();

  // Delay only this isolated test page's capture, and verify one in-flight request
  // plus a latest queued request instead of a pile of stale captures.
  await app.evaluate(({ webContents }, contentsId) => {
    const source = webContents.fromId(contentsId)! as any;
    const original = source.capturePage.bind(source);
    source.__captureProbe = { active: 0, max: 0, count: 0, delay: 100 };
    source.capturePage = async (...args: unknown[]) => {
      const probe = source.__captureProbe; probe.active++; probe.count++; probe.max = Math.max(probe.max, probe.active);
      try { await new Promise(resolveWait => setTimeout(resolveWait, probe.delay)); return await original(...args); }
      finally { probe.active--; }
    };
  }, proseSample.sourceContentsId);
  // Live scroll may now use shared compositor frames without capturePage.
  // Independently await the real 400ms force watchdog to exercise its fallback
  // and retain the strict single-in-flight assertion on actual delayed calls.
  await until(async () => (await app.evaluate(({ webContents }, contentsId) => (webContents.fromId(contentsId)! as any).__captureProbe.count, proseSample.sourceContentsId)) >= 1, 'real watchdog enters the delayed capture fallback');
  for (let index = 0; index < 12; index++) { await fixture.mouse.wheel(0, 9); await fixture.waitForTimeout(20); }
  const latestY = await fixture.evaluate(() => scrollY);
  await until(async () => (await toolbarState()).backdropSample?.scrollY === latestY, 'latest pending source wins after delayed captures');
  await until(async () => (await app.evaluate(({ webContents }, contentsId) => (webContents.fromId(contentsId)! as any).__captureProbe.count, proseSample.sourceContentsId)) >= 2, 'at least two real watchdog captures exercise the guarded fallback');
  const probe = await app.evaluate(({ webContents }, contentsId) => (webContents.fromId(contentsId)! as any).__captureProbe, proseSample.sourceContentsId);
  assert.equal(probe.max, 1, 'capture requests never overlap'); assert.ok(probe.count >= 2);
  await app.evaluate(({ webContents }, contentsId) => { (webContents.fromId(contentsId)! as any).__captureProbe.delay = 0; }, proseSample.sourceContentsId);
  const beforeReload = (await toolbarState()).backdropSample!.navigationId;
  await fixture.reload();
  await until(async () => { const sample = (await toolbarState()).backdropSample; return !!sample && sample.navigationId !== beforeReload && sample.scrollY === await fixture.evaluate(() => scrollY); }, 'same-URL reload rejects old navigation samples');
  await assertCurrentPixels();

  // A hover in the page's top zone outside the capsule is a reveal, not a lock.
  await invoke('settings-set', { id: 'appearance.autoHideToolbar', value: true });
  await fixture.mouse.move(20, 20); await fixture.mouse.move(20, 250);
  for (let index = 0; index < 8; index++) { await fixture.mouse.wheel(0, 12); await fixture.waitForTimeout(45); }
  await until(async () => { const state = await toolbarState(); return Number(state.hideProgress) > 0 && Number(state.hideProgress) < 1 && !!state.backdropSample; }, 'real wheel produces a partial hide');
  // The source-sized toolbar now eases for 380–650ms. Compare each live
  // geometry to the current sample rather than freezing a 220ms intermediate
  // coordinate and then waiting for a newer surface to move back to it.
  await until(async () => { const actual = await toolbar.locator('.navigation-capsule').evaluate(element => element.getBoundingClientRect().y); const current = await toolbarState(); return Number(current.hideProgress) > 0 && Number(current.hideProgress) < 1 && !!current.backdropSample && Math.abs(current.backdropSample.capsuleBounds.y - actual) < .3 && Math.abs(current.backdropSample.capsuleBounds.y - initial.capsuleBounds.y) > 1; }, 'sample uses the actual transformed capsule after it has visibly moved');
  const halfSample = (await toolbarState()).backdropSample!;
  assert.ok(Math.abs(initial.capsuleBounds.y - NAVIGATION_METRICS.shadowGutter) < .5, 'initial native capsule uses the shared source-sized transparent gutter');
  assert.ok(Math.abs(halfSample.capsuleBounds.y - NAVIGATION_METRICS.shadowGutter) > 1, 'partial hiding moves the capsule from its actual initial position');
  await assertCurrentPixels();
  for (let index = 0; index < 10; index++) { await fixture.mouse.wheel(0, 12); await fixture.waitForTimeout(45); }
  await until(async () => (await toolbarState()).visible === false, 'continuous small wheel input hides toolbar without sticky top hover');
  for (let index = 0; index < 4; index++) { await fixture.mouse.wheel(0, -12); await fixture.waitForTimeout(45); }
  await until(async () => (await toolbarState()).visible === true, 'upward real wheel reveals toolbar');
  await invoke('settings-set', { id: 'appearance.autoHideToolbar', value: false });
  await until(async () => !!(await toolbarState()).backdropSample, 'sample restored after reveal');
  await toolbar.screenshot({ path: join(qa, 'native-current-prose.png'), omitBackground: true, scale: 'css' });
  const finalState = await toolbarState();
  await writeFile(join(qa, 'sample-evidence.json'), JSON.stringify({ initial, proseSample, halfSample, finalSample: finalState.backdropSample, eventData, probe }, null, 2));
  assert.deepEqual(errors, []);
  console.log('Native real-prose/wheel freshness, sampled geometry, 150% density, single in-flight, reload and hover: PASS', qa);
} catch (error) {
  await page.screenshot({ path: join(qa, 'failure-main.png'), scale: 'css' }).catch(() => {});
  const toolbar = app.context().pages().find(target => target.url().includes('#/web-toolbar'));
  if (toolbar) { const current = await toolbar.evaluate(() => window.agentViewer!.call('toolbar-state', {})).catch(() => undefined); const actual = await toolbar.locator('.navigation-capsule').evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }).catch(() => undefined); await writeFile(join(qa, 'failure.json'), JSON.stringify({ error: String(error), current, actual }, null, 2)); }
  console.error('Native backdrop evidence:', qa); throw error;
} finally { await app.close(); }
