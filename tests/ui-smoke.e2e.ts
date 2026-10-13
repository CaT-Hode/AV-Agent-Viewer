import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { DocumentModel, WorkspaceState, ReadingContext, ViewInfo, NativeOfficeCommand, NativeOfficeState, NativeOfficeStyleInspection } from '../packages/contracts/src/index';
import type { TranslationArtifact, TranslationJob } from '../packages/translation/src/index';

const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-ui-'));
const modelServer = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); const path = request.url ?? ''; response.setHeader('Content-Type', 'application/json'); if (path.endsWith('/models')) response.end(JSON.stringify({ data: [{ id: 'test-model' }] })); else if (path.endsWith('/chat/completions')) response.end(JSON.stringify({ choices: [{ message: { content: 'chat-ok' } }] })); else if (path.endsWith('/responses')) response.end(JSON.stringify({ output_text: 'responses-ok' })); else if (path.endsWith('/messages')) response.end(JSON.stringify({ content: [{ type: 'text', text: 'anthropic-ok' }] })); else { response.writeHead(404); response.end('{}'); } });
await new Promise<void>(done => modelServer.listen(0, '127.0.0.1', done));
const modelAddress = modelServer.address(); if (!modelAddress || typeof modelAddress === 'string') throw new Error('model server unavailable');
const modelBase = 'http://127.0.0.1:' + modelAddress.port;
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete environment.ELECTRON_RUN_AS_NODE;
Object.assign(environment, { AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: '3211', AGENTVIEWER_TEST_MODE: '1', AGENTVIEWER_TEST_TRANSLATOR: '1' });
const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: resolve('.'), env: environment, timeout: 45_000 });
const page = await app.firstWindow(), errors: string[] = [], stderr: string[] = [];
const screenshotDir = process.env.AGENTVIEWER_QA_DIR ?? directory, primary = app.process();
let failure: unknown, report: Record<string, unknown> | undefined;
const startedAt = Date.now(), stages: { name: string; timestamp: string; elapsedMs: number }[] = [], errorDetails: { message: string; stack?: string; page: string; stage: string; timestamp: string }[] = [];
let stage = 'launch';
const mark = (name: string) => { stage = name; stages.push({ name, timestamp: new Date().toISOString(), elapsedMs: Date.now() - startedAt }); };
primary.stderr?.on('data', value => stderr.push(String(value)));
const watch = (target: typeof page) => target.on('pageerror', error => { errors.push(error.message); errorDetails.push({ message: error.message, stack: error.stack, page: target.url(), stage, timestamp: new Date().toISOString() }); });
app.context().pages().forEach(watch); app.context().on('page', watch);
const invoke = <T>(method: string, args: Record<string, unknown> = {}) => page.evaluate(async value => window.agentViewer!.call(value.method, value.args), { method, args }) as Promise<T>;
const nativeReady = async (view: ViewInfo) => {
  const deadline = Date.now() + 120_000;
  let state: NativeOfficeState | undefined;
  while (Date.now() < deadline) {
    try {
      state = await invoke<NativeOfficeState>('office-status', { viewId: view.id });
      if (state.status === 'ready' && state.visible && state.nativeGeometry && state.viewport && state.viewport.width > 100 && state.viewport.height > 100) break;
    } catch { /* The renderer may still be establishing the native binding. */ }
    await page.waitForTimeout(90);
  }
  assert.equal(state?.status, 'ready', 'the real Office engine must become ready');
  assert.ok(state.visible && state.nativeGeometry && state.viewport && state.viewport.width > 100 && state.viewport.height > 100, 'the real native Office surface is mounted');
  assert.equal(state.documentId, view.documentId); assert.equal(state.viewId, view.id);
  assert.match(state.nativeHwnd ?? '', /^[1-9]\d*$/); assert.ok((state.nativePid ?? 0) > 0);
  for (const key of ['menus', 'toolbars', 'statusbar'] as const) assert.equal(state.nativeUi?.[key], false);
  await page.locator(`.native-office-content[data-native-office="${view.id}"][data-native-ready="true"]`).waitFor();
  return state;
};
try {
  mark('welcome');
  await page.locator('.prose h1').waitFor();
  await mkdir(screenshotDir, { recursive: true }); await page.screenshot({ path: join(screenshotDir, 'ui-smoke.png'), scale: 'css' });
  const initial = await invoke<WorkspaceState>('state'); assert.equal(initial.views.length, 3);
  await page.getByRole('button', { name: '新建标签页', exact: true }).click(); await page.getByRole('heading', { name: '从这里继续阅读。' }).waitFor();
  await page.screenshot({ path: join(screenshotDir, 'home.png'), scale: 'css' });
  mark('settings');
  const settingsOpened = app.waitForEvent('window');
  await page.locator('.top-utility button').click();
  const settingsPage = await settingsOpened; await settingsPage.locator('.settings-shell').waitFor();
  assert.equal(settingsPage.url().includes('#/settings'), true);
  assert.equal((await invoke<WorkspaceState>('state')).activeViewId, initial.activeViewId);
  await settingsPage.getByRole('button', { name: '外观与布局' }).click();
  const backgroundOptions = settingsPage.getByRole('radiogroup', { name: '文档阅读背景', exact: true });
  await backgroundOptions.getByRole('radio', { name: '极光', exact: true }).click();
  await settingsPage.waitForFunction(() => document.querySelector('[data-setting-id="appearance.documentBackground"] [role="radio"][data-value="aurora"]')?.getAttribute('aria-checked') === 'true');
  assert.equal(await backgroundOptions.getByRole('radio', { name: '极光', exact: true }).getAttribute('aria-checked'), 'true');
  await page.locator('html[data-document-background="aurora"]').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-document-background'), 'aurora');
  await settingsPage.getByRole('button', { name: '模型与连接' }).click();
  const harnessOptions = settingsPage.getByRole('radiogroup', { name: '默认 Harness', exact: true });
  await harnessOptions.locator('[role="radio"][data-value="codex"]').click();
  await settingsPage.waitForFunction(() => document.querySelector('[data-setting-id="ai.defaultDriver"] [role="radio"][data-value="codex"]')?.getAttribute('aria-checked') === 'true');
  const invokeSettings = <T>(method: string, args: Record<string, unknown> = {}) => settingsPage.evaluate(async value => window.agentViewer!.call(value.method, value.args), { method, args }) as Promise<T>;
  const profiles = [
    { protocol: 'openai-responses', baseUrl: modelBase + '/v1', expected: 'responses-ok' },
    { protocol: 'chat-completions', baseUrl: modelBase + '/v1', expected: 'chat-ok' },
    { protocol: 'anthropic-messages', baseUrl: modelBase, expected: 'anthropic-ok' },
  ] as const;
  for (const profile of profiles) { const saved = await invokeSettings<{ profiles: { id: string }[] }>('connections-upsert', { name: profile.protocol, protocol: profile.protocol, baseUrl: profile.baseUrl, modelId: 'test-model', apiKey: 'qa-secret-value' }); const id = saved.profiles.at(-1)!.id; assert.equal((await invokeSettings<{ text: string }>('connections-test', { id })).text, profile.expected); assert.deepEqual(await invokeSettings<string[]>('connections-discover', { id }), ['test-model']); }
  assert.doesNotMatch(await readFile(join(directory, 'connections.json'), 'utf8'), /qa-secret-value/);
  await settingsPage.getByRole('button', { name: '翻译', exact: true }).click();
  await settingsPage.getByRole('spinbutton', { name: '选区翻译等待时间（毫秒）' }).fill('600');
  await settingsPage.screenshot({ path: join(screenshotDir, 'settings.png'), scale: 'css' });
  await settingsPage.close();
  mark('markdown-selection-translation');
  await page.locator('.tab').first().locator('.tab-select').click();
  assert.equal(await page.locator('.reader-toolbar .address-input').count(), 0);
  assert.equal(await page.locator('.capsule-document-title').innerText(), initial.documents[0].title);
  assert.equal(await page.locator('.reader-toolbar').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  const navWidth = await page.locator('.navigation-capsule').evaluate(node => node.getBoundingClientRect().width);
  const pageWidth = await page.locator('.reader-panel').evaluate(node => node.getBoundingClientRect().width);
  assert.ok(navWidth < pageWidth * .8, '文档胶囊仍有整行遮罩');
  assert.ok(parseFloat(await page.locator('.format-sidebar').evaluate(node => getComputedStyle(node).borderTopLeftRadius)) >= 12);
  await page.locator('.prose p').nth(1).evaluate(node => { const range = window.document.createRange(); range.selectNodeContents(node); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  for (let i = 0; i < 50; i++) { const current = await invoke<WorkspaceState>('state'); const reading = await invoke<ReadingContext>('context', { viewId: current.activeViewId }); if (reading.selection.text === '选中一段文字，开始共同阅读。') break; await page.waitForTimeout(50); }
  await page.getByRole('button', { name: 'AI 工具', exact: true }).click(); await page.locator('.selection-preview').waitFor(); await page.getByRole('button', { name: '翻译选区' }).click(); await page.getByRole('button', { name: 'AI 工具', exact: true }).click();
  await page.locator('.translation-popover .translation-result').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.translation-popover').evaluate(node => getComputedStyle(node).position), 'absolute', '译文浮窗不能占用阅读器的网格列');
  assert.match(await page.locator('.translation-popover .translation-result').innerText(), /【zh-CN】/);
  assert.equal((await invoke<WorkspaceState>('state')).documents[0].dirty, false);
  const first = (await invoke<WorkspaceState>('state')).documents[0], originalBytes = await readFile(first.path!);
  await page.getByRole('button', { name: 'AI 工具', exact: true }).click(); await page.getByRole('button', { name: '生成全文译文' }).click();
  let list!: { jobs: TranslationJob[]; artifacts: TranslationArtifact[] };
  for (let i = 0; i < 100; i++) { list = await invoke('translation-list'); if (list.jobs.some(job => job.status === 'completed')) break; await page.waitForTimeout(50); }
  const artifact = list.artifacts[0]; assert.ok(artifact); assert.notEqual(artifact.path, first.path); assert.match(await readFile(artifact.path, 'utf8'), /【zh-CN】/); assert.deepEqual(await readFile(first.path!), originalBytes);
  mark('web-translation');
  await page.getByRole('button', { name: '新建标签页', exact: true }).click(); await page.locator('.file-row').filter({ hasText: '交互测试页' }).last().click();
  const current = await invoke<WorkspaceState>('state'), webView = current.views.find(view => current.documents.find(doc => doc.id === view.documentId)?.format === 'web')!;
  let before!: ReadingContext;
  for (let i = 0; i < 50; i++) { before = await invoke<ReadingContext>('context', { viewId: webView.id }); if (before.quality === 'confirmed') break; await page.waitForTimeout(50); }
  assert.equal(before.viewport?.layoutRevision, 0);
  const replacement = await invoke<{ translated: number }>('web-translation-apply', { viewId: webView.id, scope: 'page' }); assert.ok(replacement.translated > 0);
  const pageStateVisible = await app.evaluate(async ({ webContents }) => { const target = webContents.getAllWebContents().find(item => item.getURL().includes('/fixtures/interaction.html'))!; return target.executeJavaScript('typeof window.__agentViewerTranslationState'); });
  assert.equal(pageStateVisible, 'undefined');
  const after = await invoke<ReadingContext>('context', { viewId: webView.id }); assert.ok((after.viewport?.layoutRevision ?? 0) > 0);
  await assert.rejects(invoke('browser-input', { viewId: webView.id, expectedNavigationId: after.viewport!.navigationId, action: { kind: 'click', x: 4, y: 4 }, idempotencyKey: crypto.randomUUID() }), /STALE_LAYOUT|重新读取视口和坐标/);
  const restored = await invoke<{ restored: number }>('web-translation-restore', { viewId: webView.id }); assert.ok(restored.restored > 0);
  await page.screenshot({ path: join(screenshotDir, 'web-restored.png'), scale: 'css' });
  // Actual edits, save/reopen and multi-controller behavior are exercised by
  // native-office.e2e.ts. This smoke check must never fall back to the old DOM editor.
  const officeCases = [
    { format: 'docx', categories: ['home', 'insert', 'table', 'layout', 'references', 'review', 'view'], initial: 'home' },
    { format: 'pptx', categories: ['slides', 'home', 'insert', 'design', 'arrange', 'transitions', 'animation', 'presentation', 'notes'], initial: 'slides' },
    { format: 'xlsx', categories: ['home', 'insert', 'formulas', 'data', 'worksheet', 'view', 'print'], initial: 'home' },
  ] as const;
  for (const sample of officeCases) {
    mark('native-' + sample.format + '-open');
    const view = await invoke<ViewInfo>('new-document', { format: sample.format, windowId: 'main' });
    const native = await nativeReady(view);
    const document = (await invoke<WorkspaceState>('state')).documents.find(item => item.id === view.documentId)!;
    assert.equal(document.capabilities.engine, 'libreoffice-native');
    assert.deepEqual(document.model, { format: sample.format }, 'display state deliberately excludes native mirror paragraphs, objects and grid rows');
    const model = await invoke<DocumentModel>('read', { documentId: view.documentId });
    const rail = page.locator('.office-toolbox-rail');
    assert.deepEqual(await rail.locator('button[data-office-category]').evaluateAll(items => items.map(item => item.getAttribute('data-office-category'))), [...sample.categories]);
    assert.equal(await rail.locator(`[data-office-category="${sample.initial}"]`).getAttribute('aria-pressed'), 'true');
    await page.locator(`.native-office-tools[data-office-category="${sample.initial}"]`).waitFor();
    assert.equal(await page.locator('.native-office-categories').count(), 0, 'categories appear only once in the left rail');
    assert.equal(await page.locator('.office-editing-ribbon, .office-word-paragraph, .office-slide-canvas, .office-sheet-grid').count(), 0, 'no legacy Office renderer or ribbon is present');
    assert.equal(await page.locator('.status-bar, .office-footer, .reader-panel footer').count(), 0, 'no extra document footer consumes the native surface');
    if (sample.format === 'docx') {
      const statistics = await invoke<{ methods: Record<string, { count: number }> }>('office-statistics');
      assert.equal(statistics.methods.commands?.count ?? 0, 0, 'opening the default toolbox must not eagerly load the expensive complete catalog');
    }
    const catalog = await invoke<{ state: NativeOfficeState; commands: NativeOfficeCommand[]; total: number }>('office-commands', { viewId: view.id, offset: 0, limit: 200 });
    assert.equal(catalog.state.sessionId, native.sessionId); assert.ok(catalog.total > 50 && catalog.commands.length > 0, 'a real UNO command catalog is available');
    if (sample.format === 'docx') {
      assert.ok(model.blocks?.length && model.blocks.every(block => block.text === ''), 'new Word documents have an editable empty paragraph');
      const result = await invoke<{ data: { text: string } }>('office-query', { viewId: view.id, target: { kind: 'document' } });
      assert.equal(result.data.text.trim(), '', 'the actual Writer document has no demonstration text');
    } else if (sample.format === 'pptx') {
      assert.equal(model.slides?.length, 1); assert.equal(model.slides[0].blocks.length, 0);
      const result = await invoke<{ data: { slides: { text: string }[] } }>('office-query', { viewId: view.id, target: { kind: 'slides' } });
      assert.equal(result.data.slides.length, 1); assert.equal(result.data.slides[0].text.trim(), '', 'the actual Impress document starts with a blank slide');
    } else {
      assert.equal(model.sheets?.length, 1);
      assert.ok(model.sheets[0].rows.every(row => row.every(cell => cell.value === '' && !cell.formula)), 'new spreadsheets have no demonstration values or formulas');
      const sheets = await invoke<{ data: { sheets: { name: string }[] } }>('office-query', { viewId: view.id, target: { kind: 'sheets' } });
      assert.equal(sheets.data.sheets.length, 1);
      const cells = await invoke<{ data: { values: unknown[][]; formulas: string[][] } }>('office-query', { viewId: view.id, target: { kind: 'cell-range', sheetName: sheets.data.sheets[0].name, range: 'A1:C3' } });
      assert.deepEqual(cells.data.values, Array.from({ length: 3 }, () => ['', '', '']));
      assert.deepEqual(cells.data.formulas, Array.from({ length: 3 }, () => ['', '', '']));
      mark('native-xlsx-typed-style-ui');
      const inspector = page.locator('[data-native-style-target="cells"]');
      const fontSize = inspector.getByRole('spinbutton', { name: '单元格 · 字号', exact: true });
      await fontSize.waitFor();
      await page.waitForFunction(() => !(window.document.querySelector('[aria-label="单元格 · 字号"]') as HTMLInputElement | null)?.disabled);
      await fontSize.fill('16');
      await inspector.getByRole('button', { name: '应用修改', exact: true }).click();
      await page.waitForFunction(() => window.document.querySelector('[data-native-style-target="cells"]')?.getAttribute('data-dirty') === 'false');
      const updated = await invoke<{ data: NativeOfficeStyleInspection }>('office-query', { viewId: view.id, target: { kind: 'style', target: 'cells' } });
      assert.equal(updated.data.fields.fontSize.value, 16, 'the compact app-owned control changes the real Calc selection');
      const afterStyle = await invoke<{ data: { values: unknown[][]; formulas: string[][] } }>('office-query', { viewId: view.id, target: { kind: 'cell-range', sheetName: sheets.data.sheets[0].name, range: 'A1:C3' } });
      assert.deepEqual(afterStyle.data, cells.data, 'a style-only UI action preserves cell values and formulas');
      await page.screenshot({ path: join(screenshotDir, 'office-compact-style-tools.png'), scale: 'css' });
    }
    for (const category of sample.categories) {
      mark('native-' + sample.format + '-' + category);
      await rail.locator(`[data-office-category="${category}"]`).click();
      // The default category is already open; a repeat click deliberately closes it.
      if (category === sample.initial) await rail.locator(`[data-office-category="${category}"]`).click();
      await page.locator(`.native-office-tools[data-office-category="${category}"] [role="tabpanel"]`).waitFor();
    }
  }
  mark('scenario-complete');
  await page.screenshot({ path: join(screenshotDir, 'office-tools.png'), scale: 'css' });
  assert.deepEqual(errors, [], 'Renderer errors: ' + JSON.stringify(errors));
  report = { passed: true, artifacts: screenshotDir, checks: ['home', 'independent settings window', 'provider protocols and encrypted key', 'selection translation without edits', 'separate document artifact', 'web replacement and restoration', 'layout revision guard', 'three real native Office surfaces, blank new documents and left tool categories'] };
} catch (cause) { failure = cause; throw cause; }
finally {
  mark('normal-close');
  let timer: ReturnType<typeof setTimeout> | undefined, closeError: string | undefined;
  try {
    const closed = await Promise.race([
      app.close().then(() => true).catch(cause => { closeError = String(cause); return false; }),
      new Promise<boolean>(done => { timer = setTimeout(() => { closeError = 'Own test process did not close normally within 30 seconds.'; if (primary.exitCode === null) primary.kill(); done(false); }, 30_000); }),
    ]);
    if (!closed && primary.exitCode === null) primary.kill();
  } finally {
    clearTimeout(timer); await mkdir(screenshotDir, { recursive: true });
    await writeFile(join(screenshotDir, 'ui-smoke-diagnostics.json'), JSON.stringify({ failure: failure === undefined ? undefined : String(failure), rendererErrors: errors, errorDetails, stages, closeError, primaryPid: primary.pid, profile: directory }, null, 2));
    await writeFile(join(screenshotDir, 'primary-stderr.log'), stderr.join(''));
    await new Promise<void>(done => modelServer.close(() => done()));
  }
  if (closeError && failure === undefined) throw new Error(closeError + ' Evidence: ' + screenshotDir);
}
console.log(JSON.stringify(report, null, 2));
