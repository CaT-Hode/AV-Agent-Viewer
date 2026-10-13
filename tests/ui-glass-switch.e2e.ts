import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { SettingDefinition, SettingsSnapshot } from '../packages/settings/src/index';
import { verifyRangeReferenceOptics } from './range-optics.e2e-helper';

// Actual settings DOM and pixels, never a standalone imitation of the switch.
// Run serially after the coordinated build freeze. AGENTVIEWER_QA_SCALE=1/1.5/2.
type Rect = { x: number; y: number; width: number; height: number };
type Geometry = { track: Rect; thumb: Rect; surface: Rect; tint: Rect; center: Rect; edge?: Rect; zoom: number; dpr: number; fill: number; scale: string; willChange: string };
type Bitmap = { width: number; height: number; data: Buffer };
const expected = { trackWidth: 68, trackHeight: 28.475, thumbWidth: 40.3325, thumbHeight: 25.415, margin: 1.53, travel: 24.6075 };
const deviceScale = Number(process.env.AGENTVIEWER_QA_SCALE ?? '1');
assert.ok([1, 1.5, 2].includes(deviceScale), 'AGENTVIEWER_QA_SCALE must be 1, 1.5 or 2');
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-glass-switch-'));
const evidence = join(directory, 'evidence'); await mkdir(evidence);
await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, revision: 0, values: { 'appearance.theme': 'light', 'appearance.motion': 'off', 'appearance.glass': 'standard', 'appearance.autoHideToolbar': false, 'appearance.reduceTransparency': false, 'appearance.highContrast': false } }));
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: ['--force-device-scale-factor=' + deviceScale, '.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], results: Record<string, unknown> = {};
main.on('pageerror', error => errors.push(error.message)); app.context().on('page', page => page.on('pageerror', error => errors.push(error.message)));
const invoke = <T>(page: Page, method: string, args: Record<string, unknown> = {}) => page.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const settingsState = async (page: Page) => (await invoke<{ snapshot: SettingsSnapshot }>(page, 'settings-read')).snapshot;
const until = async (check: () => Promise<boolean>, label: string) => { for (let i = 0; i < 180; i++) { if (await check()) return; await new Promise(done => setTimeout(done, 50)); } throw new Error('等待失败：' + label); };
const frames = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const closeEnough = (actual: number, target: number, message: string, tolerance = .35) => assert.ok(Math.abs(actual - target) <= tolerance, `${message}: ${actual} vs ${target}`);
const centerX = (rect: Rect) => rect.x + rect.width / 2, centerY = (rect: Rect) => rect.y + rect.height / 2;
async function geometry(control: Locator, selector = '.glass-switch-thumb'): Promise<Geometry> {
  return control.evaluate((track, selector) => {
    const thumb = track.querySelector<HTMLElement>(selector)!, surface = thumb.querySelector<HTMLElement>(':scope > .liquid-glass-surface')!, tint = surface.querySelector<HTMLElement>('.liquid-glass-tint')!, center = surface.querySelector<HTMLElement>('.liquid-glass-center')!, edge = surface.querySelector<HTMLElement>('.liquid-glass-edge');
    const rects = [track, thumb, surface, tint, center, edge].map(node => { if (!node) return undefined; const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; });
    const style = getComputedStyle(thumb);
    return { track: rects[0]!, thumb: rects[1]!, surface: rects[2]!, tint: rects[3]!, center: rects[4]!, edge: rects[5], zoom: Number(getComputedStyle(track).zoom), dpr: devicePixelRatio, fill: Number.parseFloat(style.getPropertyValue('--glass-material-fill')), scale: style.scale, willChange: thumb.style.willChange };
  }, selector);
}
function fullThumbLayers(value: Geometry, sampleVisible = true) {
  for (const [name, layer] of [['surface', value.surface], ['tint', value.tint]] as const) {
    closeEnough(layer.width, value.thumb.width, name + ' covers entire thumb width'); closeEnough(layer.height, value.thumb.height, name + ' covers entire thumb height');
    closeEnough(centerX(layer), centerX(value.thumb), name + ' is horizontally aligned'); closeEnough(centerY(layer), centerY(value.thumb), name + ' is vertically aligned');
  }
  if (sampleVisible) {
    assert.ok(value.center.width >= value.thumb.width - .35 && value.center.height >= value.thumb.height - .35, 'center sampling layer covers the thumb instead of a legacy 16px dot');
    closeEnough(centerX(value.center), centerX(value.thumb), 'center sample remains centered'); closeEnough(centerY(value.center), centerY(value.thumb), 'center sample remains centered vertically');
  }
}
function settledGeometry(value: Geometry, on: boolean, sampleVisible = true) {
  closeEnough(value.track.width, expected.trackWidth, 'compact native track width'); closeEnough(value.track.height, expected.trackHeight, 'compact native track height'); assert.equal(value.zoom, 1, 'switch has no CSS zoom');
  closeEnough(value.dpr, deviceScale, 'actual renderer uses the requested device scale', .01);
  closeEnough(value.thumb.width, expected.thumbWidth, 'visible resting pill width'); closeEnough(value.thumb.height, expected.thumbHeight, 'visible resting pill height');
  closeEnough(value.thumb.x - value.track.x, expected.margin + (on ? expected.travel : 0), 'checked state horizontal position');
  closeEnough(centerY(value.thumb), centerY(value.track), 'thumb/track vertical centers');
  assert.ok(value.thumb.x >= value.track.x - .35 && value.thumb.y >= value.track.y - .35 && value.thumb.x + value.thumb.width <= value.track.x + value.track.width + .35 && value.thumb.y + value.thumb.height <= value.track.y + value.track.height + .35, 'settled on/off pill stays inside track');
  fullThumbLayers(value, sampleVisible);
}
async function bitmap(app: ElectronApplication, dataUrl: string): Promise<Bitmap> {
  const result = await app.evaluate(({ nativeImage }, url) => { const image = nativeImage.createFromDataURL(url); return { ...image.getSize(), data: image.toBitmap().toString('base64') }; }, dataUrl);
  const data = Buffer.from(result.data, 'base64'); assert.equal(data.length, result.width * result.height * 4); return { ...result, data };
}
async function opticalAssets(control: Locator, selector = '.glass-switch-thumb', profile = 'lip') {
  const surface = control.locator(selector + ' > .liquid-glass-surface');
  assert.equal(await surface.getAttribute('data-glass-effect'), 'refractive'); assert.equal(await surface.getAttribute('data-glass-profile'), profile);
  await surface.locator('feDisplacementMap[data-glass-displacement]').waitFor({ state: 'attached' });
  assert.ok(Number(await surface.locator('feDisplacementMap[data-glass-displacement]').getAttribute('scale')) > 0, 'displacement field is active');
  const variant = await surface.getAttribute('data-glass-variant');
  assert.equal(variant, profile === 'lip' ? 'switch' : 'slider');
  const reference = await surface.evaluate(node => ({ blur: Number.parseFloat(getComputedStyle(node).getPropertyValue('--liquid-glass-blur')), bezel: Number.parseFloat(getComputedStyle(node).getPropertyValue('--liquid-glass-bezel-width')) }));
  closeEnough(reference.blur, 0, 'clear refractive controls have no Gaussian blur', .001); closeEnough(reference.bezel, profile === 'lip' ? 8.075 : selector === '.glass-range-thumb' ? 16 : 9.6, 'reference bezel follows each control optical geometry', .001);
  assert.ok((await surface.locator('feGaussianBlur').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('stdDeviation'))))).every(value => value === 0), 'every optical Gaussian stage is an identity operation');
  const segmented = selector === '.glass-segmented-thumb';
  assert.equal(await surface.locator('feColorMatrix').getAttribute('values'), profile === 'lip' ? '6' : segmented ? '1' : '7');
  assert.equal(await surface.locator('feFuncA').getAttribute('slope'), profile === 'lip' ? '0.5' : segmented ? '0' : '0.4');
  const filters = await surface.locator('.liquid-glass-center,.liquid-glass-edge').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backdropFilter));
  assert.ok(filters.every(filter => filter.includes('url(')), 'actual center/rim use their SVG filters');
  const fields = await surface.locator('feImage').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('href') ?? ''))]);
  assert.ok(fields.length >= 2); let varied = false;
  for (const field of fields) {
    assert.match(field, /^data:image\/png;base64,/); const image = await bitmap(app, field); assert.ok(image.width > 16 && image.height > 16, 'decoded optical field has real compact geometry');
    let minimum = 255, maximum = 0, alpha = 0;
    for (let i = 0; i < image.data.length; i += 4) { minimum = Math.min(minimum, image.data[i + 2]); maximum = Math.max(maximum, image.data[i + 2]); alpha += image.data[i + 3]; }
    assert.ok(alpha > 0, 'optical field is not an empty PNG'); if (maximum - minimum > 8) varied = true;
  }
  assert.ok(varied, 'decoded optical PNGs contain a varying field, not placeholder bytes');
}
async function segmentedGeometry(group: Locator) {
  // Value/width changes reach React before the optical ResizeObserver+rAF.
  // Wait for real geometry to agree; never accept a stale clipped field.
  await until(async () => { const value = await geometry(group, '.glass-segmented-thumb'); return Math.abs(value.surface.width - value.thumb.width) < .35 && Math.abs(value.surface.height - value.thumb.height) < .35; }, 'segmented optical surface catches up with selected geometry');
  const value = await geometry(group, '.glass-segmented-thumb'); fullThumbLayers(value);
  const selected = group.locator('[role=radio][aria-checked=true]'); assert.equal(await selected.count(), 1);
  const box = await selected.boundingBox(); assert.ok(box);
  const borders = await group.evaluate(node => ({ top: Number.parseFloat(getComputedStyle(node).borderTopWidth), bottom: Number.parseFloat(getComputedStyle(node).borderBottomWidth) }));
  results.lastSegmentedGeometry = { label: await group.getAttribute('aria-label'), value, box, borders };
  assert.ok(value.track.height >= 32 && value.track.height <= 40, 'multi-option control retains its compact hit area');
  closeEnough(value.thumb.height, box.height, 'multi-option pill fills the selected button height', .2); closeEnough(value.track.height - value.thumb.height, 6 + borders.top + borders.bottom, 'multi-option inset uses actual physical-pixel borders', .2);
  // The component measures offsetWidth/offsetLeft (integer CSS pixels). Their
  // legal rounding can contribute .5px width and .75px center-X difference.
  closeEnough(value.thumb.width, box.width, 'multi-option material follows selected width', .5); closeEnough(centerX(value.thumb), centerX(box), 'multi-option pill follows selected X', .8); closeEnough(centerY(value.thumb), centerY(box), 'multi-option pill follows selected Y', .2);
  await opticalAssets(group, '.glass-segmented-thumb', 'convex'); return value;
}
async function rangeGeometry(control: Locator) {
  const track = control.locator('.glass-range'), value = await geometry(track, '.glass-range-thumb'); fullThumbLayers(value);
  const input = await track.locator('input[type=range]').evaluate(node => { const input = node as HTMLInputElement; return { value: Number(input.value), min: Number(input.min), max: Number(input.max) }; });
  const progress = (input.value - input.min) / (input.max - input.min);
  closeEnough(value.track.height, 40, 'range input hit area height'); closeEnough(value.thumb.width, 54, 'source resting range pill width'); closeEnough(value.thumb.height, 36, 'source resting range pill height');
  closeEnough(centerY(value.thumb), centerY(value.track), 'range track and thumb centers'); closeEnough(centerX(value.thumb), value.track.x + (value.track.width - 54) * progress + 27, 'range visual center matches native input value');
  await opticalAssets(track, '.glass-range-thumb', 'convex'); return value;
}
async function paintedPill(page: Page, value: Geometry, on: boolean, label: string) {
  const clip = { x: Math.max(0, value.track.x - 12), y: Math.max(0, value.track.y - 12), width: value.track.width + 24, height: value.track.height + 24 };
  const png = await page.screenshot({ clip, scale: 'device' }); await writeFile(join(evidence, label + '.png'), png);
  const image = await bitmap(app, 'data:image/png;base64,' + png.toString('base64')), ratioX = image.width / clip.width, ratioY = image.height / clip.height;
  closeEnough(ratioX, value.dpr, 'actual screenshot density', .04); closeEnough(ratioY, value.dpr, 'actual screenshot density Y', .04);
  const color = (x: number, y: number) => {
    const channels: number[][] = [[], [], []], px = Math.round((x - clip.x) * ratioX), py = Math.round((y - clip.y) * ratioY);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const index = (Math.max(0, Math.min(image.height - 1, py + dy)) * image.width + Math.max(0, Math.min(image.width - 1, px + dx))) * 4; channels[0].push(image.data[index + 2]); channels[1].push(image.data[index + 1]); channels[2].push(image.data[index]); }
    return channels.map(channel => channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)]);
  };
  const exposed = color(on ? value.track.x + 5 : value.track.x + value.track.width - 5, centerY(value.track));
  if (on) assert.ok(exposed[1] > exposed[0] + 35 && exposed[1] > exposed[2] + 35, 'checked track is actually green in rendered pixels');
  else assert.ok(Math.abs(exposed[1] - exposed[0]) < 28, 'unchecked track is neutral, not the checked green');
  const locations = [[centerX(value.thumb), centerY(value.thumb)], [value.thumb.x + 5, centerY(value.thumb)], [value.thumb.x + value.thumb.width - 5, centerY(value.thumb)], [centerX(value.thumb), value.thumb.y + 5], [centerX(value.thumb), value.thumb.y + value.thumb.height - 5]];
  const pillPixels = locations.map(([x, y]) => color(x, y));
  assert.ok(pillPixels.every(channels => Math.min(...channels) >= 185), 'white resting material paints the full pill, including both ends and vertical interior');
  assert.ok(pillPixels.every(channels => Math.min(...channels) > Math.min(...exposed) + 18), 'painted knob is distinct from exposed track across its full interior');
  return { exposed, pillPixels, density: ratioX };
}
async function paintedDarkSegment(page: Page, group: Locator, value: Geometry, label: string) {
  const selected = group.locator('[role=radio][aria-checked=true]');
  const textColor = await selected.evaluate(node => getComputedStyle(node).color), text = textColor.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  assert.ok(text.every(channel => channel >= 245), 'dark selected segment uses white text');
  const png = await page.screenshot({ clip: value.track, scale: 'device' }); await writeFile(join(evidence, label + '.png'), png);
  const image = await bitmap(app, 'data:image/png;base64,' + png.toString('base64')), ratioX = image.width / value.track.width, ratioY = image.height / value.track.height;
  closeEnough(ratioX, deviceScale, 'dark segment screenshot actual density', .04);
  const color = (x: number, y: number) => {
    const channels: number[][] = [[], [], []], px = Math.round((x - value.track.x) * ratioX), py = Math.round((y - value.track.y) * ratioY);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const index = (Math.max(0, Math.min(image.height - 1, py + dy)) * image.width + Math.max(0, Math.min(image.width - 1, px + dx))) * 4; channels[0].push(image.data[index + 2]); channels[1].push(image.data[index + 1]); channels[2].push(image.data[index]); }
    return channels.map(channel => channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)]);
  };
  // Padding next to the label provides actual painted background, avoiding
  // glyph antialiasing; a 3x3 median rejects the narrow specular rim.
  const background = color(value.thumb.x + 6, centerY(value.thumb));
  assert.ok(background[1] > background[0] + 35 && background[1] > background[2] + 25, 'dark selected segment is green in screen pixels');
  const luminance = (rgb: number[]) => rgb.map(channel => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const contrast = (luminance(text) + .05) / (luminance(background) + .05);
  assert.ok(contrast >= 4.5, 'white selected text versus actually painted green meets 4.5:1 contrast: ' + contrast);
  let whiteGlyphPixels = 0;
  for (let y = Math.ceil((value.thumb.y - value.track.y + 6) * ratioY); y < Math.floor((value.thumb.y - value.track.y + value.thumb.height - 6) * ratioY); y++) for (let x = Math.ceil((value.thumb.x - value.track.x + 12) * ratioX); x < Math.floor((value.thumb.x - value.track.x + value.thumb.width - 12) * ratioX); x++) {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
    const index = (y * image.width + x) * 4; if (Math.min(image.data[index], image.data[index + 1], image.data[index + 2]) >= 230) whiteGlyphPixels++;
  }
  assert.ok(whiteGlyphPixels >= 4, 'white label is present in the real screenshot, not only a computed CSS value');
  return { label: await group.getAttribute('aria-label'), textColor, background, contrast, whiteGlyphPixels, density: ratioX };
}
async function textRefractionComparison(page: Page, group: Locator, target: Locator, label: string) {
  const clip = (await geometry(group, '.glass-segmented-thumb')).track;
  const textBounds = await target.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
  const layers = group.locator('.glass-segmented-thumb .liquid-glass-center,.glass-segmented-thumb .liquid-glass-edge');
  // Neutralize saturation/specular lighting equally in both captures. This
  // isolates displacement of glyph strokes from color or rim highlights;
  // under-fill, font, opacity, text and position remain identical.
  const lighting = group.locator('.glass-segmented-thumb feColorMatrix,.glass-segmented-thumb feFuncA');
  const lightingSaved = await lighting.evaluateAll(nodes => nodes.map(node => { const attribute = node.tagName === 'feColorMatrix' ? 'values' : 'slope', previous = node.getAttribute(attribute); node.setAttribute(attribute, attribute === 'values' ? '1' : '0'); return { attribute, previous }; }));
  await frames(page);
  const baseline = await page.screenshot({ clip, scale: 'device' });
  const saved = await layers.evaluateAll(nodes => nodes.map(node => { const element = node as HTMLElement, previous = { value: element.style.getPropertyValue('backdrop-filter'), priority: element.style.getPropertyPriority('backdrop-filter') }; element.style.setProperty('backdrop-filter', 'none', 'important'); return previous; }));
  let plain: Buffer;
  try { await frames(page); plain = await page.screenshot({ clip, scale: 'device' }); }
  finally { await layers.evaluateAll((nodes, saved) => nodes.forEach((node, index) => { const element = node as HTMLElement; if (saved[index].value) element.style.setProperty('backdrop-filter', saved[index].value, saved[index].priority); else element.style.removeProperty('backdrop-filter'); }), saved); }
  await frames(page); const restored = await page.screenshot({ clip, scale: 'device' });
  await lighting.evaluateAll((nodes, saved) => nodes.forEach((node, index) => { if (saved[index].previous !== null) node.setAttribute(saved[index].attribute, saved[index].previous!); else node.removeAttribute(saved[index].attribute); }), lightingSaved); await frames(page);
  await writeFile(join(evidence, label + '-full-effect.png'), await page.screenshot({ clip, scale: 'device' }));
  await writeFile(join(evidence, label + '-refractive.png'), restored); await writeFile(join(evidence, label + '-filters-disabled.png'), plain!);
  const originalImage = await bitmap(app, 'data:image/png;base64,' + baseline.toString('base64')), plainImage = await bitmap(app, 'data:image/png;base64,' + plain!.toString('base64')), actualImage = await bitmap(app, 'data:image/png;base64,' + restored.toString('base64'));
  assert.equal(plainImage.width, actualImage.width); assert.equal(plainImage.height, actualImage.height);
  const ratioX = actualImage.width / clip.width, ratioY = actualImage.height / clip.height;
  let glyphPixels = 0, changedGlyphPixels = 0, displacedGlyphPixels = 0, changedPixels = 0, unstablePixels = 0;
  for (let y = Math.max(0, Math.floor((textBounds.y - clip.y - 2) * ratioY)); y < Math.min(actualImage.height, Math.ceil((textBounds.y + textBounds.height - clip.y + 2) * ratioY)); y++) for (let x = Math.max(0, Math.floor((textBounds.x - clip.x - 2) * ratioX)); x < Math.min(actualImage.width, Math.ceil((textBounds.x + textBounds.width - clip.x + 2) * ratioX)); x++) {
    const index = (y * actualImage.width + x) * 4, plainChannels = [plainImage.data[index + 2], plainImage.data[index + 1], plainImage.data[index]], actualChannels = [actualImage.data[index + 2], actualImage.data[index + 1], actualImage.data[index]];
    const difference = Math.max(...plainChannels.map((channel, channelIndex) => Math.abs(channel - actualChannels[channelIndex]))), originalDifference = Math.max(...actualChannels.map((channel, channelIndex) => Math.abs(channel - originalImage.data[index + 2 - channelIndex])));
    if (difference >= 15) changedPixels++; if (originalDifference >= 15) unstablePixels++;
    if (Math.min(...plainChannels) >= 80 && Math.max(...plainChannels) - Math.min(...plainChannels) < 45) {
      glyphPixels++; if (difference >= 15) changedGlyphPixels++;
      if (plainChannels.reduce((sum, channel) => sum + channel, 0) / 3 - actualChannels.reduce((sum, channel) => sum + channel, 0) / 3 >= 30) displacedGlyphPixels++;
    }
  }
  const comparison = { textBounds, glyphPixels, changedGlyphPixels, displacedGlyphPixels, changedPixels, unstablePixels, comparison: 'actual glyph displacement; saturation/specular neutralized equally; restored afterward' }; results.textRefraction = comparison;
  assert.ok(glyphPixels >= 8, 'control comparison contains actual caption pixels');
  assert.ok(changedGlyphPixels >= 4 && changedGlyphPixels / glyphPixels >= .05, 'restored refraction changes the real caption instead of only background paint');
  assert.ok(displacedGlyphPixels >= 2, 'refraction moves actual glyph strokes away from their unfiltered positions');
  assert.ok(unstablePixels <= Math.max(4, changedPixels * .1), 'restored image reproduces the original optical result; difference is not an unfinished animation');
  assert.ok(await layers.evaluateAll(nodes => nodes.every(node => getComputedStyle(node).backdropFilter.includes('url('))), 'temporary comparison restores all actual filters'); return comparison;
}

