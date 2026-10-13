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
async function resize(page: Page, side: 'left' | 'right', delta: number) {
  await page.evaluate(() => { const values: unknown[] = []; (window as unknown as { __panelTrace: unknown[] }).__panelTrace = values; for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','blur']) window.addEventListener(type, event => { const pointer = event as PointerEvent, target = event.target as HTMLElement; values.push({ type, clientX: pointer.clientX, screenX: pointer.screenX, id: pointer.pointerId, windowX: screenX, className: target?.className, role: target?.getAttribute?.('role'), dragging: document.querySelector('[role=separator]')?.getAttribute('data-dragging'), width: document.querySelector('[role=separator]')?.getAttribute('aria-valuenow') }); }, true); });
  const handle = page.getByRole('separator', { name: side === 'left' ? '调整左侧工具栏宽度' : '调整右侧 AI 面板宽度' }), box = await handle.boundingBox(); assert.ok(box);
  const old = Number(await handle.getAttribute('aria-valuenow'));
  const origin = await page.evaluate(() => ({ x: screenX, y: screenY })), globalX = origin.x + box.x + box.width / 2, globalY = origin.y + box.y + box.height / 2, portalled = page !== main;
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
  try { await until(async () => main.evaluate(({ side, target }) => { const stored = JSON.parse(localStorage.getItem('agentviewer.reader-panels.v1') ?? '{}'); return Math.abs(Number(stored[side + 'Width']) - target) <= 1; }, { side, target: old + (side === 'left' ? delta : -delta) }), side + ' width persisted'); }
  catch (error) { results.resizeFailure = { side, old, delta, url: page.url(), events: await page.evaluate(() => (window as unknown as { __panelTrace: unknown[] }).__panelTrace) }; throw error; }
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
let failure: unknown;
try {
  await main.locator('.prose h1').waitFor();
  const initial = (await canvas())!; assert.ok(initial.width > 1100, 'canvas includes space under both sidebars');
  await resize(main, 'left', 90); unchanged(initial, (await canvas())!);
  await main.getByRole('button', { name: 'AI 工具', exact: true }).click(); await resize(main, 'right', -50); unchanged(initial, (await canvas())!);
  const defs = await invoke<{ definitions: { id: string }[] }>('settings-read'); assert.ok(defs.definitions.every(d => !['appearance.leftWidth','appearance.rightWidth'].includes(d.id)));
  const stored = await main.evaluate(() => localStorage.getItem('agentviewer.reader-panels.v1')); results.dom = { canvas: initial, stored };
  await main.screenshot({ path: join(evidence, 'markdown-panels.png'), scale: 'css' });
  const workspace = await invoke<WorkspaceState>('state'), web = workspace.views.find(view => workspace.documents.find(doc => doc.id === view.documentId)?.format === 'web')!; assert.ok(web);
  await invoke('activate', { viewId: web.id });
  const right = await panel('right', web.id), webCanvas = (await canvas())!;
  await resize(right, 'right', -35); unchanged(webCanvas, (await canvas())!);
  await right.screenshot({ path: join(evidence, 'web-right-panel.png'), scale: 'css' });
  await invoke('settings-set', { id: 'appearance.glass', value: 'off' });
  await until(async () => await right.locator('html').getAttribute('data-glass') === 'off' && await right.locator('.reader-panel-backdrop').evaluate(node => getComputedStyle(node).backgroundImage === 'none'), 'disabled frost stops native background publication');
  await invoke('settings-set', { id: 'appearance.glass', value: 'standard' });
  await until(async () => right.locator('.reader-panel-backdrop').evaluate(node => getComputedStyle(node).backgroundImage.startsWith('url(')), 'frost resumes from the same source');
  await right.getByRole('separator').focus(); await right.keyboard.press('Control+,');
  await until(async () => app.context().pages().some(page => page.url().includes('#/settings')), 'same app shortcuts work in owned toolbars');
  await app.context().pages().find(page => page.url().includes('#/settings'))!.close();
  const layers = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ url: window.webContents.getURL(), visible: window.isVisible(), bounds: window.getBounds(), parent: window.getParentWindow()?.webContents.getURL() })));
  results.web = { canvas: webCanvas, layers };
  const samples = await main.evaluate(async () => { const response = await fetch('/api/samples'); return response.json(); }) as { path: string; format: string }[];
  for (const format of ['docx','xlsx','pptx']) {
    const sample = samples.find(item => item.format === format); assert.ok(sample);
    const path = join(directory, basename(sample.path)); await copyFile(sample.path, path);
    const view = await invoke<ViewInfo>('open', { uri: path }); await invoke('activate', { viewId: view.id });
    await until(async () => { try { const state = await invoke<NativeOfficeState>('office-status', { viewId: view.id }); return state.status === 'ready' && !!state.visible && !!state.nativeGeometry; } catch { return false; } }, format + ' native ready', 1500);
    const left = await panel('left', view.id), ai = await panel('right', view.id), before = (await canvas())!;
    await resize(left, 'left', 24); unchanged(before, (await canvas())!);
    await until(async () => (await left.locator('.native-style-inspector .native-office-note').allTextContents()).every(text => !text.startsWith('正在读取')), format + ' own format tools finish reading');
    if (format === 'docx' || format === 'xlsx') assert.ok(await left.locator('.native-style-field').count() > 0, format + ' exposes real native properties');
    const engine = await invoke<NativeOfficeState>('office-status', { viewId: view.id });
    assert.ok(engine.viewport && engine.viewport.width > 1000, format + ' native viewport extends under sidebars');
    await left.screenshot({ path: join(evidence, format + '-left-panel.png'), scale: 'css' }); await ai.screenshot({ path: join(evidence, format + '-right-panel.png'), scale: 'css' });
    results[format] = { canvas: before, engine, leftUrl: left.url(), rightUrl: ai.url() };
  }
  assert.deepEqual(errors, []);
  console.log('Reader canvas stays full width; DOM/Web/native sidebars resize, sample real pixels and retain one React tree: PASS');
} catch (error) { failure = error; }
finally {
  try { results.lastLayout = await main.evaluate(() => ({ stored: localStorage.getItem('agentviewer.reader-panels.v1'), elements: [...document.querySelectorAll('.workbench > .reader-panel,.workbench > .floating-side-panel,.workbench > .activity-rail,.workbench > .ai-rail')].map(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return { className: node.className, x: box.x, y: box.y, width: box.width, height: box.height, position: style.position, translate: style.translate }; }) })); } catch { /* The original failure remains authoritative. */ }
  try { await main.screenshot({ path: join(evidence, failure ? 'failure.png' : 'final.png'), scale: 'css' }); } catch { /* App may have closed. */ }
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ success: !failure, errors, failure: failure ? String(failure) : undefined, results }, null, 2));
  await app.close(); console.log('evidence=' + evidence);
}
if (failure) throw failure;
