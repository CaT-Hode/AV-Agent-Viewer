import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { NAVIGATION_METRICS } from '../apps/desktop/src/renderer/lib/navigation-optics';
import { activeSourceBezel, insidePixelRect, opaqueInkError, SOURCE_NAVIGATION_SCALE } from './glass-pixel-helpers';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-glass-optics-'));
const evidence = process.env.AGENTVIEWER_QA_DIR ? resolve(process.env.AGENTVIEWER_QA_DIR, 'ui-glass-optics') : join(directory, 'evidence');
await mkdir(evidence, { recursive: true });
const selector = '.reader-toolbar > .floating-capsule.navigation-capsule';
// High-frequency detail exposes the author's squircle's actual displacement.
const pattern = 'repeating-linear-gradient(90deg,transparent 0px 5px,#152b3d 5px 6px,transparent 6px 12px),repeating-linear-gradient(0deg,#f5fbff 0px 1px,#79b1ce 1px 2px)';
type Rect = { x: number; y: number; width: number; height: number };
type Bitmap = { width: number; height: number; data: Buffer };
type CaseResult = { host: string; scale: number; ratio: number; regions: Record<string, { pixels: number; changed: number; max: number; total: number }> };
const results: CaseResult[] = [], failures: string[] = [];

const unusedPort = () => new Promise<number>((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    server.close(error => error ? reject(error) : resolvePort(address.port));
  });
});
const until = async (check: () => Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error(`Timeout: ${label}`);
};
const frames = (target: Page) => target.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const decode = async (app: ElectronApplication, png: Buffer): Promise<Bitmap> => {
  const value = await app.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    return { ...image.getSize(), bitmap: image.toBitmap().toString('base64') };
  }, png.toString('base64'));
  const data = Buffer.from(value.bitmap, 'base64');
  assert.equal(data.length, value.width * value.height * 4, 'PNG bitmap dimensions are physical pixels');
  return { width: value.width, height: value.height, data };
};
const depth = (x: number, y: number, capsule: Rect) => {
  const radius = Math.min(capsule.width, capsule.height) / 2;
  const qx = Math.abs(x - capsule.x - capsule.width / 2) - (capsule.width / 2 - radius);
  const qy = Math.abs(y - capsule.y - capsule.height / 2) - (capsule.height / 2 - radius);
  return -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius);
};