try {
  await main.locator('.prose h1').waitFor();
  // Profiles only seed real routing controls in this isolated profile. No
  // connection discovery, provider test or model request is performed.
  const seeded = await invoke<{ profiles: { id: string; name: string }[] }>(main, 'connections-upsert', { name: '控件几何验收连接', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${port}`, modelId: 'layout-only-no-request', enabled: true });
  const profileId = seeded.profiles.find(profile => profile.name === '控件几何验收连接')!.id;
  await invoke(main, 'settings-open', { category: '外观与布局' });
  await until(async () => app.context().pages().some(page => page.url().includes('#/settings')), 'settings window');
  const settings = app.context().pages().find(page => page.url().includes('#/settings'))!;
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/settings'))!; window.setContentSize(1120, 800); });
  await settings.getByRole('button', { name: '外观与布局', exact: true }).click();
  assert.equal(await settings.locator('.glass-preview-lens').count(), 0, 'closed preview is lazy and does not mount a hidden optical lens');
  const control = settings.getByRole('switch', { name: '导航栏自动隐藏', exact: true }), thumb = control.locator('.glass-switch-thumb');
  await control.scrollIntoViewIfNeeded();
  const settled = async () => { await until(async () => { const value = await geometry(control), on = await control.getAttribute('aria-checked') === 'true'; return value.willChange === '' && Math.abs(value.thumb.width - expected.thumbWidth) < .35 && Math.abs(value.thumb.x - value.track.x - expected.margin - (on ? expected.travel : 0)) < .35; }, 'switch returns to its full resting pill and finishes its independent position spring'); return geometry(control); };
  const themeCases: Record<string, unknown> = {};
  for (const theme of ['light', 'dark']) {
    await invoke(settings, 'settings-set', { id: 'appearance.theme', value: theme }); await settings.locator(`html[data-theme="${theme}"]`).waitFor();
    await invoke(settings, 'settings-set', { id: 'appearance.autoHideToolbar', value: false }); await until(async () => await control.getAttribute('aria-checked') === 'false', 'unchecked state');
    await opticalAssets(control); const off = await settled(); settledGeometry(off, false);
    const offPixels = await paintedPill(settings, off, false, theme + '-off');
    const before = await settingsState(settings); await control.click(); await until(async () => await control.getAttribute('aria-checked') === 'true', 'real click checks switch');
    assert.equal((await settingsState(settings)).revision, before.revision + 1, 'one click is one setting transaction');
    const on = await settled(); settledGeometry(on, true); closeEnough(centerX(on.thumb) - centerX(off.thumb), expected.travel, 'actual on/off center travel');
    const onPixels = await paintedPill(settings, on, true, theme + '-on'); themeCases[theme] = { off, on, offPixels, onPixels };
  }
  results.themes = themeCases;
  await invoke(settings, 'settings-set', { id: 'appearance.motion', value: 'standard' }); await settings.locator('html[data-motion="standard"]').waitFor();
  const beforePress = await settled(), beforePressScroll = await settings.locator('.settings-main').evaluate(node => node.scrollTop), revision = (await settingsState(settings)).revision;
  const start = { x: centerX(beforePress.thumb), y: centerY(beforePress.thumb) };
  await settings.mouse.move(start.x, start.y); await settings.mouse.down();
  await until(async () => { const value = await geometry(control); return value.thumb.width > expected.thumbWidth * 1.25 && value.fill > .02 && value.fill < .2; }, 'press grows thumb and reveals glass');
  const pressed = await geometry(control), pressedScroll = await settings.locator('.settings-main').evaluate(node => node.scrollTop); results.pressGeometry = { beforePress, pressed, beforePressScroll, pressedScroll }; fullThumbLayers(pressed);
  closeEnough(centerX(pressed.thumb) - pressed.track.x, centerX(beforePress.thumb) - beforePress.track.x, 'press keeps center X relative to its track'); closeEnough(centerY(pressed.thumb), centerY(pressed.track), 'press keeps center Y relative to its track', .2);
  assert.ok(pressed.thumb.height > pressed.track.height, 'author press growth may extend beyond track intentionally');
  await opticalAssets(control); await settings.screenshot({ path: join(evidence, 'pressed-glass.png'), scale: 'device' });
  await settings.mouse.move(start.x - 6, start.y, { steps: 3 }); await frames(settings);
  const following = await geometry(control); fullThumbLayers(following); closeEnough(centerX(following.thumb) - following.track.x - centerX(beforePress.thumb) + beforePress.track.x, -6, 'real center follows pointer without double scaling', .6); closeEnough(centerY(following.thumb), centerY(following.track), 'drag stays vertically aligned', .2);
  await settings.mouse.move(beforePress.track.x + expected.margin + expected.thumbWidth / 2, start.y, { steps: 5 }); await settings.mouse.up();
  await until(async () => await control.getAttribute('aria-checked') === 'false', 'drag commits unchecked state');
  assert.equal((await settingsState(settings)).revision, revision + 1, 'one continuous drag commits one transaction'); settledGeometry(await settled(), false);
  await settings.getByRole('button', { name: '撤销上一次设置更改', exact: true }).click(); await until(async () => await control.getAttribute('aria-checked') === 'true', 'undo restores switch'); settledGeometry(await settled(), true);
  await control.focus(); const beforeKeyboard = await settingsState(settings); await control.press('Space'); await until(async () => await control.getAttribute('aria-checked') === 'false', 'native Space key toggles switch');
  assert.equal((await settingsState(settings)).revision, beforeKeyboard.revision + 1); settledGeometry(await settled(), false);
  results.interaction = { beforePress, pressed, following, dragOneTransaction: true, undo: true, keyboard: true };
  for (const mode of ['off', 'reduced']) {
    await invoke(settings, 'settings-set', { id: 'appearance.motion', value: mode }); const rest = await settled();
    await settings.mouse.move(centerX(rest.thumb), centerY(rest.thumb)); await settings.mouse.down(); await settings.waitForTimeout(100);
    const during = await geometry(control); closeEnough(during.thumb.width, rest.thumb.width, mode + ' does not grow thumb', .15); closeEnough(centerY(during.thumb), centerY(rest.thumb), mode + ' retains center'); await settings.mouse.up(); await settled();
  }
  await invoke(settings, 'settings-set', { id: 'appearance.motion', value: 'standard' }); await settings.emulateMedia({ reducedMotion: 'reduce' }); await frames(settings);
  const reduced = await settled(); await settings.mouse.move(centerX(reduced.thumb), centerY(reduced.thumb)); await settings.mouse.down(); await settings.waitForTimeout(100); closeEnough((await geometry(control)).thumb.width, reduced.thumb.width, 'system reduced motion does not grow thumb', .15); await settings.mouse.up(); await settings.emulateMedia({ reducedMotion: 'no-preference' });
  await invoke(settings, 'settings-set', { id: 'appearance.motion', value: 'off' }); await settled();
  for (const preference of [{ id: 'appearance.glass', value: 'off', reset: 'standard' }, { id: 'appearance.reduceTransparency', value: true, reset: false }, { id: 'appearance.highContrast', value: true, reset: false }] as const) {
    await invoke(settings, 'settings-set', { id: preference.id, value: preference.value });
    await until(async () => await control.locator('feDisplacementMap').count() === 0 && await control.locator('.liquid-glass-center').evaluate(node => getComputedStyle(node).display === 'none'), preference.id + ' removes optical pass');
    const fallback = await geometry(control); settledGeometry(fallback, await control.getAttribute('aria-checked') === 'true', false);
    const tint = await control.locator('.liquid-glass-tint').evaluate(node => getComputedStyle(node).backgroundColor); assert.notEqual(tint, 'rgba(0, 0, 0, 0)', 'fallback remains visible');
    const fallbackGroup = settings.getByRole('radiogroup', { name: '界面密度', exact: true }); await fallbackGroup.scrollIntoViewIfNeeded();
    assert.equal(await fallbackGroup.locator('.glass-segmented-thumb').evaluate(node => getComputedStyle(node).visibility), 'hidden', 'solid fallback never covers the foreground caption with its upper lens');
    assert.equal(await fallbackGroup.locator('feDisplacementMap').count(), 0);
    const readable = await geometry(fallbackGroup, '.glass-segmented-thumb'); await paintedDarkSegment(settings, fallbackGroup, readable, 'dark-segmented-fallback-' + preference.id);
    await control.scrollIntoViewIfNeeded();
    await invoke(settings, 'settings-set', { id: preference.id, value: preference.reset }); await opticalAssets(control);
  }
  await settings.emulateMedia({ contrast: 'more' });
  const contrastGroup = settings.getByRole('radiogroup', { name: '界面密度', exact: true }); await contrastGroup.scrollIntoViewIfNeeded();
  await until(async () => await contrastGroup.locator('.glass-segmented-thumb').evaluate(node => getComputedStyle(node).visibility === 'hidden') && await contrastGroup.locator('feDisplacementMap').count() === 0, 'system enhanced contrast removes the foreground lens');
  const contrastReadable = await paintedDarkSegment(settings, contrastGroup, await geometry(contrastGroup, '.glass-segmented-thumb'), 'dark-segmented-system-contrast');
  await settings.emulateMedia({ contrast: 'no-preference' }); await control.scrollIntoViewIfNeeded(); await opticalAssets(control);
  results.systemContrast = { readable: contrastReadable, lensHidden: true };
  results.accessibility = { motionOff: true, reducedMotion: true, systemReducedMotion: true, glassOff: true, reducedTransparency: true, highContrast: true };

  // Enumerate actual backend availability, rather than maintaining a shortlist
  // that silently misses controls when a new preference becomes available.
  const registry = await invoke<{ definitions: SettingDefinition[] }>(settings, 'settings-read');
  const rangeIds = new Set(['appearance.toolbarDelayMs']);
  const audit: { theme: string; section: string; id: string; type: string }[] = [], darkSegments: unknown[] = [];
  for (const theme of ['light', 'dark']) {
    await invoke(settings, 'settings-set', { id: 'appearance.theme', value: theme }); await settings.locator(`html[data-theme="${theme}"]`).waitFor();
    for (const section of new Set(registry.definitions.map(definition => definition.section))) {
      await settings.getByRole('button', { name: section, exact: true }).click();
      await until(async () => await settings.locator('.settings-top h1').innerText() === section, 'category ' + section); await frames(settings);
      if (section === '外观与布局') assert.equal(await settings.locator('.glass-preview-lens').count(), 0, 'visiting appearance never eagerly mounts the closed preview');
      assert.equal(await settings.locator('input[type=checkbox]').count(), 0, 'settings has no unstyled native boolean checkbox');
      assert.equal(await settings.locator('select').count(), 0, 'settings enum controls all use the common multi-option material');
      for (const definition of registry.definitions.filter(definition => definition.available && definition.section === section)) {
        const row = settings.locator(`[data-setting-id="${definition.id}"]`); assert.equal(await row.count(), 1, 'available registry item has one actual UI row: ' + definition.id); await row.scrollIntoViewIfNeeded(); await frames(settings);
        if (definition.type === 'boolean') {
          const item = row.getByRole('switch', { name: definition.label, exact: true }); assert.equal(await item.count(), 1); assert.equal(await item.isDisabled(), false); await opticalAssets(item); settledGeometry(await geometry(item), await item.getAttribute('aria-checked') === 'true');
        } else if (definition.type === 'select') {
          const item = row.getByRole('radiogroup', { name: definition.label, exact: true }); assert.equal(await item.count(), 1); assert.equal(await item.getByRole('radio').count(), definition.options!.length); const actual = await segmentedGeometry(item);
          if (theme === 'dark') darkSegments.push(await paintedDarkSegment(settings, item, actual, 'dark-segmented-' + definition.id));
        } else if (definition.type === 'number' && rangeIds.has(definition.id)) {
          assert.equal(await row.getByRole('slider', { name: definition.label + '滑块', exact: true }).count(), 1); await rangeGeometry(row.locator('.glass-range-control'));
        } else if (definition.type === 'number') assert.equal(await row.getByRole('spinbutton', { name: definition.label, exact: true }).count(), 1);
        audit.push({ theme, section, id: definition.id, type: definition.type });
      }
    }
  }
  assert.equal(audit.length, registry.definitions.filter(definition => definition.available).length * 2, 'both themes cover every available registered preference'); results.registryAudit = audit; results.darkSegments = darkSegments;

  await settings.getByRole('button', { name: '翻译', exact: true }).click();
  const languages = settings.getByRole('radiogroup', { name: '目标语言', exact: true }); await languages.scrollIntoViewIfNeeded();
  const languageViewport = languages.locator('.glass-segmented-viewport');
  const overflow = await languageViewport.evaluate(node => node.scrollWidth - node.clientWidth); assert.ok(overflow > 1, 'actual long language options overflow horizontally at the real settings size');
  await languageViewport.evaluate(node => { node.scrollLeft = node.scrollWidth - node.clientWidth; }); await frames(settings); await segmentedGeometry(languages);
  const oldLanguage = (await settingsState(settings)).values['translation.targetLanguage'];
  const selectedLanguage = languages.locator('[role=radio][aria-checked=true]'); await selectedLanguage.focus(); const beforeEnum = await settingsState(settings); await selectedLanguage.press('End');
  await until(async () => await languages.locator('[role=radio][aria-checked=true]').getAttribute('data-value') === 'es', 'keyboard End selects final language'); assert.equal((await settingsState(settings)).revision, beforeEnum.revision + 1);
  const languageGeometry = await segmentedGeometry(languages); const languageScroll = await languageViewport.evaluate(node => ({ left: node.scrollLeft, maximum: node.scrollWidth - node.clientWidth }));
  assert.ok(languageGeometry.thumb.x >= languageGeometry.track.x - .5 && languageGeometry.thumb.x + languageGeometry.thumb.width <= languageGeometry.track.x + languageGeometry.track.width + .5, 'keyboard selection scrolls the chosen pill into view');
  await settings.getByRole('button', { name: '撤销上一次设置更改', exact: true }).click(); await until(async () => (await settingsState(settings)).values['translation.targetLanguage'] === oldLanguage, 'global undo restores long enum');
  results.horizontalEnum = { overflow, languageScroll, oneTransaction: true, undo: true };

  await settings.getByRole('button', { name: '模型与连接', exact: true }).click();
  const protocol = settings.getByRole('radiogroup', { name: '协议', exact: true }); await protocol.scrollIntoViewIfNeeded(); await segmentedGeometry(protocol);
  await protocol.getByRole('radio', { name: 'Anthropic', exact: true }).click(); await until(async () => await protocol.getByRole('radio', { name: 'Anthropic', exact: true }).getAttribute('aria-checked') === 'true', 'protocol shares the actual segmented interaction'); await segmentedGeometry(protocol);
  darkSegments.push(await paintedDarkSegment(settings, protocol, await segmentedGeometry(protocol), 'dark-segmented-protocol'));
  const routes: { tool: string; label: string }[] = [{ tool: 'selection', label: '选区翻译模型' }, { tool: 'full', label: '全文翻译模型' }, { tool: 'web', label: '网页翻译模型' }, { tool: 'chat', label: '问答模型' }];
  for (const route of routes) {
    const group = settings.getByRole('radiogroup', { name: route.label, exact: true }); await group.scrollIntoViewIfNeeded(); assert.equal(await group.getByRole('radio').count(), 2); await segmentedGeometry(group);
    await group.locator(`[role=radio][data-value="${profileId}"]`).click(); await until(async () => (await invoke<{ routes: Record<string, string> }>(settings, 'connections-read')).routes[route.tool] === profileId && await group.locator('[role=radio][aria-checked=true]').getAttribute('data-value') === profileId, 'real model route ' + route.tool); await segmentedGeometry(group);
    darkSegments.push(await paintedDarkSegment(settings, group, await segmentedGeometry(group), 'dark-segmented-route-' + route.tool));
  }
  results.sharedConnections = { protocol: true, routes: routes.map(route => route.tool), providerTestOrDiscoveryActions: 0 };

  await settings.getByRole('button', { name: '外观与布局', exact: true }).click();
  const density = settings.getByRole('radiogroup', { name: '界面密度', exact: true }); await density.scrollIntoViewIfNeeded(); await segmentedGeometry(density);
  const beforeDensity = await settingsState(settings), initialDensity = String(beforeDensity.values['appearance.density']);
  const destination = density.locator(`[role=radio][data-value="${initialDensity === 'comfortable' ? 'compact' : 'comfortable'}"]`), destinationValue = await destination.getAttribute('data-value');
  const initialDensityGeometry = await geometry(density, '.glass-segmented-thumb'), destinationBox = await destination.boundingBox(), fillBefore = await density.locator('.glass-segmented-fill').boundingBox(); assert.ok(destinationBox && fillBefore);
  const zLayers = await density.evaluate(node => ({ thumb: Number(getComputedStyle(node.querySelector('.glass-segmented-thumb')!).zIndex), fill: Number(getComputedStyle(node.querySelector('.glass-segmented-fill')!).zIndex), buttons: [...node.querySelectorAll('[role=radio]')].map(button => Number(getComputedStyle(button).zIndex)) }));
  assert.ok(zLayers.buttons.every(z => zLayers.thumb > z && z > zLayers.fill), 'moving optical lens sits above captions and committed color remains below them');
  await invoke(settings, 'settings-set', { id: 'appearance.motion', value: 'standard' }); await settings.locator('html[data-motion="standard"]').waitFor();
  const dragRevision = (await settingsState(settings)).revision, densityStart = { x: centerX(initialDensityGeometry.thumb), y: centerY(initialDensityGeometry.track) }, pointerDelta = centerX(destinationBox) - densityStart.x;
  await settings.mouse.move(densityStart.x, densityStart.y); await settings.mouse.down();
  const intermediateDelta = Math.sign(pointerDelta) * 16; await settings.mouse.move(densityStart.x + intermediateDelta, densityStart.y, { steps: 3 }); await frames(settings);
  const intermediate = await geometry(density, '.glass-segmented-thumb'); fullThumbLayers(intermediate);
  const fillOpacityIntermediate = await density.locator('.glass-segmented-fill').evaluate(node => Number(getComputedStyle(node).opacity));
  assert.ok(fillOpacityIntermediate > 0 && fillOpacityIntermediate < 1, 'green selected fill continuously fades during early drag');
  closeEnough(centerX(intermediate.thumb) - intermediate.track.x - centerX(initialDensityGeometry.thumb) + initialDensityGeometry.track.x, intermediateDelta, 'upper lens follows actual pointer delta directly before the boundary', .8);
  // Place the expanded convex rim across the real destination caption. Its
  // enlargement is intentional; the old fixed half-option displacement can
  // leave the caption in the flat center and cannot test edge refraction.
  await until(async () => density.locator('.glass-segmented-thumb').evaluate(node => (node as HTMLElement).style.willChange === ''), 'raised material finishes its optical spring');
  const raised = await geometry(density, '.glass-segmented-thumb');
  assert.ok(raised.thumb.height > raised.track.height && raised.thumb.width > initialDensityGeometry.thumb.width * 1.25, 'pressed optical lens visibly exceeds the original capsule');
  assert.equal(await density.evaluate(node => getComputedStyle(node).overflowY), 'visible', 'the outer capsule does not clip its raised glass');
  const targetText = await destination.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const bounds = range.getBoundingClientRect(); return { x: bounds.x, width: bounds.width }; });
  const direction = Math.sign(pointerDelta), raisedBezel = 9.6 * raised.thumb.width / initialDensityGeometry.thumb.width;
  const opticalDelta = targetText.x + targetText.width / 2 - direction * (raised.thumb.width / 2 - raisedBezel / 2) - densityStart.x;
  await settings.mouse.move(densityStart.x + opticalDelta, densityStart.y, { steps: 6 }); await frames(settings);
  const dragged = await geometry(density, '.glass-segmented-thumb'), fillDuring = await density.locator('.glass-segmented-fill').boundingBox(); assert.ok(fillDuring); fullThumbLayers(dragged);
  closeEnough(centerY(dragged.thumb), centerY(dragged.track), 'dragged lens vertical center', .2);
  closeEnough(centerX(fillDuring) - dragged.track.x, centerX(fillBefore) - initialDensityGeometry.track.x, 'committed fill stays on original option while dragging', .2); assert.equal((await settingsState(settings)).revision, dragRevision, 'drag movement has no premature setting transaction');
  const fillOpacityDuring = await density.locator('.glass-segmented-fill').evaluate(node => Number(getComputedStyle(node).opacity));
  assert.ok(fillOpacityDuring < fillOpacityIntermediate, 'farther lens travel fades more of the fixed green fill');
  await until(async () => density.locator('.glass-segmented-thumb').evaluate(node => (node as HTMLElement).style.willChange === ''), 'held optical spring settles for reproducible actual pixel comparison');
  results.segmentedDragGeometry = { initialDensityGeometry, intermediate, raised, dragged, fillBefore, fillDuring, fillOpacityIntermediate, fillOpacityDuring, pointerDelta, opticalDelta };
  const actualText = await textRefractionComparison(settings, density, destination, 'dark-segmented-drag-text');
  await settings.mouse.move(densityStart.x + pointerDelta, densityStart.y, { steps: 6 }); await settings.mouse.up(); await until(async () => (await settingsState(settings)).values['appearance.density'] === destinationValue, 'release commits target option'); assert.equal((await settingsState(settings)).revision, dragRevision + 1, 'one segmented drag commits exactly once');
  await invoke(settings, 'settings-set', { id: 'appearance.motion', value: 'off' }); await settings.locator('html[data-motion="off"]').waitFor(); await segmentedGeometry(density);
  // Revert the motion preference first, then undo the actual drag transaction.
  await settings.getByRole('button', { name: '撤销上一次设置更改', exact: true }).click(); await until(async () => (await settingsState(settings)).values['appearance.motion'] === 'standard', 'undo motion preference');
  await settings.getByRole('button', { name: '撤销上一次设置更改', exact: true }).click(); await until(async () => (await settingsState(settings)).values['appearance.density'] === initialDensity, 'one global undo restores segmented drag');
  await invoke(settings, 'settings-set', { id: 'appearance.motion', value: 'off' }); await settings.locator('html[data-motion="off"]').waitFor(); await segmentedGeometry(density); results.segmentedDrag = { zLayers, intermediateDelta, intermediate, pointerDelta, dragged, fillBefore, fillDuring, actualText, oneTransaction: true, undo: true };
  const allOpticalThumbs = settings.locator('.glass-switch-thumb:visible,.glass-segmented-thumb:visible,.glass-range-thumb:visible');
  await until(async () => allOpticalThumbs.evaluateAll(nodes => nodes.every(node => node.querySelector('feDisplacementMap'))), 'all visible small control classes have attached fields');
  const beforeIdle = await settings.evaluate(() => window.__agentViewerRenderingDiagnostics!().glass); await settings.waitForTimeout(400); const afterIdle = await settings.evaluate(() => window.__agentViewerRenderingDiagnostics!().glass);
  assert.equal(afterIdle.builds, beforeIdle.builds, 'static switch, segmented and range controls create no new maps'); assert.equal(afterIdle.pngEncodes, beforeIdle.pngEncodes, 'static controls create no new optical PNGs'); assert.equal(await settings.locator('.glass-preview-lens').count(), 0); results.idleAssets = { beforeIdle, afterIdle };

  const range = settings.getByRole('slider', { name: '胶囊隐藏等待时间（毫秒）滑块', exact: true }); await range.scrollIntoViewIfNeeded(); await rangeGeometry(settings.locator('[data-setting-id="appearance.toolbarDelayMs"] .glass-range-control'));
  const rangeBefore = await settingsState(settings); await range.focus(); await range.press('ArrowRight'); await until(async () => Number((await settingsState(settings)).values['appearance.toolbarDelayMs']) === Number(rangeBefore.values['appearance.toolbarDelayMs']) + 100, 'native range keyboard increments by the actual 100ms step'); assert.equal((await settingsState(settings)).revision, rangeBefore.revision + 1); await rangeGeometry(settings.locator('[data-setting-id="appearance.toolbarDelayMs"] .glass-range-control'));
  await settings.getByRole('button', { name: '撤销上一次设置更改', exact: true }).click(); await until(async () => (await settingsState(settings)).values['appearance.toolbarDelayMs'] === rangeBefore.values['appearance.toolbarDelayMs'], 'global undo restores keyboard range'); results.rangeKeyboardUndo = true;
  const rangeControl = settings.locator('[data-setting-id="appearance.toolbarDelayMs"] .glass-range-control');
  const savedDelay = (await settingsState(settings)).values['appearance.toolbarDelayMs'];
  await invoke(settings, 'settings-set', { id:'appearance.toolbarDelayMs', value:5000 });
  await invoke(settings, 'settings-set', { id:'appearance.motion', value:'standard' });
  await settings.locator('html[data-motion="standard"]').waitFor();
  const comparisonRevision = (await settingsState(settings)).revision;
  results.rangeOptics = await verifyRangeReferenceOptics(settings,app,rangeControl,evidence);
  assert.equal((await settingsState(settings)).revision,comparisonRevision,'held optical comparison and cancellation never commit a setting');
  await invoke(settings,'settings-set',{id:'appearance.motion',value:'off'}); await settings.locator('html[data-motion="off"]').waitFor();
  const endpointGeometry: Record<string,unknown> = {};
  for (const endpoint of ['Home','End'] as const) {
    await range.focus(); await range.press(endpoint);
    const expectedValue = await range.evaluate((node,endpoint) => Number(endpoint === 'Home' ? (node as HTMLInputElement).min : (node as HTMLInputElement).max),endpoint);
    await until(async() => Number((await settingsState(settings)).values['appearance.toolbarDelayMs']) === expectedValue,'native input reaches '+endpoint);
    await rangeGeometry(rangeControl); const endpointBox = await geometry(rangeControl.locator('.glass-range'),'.glass-range-thumb');
    closeEnough(endpoint === 'Home' ? endpointBox.thumb.x : endpointBox.thumb.x + endpointBox.thumb.width,endpoint === 'Home' ? endpointBox.track.x : endpointBox.track.x + endpointBox.track.width,'source resting pill aligns with '+endpoint+' native boundary',.4);
    endpointGeometry[endpoint] = endpointBox;
  }
  await invoke(settings,'settings-set',{id:'appearance.toolbarDelayMs',value:savedDelay});
  results.rangeEndpoints = endpointGeometry;
  await settings.getByRole('button', { name: '通用与多开', exact: true }).click();
  const additional = settings.locator('details.settings-unavailable'); if (await additional.count() && await additional.getAttribute('open') === null) await additional.locator(':scope > summary').click();
  const disabled = settings.locator('.setting-switch:disabled').first(); await disabled.waitFor(); await disabled.scrollIntoViewIfNeeded();
  const disabledBefore = await settingsState(settings), disabledGeometry = await geometry(disabled); settledGeometry(disabledGeometry, await disabled.getAttribute('aria-checked') === 'true');
  await settings.mouse.move(centerX(disabledGeometry.thumb), centerY(disabledGeometry.thumb)); await settings.mouse.down(); await settings.mouse.move(centerX(disabledGeometry.thumb) + 14, centerY(disabledGeometry.thumb), { steps: 3 }); await settings.mouse.up();
  await settings.locator('.settings-nav-heading').click(); await disabled.evaluate(node => (node as HTMLButtonElement).focus());
  assert.equal(await disabled.evaluate(node => document.activeElement === node), false, 'disabled native switch cannot receive keyboard focus');
  await settings.keyboard.press('Space'); await settings.waitForTimeout(150);
  assert.equal((await settingsState(settings)).revision, disabledBefore.revision, 'disabled control pointer/keyboard interaction produces no setting change');
  closeEnough((await geometry(disabled)).thumb.width, disabledGeometry.thumb.width, 'disabled thumb has no press deformation');
  results.disabled = true; assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, deviceScale, port, ...results, errors }, null, 2));
  console.log('Actual switch paint/geometry/DPI, every available enum/range, routing, drag/undo/keyboard and accessibility: PASS', evidence);
} catch (error) {
  for (const page of app.context().pages().filter(page => page.url().includes('#/settings'))) await page.screenshot({ path: join(evidence, 'failure-settings.png'), scale: 'device' }).catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), deviceScale, ...results, errors }, null, 2)); throw error;
} finally { await app.close(); }
