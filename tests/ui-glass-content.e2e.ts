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
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-glass-content-'));
const evidence = process.env.AGENTVIEWER_QA_DIR ? resolve(process.env.AGENTVIEWER_QA_DIR, 'ui-glass-content') : join(directory, 'evidence');
await mkdir(evidence, { recursive: true });
const selector = '.navigation-toolbar > .navigation-capsule';
type Rect = { x: number; y: number; width: number; height: number };
type Bitmap = { width: number; height: number; pixels: Buffer };
const results: unknown[] = [], failures: string[] = [];
const unusedPort = () => new Promise<number>((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    server.close(error => error ? reject(error) : resolvePort(address.port));
  });
});
const frames = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const decode = async (app: ElectronApplication, png: Buffer): Promise<Bitmap> => {
  const image = await app.evaluate(({ nativeImage }, base64) => {
    const value = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    return { ...value.getSize(), pixels: value.toBitmap().toString('base64') };
  }, png.toString('base64'));
  const pixels = Buffer.from(image.pixels, 'base64');
  assert.equal(pixels.length, image.width * image.height * 4);
  return { width: image.width, height: image.height, pixels };
};
const depth = (x: number, y: number, box: Rect) => {
  const radius = Math.min(box.width, box.height) / 2;
  const qx = Math.abs(x - box.x - box.width / 2) - (box.width / 2 - radius);
  const qy = Math.abs(y - box.y - box.height / 2) - (box.height / 2 - radius);
  return -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius);
};
const html = '<!doctype html><html><body style="margin:0;padding:72px 40px;font:20px/1.7 sans-serif;background:white;min-height:2600px"><h1 style="font-size:38px">AgentViewer 实际正文阅读测试</h1><p>连续阅读内容通过独立 iframe 呈现。这段正文用于检查玻璃边缘是否真正折射文字，保留实际滚动与合成路径。</p></body></html>';

async function alignText(page: Page, format: 'markdown' | 'pdf' | 'html') {
  // Keep every real reading layer visible. No patterned reader background,
  // hidden canvas, cloned document or fake glass source is used in this test.
  if (format === 'html') {
    const offset = await page.locator('iframe.html-preview').evaluate(frame => {
      const capsule = document.querySelector('.navigation-capsule')!.getBoundingClientRect();
      return capsule.y - 4 - frame.getBoundingClientRect().y;
    });
    await page.frameLocator('iframe.html-preview').locator('h1').evaluate((heading, desiredTop) => {
      window.scrollTo(0, window.scrollY + heading.getBoundingClientRect().top - desiredTop);
    }, offset);
  } else {
    await page.locator(format === 'markdown' ? '.prose h1' : '.textLayer span').first().evaluate(heading => {
      const container = heading.closest<HTMLElement>('.document-content')!;
      const capsule = document.querySelector('.navigation-capsule')!.getBoundingClientRect();
      container.scrollTop += heading.getBoundingClientRect().top - capsule.top + 4;
    });
  }
  await frames(page);
}