async function verifyHost(app: ElectronApplication, target: Page, host: string, scale: number) {
  await target.locator(selector).waitFor();
  await target.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '*{animation:none!important;transition:none!important;caret-color:transparent!important} .floating-capsule.navigation-capsule{box-shadow:none!important} .qa-no-foreground :is(.navigation-module,.capsule-divider){visibility:hidden!important} .qa-shift-foreground .navigation-module{translate:1px 0!important}';
    document.head.appendChild(style);
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await target.locator(`${selector} feDisplacementMap`).waitFor({ state: 'attached' });
  await target.waitForTimeout(500); // Decode the data URI and let the native screenshot source settle.
  const geometry = await target.locator(selector).evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const edgeWidth = Number.parseFloat(getComputedStyle(element).getPropertyValue('--navigation-refraction-width'));
    const primitive = element.querySelector<SVGElement>('[data-glass-displacement]')!;
    const sourceScale = Number(primitive.dataset.glassBaseScale), paint = document.createElement('canvas'); paint.width = paint.height = 1;
    const context = paint.getContext('2d')!;
    const foreground = [...element.querySelectorAll<HTMLElement>('button:not(:disabled),button:not(:disabled) svg,input,.capsule-document-title')].map(node => {
      const bounds = node.getBoundingClientRect(); context.clearRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(node).color; context.fillRect(0, 0, 1, 1);
      let opacity = 1, ancestor: Element | null = node; while (ancestor) { opacity *= Number(getComputedStyle(ancestor).opacity); if (ancestor === element) break; ancestor = ancestor.parentElement; }
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, ink: [...context.getImageData(0, 0, 1, 1).data], opacity };
    });
    return { capsule: { x, y, width, height }, edgeWidth, sourceScale, foreground, viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio };
  });
  assert.ok(Number.isFinite(geometry.edgeWidth) && geometry.edgeWidth > 0, 'refraction band has a real CSS width');
  assert.equal(geometry.edgeWidth, NAVIGATION_METRICS.bezelWidth); assert.equal(geometry.capsule.height, NAVIGATION_METRICS.height);
  assert.ok(Math.abs(geometry.sourceScale - SOURCE_NAVIGATION_SCALE) < .0001, 'the actual filter uses the source ray/encoding scale');
  const capsule = geometry.capsule;
  const gutter = NAVIGATION_METRICS.shadowGutter;
  const clip = { x: Math.max(0, capsule.x - gutter), y: Math.max(0, capsule.y - gutter), width: Math.min(geometry.viewport.width, capsule.x + capsule.width + gutter) - Math.max(0, capsule.x - gutter), height: Math.min(geometry.viewport.height, capsule.y + capsule.height + gutter) - Math.max(0, capsule.y - gutter) };
  const setScale = async (amount: number) => {
    await target.locator(`${selector} [data-glass-displacement]`).evaluate((element, value) => element.setAttribute('scale', String(value)), amount);
    await frames(target);
  };
  await setScale(0);
  const baselinePng = await target.screenshot({ clip, omitBackground: true, scale: 'device' });
  await setScale(geometry.sourceScale);
  const refractedPng = await target.screenshot({ clip, omitBackground: true, scale: 'device' });
  await setScale(0);
  const repeatedPng = await target.screenshot({ clip, omitBackground: true, scale: 'device' });
  await target.locator(selector).evaluate(element => element.classList.add('qa-no-foreground')); await frames(target);
  const background0Png = await target.screenshot({ clip, omitBackground: true, scale: 'device' });
  await setScale(geometry.sourceScale);
  const backgroundSourcePng = await target.screenshot({ clip, omitBackground: true, scale: 'device' });
  await target.locator(selector).evaluate(element => { element.classList.remove('qa-no-foreground'); element.classList.add('qa-shift-foreground'); }); await setScale(0);
  const shiftedInkPng = await target.screenshot({ clip, omitBackground: true, scale: 'device' });
  await target.locator(selector).evaluate(element => element.classList.remove('qa-shift-foreground'));
  await target.locator(selector).evaluate(element => { (element as HTMLElement).style.visibility = 'hidden'; });
  await frames(target);
  const hiddenPng = await target.screenshot({ clip, omitBackground: true, scale: 'device' });
  await target.locator(selector).evaluate(element => { (element as HTMLElement).style.visibility = ''; });
  await setScale(geometry.sourceScale);

  const prefix = `${host}-${scale}`;
  await Promise.all([
    writeFile(join(evidence, `${prefix}-scale0.png`), baselinePng),
    writeFile(join(evidence, `${prefix}-source-scale.png`), refractedPng),
    writeFile(join(evidence, `${prefix}-background0.png`), background0Png),
    writeFile(join(evidence, `${prefix}-background-source.png`), backgroundSourcePng),
    writeFile(join(evidence, `${prefix}-foreground-positive-control.png`), shiftedInkPng),
    writeFile(join(evidence, `${prefix}-repeat.png`), repeatedPng),
    writeFile(join(evidence, `${prefix}-hidden.png`), hiddenPng),
  ]);
  const [baseline, refracted, repeated, hidden, background0, backgroundSource, shiftedInk] = await Promise.all([baselinePng, refractedPng, repeatedPng, hiddenPng, background0Png, backgroundSourcePng, shiftedInkPng].map(png => decode(app, png)));
  for (const image of [refracted, repeated, hidden]) { assert.equal(image.width, baseline.width); assert.equal(image.height, baseline.height); }
  const ratioX = baseline.width / clip.width, ratioY = baseline.height / clip.height;
  assert.ok(Math.abs(ratioX - geometry.dpr) < .05, `actual screenshot scale ${ratioX} matches DPR ${geometry.dpr}`);
  const regions = Object.fromEntries(['ring', 'activeBezel', 'center', 'foreground', 'foregroundPositiveControl', 'outside', 'outsideHidden', 'repeat'].map(name => [name, { pixels: 0, changed: 0, max: 0, total: 0 }])) as CaseResult['regions'];
  const inkFailures: unknown[] = [];
  const compare = (name: string, index: number, left: Bitmap, right: Bitmap) => {
    const region = regions[name]; region.pixels++;
    const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(left.data[index + channel] - right.data[index + channel])));
    region.total += delta; region.max = Math.max(region.max, delta); if (delta > 2) region.changed++;
  };
  for (let py = 0; py < baseline.height; py++) {
    for (let px = 0; px < baseline.width; px++) {
      const x = clip.x + (px + .5) / ratioX, y = clip.y + (py + .5) / ratioY;
      const d = depth(x, y, capsule), index = (py * baseline.width + px) * 4;
      compare('repeat', index, baseline, repeated);
      if (d > .65 && d < geometry.edgeWidth - .5) compare('ring', index, baseline, refracted);
      if (activeSourceBezel(d, geometry.edgeWidth, geometry.sourceScale)) compare('activeBezel', index, baseline, refracted);
      if (d > geometry.edgeWidth + .25) compare('center', index, baseline, refracted);
      for (const ink of geometry.foreground) {
        if (!insidePixelRect(x, y, ink)) continue;
        const delta = opaqueInkError(index, ink, baseline.data, background0.data, refracted.data, backgroundSource.data);
        if (delta === undefined) continue;
        const positive = opaqueInkError(index, ink, baseline.data, background0.data, shiftedInk.data, background0.data)!;
        for (const [name, value] of [['foreground', delta], ['foregroundPositiveControl', positive]] as const) { const region = regions[name]; region.pixels++; region.max = Math.max(region.max, value); region.total += value; if (value > 2) region.changed++; }
        if (delta > 2 && inkFailures.length < 100) inkFailures.push({ x, y, depth: d, delta, ink: ink.ink, opacity: ink.opacity, before: [...baseline.data.subarray(index, index + 4)], after: [...refracted.data.subarray(index, index + 4)], background0: [...background0.data.subarray(index, index + 4)], backgroundSource: [...backgroundSource.data.subarray(index, index + 4)] });
        break;
      }
      if (d < -1) compare('outside', index, baseline, refracted);
      // Rounded clipping has an AA footprint: the first physical pixel can
      // carry a tiny premultiplied alpha at ~1.16 CSS px outside the ideal arc.
      // The exterior moat excludes only that footprint, not a rectangular
      // scrim; every pixel farther than 1.5 CSS px must match the uncovered page.
      if (d < -1.5) compare('outsideHidden', index, baseline, hidden);
    }
  }
  const result = { host, scale, ratio: ratioX, regions }; results.push(result);
  await writeFile(join(evidence, `${prefix}.json`), JSON.stringify({ ...result, geometry, clip, inkFailures }, null, 2));
  console.log(`${prefix}: ${JSON.stringify(regions)}`);
  assert.ok(regions.ring.pixels > 500, 'sample has enough configured-band pixels');
  assert.ok(regions.activeBezel.pixels > 500 && regions.activeBezel.changed / regions.activeBezel.pixels > .05, `${host}: actual SVG displacement changes the visibly active source bezel; CSS support is not evidence`);
  assert.ok(regions.center.pixels > 100, 'the source central 2px strip must be sampled, not a vacuous zero-pixel region');
  assert.ok(regions.foreground.pixels > 20, 'actual opaque ink must be identified separately from transparent button backgrounds');
  assert.ok(regions.foregroundPositiveControl.changed > 5, 'the same ink check must detect a deliberate 1px foreground displacement');
  assert.equal(regions.center.changed, 0, `${host}: central pixels must not receive displacement`);
  assert.equal(regions.foreground.changed, 0, `${host}: foreground glyphs/icons must not change`);
  assert.equal(regions.outside.changed, 0, `${host}: displacement stays inside the rounded capsule`);
  assert.equal(regions.outsideHidden.changed, 0, `${host}: no rectangle outside the capsule remains when compared to the uncovered background`);
  assert.equal(regions.repeat.changed, 0, `${host}: fixed source must be deterministic across capture frames`);
}

