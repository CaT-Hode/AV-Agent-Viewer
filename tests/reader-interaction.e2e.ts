import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ReadingContext, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';
import type { SettingsSnapshot } from '../packages/settings/src/index';

// Every process, file and profile belongs to this run. Never attaches to or
// closes the user's installed application. Run after other focus-sensitive UI QA.
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-reader-interaction-'));
const evidence = join(directory, 'evidence'); await mkdir(evidence);
const files = { markdown: join(directory, 'dropped-reading.md'), html: join(directory, 'dropped-reading.html'), unsupported: join(directory, 'keep-existing.unsupported') };
const sourceMarkdown = '# Backed file drop\n\nReader interaction fixture, loaded from its real on-disk path.\n';
await Promise.all([
  writeFile(files.markdown, sourceMarkdown),
  writeFile(files.html, '<!doctype html><html><body><h1>Backed HTML drop</h1><p>Real local file fixture.</p></body></html>'),
  writeFile(files.unsupported, 'Unsupported file must not replace an existing document.'),
]);
const port = await new Promise<number>((done, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); });
});
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: ['--force-device-scale-factor=1', '.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], results: Record<string, unknown> = {};
const watch = (target: Page) => target.on('pageerror', error => errors.push(`${target.url()}: ${error.message}`));
app.context().pages().forEach(watch); app.context().on('page', watch);
const invoke = <T = unknown>(target: Page, method: string, args: Record<string, unknown> = {}) => target.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const state = () => invoke<WorkspaceState>(main, 'state');
const preferences = async (target: Page) => (await invoke<{ snapshot: SettingsSnapshot }>(target, 'settings-read')).snapshot;
const until = async (check: () => Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error(`等待失败：${label}`);
};
const currentZoom = async (viewId: string) => (await state()).views.find(view => view.id === viewId)?.zoom ?? 1;
const commitZoom = async (target: Page, percent: number) => { const input = target.getByRole('spinbutton', { name: '正文缩放比例', exact: true }); await input.fill(String(percent)); await input.press('Enter'); };
const toolbarState = (target: Page) => invoke<{ viewId: string; zoom?: number; backdropSample?: { sourceContentsId: number; layoutRevision: number } }>(target, 'toolbar-state');
const activate = async (viewId: string) => { await invoke(main, 'activate', { viewId }); await until(async () => (await state()).activeViewId === viewId, 'active reading view'); };

/** CDP setFileInputFiles creates genuine backed File objects. Reuse those exact
 * objects in DataTransfer; no new File(), invented file.path or direct drop IPC. */
const dropBackedFiles = async (paths: string[]) => {
  await main.evaluate(() => { document.getElementById('qa-backed-files')?.remove(); const input = document.createElement('input'); input.id = 'qa-backed-files'; input.type = 'file'; input.multiple = true; input.hidden = true; document.body.append(input); });
  await main.locator('#qa-backed-files').setInputFiles(paths);
  const selected = await main.locator('#qa-backed-files').evaluate(input => [...(input as HTMLInputElement).files!].map(file => ({ name: file.name, size: file.size })));
  assert.equal(selected.length, paths.length); assert.ok(selected.every(file => file.size > 0));
  await main.evaluate(() => {
    const input = document.getElementById('qa-backed-files') as HTMLInputElement;
    const transfer = new DataTransfer(); for (const file of input.files!) transfer.items.add(file);
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); input.remove();
  });
  return selected;
};