async function verifyContent(app: ElectronApplication, page: Page, format: 'markdown' | 'pdf' | 'html', scale: number, progress: number) {
  const label = `${format}-${scale}-${progress === 0 ? 'shown' : 'fading'}`;
  await page.locator('.navigation-toolbar').evaluate((toolbar, amount) => {
    (toolbar as HTMLElement).style.setProperty('--navigation-hide-progress', String(amount), 'important');
  }, progress);
  await frames(page); await alignText(page, format);
  const geometry = await page.locator(selector).evaluate(element => {
    const host = document.querySelector<HTMLElement>('.document-content')!, style = getComputedStyle(element);
    const capsuleBox = element.getBoundingClientRect(), hostBox = host.getBoundingClientRect();
    const iframeBox = document.querySelector('iframe.html-preview')?.getBoundingClientRect();
    const primitive = element.querySelector<SVGElement>('[data-glass-displacement]')!, sourceScale = Number(primitive.dataset.glassBaseScale);
    const paint = document.createElement('canvas'); paint.width = paint.height = 1; const context = paint.getContext('2d')!;
    const ancestors = [];
    let node: Element | null = element;
    while (node) {
      const css = getComputedStyle(node);
      ancestors.push({ tag: node.tagName, class: node.className, opacity: css.opacity, filter: css.filter, backdrop: css.backdropFilter, mask: css.maskImage, clip: css.clipPath, willChange: css.willChange, overflow: css.overflow });
      node = node.parentElement;
    }
    return {
      capsule: { x: capsuleBox.x, y: capsuleBox.y, width: capsuleBox.width, height: capsuleBox.height }, edgeWidth: Number.parseFloat(style.getPropertyValue('--navigation-refraction-width')), sourceScale,
      host: { x: hostBox.x, y: hostBox.y, width: hostBox.width, height: hostBox.height, visibility: getComputedStyle(host).visibility, opacity: getComputedStyle(host).opacity, scrollTop: host.scrollTop, paddingTop: getComputedStyle(host).paddingTop },
      iframe: iframeBox ? { x: iframeBox.x, y: iframeBox.y, width: iframeBox.width, height: iframeBox.height } : undefined,
      viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, ancestors,
      opticalOpacity: [...element.querySelectorAll('.navigation-glass-center,.navigation-glass-edge,.navigation-glass-tint')].map(layer => getComputedStyle(layer).opacity),
      foreground: [...element.querySelectorAll<HTMLElement>('button:not(:disabled),button:not(:disabled) svg,input,.capsule-document-title')].map(node => {
        const b = node.getBoundingClientRect(); context.clearRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(node).color; context.fillRect(0, 0, 1, 1);
        let opacity = 1, ancestor: Element | null = node; while (ancestor) { opacity *= Number(getComputedStyle(ancestor).opacity); if (ancestor === element) break; ancestor = ancestor.parentElement; }
        return { x: b.x, y: b.y, width: b.width, height: b.height, ink: [...context.getImageData(0, 0, 1, 1).data], opacity };
      }),
    };
  });
  const box = geometry.capsule;
  assert.equal(geometry.edgeWidth, NAVIGATION_METRICS.bezelWidth); assert.equal(box.height, NAVIGATION_METRICS.height);
  assert.ok(Math.abs(geometry.sourceScale - SOURCE_NAVIGATION_SCALE) < .0001);
  const gutter = NAVIGATION_METRICS.shadowGutter;
  const clip = { x: Math.max(0, box.x - gutter), y: Math.max(0, box.y - gutter), width: Math.min(geometry.viewport.width, box.x + box.width + gutter) - Math.max(0, box.x - gutter), height: Math.min(geometry.viewport.height, box.y + box.height + gutter) - Math.max(0, box.y - gutter) };
  const setScale = async (value: number) => { await page.locator(`${selector} [data-glass-displacement]`).evaluate((primitive, amount) => primitive.setAttribute('scale', String(amount)), value); await frames(page); };
  const pngs: Buffer[] = [];
  for (const amount of [0, geometry.sourceScale, 0]) {
    await setScale(amount);
    pngs.push(await page.screenshot({ clip, omitBackground: true, scale: 'device' }));
  }
  await page.locator(selector).evaluate(element => element.classList.add('qa-no-foreground')); await frames(page);
  const background0Png = await page.screenshot({ clip, omitBackground: true, scale: 'device' });
  await setScale(geometry.sourceScale); const backgroundSourcePng = await page.screenshot({ clip, omitBackground: true, scale: 'device' });
  await page.locator(selector).evaluate(element => { element.classList.remove('qa-no-foreground'); element.classList.add('qa-shift-foreground'); }); await setScale(0);
  const shiftedInkPng = await page.screenshot({ clip, omitBackground: true, scale: 'device' });
  await page.locator(selector).evaluate(element => { element.classList.remove('qa-shift-foreground'); (element as HTMLElement).style.visibility = 'hidden'; }); await frames(page);
  const hiddenPng = await page.screenshot({ clip, omitBackground: true, scale: 'device' });
  await page.locator(selector).evaluate(element => { (element as HTMLElement).style.visibility = ''; }); await setScale(geometry.sourceScale);
  await Promise.all([
    writeFile(join(evidence, `${label}-scale0.png`), pngs[0]),
    writeFile(join(evidence, `${label}-source-scale.png`), pngs[1]),
    writeFile(join(evidence, `${label}-repeat.png`), pngs[2]),
    writeFile(join(evidence, `${label}-background0.png`), background0Png),
    writeFile(join(evidence, `${label}-background-source.png`), backgroundSourcePng),
    writeFile(join(evidence, `${label}-foreground-positive-control.png`), shiftedInkPng),
    writeFile(join(evidence, `${label}-hidden.png`), hiddenPng),
    writeFile(join(evidence, `${label}-reading.png`), await page.screenshot({ scale: 'css' })),
  ]);
  const [before, after, repeated, background0, backgroundSource, shiftedInk, hidden] = await Promise.all([...pngs, background0Png, backgroundSourcePng, shiftedInkPng, hiddenPng].map(png => decode(app, png)));
  assert.equal(before.width, after.width); assert.equal(before.height, after.height);
  const ratioX = before.width / clip.width, ratioY = before.height / clip.height;
  const regions = Object.fromEntries(['ring', 'activeBezel', 'center', 'foreground', 'foregroundPositiveControl', 'outside', 'outsideHidden', 'repeat'].map(name => [name, { pixels: 0, changed: 0, max: 0 }])) as Record<string, { pixels: number; changed: number; max: number }>;
  const differences: { region: string; x: number; y: number; depth: number; delta: number; ink?: number[]; opacity?: number }[] = [];
  const compare = (name: string, index: number, a: Bitmap, b: Bitmap) => {
    const region = regions[name]; region.pixels++;
    const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(a.pixels[index + channel] - b.pixels[index + channel])));
    region.max = Math.max(region.max, delta); if (delta > 2) region.changed++;
    return delta;
  };
  for (let py = 0; py < before.height; py++) for (let px = 0; px < before.width; px++) {
    const x = clip.x + (px + .5) / ratioX, y = clip.y + (py + .5) / ratioY, d = depth(x, y, box), index = (py * before.width + px) * 4;
    compare('repeat', index, before, repeated);
    if (d > .65 && d < geometry.edgeWidth - .5) compare('ring', index, before, after);
    if (activeSourceBezel(d, geometry.edgeWidth, geometry.sourceScale)) compare('activeBezel', index, before, after);
    if (d > geometry.edgeWidth + .25) {
      const delta = compare('center', index, before, after);
      if (delta > 2 && differences.length < 100) differences.push({ region: 'center', x, y, depth: d, delta });
    }
    for (const ink of geometry.foreground) {
      if (!insidePixelRect(x, y, ink)) continue;
      const delta = opaqueInkError(index, ink, before.pixels, background0.pixels, after.pixels, backgroundSource.pixels);
      if (delta === undefined) continue;
      const positive = opaqueInkError(index, ink, before.pixels, background0.pixels, shiftedInk.pixels, background0.pixels)!;
      for (const [name, value] of [['foreground', delta], ['foregroundPositiveControl', positive]] as const) { const region = regions[name]; region.pixels++; region.max = Math.max(region.max, value); if (value > 2) region.changed++; }
      if (delta > 2 && differences.length < 100) differences.push({ region: 'foreground', x, y, depth: d, delta, ink: ink.ink, opacity: ink.opacity });
      break;
    }
    if (d < -1) compare('outside', index, before, after);
    if (d < -1.5) compare('outsideHidden', index, before, hidden);
  }
  const result = { label, format, scale, progress, geometry, clip, regions, differences }; results.push(result);
  await writeFile(join(evidence, `${label}.json`), JSON.stringify(result, null, 2));
  console.log(`${label}: ${JSON.stringify(regions)}`);
  assert.equal(geometry.host.visibility, 'visible', 'the real document remains visible');
  assert.equal(geometry.host.opacity, '1', 'document content does not fade with navigation');
  for (const ancestor of geometry.ancestors) assert.equal(ancestor.opacity, '1', `${ancestor.tag}.${ancestor.class} must not block the sibling document behind a backdrop root`);
  if (progress > 0) {
    for (const opacity of geometry.opticalOpacity) assert.ok(Math.abs(Number(opacity) - (1 - progress)) < .02, 'individual optical layers, not their ancestor, fade');
  }
  if (geometry.iframe) {
    const overlap = Math.min(geometry.iframe.y + geometry.iframe.height, box.y + box.height) - Math.max(geometry.iframe.y, box.y);
    assert.ok(overlap >= box.height - 1, 'HTML iframe viewport covers the whole navigation capsule');
    assert.equal(geometry.host.paddingTop, '0px', 'HTML clearance belongs in its scrolling document, not outside the iframe');
  }
  assert.ok(regions.activeBezel.pixels > 500 && regions.activeBezel.changed / regions.activeBezel.pixels > .05, 'real body text must visibly displace in the active source squircle bezel');
  assert.ok(regions.center.pixels > 100, 'the source central 2px strip is nonempty');
  assert.ok(regions.foreground.pixels > 20, 'opaque actual navigation ink is identified');
  assert.ok(regions.foregroundPositiveControl.changed > 5, 'the ink check detects a deliberate 1px control displacement');
  assert.equal(regions.center.changed, 0, 'body text in the true center remains unchanged');
  assert.equal(regions.foreground.changed, 0, 'actual navigation glyph/icon bounds remain unchanged');
  assert.equal(regions.outside.changed, 0, 'refraction cannot affect text outside the capsule');
  assert.equal(regions.outsideHidden.changed, 0, 'the exterior matches the actual uncovered document');
  assert.equal(regions.repeat.changed, 0, 'fixed document position has deterministic baseline pixels');
}

