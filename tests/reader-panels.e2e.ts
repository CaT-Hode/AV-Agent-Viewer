import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import assert from 'node:assert/strict';
import type { WorkspaceState, ViewInfo, NativeOfficeState } from '../packages/contracts/src/index';

const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-reader-panels-')), evidence = join(directory, 'evidence');
await mkdir(evidence);
await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, revision: 0, values: { 'appearance.theme': 'light', 'appearance.motion': 'off', 'appearance.glass': 'standard', 'appearance.autoHideToolbar': false } }));
const port = await new Promise<number>(done => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const address = socket.address(); assert.ok(address && typeof address !== 'string'); socket.close(() => done(address.port)); }); });
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const packagedExecutable = process.env.AGENTVIEWER_QA_EXE;
const app = await electron.launch({ executablePath: packagedExecutable ?? require('electron'), args: packagedExecutable ? [] : ['.'], cwd: resolve('.'), env, timeout: 45_000 });
const main = await app.firstWindow(), errors: string[] = [], results: Record<string, unknown> = {};
main.on('pageerror', e => errors.push(e.message)); app.context().on('page', page => page.on('pageerror', e => errors.push(e.message)));
const invoke = <T>(method: string, args: Record<string, unknown> = {}) => main.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const until = async (check: () => Promise<boolean>, label: string, limit = 180) => { for (let i = 0; i < limit; i++) { if (await check()) return; await main.waitForTimeout(70); } throw new Error('等待失败：' + label); };
const canvas = () => main.locator('.workbench > .reader-panel').boundingBox();
const close = (a: number, b: number, label: string, tolerance = 1.1) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} != ${b}`);
const unchanged = (a: NonNullable<Awaited<ReturnType<typeof canvas>>>, b: typeof a) => { for (const key of ['x','y','width','height'] as const) close(a[key], b[key], 'reading ' + key); };
type Side = 'left' | 'right';
const paneSelector = (side: Side) => `.floating-side-panel[data-side="${side}"]:not([data-panel-anchor="true"])`;
const separator = (page: Page, side: Side) => page.getByRole('separator', { name: side === 'left' ? '调整左侧工具栏宽度' : '调整右侧 AI 面板宽度' });
const persistedWidth = (side: Side) => main.evaluate(side => Number(JSON.parse(localStorage.getItem('agentviewer.reader-panels.v1') ?? '{}')[side + 'Width']), side);
const resizeChecks: unknown[] = [], motionChecks: unknown[] = [], keyboardChecks: unknown[] = [];
results.resizeChecks = resizeChecks; results.motionChecks = motionChecks; results.keyboardChecks = keyboardChecks;
async function panelGeometry(page: Page, side: Side) {
  const local = await page.locator(paneSelector(side)).evaluate(node => { const box = node.getBoundingClientRect(); return { pane: { x: box.x, y: box.y, width: box.width, height: box.height }, width: Number(node.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')), screen: { x: screenX, y: screenY } }; });
  if (page === main) return { ...local, anchor: local.pane, window: undefined };
  const anchor = await main.locator(`.workbench > .floating-side-panel[data-side="${side}"][data-panel-anchor="true"]`).boundingBox();
  const owned = await app.evaluate(({ BrowserWindow }, url) => { const popup = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url), owner = popup?.getParentWindow(); return popup && owner ? { bounds: popup.getBounds(), owner: owner.getContentBounds(), visible: popup.isVisible() } : undefined; }, page.url());
  return { ...local, anchor, window: owned };
}
async function settledPanel(page: Page, side: Side, target: number, label: string) {
  let previous = '', matched = 0;
  await until(async () => {
    const state = await panelGeometry(page, side), anchor = state.anchor;
    const geometryMatches = !!anchor && Math.abs(state.pane.width - target) <= 1.1 && Math.abs(anchor.width - target) <= 1.1 && state.width === target && (page === main || (!!state.window && (
      state.window.visible && Math.abs(state.window.bounds.x - (state.window.owner.x + Math.round(anchor.x) - 12)) <= 1.1 && Math.abs(state.window.bounds.y - (state.window.owner.y + Math.round(anchor.y) - 12)) <= 1.1 &&
      Math.abs(state.window.bounds.width - (Math.ceil(anchor.width) + 24)) <= 1.1 && Math.abs(state.window.bounds.height - (Math.ceil(anchor.height) + 24)) <= 1.1 &&
      Math.abs(state.screen.x - state.window.bounds.x) <= 1.1 && Math.abs(state.screen.y - state.window.bounds.y) <= 1.1)));
    const signature = JSON.stringify(state);
    matched = geometryMatches ? signature === previous ? matched + 1 : 1 : 0; previous = signature;
    results.geometryInProgress = { label, side, target, state, matched };
    return matched >= 2;
  }, label + ' actual parent/owned geometry acknowledged');
  delete results.geometryInProgress;
}
async function resize(page: Page, side: 'left' | 'right', delta: number) {
  const expectedStart = Number(await separator(page, side).getAttribute('aria-valuenow'));
  // ARIA/storage update synchronously, while a native owned window follows an
  // asynchronous parent geometry IPC. Begin physical pointer travel only after
  // the visible width AND screen origin have actually acknowledged that state.
  await settledPanel(page, side, expectedStart, side + ' resize start');
  await page.evaluate(() => { const values: unknown[] = []; (window as unknown as { __panelTrace: unknown[] }).__panelTrace = values; for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','blur']) window.addEventListener(type, event => { const pointer = event as PointerEvent, target = event.target as HTMLElement; values.push({ type, clientX: pointer.clientX, screenX: pointer.screenX, id: pointer.pointerId, windowX: screenX, className: target?.className, role: target?.getAttribute?.('role'), dragging: document.querySelector('[role=separator]')?.getAttribute('data-dragging'), width: document.querySelector('[role=separator]')?.getAttribute('aria-valuenow') }); }, true); });
  const handle = page.getByRole('separator', { name: side === 'left' ? '调整左侧工具栏宽度' : '调整右侧 AI 面板宽度' }), box = await handle.boundingBox(); assert.ok(box);
  const old = Number(await handle.getAttribute('aria-valuenow'));
  const origin = await page.evaluate(() => ({ x: screenX, y: screenY })), globalX = origin.x + box.x + box.width / 2, globalY = origin.y + box.y + box.height / 2, portalled = page !== main;
  const startGeometry = await panelGeometry(page, side);
  try {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
    const current = await page.evaluate(() => ({ x: screenX, y: screenY })), travel = delta * step / 8;
    // CDP takes window-local positions. Keep the intended physical position
    // fixed while an owned right panel itself moves during width adjustment.
    await page.mouse.move(globalX + travel - current.x, globalY - current.y);
    if (portalled && side === 'right') await page.waitForFunction(target => Math.abs(screenX - target) <= 1.1, origin.x + travel);
    }
    if (portalled) { const current = await page.evaluate(() => ({ x: screenX, y: screenY })); await page.mouse.move(globalX + delta - current.x, globalY - current.y); }
    await page.mouse.up();
    await until(async () => main.evaluate(({ side, target }) => { const stored = JSON.parse(localStorage.getItem('agentviewer.reader-panels.v1') ?? '{}'); return Math.abs(Number(stored[side + 'Width']) - target) <= 1; }, { side, target: old + (side === 'left' ? delta : -delta) }), side + ' width persisted');
    if (delta === 0) assert.equal(await persistedWidth(side), old, side + ' stationary pointer press must not accumulate native pixel quantization');
    await settledPanel(page, side, await persistedWidth(side), side + ' resize completed');
  } catch (error) { results.resizeFailure = { side, old, delta, url: page.url(), startGeometry, latestGeometry: await panelGeometry(page, side), events: await page.evaluate(() => (window as unknown as { __panelTrace: unknown[] }).__panelTrace) }; throw error; }
  finally { await page.mouse.up(); }
  resizeChecks.push({ side, delta, previousWidth: old, persistedWidth: await persistedWidth(side), actualPane: await page.locator(paneSelector(side)).boundingBox(), url: page.url() });
}
async function materialSnapshot(page: Page, side: Side) {
  return page.locator(paneSelector(side)).evaluate((pane, side) => {
    const surface = pane.querySelector<HTMLElement>(':scope > .liquid-glass-surface')!, highlight = surface.querySelector<HTMLElement>('.liquid-glass-highlight')!, style = getComputedStyle(surface);
    const caption = pane.querySelector(side === 'left' ? '.format-heading > span' : '.drawer-heading h2')!, handle = pane.querySelector('[role="separator"]')!;
    const box = pane.getBoundingClientRect(), textBox = caption.getBoundingClientRect(), handleBox = handle.getBoundingClientRect(), backgroundBox = surface.getBoundingClientRect();
    return { state: pane.getAttribute('data-glass-elastic-state'), owner: pane.getAttribute('data-glass-elastic-owner'), layer: pane.getAttribute('data-glass-elastic-layer'),
      scale: style.scale, translate: style.translate, willChange: style.willChange, origin: style.transformOrigin, shadow: getComputedStyle(highlight).boxShadow,
      scaleX: Number(style.getPropertyValue('--glass-elastic-scale-x') || 1), scaleY: Number(style.getPropertyValue('--glass-elastic-scale-y') || 1),
      insetAlpha: Number(style.getPropertyValue('--glass-material-inset-alpha') || .2), shadowX: parseFloat(style.getPropertyValue('--glass-material-shadow-x') || '0'), shadowY: parseFloat(style.getPropertyValue('--glass-material-shadow-y') || '4'),
      pane: { x: box.x, y: box.y, width: box.width, height: box.height }, foreground: [
        { x: textBox.x, y: textBox.y, width: textBox.width, height: textBox.height },
        { x: handleBox.x, y: handleBox.y, width: handleBox.width, height: handleBox.height }],
      surface: { x: backgroundBox.x, y: backgroundBox.y, width: backgroundBox.width, height: backgroundBox.height } };
  }, side);
}
async function materialGesture(page: Page, side: Side, label: string, mode: 'standard' | 'elegant') {
  await invoke('settings-set', { id: 'appearance.motion', value: mode });
  await until(async () => await main.locator('html').getAttribute('data-motion') === mode && await page.locator('html').getAttribute('data-motion') === mode, label + ' motion reaches actual pane');
  await until(async () => page.locator(paneSelector(side)).evaluate(node => node.getAttribute('data-motion-phase') === 'open' && node.getAnimations().every(animation => animation.playState !== 'running')), label + ' presence settled');
  const before = await materialSnapshot(page, side), beforeCanvas = (await canvas())!;
  const point = await page.locator(paneSelector(side)).evaluate((pane, side) => {
    const heading = pane.querySelector(side === 'left' ? '.format-heading' : '.drawer-heading')!, box = heading.getBoundingClientRect();
    // Use an actual empty header point, rather than dispatching a synthetic
    // event or pressing a nested button/control with its own controller.
    for (const fraction of [.62, .72, .52, .82]) {
      const x = box.x + box.width * fraction, y = box.y + box.height / 2, hit = document.elementFromPoint(x, y);
      if (hit && heading.contains(hit) && !hit.closest('button,input,textarea,select,[role="separator"],[data-glass-control-owner]') && hit.closest('.material-host') === pane) return { x, y };
    }
    throw new Error('No empty material heading point for ' + side);
  }, side);
  results.materialInProgress = { label, side, mode, before, point, url: page.url() };
  // A bounded test-only RAF trace observes real painted geometry while short
  // pointer velocity decays. It neither edits CSS nor drives production RAF.
  await page.locator(paneSelector(side)).evaluate(pane => {
    const trace: unknown[] = [], target = pane as HTMLElement;
    const observer = window as unknown as { __materialTrace: unknown[]; __materialTraceFrame: number; __materialTraceTick: FrameRequestCallback };
    observer.__materialTrace = trace;
    // Store the anonymous callback on the test window: tsx's keepNames wrapper
    // otherwise references its Node-only __name helper inside page.evaluate.
    observer.__materialTraceTick = () => {
      const surface = target.querySelector<HTMLElement>(':scope > .liquid-glass-surface')!, style = getComputedStyle(surface), box = target.getBoundingClientRect();
      const foreground = [target.querySelector('.format-heading > span,.drawer-heading h2')!, target.querySelector('[role="separator"]')!].map(node => { const value = node.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; });
      trace.push({ state: target.dataset.glassElasticState, x: Number(style.getPropertyValue('--glass-elastic-scale-x') || 1), y: Number(style.getPropertyValue('--glass-elastic-scale-y') || 1), scale: style.scale, translate: style.translate, shadow: getComputedStyle(surface.querySelector('.liquid-glass-highlight')!).boxShadow, pane: { x: box.x, y: box.y, width: box.width, height: box.height }, foreground });
      if (trace.length < 180) observer.__materialTraceFrame = requestAnimationFrame(observer.__materialTraceTick);
    };
    observer.__materialTraceFrame = requestAnimationFrame(observer.__materialTraceTick);
  });
  let pressed: Awaited<ReturnType<typeof materialSnapshot>> | undefined;
  try {
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await until(async () => { const value = await materialSnapshot(page, side); return value.state === 'press' && value.scaleY < .998 && value.insetAlpha > .2005 && value.shadow !== before.shadow; }, label + ' actual spring/inset press');
    pressed = await materialSnapshot(page, side);
    assert.equal(pressed.owner, 'delegated'); assert.equal(pressed.layer, 'surface');
    assert.notEqual(pressed.scale, before.scale, label + ' computed material scale changes');
    assert.ok(pressed.shadowX > .05 && pressed.shadowY > 4.05, label + ' broad inset responds to press');
    // CDP emits real pointer moves. Keep them within the header, with no
    // sleeps between them; the RAF trace retains the resulting velocity peak.
    await page.mouse.move(point.x + 20, point.y); await page.mouse.move(point.x - 20, point.y + 1); await page.mouse.move(point.x + 20, point.y);
    await until(async () => page.evaluate(() => (window as unknown as { __materialTrace: { state: string; x: number; y: number }[] }).__materialTrace.some(value => value.state === 'drag' && value.x > 1.00005 && value.y < .999 && Math.abs(value.x - value.y) > .001)), label + ' actual velocity produces nonuniform material deformation', 36);
    unchanged(beforeCanvas, (await canvas())!);
  } finally { await page.mouse.up(); }
  await until(async () => { const value = await materialSnapshot(page, side); return value.state === 'rest' && Math.abs(value.scaleX - 1) < .001 && Math.abs(value.scaleY - 1) < .001 && value.willChange === before.willChange && Math.abs(value.insetAlpha - .2) < .001 && Math.abs(value.shadowX) < .03 && Math.abs(value.shadowY - 4) < .03; }, label + ' finite spring returns to rest', 45);
  const after = await materialSnapshot(page, side), trace = await page.evaluate(() => { const state = window as unknown as { __materialTraceFrame: number; __materialTrace: { state: string; x: number; y: number; scale: string; translate: string; shadow: string; pane: { x: number; y: number; width: number; height: number }; foreground: { x: number; y: number; width: number; height: number }[] }[] }; cancelAnimationFrame(state.__materialTraceFrame); return state.__materialTrace; });
  for (const value of trace) {
    for (const key of ['x','y','width','height'] as const) close(value.pane[key], before.pane[key], label + ' fixed material host ' + key, .35);
    assert.equal(value.foreground.length, before.foreground.length);
    value.foreground.forEach((box, index) => { for (const key of ['x','y','width','height'] as const) close(box[key], before.foreground[index][key], label + ' foreground ' + index + ' ' + key, .35); });
  }
  unchanged(beforeCanvas, (await canvas())!);
  assert.ok(trace.some(value => value.shadow !== before.shadow && value.scale !== before.scale), label + ' actual optical leaf changes during input');
  motionChecks.push({ label, side, mode, before, pressed, after, trace });
  delete results.materialInProgress;
  await invoke('settings-set', { id: 'appearance.motion', value: 'off' });
  await until(async () => await page.locator('html').getAttribute('data-motion') === 'off', label + ' motion off restored');
}
async function keyboardAndCancel(page: Page, side: Side, label: string) {
  const handle = separator(page, side), old = Number(await handle.getAttribute('aria-valuenow')), beforeCanvas = (await canvas())!;
  const min = Number(await handle.getAttribute('aria-valuemin')), max = Number(await handle.getAttribute('aria-valuemax'));
  await handle.focus(); await page.keyboard.press('Home');
  await until(async () => await persistedWidth(side) === min && Number(await handle.getAttribute('aria-valuenow')) === min, label + ' Home minimum');
  await settledPanel(page, side, min, label + ' Home');
  await page.keyboard.press(side === 'left' ? 'ArrowLeft' : 'ArrowRight');
  assert.equal(await persistedWidth(side), min, label + ' outward key is clamped at minimum');
  await page.keyboard.press('End');
  await until(async () => await persistedWidth(side) === max && Number(await handle.getAttribute('aria-valuenow')) === max, label + ' End maximum');
  await settledPanel(page, side, max, label + ' End');
  await page.keyboard.press(side === 'left' ? 'ArrowRight' : 'ArrowLeft');
  assert.equal(await persistedWidth(side), max, label + ' outward key is clamped at maximum');
  await page.keyboard.press(side === 'left' ? 'Shift+ArrowLeft' : 'Shift+ArrowRight');
  await until(async () => await persistedWidth(side) === max - 32, label + ' accelerated keyboard step');
  await settledPanel(page, side, max - 32, label + ' Shift step');
  await resize(page, side, (old - (max - 32)) * (side === 'left' ? 1 : -1));
  await until(async () => Math.abs((await page.locator(paneSelector(side)).boundingBox())!.width - old) <= 1.1, label + ' original width restored');
  const original = await persistedWidth(side), box = (await handle.boundingBox())!, origin = await page.evaluate(() => ({ x: screenX, y: screenY }));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  const travel = side === 'left' ? 36 : -36;
  await page.mouse.move(box.x + box.width / 2 + travel, box.y + box.height / 2);
  await until(async () => Number(await handle.getAttribute('aria-valuenow')) === original + 36 && Math.abs((await page.locator(paneSelector(side)).boundingBox())!.width - (original + 36)) <= 1.1, label + ' actual uncommitted resize preview');
  await settledPanel(page, side, original + 36, label + ' preview');
  assert.equal(await persistedWidth(side), original, label + ' pointer preview is not persisted');
  await page.keyboard.press('Escape'); await page.mouse.up();
  await until(async () => await handle.getAttribute('data-dragging') !== 'true' && Number(await handle.getAttribute('aria-valuenow')) === original && Math.abs((await page.locator(paneSelector(side)).boundingBox())!.width - original) <= 1.1, label + ' Escape cancels preview');
  await settledPanel(page, side, original, label + ' cancellation');
  assert.equal(await persistedWidth(side), original, label + ' cancellation preserves stored width');
  unchanged(beforeCanvas, (await canvas())!);
  keyboardChecks.push({ label, side, min, max, original, final: await persistedWidth(side), originalWindow: origin, finalWindow: await page.evaluate(() => ({ x: screenX, y: screenY })), canvas: beforeCanvas });
}
async function panel(side: 'left' | 'right', viewId: string) {
  const match = () => app.context().pages().find(page => page.url().includes(`#/reader-panel?side=${side}&view=${encodeURIComponent(viewId)}`));
  await until(async () => !!match(), side + ' owned window'); const page = match()!;
  await page.locator('.reader-panel-ported').waitFor();
  await until(async () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().includes(id) && window.isVisible()), `#/reader-panel?side=${side}&view=${encodeURIComponent(viewId)}`), side + ' owned window visible');
  await until(async () => page.locator('.reader-panel-backdrop').evaluate(node => getComputedStyle(node).backgroundImage.startsWith('url(')), side + ' actual underlying pixels');
  assert.equal(await page.locator('.reader-panel-ported > .liquid-glass-surface').getAttribute('data-glass-effect'), 'frosted');
  assert.equal(await page.locator('.reader-panel-ported > .liquid-glass-surface feDisplacementMap').count(), 0, 'sidebar uses frost, not full-height optical maps');
  await assert.rejects(() => page.evaluate(() => window.agentViewer!.call('state')), /AUTH_SCOPE_DENIED/);
  return page;
}
async function webWidthAcrossRemount(page: Page, viewId: string) {
  await invoke('settings-set', { id: 'appearance.motion', value: 'off' });
  await until(async () => await main.locator('html').getAttribute('data-motion') === 'off' && await page.locator('html').getAttribute('data-motion') === 'off', 'remount regression disables presence motion');
  const originalWidth = await persistedWidth('right'), originalCanvas = (await canvas())!, ownerUrl = main.url();
  const originalSize = await app.evaluate(({ BrowserWindow }, url) => { const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url && !window.getParentWindow()); if (!owner) throw new Error('Own reader window missing'); return owner.getContentSize(); }, ownerUrl);
  const stages: unknown[] = [], report = { originalWidth, originalSize, stages, completed: false };
  results.webWidthAcrossRemount = report;
  let reopened = page;
  try {
    await resize(page, 'right', originalWidth - 600);
    assert.equal(await persistedWidth('right'), 600, 'Wide window stores the requested logical width');
    stages.push({ stage: 'wide-saved', saved: await persistedWidth('right'), min: Number(await separator(page, 'right').getAttribute('aria-valuemin')), max: Number(await separator(page, 'right').getAttribute('aria-valuemax')), geometry: await panelGeometry(page, 'right'), canvas: await canvas() });
    await main.getByRole('button', { name: 'AI 工具', exact: true }).click();
    await until(async () => page.isClosed() && await main.locator('.workbench > [data-panel-anchor="true"][data-side="right"]').count() === 0, 'AI drawer and its old resize controller are unmounted');
    await app.evaluate(({ BrowserWindow }, input) => { const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === input.url && !window.getParentWindow()); if (!owner) throw new Error('Own reader window missing'); owner.setContentSize(1280, input.height); }, { url: ownerUrl, height: originalSize[1] });
    await until(async () => main.evaluate(height => Math.abs(innerWidth - 1280) <= 1.1 && Math.abs(innerHeight - height) <= 1.1, originalSize[1]), 'own reader actual supported narrow viewport');
    await main.getByRole('button', { name: 'AI 工具', exact: true }).click();
    reopened = await panel('right', viewId);
    assert.notEqual(reopened, page, 'Reopening creates a new actual owned panel and resize controller');
    await until(async () => { const handle = separator(reopened, 'right'), max = Number(await handle.getAttribute('aria-valuemax')); return max < 600 && Number(await handle.getAttribute('aria-valuenow')) === max; }, 'new narrow controller visibly clamps the saved width');
    const narrowMax = Number(await separator(reopened, 'right').getAttribute('aria-valuemax'));
    await settledPanel(reopened, 'right', narrowMax, 'narrow remounted panel');
    assert.equal(await persistedWidth('right'), 600, 'Viewport clamping must not rewrite the saved logical width');
    stages.push({ stage: 'narrow-remounted', saved: await persistedWidth('right'), min: Number(await separator(reopened, 'right').getAttribute('aria-valuemin')), max: narrowMax, geometry: await panelGeometry(reopened, 'right'), canvas: await canvas() });
    await app.evaluate(({ BrowserWindow }, input) => { const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === input.url && !window.getParentWindow()); if (!owner) throw new Error('Own reader window missing'); owner.setContentSize(input.size[0], input.size[1]); }, { url: ownerUrl, size: originalSize });
    await until(async () => main.evaluate(size => Math.abs(innerWidth - size[0]) <= 1.1 && Math.abs(innerHeight - size[1]) <= 1.1, originalSize), 'own reader actual original viewport restored');
    await settledPanel(reopened, 'right', 600, 'restored wide remounted panel');
    stages.push({ stage: 'wide-restored-before-press', saved: await persistedWidth('right'), min: Number(await separator(reopened, 'right').getAttribute('aria-valuemin')), max: Number(await separator(reopened, 'right').getAttribute('aria-valuemax')), geometry: await panelGeometry(reopened, 'right'), canvas: await canvas() });
    await resize(reopened, 'right', 0);
    assert.equal(await persistedWidth('right'), 600, 'A new gesture must not reuse the controller preview clamped in a former narrow viewport');
    stages.push({ stage: 'wide-after-stationary-press', saved: await persistedWidth('right'), min: Number(await separator(reopened, 'right').getAttribute('aria-valuemin')), max: Number(await separator(reopened, 'right').getAttribute('aria-valuemax')), geometry: await panelGeometry(reopened, 'right'), canvas: await canvas() });
    await resize(reopened, 'right', 600 - originalWidth);
    assert.equal(await persistedWidth('right'), originalWidth, 'Remount regression restores the original user layout width');
    unchanged(originalCanvas, (await canvas())!);
    stages.push({ stage: 'original-layout-restored', saved: await persistedWidth('right'), geometry: await panelGeometry(reopened, 'right'), canvas: await canvas() });
    report.completed = true;
    return reopened;
  } finally {
    // A failed assertion still restores only this isolated test's own reader.
    await app.evaluate(({ BrowserWindow }, input) => { const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === input.url && !window.getParentWindow()); owner?.setContentSize(input.size[0], input.size[1]); }, { url: ownerUrl, size: originalSize });
  }
}
let failure: unknown;
try {
  await main.locator('.prose h1').waitFor();
  const initial = (await canvas())!; assert.ok(initial.width > 1100, 'canvas includes space under both sidebars');
  await resize(main, 'left', 90); unchanged(initial, (await canvas())!);
  await main.getByRole('button', { name: 'AI 工具', exact: true }).click(); await resize(main, 'right', -50); unchanged(initial, (await canvas())!);
  await keyboardAndCancel(main, 'left', 'Markdown left');
  for (const mode of ['standard','elegant'] as const) for (const side of ['left','right'] as const) await materialGesture(main, side, 'Markdown ' + side, mode);
  const defs = await invoke<{ definitions: { id: string }[] }>('settings-read'); assert.ok(defs.definitions.every(d => !['appearance.leftWidth','appearance.rightWidth'].includes(d.id)));
  const stored = await main.evaluate(() => localStorage.getItem('agentviewer.reader-panels.v1')); results.dom = { canvas: initial, stored };
  await main.screenshot({ path: join(evidence, 'markdown-panels.png'), scale: 'css' });
  const workspace = await invoke<WorkspaceState>('state'), web = workspace.views.find(view => workspace.documents.find(doc => doc.id === view.documentId)?.format === 'web')!; assert.ok(web);
  await invoke('activate', { viewId: web.id });
  let right = await panel('right', web.id);
  const webCanvas = (await canvas())!;
  right = await webWidthAcrossRemount(right, web.id);
  await resize(right, 'right', 0); unchanged(webCanvas, (await canvas())!);
  await resize(right, 'right', -35); unchanged(webCanvas, (await canvas())!);
  await keyboardAndCancel(right, 'right', 'Web right');
  for (const mode of ['standard','elegant'] as const) await materialGesture(right, 'right', 'Web right', mode);
  await right.screenshot({ path: join(evidence, 'web-right-panel.png'), scale: 'css' });
  await invoke('settings-set', { id: 'appearance.glass', value: 'off' });
  await until(async () => await right.locator('html').getAttribute('data-glass') === 'off' && await right.locator('.reader-panel-backdrop').evaluate(node => getComputedStyle(node).backgroundImage === 'none'), 'disabled frost stops native background publication');
  await invoke('settings-set', { id: 'appearance.glass', value: 'standard' });
  await until(async () => right.locator('.reader-panel-backdrop').evaluate(node => getComputedStyle(node).backgroundImage.startsWith('url(')), 'frost resumes from the same source');
  await right.getByRole('separator').focus(); await right.keyboard.press('Control+,');
  await until(async () => app.context().pages().some(page => page.url().includes('#/settings')), 'same app shortcuts work in owned toolbars');
  const settingsPage = app.context().pages().find(page => page.url().includes('#/settings'))!;
  const settingsWindowId = await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.getURL() === url)?.id, settingsPage.url());
  assert.equal(typeof settingsWindowId, 'number', 'The shortcut opens an identifiable settings window');
  await settingsPage.close();
  // Page.close resolves when its renderer closes, before the BrowserWindow may
  // leave Electron's registry. Wait for this exact window, not a fixed delay.
  await until(async () => app.evaluate(({ BrowserWindow }, id) => {
    const closing = BrowserWindow.getAllWindows().find(window => window.id === id);
    return !closing || closing.isDestroyed();
  }, settingsWindowId), 'settings window is destroyed after close');
  const layers = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return [];
    const parent = window.getParentWindow();
    return [{ url: window.webContents.getURL(), visible: window.isVisible(), bounds: window.getBounds(), parent: parent && !parent.isDestroyed() && !parent.webContents.isDestroyed() ? parent.webContents.getURL() : undefined }];
  }));
  results.web = { canvas: webCanvas, layers };
  const samples = await main.evaluate(async () => { const response = await fetch('/api/samples'); return response.json(); }) as { path: string; format: string }[];
  for (const format of ['docx','xlsx','pptx']) {
    const sample = samples.find(item => item.format === format); assert.ok(sample);
    const path = join(directory, basename(sample.path)); await copyFile(sample.path, path);
    const view = await invoke<ViewInfo>('open', { uri: path }); await invoke('activate', { viewId: view.id });
    await until(async () => { try { const state = await invoke<NativeOfficeState>('office-status', { viewId: view.id }); return state.status === 'ready' && !!state.visible && !!state.nativeGeometry; } catch { return false; } }, format + ' native ready', 1500);
    const left = await panel('left', view.id), ai = await panel('right', view.id), before = (await canvas())!;
    await resize(left, 'left', 24); unchanged(before, (await canvas())!);
    await resize(ai, 'right', 0); unchanged(before, (await canvas())!);
    await resize(ai, 'right', -18); unchanged(before, (await canvas())!);
    await until(async () => (await left.locator('.native-style-inspector .native-office-note').allTextContents()).every(text => !text.startsWith('正在读取')), format + ' own format tools finish reading');
    if (format === 'docx' || format === 'xlsx') assert.ok(await left.locator('.native-style-field').count() > 0, format + ' exposes real native properties');
    const engine = await invoke<NativeOfficeState>('office-status', { viewId: view.id });
    assert.ok(engine.viewport && engine.viewport.width > 1000, format + ' native viewport extends under sidebars');
    for (const mode of ['standard','elegant'] as const) {
      await materialGesture(left, 'left', format + ' left', mode);
      await materialGesture(ai, 'right', format + ' right', mode);
    }
    await left.screenshot({ path: join(evidence, format + '-left-panel.png'), scale: 'css' }); await ai.screenshot({ path: join(evidence, format + '-right-panel.png'), scale: 'css' });
    results[format] = { canvas: before, engine, persisted: { leftWidth: await persistedWidth('left'), rightWidth: await persistedWidth('right') }, leftPane: await left.locator(paneSelector('left')).boundingBox(), rightPane: await ai.locator(paneSelector('right')).boundingBox(), leftUrl: left.url(), rightUrl: ai.url() };
  }
  assert.deepEqual(errors, []);
  assert.equal(motionChecks.length, 18, 'Both motion modes cover DOM left/right, Web right and all three Office left/right materials');
  assert.equal(keyboardChecks.length, 2, 'DOM left and native Web right have real bounded keyboard/preview cancellation coverage');
  console.log('Full reader canvas, persisted two-sided Office resizing, real pane material gestures and keyboard cancellation: PASS');
} catch (error) { failure = error; }
finally {
  if (failure) {
    const materialTrace: unknown[] = [];
    for (const page of app.context().pages()) try {
      const trace = await page.evaluate(() => (window as unknown as { __materialTrace?: unknown[] }).__materialTrace);
      if (trace) materialTrace.push({ url: page.url(), trace });
    } catch { /* A retired owned window must not mask the original failure. */ }
    results.failureMaterialTraces = materialTrace;
  }
  try { results.lastLayout = await main.evaluate(() => ({ stored: localStorage.getItem('agentviewer.reader-panels.v1'), elements: [...document.querySelectorAll('.workbench > .reader-panel,.workbench > .floating-side-panel,.workbench > .activity-rail,.workbench > .ai-rail')].map(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return { className: node.className, x: box.x, y: box.y, width: box.width, height: box.height, position: style.position, translate: style.translate }; }) })); } catch { /* The original failure remains authoritative. */ }
  try { await main.screenshot({ path: join(evidence, failure ? 'failure.png' : 'final.png'), scale: 'css' }); } catch { /* App may have closed. */ }
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ success: !failure, errors, failure: failure ? String(failure) : undefined, results }, null, 2));
  await app.close(); console.log('evidence=' + evidence);
}
if (failure) throw failure;