try {
  await main.locator('.prose h1').waitFor();
  await invoke(main, 'settings-set', { id: 'appearance.autoHideToolbar', value: false });
  await invoke(main, 'settings-set', { id: 'appearance.motion', value: 'off' });
  await invoke(main, 'settings-set', { id: 'appearance.theme', value: 'light' });
  await main.locator('html[data-motion="off"][data-theme="light"]').waitFor();
  const initial = await state(), markdown = initial.views.find(view => initial.documents.find(document => document.id === view.documentId)?.format === 'markdown')!;
  assert.ok(markdown); await until(async () => await main.getByRole('spinbutton', { name: '正文缩放比例' }).inputValue() === '100', 'initial zoom input');
  const mainContentsId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)!.id, main.url());
  const baseline = await main.locator('.prose h1').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const glyph = range.getClientRects()[0], box = element.getBoundingClientRect(); return { height: box.height, glyphHeight: glyph.height }; });
  const tabBar = await main.locator('.tab-strip').boundingBox(), capsule = await main.locator('.navigation-capsule').boundingBox(); assert.ok(tabBar && capsule);
  await commitZoom(main, 150);
  await until(async () => await currentZoom(markdown.id) === 1.5 && await main.locator('.document-content').getAttribute('data-reading-zoom') === '1.5', 'Markdown zoom reaches 150%');
  const enlarged = await main.locator('.prose h1').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return { height: element.getBoundingClientRect().height, glyphHeight: range.getClientRects()[0].height }; });
  assert.ok(Math.abs(enlarged.glyphHeight / baseline.glyphHeight - 1.5) < .04, 'painted text height follows document zoom');
  assert.ok(enlarged.height >= baseline.height * 1.4);
  assert.deepEqual(await main.locator('.tab-strip').boundingBox(), tabBar, 'tabs stay at application scale');
  assert.deepEqual(await main.locator('.navigation-capsule').boundingBox(), capsule, 'navigation remains fixed in application coordinates');
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), mainContentsId), 1);
  // Cancel is exercised through the real input and blur, catching stale draft commits.
  const zoomInput = main.getByRole('spinbutton', { name: '正文缩放比例', exact: true });
  await zoomInput.fill('225'); await zoomInput.press('Escape'); await main.waitForTimeout(750);
  assert.equal(await currentZoom(markdown.id), 1.5); assert.equal(await zoomInput.inputValue(), '150');
  const body = await main.locator('.document-content').boundingBox(); assert.ok(body);
  await main.mouse.move(body.x + body.width / 2, body.y + Math.min(300, body.height / 2));
  await main.keyboard.down('Control'); try { await main.mouse.wheel(0, -120); } finally { await main.keyboard.up('Control'); }
  await until(async () => await currentZoom(markdown.id) > 1.5, 'Ctrl+wheel increases document zoom');
  const wheelUp = await currentZoom(markdown.id);
  await main.keyboard.down('Control'); try { await main.mouse.wheel(0, 120); } finally { await main.keyboard.up('Control'); }
  await until(async () => await currentZoom(markdown.id) < wheelUp, 'Ctrl+wheel decreases document zoom');
  assert.deepEqual(await main.locator('.tab-strip').boundingBox(), tabBar);
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), mainContentsId), 1, 'Ctrl+wheel must not zoom the entire Electron shell');
  await commitZoom(main, 150); await main.screenshot({ path: join(evidence, 'markdown-150.png'), scale: 'css' });
  results.markdown = { baseline, enlarged, wheelUp, shellZoom: 1, escapeCancels: true };
  console.log('Markdown zoom, keyboard wheel, fixed chrome and Escape: PASS');

  const pdf = initial.views.find(view => initial.documents.find(document => document.id === view.documentId)?.format === 'pdf')!;
  await main.locator('.tab').filter({ hasText: '示例.pdf' }).locator('.tab-select').click();
  await main.locator('.pdf-page .textLayer span').first().waitFor();
  const pdfBase = await main.locator('.pdf-page').first().boundingBox(); assert.ok(pdfBase);
  await commitZoom(main, 150);
  await until(async () => { const box = await main.locator('.pdf-page').first().boundingBox(); return !!box && Math.abs(box.width / pdfBase.width - 1.5) < .01; }, 'PDF viewport regenerated at 150%');
  await main.locator('.pdf-page .textLayer span').first().waitFor();
  const pdfZoomed = await main.locator('.pdf-page').first().boundingBox(); assert.ok(pdfZoomed);
  assert.ok(Math.abs(pdfZoomed.height / pdfBase.height - 1.5) < .01);
  assert.equal(await currentZoom(pdf.id), 1.5); assert.deepEqual(await main.locator('.tab-strip').boundingBox(), tabBar);
  await main.screenshot({ path: join(evidence, 'pdf-150.png'), scale: 'css' }); results.pdf = { baseline: pdfBase, enlarged: pdfZoomed };
  console.log('PDF canvas/text-layer viewport zoom: PASS');

  const native = initial.views.find(view => initial.documents.find(document => document.id === view.documentId)?.format === 'web')!;
  const fixtureUrl = `http://127.0.0.1:${port}/fixtures/interaction.html`;
  await main.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click();
  await until(async () => app.context().pages().some(target => target.url().includes('#/web-toolbar')), 'trusted native toolbar');
  const toolbar = app.context().pages().find(target => target.url().includes('#/web-toolbar'))!;
  await until(async () => { const current = await toolbarState(toolbar); return current.viewId === native.id && !!current.backdropSample; }, 'native source identity');
  const nativeBefore = await invoke<ReadingContext>(main, 'context', { viewId: native.id });
  const sourceId = (await toolbarState(toolbar)).backdropSample!.sourceContentsId;
  const nativeMode = await app.evaluate(({ webContents }, id) => ({ mode: webContents.fromId(id)!.getZoomMode(), factor: webContents.fromId(id)!.getZoomFactor() }), sourceId);
  assert.equal(nativeMode.mode, 'isolated'); assert.equal(nativeMode.factor, 1);
  await commitZoom(toolbar, 150);
  await until(async () => await currentZoom(native.id) === 1.5 && await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), sourceId) === 1.5, 'native zoom applies through the real toolbar');
  await until(async () => { const current = await invoke<ReadingContext>(main, 'context', { viewId: native.id }); return current.viewport!.layoutRevision! > nativeBefore.viewport!.layoutRevision! && Math.abs(current.viewport!.width / nativeBefore.viewport!.width - 1 / 1.5) < .02; }, 'native renderer completes its zoom layout');
  const nativeAfter = await invoke<ReadingContext>(main, 'context', { viewId: native.id });
  assert.ok(nativeAfter.viewport!.layoutRevision! > nativeBefore.viewport!.layoutRevision!);
  assert.ok(Math.abs(nativeAfter.viewport!.width / nativeBefore.viewport!.width - 1 / 1.5) < .02, 'native page CSS viewport responds to its independent zoom');
  await until(async () => (await toolbarState(toolbar)).backdropSample?.layoutRevision === nativeAfter.viewport!.layoutRevision, 'native sample follows the zoom layout revision');
  const sibling = await invoke<ViewInfo>(main, 'open', { uri: fixtureUrl + '?qa=isolated-sibling', windowId: 'main' });
  await until(async () => { const current = await toolbarState(toolbar); return current.viewId === sibling.id && !!current.backdropSample; }, 'second same-origin native view');
  const siblingSourceId = (await toolbarState(toolbar)).backdropSample!.sourceContentsId;
  assert.notEqual(siblingSourceId, sourceId);
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), siblingSourceId), 1, 'same-origin second tab has its own zoom');
  await commitZoom(toolbar, 125); await until(async () => await currentZoom(sibling.id) === 1.25, 'second tab zoom changes independently');
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), sourceId), 1.5);
  await activate(native.id); await until(async () => { const current = await toolbarState(toolbar); return current.viewId === native.id && current.backdropSample?.sourceContentsId === sourceId; }, 'first native view reactivated with its own sampled surface');
  await until(async () => app.evaluate(({ BrowserWindow, WebContentsView }, id) => BrowserWindow.getAllWindows().some(window => window.contentView.children.some(view => view instanceof WebContentsView && view.webContents.id === id && view.getVisible() && view.getBounds().width > 100 && view.getBounds().height > 100)), sourceId), 'first native child view is visible again');
  assert.equal(await toolbar.getByRole('spinbutton', { name: '正文缩放比例' }).inputValue(), '150');
  assert.equal(await currentZoom(sibling.id), 1.25);
  await main.screenshot({ path: join(evidence, 'native-150.png'), scale: 'css' });
  const nativePage = app.context().pages().find(target => target.url() === fixtureUrl)!; assert.ok(nativePage);
  // CDP screenshots of a reactivated child target can stall on Chromium's
  // surface lifecycle. Capture the actual, asserted-visible native webContents
  // instead; main.screenshot does not include its sibling child surfaces.
  const nativePixels = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id)!.capturePage()).toPNG().toString('base64'), sourceId);
  await writeFile(join(evidence, 'native-page-150.png'), Buffer.from(nativePixels, 'base64'));
  await toolbar.screenshot({ path: join(evidence, 'native-toolbar-150.png'), scale: 'css' });
  results.native = { mode: nativeMode.mode, layoutBefore: nativeBefore.viewport!.layoutRevision, layoutAfter: nativeAfter.viewport!.layoutRevision, firstZoom: 1.5, sameOriginZoom: 1.25 };
  console.log('Native per-view isolated zoom, layout revision and same-origin isolation: PASS');

  const beforeDrop = await state(), tabsBefore = await main.locator('.tab').count();
  await main.getByRole('button', { name: '新建标签页', exact: true }).click(); await main.locator('.home-layout').waitFor();
  assert.equal(await main.locator('.tab').count(), tabsBefore + 1);
  const selectedFiles = await dropBackedFiles([files.markdown, files.html]);
  await until(async () => { const workspace = await state(); return [files.markdown, files.html].every(path => workspace.documents.some(document => document.path?.toLowerCase() === path.toLowerCase())); }, 'backed multi-file drop enters document library');
  await main.locator('.home-layout').waitFor({ state: 'detached' });
  await until(async () => await main.locator('.tab').count() === tabsBefore + 2, 'first file replaces the current home tab while second creates one additional tab');
  assert.equal(await main.getByRole('button', { name: '关闭 新标签页', exact: true }).count(), 0);
  const dropped = await state();
  assert.ok(beforeDrop.views.every(view => dropped.views.some(next => next.id === view.id)), 'file drop keeps all already open documents');
  assert.equal(dropped.documents.find(document => document.path?.toLowerCase() === files.markdown.toLowerCase())!.model.text, sourceMarkdown);
  const activeBeforeError = dropped.activeViewId, viewsBeforeError = dropped.views.map(view => view.id).sort();
  await dropBackedFiles([files.unsupported]);
  await main.locator('.toast').filter({ hasText: '不支持此文件类型' }).waitFor();
  await main.waitForTimeout(750); const rejected = await state();
  assert.equal(rejected.activeViewId, activeBeforeError); assert.deepEqual(rejected.views.map(view => view.id).sort(), viewsBeforeError);
  assert.equal(await main.locator('.tab').count(), tabsBefore + 2);
  assert.equal(await main.locator('.home-layout').count(), 0);
  assert.equal(await readFile(files.markdown, 'utf8'), sourceMarkdown, 'drop and zoom do not rewrite source bytes');
  results.fileDrop = { selectedFiles, replacedHome: true, preservedViews: beforeDrop.views.map(view => view.id), unsupportedPreservesActive: true };
  console.log('Genuine backed File/DataTransfer batch drop, home replacement and unsupported-file preservation: PASS');

  await invoke(main, 'settings-open', { category: '外观与布局' });
  await until(async () => app.context().pages().some(target => target.url().includes('#/settings')), 'independent settings window');
  const settings = app.context().pages().find(target => target.url().includes('#/settings'))!;
  await settings.getByRole('button', { name: '外观与布局', exact: true }).click();
  const theme = settings.getByRole('radiogroup', { name: '主题', exact: true }); await theme.waitFor();
  const compactLayout = await theme.evaluate(element => { const row = element.closest('.setting-row')!, copy = row.querySelector('.setting-copy')!, control = element.closest('.setting-control')!; const r = row.getBoundingClientRect(), c = copy.getBoundingClientRect(), box = element.getBoundingClientRect(), area = control.getBoundingClientRect(); return { height: box.height, x: box.x, labelRight: c.right, labelCenter: c.y + c.height / 2, controlCenter: box.y + box.height / 2, controlRight: area.right, expectedRight: r.right - Number.parseFloat(getComputedStyle(row).paddingRight) }; });
  assert.ok(Math.abs(compactLayout.height - 44) < .02, 'segmented choices use compact 44px desktop height');
  assert.ok(Math.abs(compactLayout.controlRight - compactLayout.expectedRight) < 1, 'options align to the right side of the same settings row');
  assert.ok(compactLayout.labelRight + 10 <= compactLayout.x); assert.ok(Math.abs(compactLayout.labelCenter - compactLayout.controlCenter) < 1);
  assert.equal(await settings.locator('select').count(), 0, 'appearance settings use segmented choices rather than native selects');
  assert.ok(await settings.locator('.settings-group-card').count() >= 2, 'settings are organized in readable cards');
  assert.equal(await settings.getByRole('checkbox', { name: '仅显示已修改', exact: true }).count(), 0);
  assert.equal(await settings.locator('.settings-undo').count(), 1, 'setting undo has one global entry');
  const undo = async (value: string) => { await settings.getByRole('button', { name: '撤销上一次设置更改', exact: true }).click(); await until(async () => (await preferences(settings)).values['appearance.theme'] === value, 'global setting undo restores theme'); };
  const themeChange = async (action: () => Promise<void>, value: string) => {
    const before = await preferences(settings); await action();
    await until(async () => (await preferences(settings)).values['appearance.theme'] === value, 'theme is committed');
    await settings.waitForTimeout(200); const after = await preferences(settings);
    assert.equal(after.revision, before.revision + 1, 'one gesture produces exactly one global settings transaction');
    await undo(String(before.values['appearance.theme'])); return { before: before.revision, after: after.revision };
  };
  const themeClick = await themeChange(() => theme.getByRole('radio', { name: '深色', exact: true }).click(), 'dark');
  const themeDrag = await themeChange(async () => {
    const from = await theme.getByRole('radio', { name: '浅色', exact: true }).boundingBox(), to = await theme.getByRole('radio', { name: '深色', exact: true }).boundingBox(); assert.ok(from && to);
    await settings.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await settings.mouse.down();
    await settings.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 }); await settings.mouse.up();
  }, 'dark');
  const themeKeyboard = await themeChange(async () => { await theme.getByRole('radio', { name: '浅色', exact: true }).focus(); await settings.keyboard.press('ArrowRight'); }, 'dark');
  const autoHide = settings.getByRole('switch', { name: '顶部胶囊自动隐藏', exact: true }); await autoHide.scrollIntoViewIfNeeded();
  const switchBox = await autoHide.boundingBox(); assert.ok(switchBox);
  assert.ok(Math.abs(switchBox.width - 96) < .02); assert.ok(Math.abs(switchBox.height - 40.2) < .02, 'source switch is displayed at the requested compact .6 scale');
  const sourceSwitch = await autoHide.evaluate(element => ({ width: Number.parseFloat(getComputedStyle(element).width), height: Number.parseFloat(getComputedStyle(element).height), zoom: Number(getComputedStyle(element).zoom) }));
  assert.equal(sourceSwitch.width, 160); assert.equal(sourceSwitch.zoom, .6);
  assert.ok(Math.abs(sourceSwitch.height - 67) <= 1 / (64 * sourceSwitch.zoom), 'Kube source track retains 67px before Chromium CSS-zoom layout-unit rounding');
  const beforeSwitch = await preferences(settings); assert.equal(beforeSwitch.values['appearance.autoHideToolbar'], false);
  await settings.mouse.move(switchBox.x + 51 * .6, switchBox.y + switchBox.height / 2); await settings.mouse.down();
  await settings.mouse.move(switchBox.x + 123 * .6, switchBox.y + switchBox.height / 2, { steps: 8 }); await settings.mouse.up();
  await until(async () => (await preferences(settings)).values['appearance.autoHideToolbar'] === true, 'source switch commits its drag');
  await settings.waitForTimeout(200); const afterSwitch = await preferences(settings);
  assert.equal(afterSwitch.revision, beforeSwitch.revision + 1);
  await settings.getByRole('button', { name: '撤销上一次设置更改', exact: true }).click();
  await until(async () => (await preferences(settings)).values['appearance.autoHideToolbar'] === false, 'global undo restores switch');
  for (const color of ['light', 'dark']) {
    await invoke(settings, 'settings-set', { id: 'appearance.theme', value: color });
    await settings.locator(`html[data-theme="${color}"]`).waitFor();
    await settings.locator('.settings-main').evaluate(element => { element.scrollTop = 0; });
    await settings.waitForTimeout(300); await settings.screenshot({ path: join(evidence, `settings-${color}.png`), scale: 'css' });
  }
  results.settings = { themeClick, themeDrag, themeKeyboard, switchBefore: beforeSwitch.revision, switchAfter: afterSwitch.revision, switchBox, sourceSwitch, compactLayout, globalUndo: true, nativeSelects: 0 };
  assert.deepEqual(errors, [], 'reader and settings retain valid renderer behavior');
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ ...results, errors }, null, 2));
  console.log('Settings click/drag/keyboard, one transaction, global undo, source switch and both themes: PASS');
  console.log('Reader interaction evidence:', evidence);
} catch (error) {
  await main.screenshot({ path: join(evidence, 'failure-main.png'), scale: 'css' }).catch(() => {});
  for (const target of app.context().pages().filter(page => page.url().includes('#/settings') || page.url().includes('#/web-toolbar'))) await target.screenshot({ path: join(evidence, pageName(target) + '-failure.png'), scale: 'css' }).catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ ...results, error: String(error), errors }, null, 2)); throw error;
} finally { await app.close(); }

function pageName(page: Page) { return page.url().includes('#/settings') ? 'settings' : 'native-toolbar'; }