async function runScale(scale: number) {
  const port = await unusedPort();
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: join(directory, `profile-${scale}`), AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [`--force-device-scale-factor=${scale}`, '.'], cwd: resolve('.'), env, timeout: 45000 });
  const page = await app.firstWindow(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const invoke = (method: string, args: Record<string, unknown> = {}) => page.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await page.locator('.prose h1').waitFor();
    for (const [id, value] of [['appearance.theme', 'light'], ['appearance.motion', 'off'], ['appearance.autoHideToolbar', false]] as const) await invoke('settings-set', { id, value });
    await page.addStyleTag({ content: '*{animation:none!important;transition:none!important;caret-color:transparent!important} .navigation-capsule{box-shadow:none!important} .qa-no-foreground :is(.navigation-module,.capsule-divider){visibility:hidden!important} .qa-shift-foreground .navigation-module{translate:1px 0!important}' });
    const verify = async (format: 'markdown' | 'pdf' | 'html') => {
      await page.locator(`${selector} feDisplacementMap`).waitFor({ state: 'attached' }); await page.waitForTimeout(250);
      for (const progress of [0, .35]) {
        try { await verifyContent(app, page, format, scale, progress); } catch (error) { failures.push(`${format}/${scale}/${progress}: ${String(error)}`); }
      }
      await page.locator('.navigation-toolbar').evaluate(toolbar => { (toolbar as HTMLElement).style.removeProperty('--navigation-hide-progress'); });
    };
    await verify('markdown');
    await page.locator('.tab').filter({ hasText: '示例.pdf' }).locator('.tab-select').click();
    await page.locator('.textLayer span').first().waitFor(); await page.waitForTimeout(250); await verify('pdf');
    await invoke('create-text', { format: 'html', title: '玻璃真实HTML正文.html', text: html });
    await page.locator('iframe.html-preview').waitFor(); await page.frameLocator('iframe.html-preview').locator('h1').waitFor(); await verify('html');
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
}

try {
  for (const scale of [1, 1.5, 2]) await runScale(scale);
  assert.deepEqual(failures, [], 'actual body-content optics validation failed; inspect the real-document images');
  console.log(`Real scrolling Markdown/PDF/HTML content and partial navigation fade: PASS ${evidence}`);
} finally {
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ results, failures }, null, 2));
  console.log(`Body-content optics evidence: ${evidence}`);
}
