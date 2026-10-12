import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createPortServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { AI_READING_TOOLS } from '../packages/ai-reading-tools/src/index';
import type { HarnessTask, ReadingContext, ReadingSnapshot, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';

const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-ai-reading-ui-'));
const evidence = join(directory, 'evidence'); await mkdir(evidence);
const requests: { prompt: string; response: string }[] = [];
const modelServer = createHttpServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: 'isolated-reading-model' }] })); return; }
    if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end('{}'); return; }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] };
    const result = { prompt: input.messages.map(message => message.content).join('\n'), response: 'ANALYSIS_RESPONSE_' + (requests.length + 1) + '\n依据本次冻结来源的模拟阅读结果。' };
    requests.push(result);
    // The first real provider call remains pending long enough to inspect card
    // dimensions before/after completion; later calls keep this suite short.
    await new Promise(done => setTimeout(done, requests.length === 1 ? 1200 : 40));
    response.end(JSON.stringify({ choices: [{ message: { content: result.response } }] }));
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise<void>(done => modelServer.listen(0, '127.0.0.1', done));
const modelAddress = modelServer.address(); assert.ok(modelAddress && typeof modelAddress !== 'string');
const port = await new Promise<number>((done, reject) => { const server = createPortServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const sourcePath = join(directory, 'reading-source.md'), selected = 'ALPHA_SELECTED_SOURCE';
const source = '# AI 阅读验收\n\n' + selected + ' 是选中的独立片段。\n\nVISIBLE_SECONDARY_SOURCE 是当前视口的第二段，用于检查范围切换。\n\n' + Array.from({ length: 90 }, (_, index) => `阅读占位段落 ${index + 1}，只用于将后续内容放到视口之外。\n\n`).join('') + 'SECRET_UNREAD_DOCUMENT_TAIL\n';
await writeFile(sourcePath, source);
const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: resolve('.'), env, timeout: 45000 });
const page = await app.firstWindow(), errors: string[] = [], checks: string[] = [];
const watch = (target: Page) => { target.on('pageerror', error => errors.push(error.message)); target.on('console', message => { if (/Encountered two children with the same key/.test(message.text())) errors.push(message.text()); }); };
app.context().pages().forEach(watch); app.context().on('page', watch);
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1586, 992));
const invoke = <T>(method: string, args: Record<string, unknown> = {}) => page.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const state = () => invoke<WorkspaceState>('state');
const until = async (check: () => Promise<boolean>, label: string) => { for (let i = 0; i < 160; i++) { if (await check()) return; await new Promise(done => setTimeout(done, 75)); } throw new Error('等待失败：' + label); };
const openUri = async (uri: string) => { await page.keyboard.press('Control+l'); await page.getByRole('dialog').waitFor(); await page.locator('.modal-input').fill(uri); await page.getByRole('dialog').getByRole('button', { name: '打开', exact: true }).click(); };
const openAI = async () => { const button = page.locator('.ai-rail').getByRole('button', { name: 'AI 工具', exact: true }); if (await button.getAttribute('aria-expanded') !== 'true') await button.click(); await page.locator('.ai-reading-tools').waitFor(); };
const assertFrostedTooltip = async (target: Page) => {
  const tooltip = target.getByRole('tooltip'); await tooltip.waitFor();
  assert.equal(await tooltip.locator('.liquid-glass-surface').getAttribute('data-glass-effect'), 'frosted');
  assert.equal(await tooltip.locator('.liquid-glass-surface').getAttribute('data-glass-fallback'), null);
  assert.equal(await tooltip.locator('feDisplacementMap').count(), 0, 'fixed frosted tooltip has no lens/displacement layer');
  const style = await tooltip.evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
  assert.notEqual(style.color, 'rgb(245, 247, 250)', 'tooltip does not retain the old forced light-on-black palette');
};
try {
  await page.locator('.prose h1').waitFor();
  await invoke('settings-set', { id: 'appearance.autoHideToolbar', value: false });
  await invoke('settings-set', { id: 'appearance.theme', value: 'light' });
  await invoke('settings-set', { id: 'appearance.motion', value: 'off' });
  await invoke('settings-set', { id: 'appearance.glass', value: 'standard' });
  await invoke('settings-set', { id: 'translation.selectionAuto', value: false });
  const connections = await invoke<{ profiles: { id: string }[] }>('connections-upsert', { name: 'isolated local test model', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:' + modelAddress.port + '/v1', modelId: 'isolated-reading-model' });
  const profileId = connections.profiles.at(-1)!.id;
  await invoke('connections-route', { tool: 'chat', id: profileId }); await invoke('connections-route', { tool: 'selection', id: profileId });
  await openUri(sourcePath);
  await until(async () => (await state()).documents.some(document => document.path === sourcePath), 'source file opened');
  const workspace = await state(), sourceDocument = workspace.documents.find(document => document.path === sourcePath)!, viewId = workspace.views.find(view => view.documentId === sourceDocument.id)!.id;
  const originalDocument = structuredClone(sourceDocument), disk = await readFile(sourcePath);
  await page.locator('.prose p').filter({ hasText: selected }).evaluate((node, text) => {
    const child = node.firstChild!; const range = document.createRange(); range.setStart(child, 0); range.setEnd(child, text.length);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, selected);
  await until(async () => (await invoke<ReadingContext>('context', { viewId })).selection.text === selected, 'actual document selection reported');
  await openAI();
  assert.deepEqual(await page.locator('.ai-reading-tools [data-ai-tool]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-ai-tool'))), AI_READING_TOOLS.map(tool => tool.id));
  const catalog = await invoke<{ tools: typeof AI_READING_TOOLS; scopes: string[] }>('ai-reading-tools', { viewId });
  assert.deepEqual(catalog.tools, AI_READING_TOOLS); assert.deepEqual(catalog.scopes, ['selection', 'visible']);
  assert.equal(await page.locator('.ai-reading-scopes').getByRole('radio', { name: '整篇文档', exact: true }).count(), 0);
  checks.push('GUI and real command catalog expose the same 11 bounded reading actions');
  await page.locator('[data-ai-tool="summary"]').hover(); await assertFrostedTooltip(page); await page.mouse.move(800, 900);
  // Copy is verified through the real click handler, with only this isolated
  // renderer's Clipboard API stubbed so the user's OS clipboard is preserved.
  await page.evaluate("Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async function(text) { sessionStorage.setItem('qa-ai-copy', text); } })");
  for (const [index, tool] of AI_READING_TOOLS.entries()) {
    await openAI(); const scope = index === 0 ? 'selection' : 'visible';
    await page.locator('.ai-reading-scopes').getByRole('radio', { name: scope === 'selection' ? '选中内容' : '当前可见', exact: true }).click();
    const beforeTasks = new Set((await state()).tasks.map(task => task.id)), beforeCalls = requests.length;
    await page.locator(`[data-ai-tool="${tool.id}"]`).click();
    const card = page.locator('.ai-result-popover'); await card.waitFor();
    assert.match(await card.locator('header small').innerText(), scope === 'selection' ? /选中内容/ : /当前可见/);
    assert.equal(await card.locator('.liquid-glass-surface').getAttribute('data-glass-effect'), 'refractive');
    await until(async () => await card.locator('feDisplacementMap[data-glass-displacement]').count() > 0, 'full card refraction generated');
    const cardHeight = await card.evaluate(node => node.getBoundingClientRect().height);
    await until(async () => { const task = (await state()).tasks.find(task => !beforeTasks.has(task.id)); return task?.status === 'completed'; }, tool.id + ' completes via actual provider');
    await until(async () => (await card.innerText()).includes(requests.at(-1)!.response), tool.id + ' result rendered');
    assert.equal(requests.length, beforeCalls + 1); assert.equal(await card.evaluate(node => node.getBoundingClientRect().height), cardHeight, 'provider completion does not resize optical card');
    const events = await invoke<{ type: string; data: { toolId?: string; scope?: string; taskId?: string } }[]>('events');
    const event = events.filter(event => event.type === 'ai.reading').at(-1)!; assert.equal(event.data.toolId, tool.id); assert.equal(event.data.scope, scope);
    const task = (await state()).tasks.find(task => task.id === event.data.taskId)!;
    const snapshot = await invoke<ReadingSnapshot>('snapshot-read', { snapshotId: task.snapshotId });
    assert.equal(snapshot.context.viewId, viewId); assert.equal(snapshot.document.revision, originalDocument.revision);
    const prompt = requests.at(-1)!.prompt, match = /\n内容：([\s\S]*?)\n问题：/.exec(prompt); assert.ok(match);
    if (scope === 'selection') assert.equal(match[1], selected);
    else { assert.ok(match[1].includes('VISIBLE_SECONDARY_SOURCE')); assert.ok(match[1].length > selected.length); }
    assert.ok(!prompt.includes('SECRET_UNREAD_DOCUMENT_TAIL')); assert.ok(!prompt.includes(directory));
    assert.deepEqual((await state()).documents.find(document => document.id === originalDocument.id), originalDocument);
    assert.deepEqual(await readFile(sourcePath), disk);
    if (index === AI_READING_TOOLS.length - 1) {
      await card.getByRole('button', { name: '复制分析结果', exact: true }).click();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-ai-copy')), requests.at(-1)!.response);
      await page.screenshot({ path: join(evidence, 'ai-result-refractive.png'), scale: 'css' });
      const expected = requests.at(-1)!.response;
      await card.getByRole('button', { name: '保存分析为独立文档', exact: true }).click();
      await until(async () => (await state()).documents.some(document => document.title === tool.label + '.md' && document.id !== originalDocument.id), 'analysis becomes independent Markdown document');
      const generated = (await state()).documents.find(document => document.title === tool.label + '.md' && document.id !== originalDocument.id)!;
      assert.equal(generated.model.text, expected);
      const artifactPath = join(directory, 'analysis-result.md');
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, artifactPath);
      await page.keyboard.press('Control+s');
      await until(async () => (await state()).documents.find(document => document.id === generated.id)?.path === artifactPath, 'independent analysis saved to disk');
      assert.equal(await readFile(artifactPath, 'utf8'), expected); assert.deepEqual(await readFile(sourcePath), disk);
      await page.locator('.tab').filter({ hasText: originalDocument.title }).getByRole('button', { name: originalDocument.title, exact: true }).click();
    } else await card.getByRole('button', { name: '关闭分析结果', exact: true }).click();
  }
  checks.push('all 11 UI actions reach the model once, report scope/identity, leave original model and file clean');
  checks.push('fixed-size refractive result card, copy handler, independent Markdown creation and real disk save');
  await page.locator('.prose p').filter({ hasText: selected }).evaluate((node, text) => { const range = document.createRange(); range.setStart(node.firstChild!, 0); range.setEnd(node.firstChild!, text.length); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); }, selected);
  await until(async () => (await invoke<ReadingContext>('context', { viewId })).selection.text === selected, 'selection restored for translation');
  await openAI(); await page.locator('.ai-drawer').getByRole('button', { name: '翻译选区', exact: true }).click();
  await page.locator('.ai-drawer').getByRole('button', { name: '关闭 AI 抽屉', exact: true }).click();
  const translation = page.locator('.translation-popover'); await translation.locator('.translation-result').waitFor();
  assert.equal(await translation.locator('.liquid-glass-surface').getAttribute('data-glass-effect'), 'refractive');
  await until(async () => await translation.locator('feDisplacementMap[data-glass-displacement]').count() > 0, 'translation card full refraction');
  assert.deepEqual((await state()).documents.find(document => document.id === originalDocument.id), originalDocument);
  checks.push('selection translation uses a refractive separate result without editing original');
  const nav = page.locator('.reader-toolbar');
  assert.equal(await nav.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await nav.evaluate(node => getComputedStyle(node).backdropFilter), 'none');
  // The native toolbar shares the same TooltipHost; inspect its real independent
  // WebContents rather than inferring it from the local reader's tooltip.
  await openUri(`http://127.0.0.1:${port}/fixtures/interaction.html`);
  await until(async () => app.context().pages().some(target => target.url().includes('#/web-toolbar')), 'native toolbar created');
  const toolbar = app.context().pages().find(target => target.url().includes('#/web-toolbar'))!;
  await toolbar.getByRole('button', { name: '刷新', exact: true }).hover(); await assertFrostedTooltip(toolbar);
  assert.equal(await toolbar.locator('.navigation-glass').getAttribute('data-glass-effect'), 'refractive');
  checks.push('local and native tooltip surfaces are frosted without fallback; navigation root has no rectangular mask');
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, port, checks, errors, providerCalls: requests.length, tools: AI_READING_TOOLS.map(tool => tool.id), clipboard: 'isolated renderer Clipboard API; OS clipboard untouched' }, null, 2));
  console.log('AI reading UI/provider/scope/material/save: PASS', evidence);
} catch (error) {
  await page.screenshot({ path: join(evidence, 'failure.png'), scale: 'css' }).catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), checks, errors, providerCalls: requests.length, state: await state().catch(() => undefined) }, null, 2));
  console.error('AI reading UI evidence:', evidence); throw error;
} finally { await app.close(); await new Promise<void>(done => modelServer.close(() => done())); }