async function runScale(scale: number) {
  const profile = join(directory, `profile-${scale}`), port = await unusedPort();
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    AGENTVIEWER_DATA_DIR: profile, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1', AGENTVIEWER_TEST_TRANSLATOR: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Device scale preserves DIP view bounds. WebContents zoom would change the
  // native overlay's CSS viewport and test a different layout contract instead.
  const app = await electron.launch({ executablePath: require('electron'), args: [`--force-device-scale-factor=${scale}`, '.'], cwd: resolve('.'), env, timeout: 45000 });
  const page = await app.firstWindow(), errors: string[] = [];
  app.context().on('page', target => target.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  const invoke = (method: string, args: Record<string, unknown> = {}) => page.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await page.locator('.prose h1').waitFor();
    for (const [id, value] of [['appearance.theme', 'light'], ['appearance.motion', 'off'], ['appearance.glass', 'standard'], ['appearance.autoHideToolbar', false]] as const) await invoke('settings-set', { id, value });
    await page.locator('html[data-motion="off"][data-theme="light"]').waitFor();
    await page.evaluate(background => {
      const reader = document.querySelector<HTMLElement>('.reader-panel')!;
      const fixture = document.createElement('div'); fixture.id = 'glass-optics-pattern';
      Object.assign(fixture.style, { position: 'absolute', inset: '0', zIndex: '0', pointerEvents: 'none', background });
      reader.prepend(fixture);
      document.querySelector<HTMLElement>('.document-content')!.style.visibility = 'hidden';
      document.querySelector<HTMLElement>('.reader-toolbar')!.style.zIndex = '10';
    }, pattern);
    try { await verifyHost(app, page, 'local', scale); } catch (error) { failures.push(String(error)); }

    await page.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click();
    await until(async () => app.context().pages().some(target => target.url().includes('#/web-toolbar')), 'native toolbar creation');
    const toolbar = app.context().pages().find(target => target.url().includes('#/web-toolbar'))!;
    await app.evaluate(async ({ webContents }, background) => {
      const fixture = webContents.getAllWebContents().find(contents => contents.getURL().includes('/fixtures/interaction.html'))!;
      await fixture.executeJavaScript(`document.body.replaceChildren();document.documentElement.style.background='transparent';Object.assign(document.body.style,{margin:'0',height:'3000px',background:${JSON.stringify(background)},backgroundAttachment:'fixed'});window.scrollTo(0,0);`);
    }, pattern);
    await toolbar.locator(`${selector} .native-glass-backdrop`).waitFor();
    await until(async () => await toolbar.locator(`${selector} .native-glass-backdrop`).evaluate(element => getComputedStyle(element).backgroundImage !== 'none'), 'sampled fixed background');
    await toolbar.waitForTimeout(900); // Two sampling cycles replace the old fixture image.
    try { await verifyHost(app, toolbar, 'native', scale); } catch (error) { failures.push(String(error)); }
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
}

try {
  for (const scale of [1, 1.5, 2]) await runScale(scale);
  assert.deepEqual(failures, [], 'pixel optics validation failed; inspect the unmodified evidence images');
  console.log(`Real local/native refraction, configured CSS band, foreground isolation and clear exterior: PASS ${evidence}`);
} finally {
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ results, failures }, null, 2));
  console.log(`Optics evidence: ${evidence}`);
}
