import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { WorkspaceState, ReadingContext, ViewInfo, EditOperation, PreparedPatch, Receipt } from '../packages/contracts/src/index';
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
const page = await app.firstWindow(), errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const invoke = <T>(method: string, args: Record<string, unknown> = {}) => page.evaluate(async value => window.agentViewer!.call(value.method, value.args), { method, args }) as Promise<T>;
const writeSetup = async (documentId: string, operation: EditOperation) => {
  const document = (await invoke<WorkspaceState>('state')).documents.find(item => item.id === documentId)!;
  const patch = await invoke<PreparedPatch>('prepare', { documentId, expectedRevision: document.revision, operation });
  const receipt = await invoke<Receipt>('commit', { patchId: patch.id, idempotencyKey: crypto.randomUUID() });
  assert.equal(receipt.status, 'applied');
};
try {
  await page.locator('.prose h1').waitFor();
  const screenshotDir = process.env.AGENTVIEWER_QA_DIR ?? directory; await mkdir(screenshotDir, { recursive: true }); await page.screenshot({ path: join(screenshotDir, 'ui-smoke.png'), scale: 'css' });
  const initial = await invoke<WorkspaceState>('state'); assert.equal(initial.views.length, 3);
  await page.getByRole('button', { name: '新建标签页', exact: true }).click(); await page.getByRole('heading', { name: '从这里继续阅读。' }).waitFor();
  await page.screenshot({ path: join(screenshotDir, 'home.png'), scale: 'css' });
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
  const wordView = await invoke<ViewInfo>('new-document', { format: 'docx', windowId: 'main' });
  const wordModel = (await invoke<WorkspaceState>('state')).documents.find(document => document.id === wordView.documentId)!.model;
  assert.ok(wordModel.blocks?.every(block => block.text === ''), 'new Word documents contain no demonstration paragraphs');
  await writeSetup(wordView.documentId, { kind: 'word.setBlock', blockId: wordModel.blocks![0].id, text: 'Word 段落样式与插入验收' });
  await page.locator('.tab').filter({ hasText: '未命名.docx' }).locator('.tab-select').click();
  const wordParagraph = page.getByRole('textbox', { name: '文档段落', exact: true }).first();
  await wordParagraph.waitFor();
  const wordTools = page.getByRole('button', { name: 'Word工具', exact: true });
  if (await wordTools.getAttribute('aria-pressed') !== 'true') await wordTools.click();
  await wordParagraph.click();
  const tools = page.locator('.format-sidebar');
  await tools.getByRole('combobox', { name: '段落样式', exact: true }).selectOption('Heading2');
  await page.locator('.office-word-paragraph[data-style="Heading2"]').first().waitFor();
  assert.equal((await invoke<WorkspaceState>('state')).documents.find(doc => doc.id === wordView.documentId)?.model.blocks?.[0].style, 'Heading2');
  await tools.getByRole('textbox', { name: '新段落文字', exact: true }).fill('界面插入');
  await tools.getByRole('button', { name: '在当前段落后插入', exact: true }).click();
  await page.getByRole('textbox', { name: '文档段落', exact: true }).filter({ hasText: '界面插入' }).waitFor();

  const slideView = await invoke<ViewInfo>('new-document', { format: 'pptx', windowId: 'main' });
  const slideModel = (await invoke<WorkspaceState>('state')).documents.find(document => document.id === slideView.documentId)!.model;
  assert.equal(slideModel.slides![0].blocks.length, 0, 'new presentations start with a blank slide');
  await writeSetup(slideView.documentId, { kind: 'slides.addTextShape', slideId: slideModel.slides![0].id, text: 'PowerPoint 对象位置验收', x: .1, y: .2, width: .7, height: .2 });
  await page.locator('.tab').filter({ hasText: '未命名.pptx' }).locator('.tab-select').click();
  const slideTools = page.getByRole('button', { name: 'PowerPoint工具', exact: true });
  if (await slideTools.getAttribute('aria-pressed') !== 'true') await slideTools.click();
  await page.getByRole('textbox', { name: '幻灯片文本对象', exact: true }).first().click();
  await tools.getByRole('spinbutton', { name: '横向位置', exact: true }).fill('20');
  await tools.getByRole('button', { name: '应用位置与尺寸', exact: true }).click();
  await page.waitForFunction(async id => { const state = await window.agentViewer!.call('state', {}) as WorkspaceState; return Math.abs((state.documents.find(doc => doc.id === id)?.model.slides?.[0].blocks?.[0].x ?? 0) - .2) < .0001; }, slideView.documentId);

  const sheetView = await invoke<ViewInfo>('new-document', { format: 'xlsx', windowId: 'main' });
  const sheetModel = (await invoke<WorkspaceState>('state')).documents.find(document => document.id === sheetView.documentId)!.model.sheets![0];
  assert.ok(sheetModel.rows.every(row => row.every(cell => cell.value === '')), 'new spreadsheets contain no demonstration values');
  await writeSetup(sheetView.documentId, { kind: 'sheets.setCell', sheetId: sheetModel.id, address: 'B2', value: '17', valueType: 'number' });
  await page.locator('.tab').filter({ hasText: '未命名.xlsx' }).locator('.tab-select').click();
  const sheetTools = page.getByRole('button', { name: 'Excel工具', exact: true });
  if (await sheetTools.getAttribute('aria-pressed') !== 'true') await sheetTools.click();
  await page.getByRole('textbox', { name: 'B2', exact: true }).click();
  await tools.getByRole('button', { name: '粗体', exact: true }).click();
  await page.waitForFunction(async id => { const state = await window.agentViewer!.call('state', {}) as WorkspaceState; return state.documents.find(doc => doc.id === id)?.model.sheets?.[0].rows?.[1]?.[1]?.bold === true; }, sheetView.documentId);
  await page.screenshot({ path: join(screenshotDir, 'office-tools.png'), scale: 'css' });
  assert.equal(errors.length, 0);
  console.log(JSON.stringify({ passed: true, artifacts: screenshotDir, checks: ['home', 'independent settings window', 'provider protocols and encrypted key', 'selection translation without edits', 'separate document artifact', 'web replacement and restoration', 'layout revision guard', 'Office editing tools'] }, null, 2));
} finally { await app.close(); await new Promise<void>(done => modelServer.close(() => done())); }
