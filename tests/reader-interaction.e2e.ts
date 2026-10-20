import { _electron as electron, type Locator, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ReadingContext, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';
import type { SettingsSnapshot } from '../packages/settings/src/index';
import { recordCurrentBuild } from './helpers/current-build';
import { verifyReaderMotion } from './helpers/reader-motion';

// Every process, file and profile belongs to this run. Never attaches to or
// closes the user's installed application. Run after other focus-sensitive UI QA.
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-reader-interaction-'));
const evidence = join(directory, 'evidence'); await mkdir(evidence);
await recordCurrentBuild(evidence);
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
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_CONNECTION_FILE: join(directory, 'runtime', 'connection.json'), AGENTVIEWER_PORT: String(port), AGENTVIEWER_ISOLATED_QA: '1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'AGENTVIEWER_TEST_MODE', 'AGENTVIEWER_TEST_TRANSLATOR', 'AGENTVIEWER_VITE_URL', 'AGENTVIEWER_OFFICE_WORKER_MODE']) delete env[key];
const app = await electron.launch({ executablePath: require('electron'), args: ['--force-device-scale-factor=1', '.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], consoleErrors: { url: string; text: string; location: { url: string; lineNumber: number; columnNumber: number } }[] = [], results: Record<string, unknown> = {};
const watch = (target: Page) => {
  target.on('pageerror', error => errors.push(`${target.url()}: ${error.stack ?? error.message}`));
  target.on('console', entry => { if (entry.type() === 'error') consoleErrors.push({ url: target.url(), text: entry.text(), location: entry.location() }); });
};
app.context().pages().forEach(watch); app.context().on('page', watch);
const invoke = <T = unknown>(target: Page, method: string, args: Record<string, unknown> = {}) => target.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const state = () => invoke<WorkspaceState>(main, 'state');
const preferences = async (target: Page) => (await invoke<{ snapshot: SettingsSnapshot }>(target, 'settings-read')).snapshot;
const until = async (check: () => Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error(`等待失败：${label}`);
};
const currentZoom = async (viewId: string) => (await state()).views.find(view => view.id === viewId)?.zoom ?? 1;
const selectTextWithMouse = async (target: Locator, needle: string) => {
  await target.evaluate((node, text) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let leaf: Node | null;
    while ((leaf = walker.nextNode())) if (leaf.textContent!.includes(text)) { leaf.parentElement!.scrollIntoView({ block: 'nearest' }); return; }
    throw new Error('Missing visible selection text: ' + text);
  }, needle);
  await main.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const points = await target.evaluate((node, text) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let leaf: Node | null;
    while ((leaf = walker.nextNode())) {
      const from = leaf.textContent!.indexOf(text); if (from < 0) continue;
      // Ranges measure glyphs only. The browser selection comes from pointer input.
      const range = document.createRange(); range.setStart(leaf, from); range.setEnd(leaf, from + 1);
      const first = range.getBoundingClientRect(); range.setStart(leaf, from + text.length - 1); range.setEnd(leaf, from + text.length);
      const last = range.getBoundingClientRect();
      return { start: { x: first.left + .2, y: first.top + first.height / 2 }, end: { x: last.right - .2, y: last.top + last.height / 2 } };
    }
    throw new Error('Selection text disappeared after layout: ' + text);
  }, needle);
  await main.mouse.move(points.start.x, points.start.y); await main.mouse.down();
  try { await main.mouse.move(points.end.x, points.end.y, { steps: 4 }); } finally { await main.mouse.up(); }
};
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
  await main.locator('.markdown-live .md-heading-1').waitFor();
  await invoke(main, 'settings-set', { id: 'appearance.autoHideToolbar', value: false });
  await invoke(main, 'settings-set', { id: 'appearance.motion', value: 'off' });
  await invoke(main, 'settings-set', { id: 'appearance.theme', value: 'light' });
  await main.locator('html[data-motion="off"][data-theme="light"]').waitFor();
  const initial = await state(), markdown = initial.views.find(view => initial.documents.find(document => document.id === view.documentId)?.format === 'markdown')!;
  assert.ok(markdown); await until(async () => await main.getByRole('spinbutton', { name: '正文缩放比例' }).inputValue() === '100', 'initial zoom input');
  const mainContentsId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)!.id, main.url());
  const baseline = await main.locator('.markdown-live .md-heading-1').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const glyph = range.getClientRects()[0], box = element.getBoundingClientRect(); return { height: box.height, glyphHeight: glyph.height }; });
  const tabBar = await main.locator('.tab-strip').boundingBox(), capsule = await main.locator('.navigation-capsule').boundingBox(); assert.ok(tabBar && capsule);
  await commitZoom(main, 150);
  await until(async () => await currentZoom(markdown.id) === 1.5 && await main.locator('.document-content').getAttribute('data-reading-zoom') === '1.5', 'Markdown zoom reaches 150%');
  const enlarged = await main.locator('.markdown-live .md-heading-1').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return { height: element.getBoundingClientRect().height, glyphHeight: range.getClientRects()[0].height }; });
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

  const markdownFile = initial.documents.find(document => document.id === markdown.documentId)!;
  const sourceBefore = markdownFile.model.text!, appended = 'Review 中文🙂';
  const editor = main.locator('.markdown-live .cm-content');
  await editor.click(); await main.keyboard.press('Control+End'); await main.keyboard.insertText(appended);
  const text = async () => (await state()).documents.find(document => document.id === markdown.documentId)!.model.text;
  await until(async () => await text() === sourceBefore + appended, 'live Markdown input reaches the shared document');
  await main.keyboard.press('Control+z');
  await until(async () => await text() === sourceBefore, 'editor undo reaches Core');
  await main.keyboard.press('Control+y');
  await until(async () => await text() === sourceBefore + appended, 'editor redo reaches Core');
  await main.keyboard.press('Control+s');
  await until(async () => await readFile(markdownFile.path!, 'utf8') === sourceBefore + appended, 'keyboard save writes the edited Markdown');
  results.markdownEditing = { input: true, undo: true, redo: true, diskSave: true };
  results.readerMotion = await verifyReaderMotion(main, directory, evidence);
  await activate(markdown.id);

  // One end-to-end authoring flow covers the shared source/history, table form,
  // delayed renderer and sidebar command paths rather than many isolated tests.
  const authoringSource = '---\ntitle: "Authoring"\nauthor: "Original"\n---\n\n# Authoring workflow\n\n[TOC]\n\nPlain text. Footnote[^check]. Emoji :rocket:.\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n\nInline $x^2$ formula.\n\n$$\na^2+b^2=c^2\n$$\n\n```mermaid\nflowchart LR\n A[Start] --> B[Finish]\n```\n\n```sequence\nAlice->Bob: Hello\nNote right of Bob: A note\nBob-->Alice: Reply\n```\n\n```flow\nst=>start: Start\nop=>operation: Action\ne=>end: End\nst->op->e\n```\n\n[^check]: Footnote content.\n\n<div><strong>Safe embedded HTML</strong><script>window.unsafeMarkdown=true</script></div>\n';
  const embeddedImage='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eFQAAAAASUVORK5CYII=';
  const authoringInline = '\nInline extensions ==**nested bold** and *nested italic*==, ~sub~, ~**nested sub**~, ^super^, ^*nested super*^.\n\nEscaped \\==literal highlight== and entity &#61;&#61;entity highlight==; `==literal code== ~code~ ^code^`.\n\n- [ ] Outer task\n  - [x] Nested task\n';
  const localImageName='local image#%.png'; await writeFile(join(directory,localImageName),Buffer.from(embeddedImage.split(',')[1],'base64'));
  const authoringPath = join(directory, 'authoring-workflow.md'); await writeFile(authoringPath, authoringSource+authoringInline+'\n![Embedded fixture]('+embeddedImage+')\n\n![Local special filename]('+encodeURIComponent(localImageName)+')\n\nFootnote with colon[^a:b].\n\n[^a:b]: Colon footnote.\n');
  const authoring = await invoke<ViewInfo>(main, 'open', { uri: authoringPath, windowId: 'main' });
  await until(async () => await main.locator('[data-markdown-view=' + JSON.stringify(authoring.id) + ']').count() === 1, 'new source editor activates');
  const authoredText = async () => (await state()).documents.find(item => item.id === authoring.documentId)!.model.text!;
  await main.getByRole('button', { name: 'Markdown工具', exact: true }).click();
  const tools = main.getByLabel('Markdown 编辑工具'), sourceEditor = main.locator('[data-markdown-view=' + JSON.stringify(authoring.id) + ']');
  await sourceEditor.locator('.cm-content').click(); await main.keyboard.press('Control+End'); await main.keyboard.insertText('\n\nSelected'); await main.keyboard.press('Shift+Home');
  await tools.getByRole('button', { name: '粗体', exact: true }).click();
  await until(async () => (await authoredText()).endsWith('**Selected**'), 'sidebar preserves source selection and applies bold');
  const changeMode = async (mode: string) => { const button = main.getByRole('button', { name: mode, exact: true }); if (!await button.isVisible()) await main.getByRole('button', { name: '更多导航工具', exact: true }).click(); await button.click(); };
  await changeMode('源码'); await main.locator('.markdown-editor:not(.markdown-live)').waitFor();
  await tools.getByRole('button', { name: '撤销', exact: true }).click();
  await until(async () => (await authoredText()).endsWith('Selected') && !(await authoredText()).endsWith('**Selected**'), 'live/source modes keep one undo history');
  await tools.getByRole('button', { name: '重做', exact: true }).click(); await until(async () => (await authoredText()).endsWith('**Selected**'), 'source mode redo restores formatting');
  await changeMode('阅读'); await main.locator('.markdown-live').waitFor();
  await main.evaluate(input => window.dispatchEvent(new CustomEvent('agentviewer:markdown-navigate', { detail: { ...input, select: false } })), { viewId: authoring.id, from: (await authoredText()).indexOf('| Name |') });
  const tableCell = sourceEditor.getByRole('textbox', { name: '表格第 2 行第 1 列', exact: true }); await tableCell.fill('Changed|cell'); await tableCell.press('Tab');
  await until(async () => (await authoredText()).includes('Changed\\|cell'), 'visual table edit preserves literal pipes');
  await sourceEditor.getByRole('button', { name: '增加一行', exact: true }).click();
  await until(async () => await sourceEditor.locator('.md-table-widget tr').count() === 3, 'table row insertion updates source and visual controls');
  await tools.getByRole('button', { name: '专注模式', exact: true }).click(); assert.equal(await sourceEditor.evaluate(node => node.classList.contains('markdown-focus')), true);
  await tools.getByRole('button', { name: '打字机模式', exact: true }).click(); assert.equal(await sourceEditor.evaluate(node => node.classList.contains('markdown-typewriter')), true);
  await tools.getByRole('button', { name: '替换', exact: true }).click(); await sourceEditor.locator('.cm-search input[name="replace"]').waitFor();
  await sourceEditor.locator('.cm-search button[name="close"]').click();
  const revealPreview = async (from: number) => { await main.evaluate(input => window.dispatchEvent(new CustomEvent('agentviewer:markdown-navigate', { detail: { ...input, select: false } })), { viewId: authoring.id, from }); };
  await revealPreview((await authoredText()).indexOf('Inline $')); await sourceEditor.locator('.md-render-math svg').first().waitFor({ timeout: 45000 });
  for (const language of ['mermaid', 'sequence', 'flow']) { await revealPreview((await authoredText()).indexOf('```' + language)); const diagram = sourceEditor.locator('[data-diagram-language=' + JSON.stringify(language) + ']'); await diagram.locator('svg').waitFor({ timeout: 45000 }); }
  await revealPreview(0);
  await sourceEditor.getByLabel('文档信息 author', { exact: true }).fill('"Updated"'); await sourceEditor.getByLabel('文档信息 author', { exact: true }).press('Enter');
  await until(async () => (await authoredText()).includes('author: "Updated"'), 'Frontmatter field writes one source transaction');
  await revealPreview((await authoredText()).indexOf('[^check]:'));
  const footnote = sourceEditor.getByLabel('脚注内容 check', { exact: true }); await footnote.fill('Edited footnote.'); await footnote.press('Tab'); await until(async () => (await authoredText()).includes('[^check]: Edited footnote.'), 'footnote visual edit updates definition');
  assert.equal(await main.evaluate(() => (window as Window & { unsafeMarkdown?: boolean }).unsafeMarkdown), undefined, 'raw HTML never executes document scripts');
  await revealPreview((await authoredText()).indexOf('Inline extensions'));
  await sourceEditor.locator('.md-highlight .md-strong').filter({ hasText: 'nested bold' }).waitFor();
  await sourceEditor.locator('.md-highlight .md-emphasis').filter({ hasText: 'nested italic' }).waitFor();
  await sourceEditor.locator('.md-sub .md-strong').filter({ hasText: 'nested sub' }).waitFor(); await sourceEditor.locator('.md-super .md-emphasis').filter({ hasText: 'nested super' }).waitFor();
  assert.equal(await sourceEditor.locator('.md-highlight').filter({ hasText: 'literal highlight' }).count(), 0, 'escaped highlight stays literal in the live editor');
  assert.equal(await sourceEditor.locator('.md-highlight').filter({ hasText: 'entity highlight' }).count(), 0, 'entity-decoded equals do not create live delimiters');
  await revealPreview((await authoredText()).indexOf('- [ ] Outer task')); await until(async () => await sourceEditor.locator('.md-task-checkbox').count() === 2, 'nested GFM tasks produce both actual checkboxes');
  assert.equal(await sourceEditor.locator('.md-task-checkbox').nth(0).isChecked(), false); assert.equal(await sourceEditor.locator('.md-task-checkbox').nth(1).isChecked(), true);
  const localLiveImage=sourceEditor.getByAltText('Local special filename',{exact:true});await localLiveImage.scrollIntoViewIfNeeded();await until(async()=>localLiveImage.evaluate(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth===1),'relative local image with spaces/hash/percent decodes in live mode');await localLiveImage.evaluate(image=>(image as HTMLImageElement).decode());
  const exportChunk = (await readdir(resolve('dist/renderer/assets'))).find(name => /^markdown-export-.*\.js$/.test(name)); assert.ok(exportChunk);
  const exported = await main.evaluate(async input => { const module = await import(input.url); return module.renderMarkdownForExport(input.source, input.documentId) as Promise<string>; }, { url: new URL('assets/' + exportChunk, main.url()).href, source: await authoredText(), documentId: authoring.documentId });
  const exportContents = await main.evaluate(html => { const document = new DOMParser().parseFromString(html, 'text/html'); return { svg: document.querySelectorAll('svg').length, footnote: document.body.textContent!.includes('Edited footnote.'), script: document.querySelectorAll('script').length, toc: document.querySelectorAll('.av-toc a').length, html: document.body.textContent!.includes('Safe embedded HTML'), emoji: document.body.textContent!.includes('🚀'), nestedHighlight: [...document.querySelectorAll('mark')].some(mark => mark.querySelector('strong')?.textContent === 'nested bold' && mark.querySelector('em')?.textContent === 'nested italic'), sub: [...document.querySelectorAll('sub')].some(node => node.textContent === 'sub'), nestedSub: document.querySelector('sub strong')?.textContent === 'nested sub', super: [...document.querySelectorAll('sup')].some(node => node.textContent === 'super'), nestedSuper: document.querySelector('sup em')?.textContent === 'nested super', literalEscapes: document.body.textContent!.includes('==literal highlight==') && document.body.textContent!.includes('==entity highlight=='), literalCode: [...document.querySelectorAll('code')].some(node => node.textContent === '==literal code== ~code~ ^code^'), nestedTasks: document.querySelectorAll('li.task-list-item li.task-list-item input[checked]').length }; }, exported);
  assert.ok(exportContents.svg >= 5, 'frozen full source exports both formulas and all three diagram languages'); assert.equal(exportContents.script, 0); assert.equal(exportContents.footnote, true); assert.ok(exportContents.toc >= 1); assert.equal(exportContents.html, true); assert.equal(exportContents.emoji, true);
  assert.equal(exportContents.nestedHighlight, true); assert.equal(exportContents.sub, true); assert.equal(exportContents.nestedSub, true); assert.equal(exportContents.super, true); assert.equal(exportContents.nestedSuper, true); assert.equal(exportContents.literalEscapes, true); assert.equal(exportContents.literalCode, true); assert.equal(exportContents.nestedTasks, 1, 'export retains nested GFM tasks and inline syntax without flattening their children');
  assert.equal(await main.evaluate(html => new DOMParser().parseFromString(html,'text/html').querySelector('img[alt="Embedded fixture"]')?.getAttribute('src'),exported),embeddedImage,'embedded PNG survives full-source export and backend image validation');
  assert.equal(await main.evaluate(html => new DOMParser().parseFromString(html,'text/html').querySelector('img[alt="Local special filename"]')?.getAttribute('src'),exported),embeddedImage,'relative local image becomes a self-contained data URI in full-source export');
  await writeFile(join(evidence, 'markdown-export.html'), exported);
  const exportedFiles: Record<string, unknown> = {};
  const revision = (await state()).documents.find(item => item.id === authoring.documentId)!.revision;
  for (const format of ['html', 'pdf', 'png']) {
    const destination = join(evidence, 'authoring-export.' + format);
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, destination);
    if (format === 'png') await app.evaluate(({ app }) => { const captures: unknown[] = []; (globalThis as typeof globalThis & { qaPngViewports?: unknown[] }).qaPngViewports = captures; app.on('browser-window-created', (_event, window) => { const capture = window.webContents.capturePage.bind(window.webContents); window.webContents.capturePage = async (...args) => { captures.push(await window.webContents.executeJavaScript('({clientWidth:document.documentElement.clientWidth,innerWidth,scrollY})')); return capture(...args); }; }); });
    const output = await invoke<{ paths: string[]; revision: number }>(main, 'markdown-export', { documentId: authoring.documentId, expectedRevision: revision, format, html: exported });
    assert.equal(output.revision, revision); assert.ok(output.paths.length > 0);
    const buffers = await Promise.all(output.paths.map(path => readFile(path))); assert.ok(buffers.every(buffer => buffer.length > 100));
    if (format === 'html') { assert.match(buffers[0].toString('utf8'), /Safe embedded HTML/); assert.match(buffers[0].toString('utf8'), /Edited footnote/); }
    if (format === 'pdf') { const { PDFDocument } = await import('pdf-lib'); const pdf = await PDFDocument.load(buffers[0]); assert.ok(pdf.getPageCount() >= 2, 'complete authoring document spans multiple PDF pages'); exportedFiles.pdf = { paths: output.paths, pages: pdf.getPageCount() }; }
    else if (format === 'png') {
      assert.ok(buffers.length >= 2, 'tall export creates all numbered image segments');
      const sizes = await app.evaluate(({ nativeImage }, paths) => paths.map(path => nativeImage.createFromPath(path).getSize()), output.paths);
      assert.ok(sizes.every(size => size.width === 1100 && size.height > 0 && size.height <= 1200));
      assert.ok(sizes.slice(0, -1).every(size => size.height === 1200));
      const captures = await app.evaluate(() => (globalThis as typeof globalThis & { qaPngViewports?: { clientWidth: number; innerWidth: number; scrollY: number }[] }).qaPngViewports!);
      assert.ok(captures.length === sizes.length && captures.every(item => item.clientWidth === 1100 && item.innerWidth === 1100), 'PNG capture uses the full content width without a scrollbar gutter');
      const edgePixels = await app.evaluate(({ nativeImage }, paths) => paths.map(path => { const image = nativeImage.createFromPath(path), { width, height } = image.getSize(), bitmap = image.toBitmap(); let nonWhite = 0; for (let y = 0; y < height; y++) for (let x = width - 15; x < width; x++) { const index = (y * width + x) * 4; if (bitmap[index] < 245 || bitmap[index + 1] < 245 || bitmap[index + 2] < 245) nonWhite++; } return nonWhite; }), output.paths);
      assert.ok(edgePixels.every(count => count === 0), 'PNG right margin has no captured scrollbar track or arrows');
      const exportedHeight = await app.evaluate(async ({ BrowserWindow }, html) => { const preview = new BrowserWindow({ show: false, width: 1100, height: 1200, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); try { await preview.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); await preview.webContents.executeJavaScript('document.fonts.ready'); return await preview.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)') as number; } finally { preview.destroy(); } }, exported);
      assert.equal(sizes.reduce((height, size) => height + size.height, 0), exportedHeight, 'PNG segments cover the entire exported document without a missing bottom crop');
      exportedFiles.png = { paths: output.paths, sizes, height: exportedHeight, captures, edgePixels };
    } else exportedFiles.html = { paths: output.paths };
  }
  assert.equal((await state()).documents.find(item => item.id === authoring.documentId)!.revision, revision, 'export does not mutate the source revision');
  assert.match(await sourceEditor.getByLabel('文档统计').innerText(), /字词.*字符.*行/);
  const writingPreferences = main.getByLabel('Markdown 偏好配置', { exact: true });
  await writingPreferences.getByLabel('Markdown 主题 CSS', { exact: true }).fill('.markdown-editor { --qa-markdown-theme: applied; }');
  await writingPreferences.getByLabel('Markdown 快捷键配置', { exact: true }).fill(JSON.stringify({ bold: 'Alt-b', undo: '', find: '' }));
  await writingPreferences.getByRole('button', { name: '保存配置', exact: true }).click();
  await until(async () => (await sourceEditor.evaluate(node => getComputedStyle(node).getPropertyValue('--qa-markdown-theme'))).trim() === 'applied', 'saved custom CSS applies within the real editor');
  await sourceEditor.locator('.cm-content').focus(); await main.keyboard.press('Control+End'); await main.keyboard.insertText('\n\nShortcut proof'); await main.keyboard.press('Shift+Home');
  await main.keyboard.press('Control+b'); await main.waitForTimeout(200);
  assert.ok((await authoredText()).endsWith('Shortcut proof') && !(await authoredText()).endsWith('**Shortcut proof**'), 'rebound formatting no longer runs its original default key');
  await main.keyboard.press('Alt+b'); await until(async () => (await authoredText()).endsWith('**Shortcut proof**'), 'configured formatting key runs the normal command');
  const beforeDisabledUndo = await authoredText(); await main.keyboard.press('Control+z'); await main.waitForTimeout(200);
  assert.equal(await authoredText(), beforeDisabledUndo, 'empty undo binding blocks the inherited CodeMirror key as well');
  await main.keyboard.press('Control+f'); assert.equal(await sourceEditor.locator('.cm-search').count(), 0, 'empty find binding blocks the inherited search key');
  await tools.getByRole('button', { name: '撤销', exact: true }).click(); await until(async () => !(await authoredText()).endsWith('**Shortcut proof**'), 'disabled keyboard binding does not disable the sidebar command');
  await writingPreferences.getByLabel('Markdown 主题 CSS', { exact: true }).fill(''); await writingPreferences.getByLabel('Markdown 快捷键配置', { exact: true }).fill('{}');
  await writingPreferences.getByRole('button', { name: '保存配置', exact: true }).click();
  await until(async () => !(await sourceEditor.evaluate(node => getComputedStyle(node).getPropertyValue('--qa-markdown-theme'))).trim(), 'clearing custom CSS restores the document theme');
  await tools.getByRole('button', { name: '拼写检查', exact: true }).click(); await tools.getByRole('button', { name: '自动配对', exact: true }).click();
  assert.equal(await sourceEditor.locator('.cm-content').getAttribute('spellcheck'), 'false');
  await main.getByRole('button', { name: '文件与快速打开', exact: true }).click(); await main.getByRole('button', { name: 'Markdown工具', exact: true }).click();
  await until(async () => await tools.getByRole('button', { name: '拼写检查', exact: true }).getAttribute('aria-pressed') === 'false' && await tools.getByRole('button', { name: '自动配对', exact: true }).getAttribute('aria-pressed') === 'false', 'remounted sidebar reflects the persistent source editor toggles');
  await tools.getByRole('button', { name: '拼写检查', exact: true }).click(); await tools.getByRole('button', { name: '自动配对', exact: true }).click();
  results.markdownPreferences = { scopedTheme: true, reboundFormatKey: true, disabledInheritedKeys: ['undo', 'find'], independentSidebarCommand: true, remountedToggles: true };
  await changeMode('分栏');
  const splitPreview = main.locator('[data-markdown-preview=' + JSON.stringify(authoring.id) + ']'); await splitPreview.waitFor();
  let codeMirrorChunk: string | undefined;
  for (const name of await readdir(resolve('dist/renderer/assets'))) if (name.endsWith('.js') && (await readFile(resolve('dist/renderer/assets', name), 'utf8')).includes('findFromDOM')) { codeMirrorChunk = name; break; }
  assert.ok(codeMirrorChunk);
  const codeMirrorUrl = new URL('assets/' + codeMirrorChunk, main.url()).href;
  // The virtual mirror cannot scroll a DOM node that is not mounted yet.
  // Navigate by source position first; actual mouse input makes each selection.
  const revealSplitPreview = async (from: number) => {
    assert.ok(from >= 0, 'preview navigation has a source position');
    await splitPreview.evaluate(async (node, input) => {
      const module = await import(input.url);
      const Editor = Object.values(module).find((value: any) => typeof value?.findFromDOM === 'function') as { findFromDOM(node: Element): { dispatch(input: unknown): void }; scrollIntoView(from: number, options: { y: string }): unknown };
      if (!Editor) throw new Error('Missing public EditorView.findFromDOM');
      Editor.findFromDOM(node.querySelector('.cm-content')!)!.dispatch({ effects: Editor.scrollIntoView(input.from, { y: 'center' }) });
    }, { url: codeMirrorUrl, from });
  };
  await revealSplitPreview((await authoredText()).indexOf('![Local special filename]'));
  const localSplitImage=splitPreview.getByAltText('Local special filename',{exact:true});await localSplitImage.scrollIntoViewIfNeeded();await until(async()=>localSplitImage.evaluate(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth===1),'same local image decodes in the virtual split preview');await localSplitImage.evaluate(image=>(image as HTMLImageElement).decode());
  await revealSplitPreview((await authoredText()).indexOf('| Name |')); await splitPreview.locator('.md-table-widget').waitFor();
  assert.equal(await splitPreview.locator('.cm-content').getAttribute('contenteditable'), 'false'); assert.equal(await splitPreview.locator('.md-table-widget input').count(), 0, 'mirror table has static cells rather than independent editable inputs');
  const blockedWrite = await splitPreview.evaluate(async (node, url) => { const module = await import(url); const Editor = Object.values(module).find((value: any) => typeof value?.findFromDOM === 'function') as { findFromDOM(node: Element): { state: { doc: { length: number } }; dispatch(input: unknown): void } }; if (!Editor) throw new Error('Missing public EditorView.findFromDOM'); const view = Editor.findFromDOM(node.querySelector('.cm-content')!)!; const length = view.state.doc.length; view.dispatch({ changes: { from: 0, insert: 'Forbidden mirror write' } }); view.dispatch({ changes: { from: 0, insert: 'Forbidden unfiltered mirror write' }, filter: false }); return { before: length, after: view.state.doc.length }; }, codeMirrorUrl);
  assert.equal(blockedWrite.after, blockedWrite.before, 'preview transaction filter blocks programmatic widget writes as well as keyboard input');
  const previewFrom = (await authoredText()).indexOf('Plain text.'); await revealSplitPreview(previewFrom);
  await splitPreview.locator('.cm-line').filter({ hasText: 'Plain text.' }).first().scrollIntoViewIfNeeded();
  await selectTextWithMouse(splitPreview.locator('.cm-line').filter({ hasText: 'Plain text.' }).first(), 'Plain text.');
  await until(async () => { const context = await invoke<ReadingContext>(main, 'context', { viewId: authoring.id }); return context.selection.text === 'Plain text.' && context.selection.locator?.from === previewFrom && context.selection.locator?.to === previewFrom + 'Plain text.'.length; }, 'preview reports the true UTF16 source range without stale source selection overwriting it');
  const floatingSelection = main.getByRole('toolbar', { name: '选区工具', exact: true });
  console.log('Markdown full exports and split source mapping: PASS; checking floating toolbar history');
  await floatingSelection.getByRole('button', { name: '加粗选区', exact: true }).click(); await until(async () => (await authoredText()).includes('**Plain text.**'), 'real floating toolbar formats the single source document');
  await sourceEditor.locator('.cm-content').focus(); await main.keyboard.press('Control+z'); await until(async () => !(await authoredText()).includes('**Plain text.**'), 'floating toolbar edit belongs to keyboard undo history');
  await main.keyboard.press('Control+y'); await until(async () => (await authoredText()).includes('**Plain text.**'), 'keyboard redo restores the floating toolbar edit');
  await tools.getByRole('button', { name: '撤销', exact: true }).click(); await until(async () => !(await authoredText()).includes('**Plain text.**'), 'sidebar undo shares floating toolbar history');
  await tools.getByRole('button', { name: '重做', exact: true }).click(); await until(async () => (await authoredText()).includes('**Plain text.**'), 'sidebar redo shares floating toolbar history');
  const topUndo = main.getByRole('button', { name: '撤销最近修改', exact: true }); if (!await topUndo.isVisible()) await main.getByRole('button', { name: '更多导航工具', exact: true }).click();
  await topUndo.click(); await until(async () => !(await authoredText()).includes('**Plain text.**'), 'top navigation undo shares floating toolbar history');
  for (let turn = 0; turn < 3; turn++) {
    await revealSplitPreview((await authoredText()).indexOf('Plain text.'));
    await splitPreview.locator('.cm-line').filter({ hasText: 'Plain text.' }).first().waitFor();
    await selectTextWithMouse(splitPreview, 'Plain text.');
    await until(async () => (await invoke<ReadingContext>(main, 'context', { viewId: authoring.id })).selection.text === 'Plain text.', 'fast sequence starts with the intended preview selection');
    await floatingSelection.getByRole('button', { name: '加粗选区', exact: true }).click();
    await until(async () => (await authoredText()).includes('**Plain text.**'), 'format acknowledged before immediate undo and reselection');
    await sourceEditor.locator('.cm-content').focus(); await main.keyboard.press('Control+z');
    // No draft/revision barrier: real pointer reselection must survive undo.
    await revealSplitPreview((await authoredText()).indexOf('Footnote'));
    await selectTextWithMouse(splitPreview, 'Footnote');
    await until(async () => { const context = await invoke<ReadingContext>(main, 'context', { viewId: authoring.id }); return !(await authoredText()).includes('**Plain text.**') && context.quality === 'confirmed' && context.selection.text === 'Footnote'; }, 'late undo acknowledgement preserves the newer preview range');
    assert.equal(await main.evaluate(() => window.getSelection()?.toString()), 'Footnote', 'native Range survives Core/preview synchronization');
  }
  console.log('Floating toolbar keyboard/sidebar/navigation undo and redo: PASS');
  for (const [selector, visibleText, sourceText] of [['.md-table-widget td', 'Changed|cell', 'Changed\\|cell'], ['.md-render-metadata dd span', '"Updated"', '"Updated"'], ['.md-render-footnote span', 'Colon footnote.', 'Colon footnote.']]) {
    const from = (await authoredText()).indexOf(sourceText); assert.ok(from >= 0); await revealSplitPreview(from);
    const field = splitPreview.locator(selector).filter({ hasText: visibleText }).first(); await field.scrollIntoViewIfNeeded();
    await selectTextWithMouse(field, visibleText);
    await until(async () => { const context = await invoke<ReadingContext>(main, 'context', { viewId: authoring.id }); return context.selection.text === sourceText && context.selection.locator?.from === from && context.selection.locator?.to === from + sourceText.length; }, 'readonly widget maps its exact source range: ' + visibleText);
  }
  await changeMode('阅读');
  results.markdownAuthoring = { sidebarSelection: true, sharedModeHistory: true, tableCellAndRow: true, focus: true, typewriter: true, replacePanel: true, formulaWorker: true, diagramLanguages: ['mermaid', 'sequence', 'flow'], sourceStatistics: true, frontmatter: true, footnotes: true, exported: exportContents, exportedFiles };
  await main.screenshot({ path: join(evidence, 'markdown-authoring.png'), scale: 'css' });
  const unsaved = await invoke<ViewInfo>(main, 'create-text', { title: 'Unsaved image fixture.md', text: '# Unsaved image fixture\n\nImage follows.\n\n', windowId: 'main' });
  console.log('Checking unsaved backed image paste, consecutive resize, split, export and save');
  const assetEditor = main.locator('[data-markdown-view=' + JSON.stringify(unsaved.id) + ']'), assetText = async () => (await state()).documents.find(item => item.id === unsaved.documentId)!.model.text!;
  await assetEditor.locator('.cm-content').waitFor(); assert.equal((await state()).documents.find(item => item.id === unsaved.documentId)!.path, undefined);
  await assetEditor.locator('.cm-content').click(); await main.keyboard.press('Control+End');
  await main.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'qa-pasted-image'; input.hidden = true; document.body.append(input); });
  await main.locator('#qa-pasted-image').setInputFiles(join(directory, localImageName));
  await assetEditor.locator('.cm-content').evaluate(node => { const input = document.getElementById('qa-pasted-image') as HTMLInputElement, transfer = new DataTransfer(); for (const file of input.files!) transfer.items.add(file); node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); input.remove(); });
  await until(async () => (await assetText()).includes('agentviewer-asset://'), 'pasted backed image is staged for the unsaved document');
  await main.evaluate(viewId => window.dispatchEvent(new CustomEvent('agentviewer:markdown-navigate', { detail: { viewId, from: 0 } })), unsaved.id);
  for (const width of ['50%', '75%']) {
    await assetEditor.getByAltText(localImageName, { exact: true }).hover();
    await assetEditor.getByRole('button', { name: '图片宽度 ' + width, exact: true }).click();
    await until(async () => (await assetText()).includes('width: ' + width), 'consecutive image resize preserves source: ' + width);
    const image = assetEditor.getByAltText(localImageName, { exact: true }); await image.scrollIntoViewIfNeeded(); await until(async () => image.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 1), 'staged raw img decodes after resize ' + width); await image.evaluate(image => (image as HTMLImageElement).decode());
    assert.equal(await assetEditor.getByRole('button', { name: '图片宽度 75%', exact: true, includeHidden: true }).count(), 1, 'standalone raw img keeps image controls');
  }
  await changeMode('分栏'); const assetPreview = main.locator('[data-markdown-preview=' + JSON.stringify(unsaved.id) + ']'), previewImage = assetPreview.getByAltText(localImageName, { exact: true });
  await previewImage.scrollIntoViewIfNeeded(); await until(async () => previewImage.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 1), 'staged resized image decodes in split preview'); await previewImage.evaluate(image => (image as HTMLImageElement).decode());
  const stagedSource = await assetText(), stagedHtml = await main.evaluate(async input => { const module = await import(input.url); return module.renderMarkdownForExport(input.source, input.documentId) as Promise<string>; }, { url: new URL('assets/' + exportChunk, main.url()).href, source: stagedSource, documentId: unsaved.documentId });
  assert.equal(await main.evaluate(html => new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src'), stagedHtml), embeddedImage, 'unsaved resized image is self-contained in full-source export');
  assert.equal(await main.evaluate(html => (new DOMParser().parseFromString(html, 'text/html').querySelector('img') as HTMLImageElement).style.width, stagedHtml), '75%');
  const stagedExportPath = join(evidence, 'unsaved-resized-export.html'); await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, stagedExportPath);
  await invoke(main, 'markdown-export', { documentId: unsaved.documentId, expectedRevision: (await state()).documents.find(item => item.id === unsaved.documentId)!.revision, format: 'html', html: stagedHtml }); assert.ok((await readFile(stagedExportPath, 'utf8')).includes(embeddedImage));
  const savedAssetPath = join(directory, 'saved-image-fixture.md'); await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, savedAssetPath);
  await assetEditor.locator('.cm-content').focus(); await main.keyboard.press('Control+s'); await until(async () => (await state()).documents.find(item => item.id === unsaved.documentId)!.path === savedAssetPath, 'save materializes the staged image');
  const savedAssetSource = await readFile(savedAssetPath, 'utf8'); assert.ok(!savedAssetSource.includes('agentviewer-asset:')); assert.match(savedAssetSource, /width: 75%/);
  // Open persisted bytes through a fresh path so the document library cannot
  // satisfy the check by returning its already cached model.
  const reopenedAssetPath = join(directory, 'reopened-image-fixture.md'); await writeFile(reopenedAssetPath, savedAssetSource); const reopenedAsset = await invoke<ViewInfo>(main, 'open', { uri: reopenedAssetPath, windowId: 'main' });
  const reopenedImage = main.locator('[data-markdown-view=' + JSON.stringify(reopenedAsset.id) + ']').getByAltText(localImageName, { exact: true }); await reopenedImage.scrollIntoViewIfNeeded(); await until(async () => reopenedImage.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 1), 'freshly parsed saved relative image decodes'); await reopenedImage.evaluate(image => (image as HTMLImageElement).decode());
  results.markdownImages = { backedPaste: true, unsavedAsset: true, consecutiveResize: ['50%', '75%'], liveAndSplitDecode: true, fullHtmlExport: true, savedRelativeSource: true, freshParseFromDisk: true };
  // Decode real local media through the bounded protocol and seek via Range.
  const wav=Buffer.alloc(44+16000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
  await writeFile(join(directory,'local sound#%.wav'),wav);
  const videoBytes=await readFile(resolve('tests/fixtures/markdown-video.webm'));
  await writeFile(join(directory,'local movie.webm'),Buffer.from(videoBytes));
  const mediaPath=join(directory,'media.md');await writeFile(mediaPath,'# Local media\n\n<audio controls src="local%20sound%23%25.wav"></audio>\n\n<video controls src="local%20movie.webm"></video>\n');
  const mediaView=await invoke<ViewInfo>(main,'open',{uri:mediaPath,windowId:'main'}),mediaEditor=main.locator('[data-markdown-view='+JSON.stringify(mediaView.id)+']');
  for(const tag of ['audio','video']){const element=mediaEditor.locator(tag);await element.scrollIntoViewIfNeeded();await until(async()=>element.evaluate(node=>(node as HTMLMediaElement).readyState>=1),'local '+tag+' metadata decodes');await element.evaluate(async node=>{const media=node as HTMLMediaElement;media.muted=true;await media.play();});}
  const mediaCapability=await invoke<{url:string}>(main,'markdown-media',{documentId:mediaView.documentId,path:'local%20sound%23%25.wav'});
  const rangeRead=await main.evaluate(async url=>{const response=await fetch(url,{headers:{Range:'bytes=4-15'}});return {status:response.status,range:response.headers.get('content-range'),bytes:[...new Uint8Array(await response.arrayBuffer())]};},mediaCapability.url);
  assert.equal(rangeRead.status,206);assert.equal(rangeRead.range,'bytes 4-15/'+wav.length);assert.deepEqual(rangeRead.bytes,[...wav.subarray(4,16)]);
  await assert.rejects(()=>invoke(main,'markdown-media',{documentId:mediaView.documentId,path:'../outside.wav'}));
  const mediaExport=join(evidence,'portable-media.html');await app.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path});},mediaExport);
  const mediaOutput=await invoke<{paths:string[];revision:number}>(main,'markdown-export',{documentId:mediaView.documentId,expectedRevision:(await state()).documents.find(item=>item.id===mediaView.documentId)!.revision,format:'html'});assert.equal(mediaOutput.paths.length,3);
  const portableMedia=await app.evaluate(async({BrowserWindow},path)=>{const preview=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,partition:'reader-media-export-qa'}});try{await preview.loadFile(path);return await preview.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const check=async()=>{const a=document.querySelector('audio'),v=document.querySelector('video');if(a?.readyState>=1&&v?.readyState>=1){try{a.muted=true;v.muted=true;await Promise.all([a.play(),v.play()]);resolve({audio:a.duration,videoWidth:v.videoWidth,audioPaused:a.paused,videoPaused:v.paused,bridge:!!window.agentViewer});}catch(error){reject(error);}}else if(++n>100)reject(new Error('Portable media metadata timeout'));else setTimeout(check,50)};check()})`);}finally{preview.destroy();}},mediaExport);
  assert.equal(portableMedia.audio,1);assert.equal(portableMedia.videoWidth,160);assert.equal(portableMedia.audioPaused,false);assert.equal(portableMedia.videoPaused,false);assert.equal(portableMedia.bridge,false);
  await app.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path});},mediaPath);await assert.rejects(()=>invoke(main,'markdown-export',{documentId:mediaView.documentId,expectedRevision:mediaOutput.revision,format:'html'}));assert.ok((await readFile(mediaPath,'utf8')).startsWith('# Local media'));
  results.markdownMedia={audio:true,video:true,range:true,confined:true,portableHtml:true};
  // Bundled Pandoc round-trips native document formats with staged raw <img>.
  assert.equal((await invoke<{pandoc:boolean}>(main,'markdown-export-capabilities')).pandoc,true);
  for(const format of ['docx','odt','epub','rtf','latex']) {
    const output=join(evidence,'converted.'+(format==='latex'?'tex':format)),imported=join(directory,'roundtrip-'+format+'.md');
    await app.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path});},output);
    await invoke(main,'markdown-export',{documentId:reopenedAsset.documentId,expectedRevision:(await state()).documents.find(item=>item.id===reopenedAsset.documentId)!.revision,format});
    const convertedBytes=await readFile(output);if(['docx','odt','epub'].includes(format))assert.equal(convertedBytes.subarray(0,2).toString(),'PK');else if(format==='rtf')assert.ok(convertedBytes.toString().startsWith('{\\rtf'));else {assert.match(convertedBytes.toString(),/includegraphics/);assert.ok(!convertedBytes.toString().includes(directory.replaceAll('\\','/')),'LaTeX carries relative image assets');}
    await app.evaluate(({dialog},input)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[input.output]});dialog.showSaveDialog=async()=>({canceled:false,filePath:input.imported});},{output,imported});
    const converted=await invoke<ViewInfo>(main,'markdown-import',{windowId:'main'});assert.ok(converted);
    const convertedText=await readFile(imported,'utf8');assert.match(convertedText,/Unsaved image fixture/);assert.ok(!convertedText.includes('agentviewer-asset:'));assert.match(convertedText,/\.assets-/);
    const resource=await invoke<{url:string}>(main,'markdown-resource',{documentId:converted.documentId,path:convertedText.match(/(?:<|\(|src=")([^<>"\s()]+\.assets-[^<>"\s()]+)(?:>|"|\))/)![1]});assert.ok(resource.url.startsWith('data:image/png;base64,'));
  }
  results.markdownPandoc={bundled:true,formats:['docx','odt','epub','rtf','latex'],roundtripImages:true};
  const hugeLineSource = 'x'.repeat(256 * 1024), hugeLine = await invoke<ViewInfo>(main, 'create-text', { title: 'Huge line input.md', text: hugeLineSource, windowId: 'main' });
  const hugeEditor = main.locator('[data-markdown-view=' + JSON.stringify(hugeLine.id) + '] .cm-content'), hugeText = async () => (await state()).documents.find(item => item.id === hugeLine.documentId)!.model.text!;
  await hugeEditor.focus(); await main.keyboard.press('Control+End'); await main.keyboard.insertText('(');
  await until(async () => (await hugeText()) === hugeLineSource + '()', 'huge-line beforeinput still invokes CodeMirror bracket input handlers');
  await main.keyboard.press('Control+z'); await until(async () => (await hugeText()) === hugeLineSource, 'huge-line paired insertion belongs to ordinary undo');
  await main.keyboard.press('Control+y'); await until(async () => (await hugeText()) === hugeLineSource + '()', 'huge-line paired insertion redoes without a DOM diff');
  // CodeMirror redo restores the end of the inserted pair. Move explicitly
  // into it before checking a multi-code-unit insertion at that source range.
  await main.keyboard.press('ArrowLeft');
  await main.keyboard.insertText('中文🙂'); await until(async () => (await hugeText()) === hugeLineSource + '(中文🙂)', 'huge-line direct Unicode insertion retains UTF16 source positions');
  results.markdownHugeLineInput = { codeMirrorPairHandler: true, undo: true, redo: true, unicode: true, size: hugeLineSource.length };
  await activate(markdown.id);
  console.log('Markdown authoring selection, table, source/live history, modes, search and deferred renders: PASS');

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
  // Background webpages are loaded on activation, so their title is not yet
  // known. Target the actual view rather than assuming an eager navigation.
  await main.locator('.tab[data-view-id=' + JSON.stringify(native.id) + '] .tab-select').click();
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
  assert.ok(Math.abs(compactLayout.height - 36) < .02, 'segmented choices retain the requested compact 36px desktop height');
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
  const autoHide = settings.getByRole('switch', { name: '导航栏自动隐藏', exact: true }); await autoHide.scrollIntoViewIfNeeded();
  const switchBox = await autoHide.boundingBox(); assert.ok(switchBox);
  assert.ok(Math.abs(switchBox.width - 68) < .02); assert.ok(Math.abs(switchBox.height - 28.475) < .02, 'source switch retains the requested compact 68px desktop track');
  const sourceSwitch = await autoHide.evaluate(element => ({ width: Number.parseFloat(getComputedStyle(element).width), height: Number.parseFloat(getComputedStyle(element).height), zoom: Number(getComputedStyle(element).zoom) }));
  assert.equal(sourceSwitch.width, 68); assert.equal(sourceSwitch.zoom, 1);
  assert.ok(Math.abs(sourceSwitch.height / sourceSwitch.width - 67 / 160) < .001, 'compact Kube track preserves the source aspect ratio');
  const beforeSwitch = await preferences(settings); assert.equal(beforeSwitch.values['appearance.autoHideToolbar'], false);
  await settings.mouse.move(switchBox.x + 51 * .425, switchBox.y + switchBox.height / 2); await settings.mouse.down();
  await settings.mouse.move(switchBox.x + 123 * .425, switchBox.y + switchBox.height / 2, { steps: 8 }); await settings.mouse.up();
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
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ ...results, errors, consoleErrors }, null, 2));
  console.log('Settings click/drag/keyboard, one transaction, global undo, source switch and both themes: PASS');
  console.log('Reader interaction evidence:', evidence);
} catch (error) {
  await main.screenshot({ path: join(evidence, 'failure-main.png'), scale: 'css' }).catch(() => {});
  for (const target of app.context().pages().filter(page => page.url().includes('#/settings') || page.url().includes('#/web-toolbar'))) await target.screenshot({ path: join(evidence, pageName(target) + '-failure.png'), scale: 'css' }).catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ ...results, error: String(error), errors, consoleErrors }, null, 2)); throw error;
} finally { await app.close(); }

function pageName(page: Page) { return page.url().includes('#/settings') ? 'settings' : 'native-toolbar'; }
