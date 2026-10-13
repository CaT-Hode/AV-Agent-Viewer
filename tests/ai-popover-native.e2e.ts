import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer as httpServer } from 'node:http';
import { createServer as portServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { HarnessTask, ReadingContext, WorkspaceState } from '../packages/contracts/src/index';

// Use only after the shared final build and with the Electron UI execution lock.
// This exercises the trusted native result WC over a real independent webpage.
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-ai-popover-native-'));
const evidence = join(directory, 'evidence'); await mkdir(evidence);
const prompts: string[] = [], result = '# 原生分析结果\n\n**明确的结论**\n\n|字段|说明|\n|---|---|\n|来源|冻结选区|\n\n<script>window.__unsafe = true</script>\n\n![禁止外部图片](https://example.invalid/image.png)\n';
const provider = httpServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  response.setHeader('Content-Type', 'application/json');
  if (request.url?.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: 'native-popup-test' }] })); return; }
  if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end('{}'); return; }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] };
  prompts.push(input.messages.map(message => message.content).join('\n'));
  await new Promise(done => setTimeout(done, 350));
  response.end(JSON.stringify({ choices: [{ message: { content: result } }] }));
});
await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
const modelAddress = provider.address(); assert.ok(modelAddress && typeof modelAddress !== 'string');
await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, revision: 0, values: { 'appearance.motion': 'elegant', 'appearance.glass': 'standard', 'appearance.autoHideToolbar': false, 'appearance.theme': 'light', 'translation.selectionAuto': false } }));
const port = await new Promise<number>((done, reject) => { const server = portServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: process.env.AGENTVIEWER_QA_EXE ?? require('electron'), args: process.env.AGENTVIEWER_QA_EXE ? [] : ['.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], checks: Record<string, unknown> = {};
const watch = (page: Page) => { page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message)); };
app.context().pages().forEach(watch); app.context().on('page', watch);
const invoke = <T>(method: string, args: Record<string, unknown> = {}) => main.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const state = () => invoke<WorkspaceState>('state'), wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const until = async (check: () => Promise<boolean>, label: string, ms = 12000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await check()) return; await wait(50); } throw new Error('Timeout: ' + label); };
const readMotion = (page: Page) => page.evaluate(() => {
  const host = document.querySelector<HTMLElement>('.ai-result-popover'); if (!host) return null;
  const style = getComputedStyle(host), rect = host.getBoundingClientRect();
  return { phase: host.dataset.motionPhase, inert: host.inert, opacity: style.opacity, translate: style.translate, scale: style.scale, duration: style.getPropertyValue('--motion-duration'), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, foreground: [...host.children].filter(node => !node.classList.contains('liquid-glass-surface')).map(node => Number(getComputedStyle(node).opacity)), leaves: [...host.querySelectorAll('.liquid-glass-center,.liquid-glass-edge,.liquid-glass-tint')].map(node => Number(getComputedStyle(node).opacity)) };
});
const hostVisible = (page: Page) => app.evaluate(({ BrowserWindow, WebContentsView }, url) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).flatMap(window => window.contentView.children).find(view => view instanceof WebContentsView && !view.webContents.isDestroyed() && view.webContents.getURL() === url)?.getVisible(), page.url());
const capture = async (page: Page, name: string) => { const bytes = await app.evaluate(async ({ webContents }, url) => (await webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.getURL() === url)!.capturePage()).toPNG().toString('base64'), page.url()); await writeFile(join(evidence, name + '.png'), Buffer.from(bytes, 'base64')); };
let native: Page | undefined, popup: Page | undefined;
try {
  await main.locator('.prose h1').waitFor(); await main.locator('html[data-motion="elegant"]').waitFor();
  const connections = await invoke<{ profiles: { id: string }[] }>('connections-upsert', { name: 'isolated native result test', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:' + modelAddress.port + '/v1', modelId: 'native-popup-test' });
  await invoke('connections-route', { tool: 'chat', id: connections.profiles.at(-1)!.id });
  const initial = await state(), web = initial.views.find(view => initial.documents.find(document => document.id === view.documentId)?.format === 'web')!;
  await main.locator(`.tab[data-view-id="${web.id}"] .tab-select`).click();
  await until(async () => app.context().pages().some(page => page.url() === `http://127.0.0.1:${port}/fixtures/interaction.html`), 'native real webpage loads');
  native = app.context().pages().find(page => page.url() === `http://127.0.0.1:${port}/fixtures/interaction.html`)!;
  const select = async (selector: string) => native!.locator(selector).evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await native.getByRole('heading', { name: '网页交互测试', exact: true }).waitFor(); await select('main > p');
  await until(async () => (await invoke<ReadingContext>('context', { viewId: web.id })).selection.text.includes('鼠标拖动'), 'actual native selection reaches frozen context');
  const originalSelection = (await invoke<ReadingContext>('context', { viewId: web.id })).selection.text;
  await main.locator('.ai-rail').getByRole('button', { name: 'AI 工具', exact: true }).click();
  await main.locator('.ai-reading-scopes').getByRole('radio', { name: '选中内容', exact: true }).click();
  await main.locator('[data-ai-tool="explain"]').click();
  await until(async () => app.context().pages().some(page => page.url().includes('#/ai-result-toolbar')), 'trusted native result WC exists');
  popup = app.context().pages().find(page => page.url().includes('#/ai-result-toolbar'))!;
  await popup.locator('.ai-result-popover').waitFor(); await wait(100);
  const entering = await readMotion(popup); checks.entering = entering; assert.ok(entering);
  assert.equal(entering.opacity, '1'); assert.equal(entering.translate, 'none'); assert.equal(entering.scale, '1');
  assert.ok(entering.foreground.some(alpha => alpha > 0 && alpha < 1), 'native foreground actually interpolates during entrance');
  await popup.getByRole('heading', { name: '原生分析结果', exact: true }).waitFor();
  await until(async () => (await readMotion(popup!))?.foreground.every(alpha => alpha === 1) === true, 'native appearance settles');
  assert.equal(await popup.locator('.ai-result-markdown table').count(), 1); assert.equal(await popup.locator('.ai-result-markdown strong').innerText(), '明确的结论');
  assert.equal(await popup.locator('.ai-result-markdown script,.ai-result-markdown img').count(), 0); assert.equal(await popup.evaluate(() => (window as unknown as { __unsafe?: boolean }).__unsafe), undefined);
  assert.equal(await popup.locator('.ai-result-popover').evaluate(node => node.getBoundingClientRect().height), entering.rect.height, 'rich content never resizes the optical host');
  await popup.getByRole('button', { name: '查看本次来源', exact: true }).click(); assert.equal(await popup.locator('.ai-source-text').innerText(), originalSelection);
  await popup.getByRole('button', { name: '返回结果', exact: true }).click();
  const before = await popup.evaluate(() => window.agentViewer!.call('toolbar-state', {})) as { taskId: string; backdropSample: { capsuleBounds: { x: number; y: number; width: number; height: number }; navigationId: string } };
  await select('main h1'); await until(async () => (await invoke<ReadingContext>('context', { viewId: web.id })).selection.text === '网页交互测试', 'human source changes after analysis');
  await popup.getByRole('button', { name: '使用本次来源重新分析', exact: true }).click();
  await until(async () => prompts.length === 2 && (await state()).tasks.filter(task => task.status === 'completed').length >= 2, 'native retry completes through provider');
  assert.equal(prompts[1], prompts[0], 'retry uses the identical frozen scoped source despite a new human selection');
  const after = await popup.evaluate(() => window.agentViewer!.call('toolbar-state', {})) as { taskId: string };
  assert.notEqual(after.taskId, before.taskId, 'retry creates a new result task');
  await popup.getByRole('button', { name: '查看本次来源', exact: true }).click(); assert.equal(await popup.locator('.ai-source-text').innerText(), originalSelection);
  await popup.getByRole('button', { name: '返回结果', exact: true }).click(); await wait(700);
  const settled = await readMotion(popup); assert.ok(settled);
  const sample = await popup.evaluate(() => window.agentViewer!.call('toolbar-state', {})) as { backdropSample: { capsuleBounds: typeof settled.rect } };
  assert.ok(sample.backdropSample); for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(sample.backdropSample.capsuleBounds[key] - settled.rect[key]) < .6, 'actual native geometry stays source-aligned: ' + key);
  await capture(popup, 'native-rich-result'); await capture(native, 'native-source');
  await popup.getByRole('button', { name: '关闭分析结果', exact: true }).click(); await wait(140);
  const exiting = await readMotion(popup); checks.exiting = exiting; assert.ok(exiting); assert.equal(exiting.inert, true);
  assert.equal(exiting.opacity, '1'); assert.equal(exiting.translate, 'none'); assert.equal(exiting.scale, '1'); assert.deepEqual(exiting.rect, settled.rect);
  assert.ok(exiting.foreground.some(alpha => alpha > 0 && alpha < 1), 'close keeps a real intermediate foreground frame');
  assert.ok(exiting.leaves.every(alpha => alpha > 0 && alpha < 1), 'material leaves actually fade, with no visible old card');
  assert.ok(Math.max(...exiting.foreground) - Math.min(...exiting.leaves) < .03, 'foreground and material share one fade curve');
  assert.equal(await hostVisible(popup), true, 'native host is retained throughout its real exit'); await capture(popup, 'native-mid-exit');
  await main.locator('.ai-rail').getByRole('button', { name: 'AI 工具', exact: true }).click();
  const history = main.locator('.ai-history-item').first(); await history.waitFor({ state: 'attached' });
  // A human can click a moving drawer. Use its current presentation rectangle
  // instead of Playwright's stability wait, which would finish the old exit.
  await history.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const historyRect = await history.boundingBox(); assert.ok(historyRect);
  await main.mouse.click(historyRect.x + historyRect.width / 2, historyRect.y + historyRect.height / 2);
  await until(async () => (await readMotion(popup!))?.inert === false, 'mid-exit history reopen immediately restores interaction');
  await wait(750); assert.equal(await hostVisible(popup), true); assert.equal(await popup.locator('.ai-result-popover').count(), 1, 'cancelled native exit cannot later hide the reopened answer');
  checks.interruptedExit = true;
  await popup.getByRole('button', { name: '关闭分析结果', exact: true }).click();
  await wait(100); assert.equal(await hostVisible(popup), true);
  await invoke('settings-set', { id: 'appearance.motion', value: 'off' });
  const offTrace: unknown[] = []; checks.offDuringExitTrace = offTrace;
  await until(async () => {
    const visible = await hostVisible(popup!), count = await popup!.locator('.ai-result-popover').count();
    const actual = await popup!.evaluate(async () => {
      const value = await window.agentViewer!.call('toolbar-state', {}) as { hideDurationMs?: number; settings?: { revision: number; values: Record<string, unknown> } };
      return { nativeMode: document.documentElement.dataset.motion, hostDuration: value.hideDurationMs, hostSettingsMode: value.settings?.values['appearance.motion'], hostSettingsRevision: value.settings?.revision };
    });
    offTrace.push({ visible, count, ...actual });
    return visible === false && count === 0;
  }, 'motion off cancels an already retained native input surface', 350);
  checks.offDuringExit = true;
  await until(async () => await hostVisible(popup!) === false && await popup!.locator('.ai-result-popover').count() === 0, 'native host and retained content both stop after exit');
  checks.frozenRetry = { originalSelection, providerCalls: prompts.length, oldTask: before.taskId, newTask: after.taskId };
  // Reopen from real history, then switch identity during the exit. Old content
  // must disappear immediately instead of riding into the unrelated document.
  await invoke('settings-set', { id: 'appearance.motion', value: 'elegant' });
  await main.locator('.ai-rail').getByRole('button', { name: 'AI 工具', exact: true }).click();
  await main.locator('.ai-history-item').first().click(); await popup.locator('.ai-result-popover').waitFor(); await wait(700);
  await popup.getByRole('button', { name: '关闭分析结果', exact: true }).click();
  const markdown = (await state()).views.find(view => initial.documents.find(document => document.id === view.documentId)?.format === 'markdown')!;
  await main.locator(`.tab[data-view-id="${markdown.id}"] .tab-select`).click();
  await until(async () => await hostVisible(popup!) === false, 'cross-view switch immediately removes unrelated native exit');
  assert.equal(await main.locator('.ai-result-popover').count(), 0, 'retained old source is never shown in a new reader');
  checks.noStaleExit = true;
  // The two accessibility modes retain no spring travel or delayed native paint.
  for (const [mode, maximum] of [['reduced', 80], ['off', 0]] as const) {
    await invoke('settings-set', { id: 'appearance.motion', value: mode });
    await main.locator(`.tab[data-view-id="${web.id}"] .tab-select`).click();
    const ai = main.locator('.ai-rail').getByRole('button', { name: 'AI 工具', exact: true }); if (await ai.getAttribute('aria-expanded') !== 'true') await ai.click();
    await main.locator('.ai-history-item').first().click(); await popup.locator('.ai-result-popover').waitFor(); await wait(100);
    const accessible = await readMotion(popup); assert.ok(accessible); assert.equal(accessible.translate, 'none'); assert.equal(accessible.scale, '1'); assert.equal(accessible.duration.trim(), `${maximum}ms`);
    await popup.getByRole('button', { name: '关闭分析结果', exact: true }).click(); await wait(maximum + 60);
    assert.equal(await hostVisible(popup), false); assert.equal(await popup.locator('.ai-result-popover').count(), 0);
  }
  assert.deepEqual(errors, []); await writeFile(join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', checks, errors, prompts, actualRenderer: await main.evaluate(() => [...document.scripts].map(script => script.src).filter(Boolean)) }, null, 2));
  console.log('Native AI rich source/retry/motion/retention/accessibility: PASS', evidence);
} catch (error) {
  await main.screenshot({ path: join(evidence, 'failure-main.png') }).catch(() => {}); if (native) await capture(native, 'failure-native').catch(() => {}); if (popup) await capture(popup, 'failure-popup').catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), checks, errors, prompts, state: await state().catch(() => undefined), nativeMotion: popup ? await readMotion(popup).catch(() => undefined) : undefined }, null, 2)); console.error('Native AI evidence', evidence); throw error;
} finally { await app.close(); await new Promise<void>(done => provider.close(() => done())); }
