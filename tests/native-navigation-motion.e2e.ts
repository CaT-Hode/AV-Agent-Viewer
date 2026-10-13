import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { WorkspaceState } from '../packages/contracts/src/index';

// The source and installed executable use the same real keyboard/scroll/edge
// probes. Every run owns its fresh profile, port and Electron process.
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-native-navigation-motion-')), evidence = join(directory, 'evidence'); await mkdir(evidence);
await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, revision: 0, values: { 'appearance.motion': 'standard', 'appearance.autoHideToolbar': true, 'appearance.toolbarDelayMs': 10000, 'appearance.theme': 'light', 'translation.selectionAuto': false } }));
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: process.env.AGENTVIEWER_QA_EXE ?? require('electron'), args: process.env.AGENTVIEWER_QA_EXE ? [] : ['.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], checks: Record<string, unknown> = {};
const watch = (page: Page) => { page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message)); }; app.context().pages().forEach(watch); app.context().on('page', watch);
const invoke = <T>(method: string, args: Record<string, unknown> = {}) => main.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const until = async (check: () => Promise<boolean>, label: string, ms = 10000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await check()) return; await wait(30); } throw new Error('Timeout: ' + label); };
const motion = (page: Page) => page.evaluate(() => {
  const nav = document.querySelector('.navigation-toolbar'); if (!nav) return null;
  const style = getComputedStyle(nav), matrix = new DOMMatrix(style.transform), module = nav.querySelector('.navigation-module')!;
  return { hidden: nav.classList.contains('is-hidden'), visibility: style.visibility, opacity: style.opacity, scale: matrix.a, translateY: matrix.f, moduleOpacity: Number(getComputedStyle(module).opacity), duration: style.getPropertyValue('--navigation-hide-duration'), source: document.documentElement.dataset.motionInput, mode: document.documentElement.dataset.motion };
});
const viewVisible = (page: Page) => app.evaluate(({ BrowserWindow, WebContentsView }, url) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).flatMap(window => window.contentView.children).find(view => view instanceof WebContentsView && !view.webContents.isDestroyed() && view.webContents.getURL() === url)?.getVisible(), page.url());
const capture = async (page: Page, label: string) => { const data = await app.evaluate(async ({ webContents }, url) => (await webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.getURL() === url)!.capturePage()).toPNG().toString('base64'), page.url()); await writeFile(join(evidence, label + '.png'), Buffer.from(data, 'base64')); };
let native: Page | undefined, toolbar: Page | undefined;
try {
  await main.locator('.prose h1').waitFor();
  const initial = await invoke<WorkspaceState>('state'), web = initial.views.find(view => initial.documents.find(document => document.id === view.documentId)?.format === 'web')!, markdown = initial.views.find(view => initial.documents.find(document => document.id === view.documentId)?.format === 'markdown')!;
  await main.locator(`.tab[data-view-id="${web.id}"] .tab-select`).click();
  await until(async () => app.context().pages().some(page => page.url().includes('#/web-toolbar')), 'native navigation exists');
  toolbar = app.context().pages().find(page => page.url().includes('#/web-toolbar'))!;
  native = app.context().pages().find(page => page.url() === `http://127.0.0.1:${port}/fixtures/interaction.html`)!; assert.ok(native);
  // Playwright normally forces every CDP page to appear focused. That prevents
  // a real native WC handoff from emitting window.blur and is unsuitable for
  // this regression. Turn the override off, not the production focus guard.
  const toolbarCDP = await app.context().newCDPSession(toolbar), nativeCDP = await app.context().newCDPSession(native);
  await toolbarCDP.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await nativeCDP.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await toolbar.evaluate("window.__navFocusTrace=[];for(const type of ['blur','focus'])window.addEventListener(type,()=>window.__navFocusTrace.push({type,at:performance.now(),focused:document.hasFocus(),active:document.activeElement?.className}));");
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.getURL() === url)!.focus(), toolbar.url());
  const nextURL = `http://127.0.0.1:${port}/fixtures/interaction.html?qa=keyboard-motion`;
  await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).fill(nextURL); await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).press('Enter');
  await until(async () => native!.url() === nextURL && (await invoke<WorkspaceState>('state')).documents.find(document => document.id === web.documentId)?.model.url === nextURL, 'real keyboard address navigation is synchronized');
  assert.equal((await motion(toolbar))?.source, 'keyboard', 'the native toolbar really last received keyboard input');
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.getURL() === url)!.focus(), native.url());
  await native.getByRole('heading', { name: '网页交互测试', exact: true }).click();
  checks.nativeFocus = { page: await native.evaluate(() => ({ focused: document.hasFocus(), active: document.activeElement?.tagName })), toolbar: await toolbar.evaluate(() => ({ focused: document.hasFocus(), active: document.activeElement?.className, events: (window as unknown as { __navFocusTrace: unknown[] }).__navFocusTrace })) };
  await native.mouse.move(700, 450); await native.mouse.wheel(0, 220);
  await until(async () => (await motion(toolbar!))?.hidden === true, 'webpage scroll begins an automatic hide after address keyboard input');
  await wait(100); const partial = await motion(toolbar); checks.afterKeyboardScroll = partial; assert.ok(partial);
  assert.ok(partial.moduleOpacity > 0 && partial.moduleOpacity < 1, 'keyboard history cannot unmount the native scroll-hide transition early');
  assert.ok(partial.scale > .965 && partial.scale < 1); assert.equal(partial.opacity, '1'); assert.equal(await viewVisible(toolbar), true);
  await capture(toolbar, 'native-scroll-mid-close');
  await until(async () => await viewVisible(toolbar!) === false, 'native scroll closing eventually removes paint and input');
  await native.mouse.move(300, 8); await wait(80); assert.equal(await viewVisible(toolbar), false, '8px is outside the explicit reveal edge');
  await native.mouse.move(300, 5); await until(async () => await viewVisible(toolbar!) === true && !!(await motion(toolbar!)), '5px edge reveals the native capsule'); await wait(100);
  const opening = await motion(toolbar); checks.nativeEdgeOpening = opening; assert.ok(opening && opening.moduleOpacity > 0 && opening.moduleOpacity < 1, 'edge remount paints a real opening intermediate frame'); await wait(650);
  await invoke('settings-set', { id: 'appearance.autoHideToolbar', value: false });
  for (const [mode, maximum] of [['off', 0], ['reduced', 80]] as const) {
    await invoke('settings-set', { id: 'appearance.motion', value: 'standard' });
    await native.mouse.move(300, 100); await native.mouse.move(300, 5); await until(async () => (await motion(toolbar!))?.hidden === false, 'edge clears the prior manual dismissal'); await wait(700);
    await toolbar.getByRole('button', { name: '关闭导航栏', exact: true }).click(); await wait(100); assert.equal(await viewVisible(toolbar), true);
    await invoke('settings-set', { id: 'appearance.motion', value: mode });
    const trace: unknown[] = []; checks['midExit-' + mode] = trace;
    await until(async () => {
      const visible = await viewVisible(toolbar!), dom = await motion(toolbar!);
      const host = await toolbar!.evaluate(() => window.agentViewer!.call('toolbar-state', {})) as { hideDurationMs: number; visible: boolean };
      trace.push({ visible, dom, hostDuration: host.hideDurationMs, stateVisible: host.visible });
      return visible === false && (!dom || dom.visibility === 'hidden') && host.hideDurationMs === maximum;
    }, mode + ' cancels the transparent native interception deadline', maximum + 350);
  }
  await invoke('settings-set', { id: 'appearance.motion', value: 'standard' });
  await main.locator(`.tab[data-view-id="${markdown.id}"] .tab-select`).click();
  const reader = await main.locator('.reader-panel').boundingBox(); assert.ok(reader);
  await main.mouse.move(reader.x + reader.width / 2, reader.y + 5); await until(async () => (await motion(main))?.hidden === false, 'local document preserves shared top-edge recovery'); await wait(650);
  await main.getByRole('button', { name: '关闭导航栏', exact: true }).click(); await wait(140);
  const local = await motion(main); checks.localMidClose = local; assert.ok(local && local.moduleOpacity > 0 && local.moduleOpacity < 1 && local.scale > .965 && local.scale < 1); assert.equal(local.opacity, '1');
  await main.screenshot({ path: join(evidence, 'local-mid-close.png'), scale: 'css' }); await wait(600);
  await main.mouse.move(reader.x + reader.width / 2, reader.y + 8); await wait(80); assert.equal((await motion(main))?.visibility, 'hidden');
  await main.mouse.move(reader.x + reader.width / 2, reader.y + 5); await wait(100); const localOpening = await motion(main); checks.localOpening = localOpening; assert.ok(localOpening && localOpening.moduleOpacity > 0 && localOpening.moduleOpacity < 1); await wait(650);
  await main.screenshot({ path: join(evidence, 'local-opening-settled.png'), scale: 'css' });
  assert.deepEqual(errors, []); await writeFile(join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', checks, errors, actualRenderer: await main.evaluate(() => [...document.scripts].map(script => script.src).filter(Boolean)) }, null, 2));
  console.log('Native keyboard-scroll, edge, off/reduced and local navigation motion: PASS', evidence);
} catch (error) {
  await main.screenshot({ path: join(evidence, 'failure-main.png') }).catch(() => {}); if (toolbar) await capture(toolbar, 'failure-toolbar').catch(() => {}); if (native) await capture(native, 'failure-source').catch(() => {});
  const hostState = toolbar ? await toolbar.evaluate(async () => { const { backdropImage: _image, ...value } = await window.agentViewer!.call('toolbar-state', {}) as Record<string, unknown>; return value; }).catch(() => undefined) : undefined;
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), checks, errors, nativeNavigation: toolbar ? await motion(toolbar).catch(() => undefined) : undefined, hostState }, null, 2)); console.error('Navigation motion evidence', evidence); throw error;
} finally { await app.close(); }
