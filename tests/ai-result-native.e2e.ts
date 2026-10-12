import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { HarnessTask, ReadingContext, WorkspaceState } from '../packages/contracts/src/index';
import type { NavigationBackdropSample, NavigationBounds } from '../apps/desktop/src/renderer/lib/navigation-optics';
import type { BackdropCacheStatistics } from '../apps/desktop/src/main/backdrop-cache';

const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-ai-result-native-')), evidence = join(directory, 'evidence'); await mkdir(evidence);
const port = await new Promise<number>((done, reject) => { const server = createNetServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const requests: { prompt: string; aborted?: boolean }[] = []; let responseDelay = 900;
const model = createHttpServer((request, response) => {
  let body = ''; request.on('data', chunk => { body += String(chunk); }); request.on('end', () => {
    const input = JSON.parse(body) as { messages: { content: string }[] }, record = { prompt: input.messages[0].content, aborted: false }; requests.push(record);
    const timer = setTimeout(() => { if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: '真实 UI 分析结果：这份冻结材料描述网页交互测试。\n来源范围明确，原页面没有被修改。' } }] })); } }, responseDelay);
    response.on('close', () => { clearTimeout(timer); if (!response.writableEnded) record.aborted = true; });
  });
});
await new Promise<void>(done => model.listen(0, '127.0.0.1', done)); const modelAddress = model.address(); assert.ok(modelAddress && typeof modelAddress !== 'string');
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? 1.5); assert.ok([1, 1.5, 2].includes(scale));
const app = await electron.launch({ executablePath: require('electron'), args: ['--force-device-scale-factor=' + scale, '.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], results: Record<string, unknown> = {};
main.on('pageerror', error => errors.push(error.message)); app.context().on('page', page => page.on('pageerror', error => errors.push(error.message)));
const invoke = <T = unknown>(page: Page, method: string, args: Record<string, unknown> = {}) => page.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const workspace = () => invoke<WorkspaceState>(main, 'state');
const until = async (predicate: () => Promise<boolean>, label: string) => { for (let attempt = 0; attempt < 180; attempt++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 50)); } throw new Error('等待失败：' + label); };
type ResultState = { viewId: string; taskId: string; visible: boolean; task: HarnessTask; backdropImage?: string; backdropSample?: NavigationBackdropSample & { captureBounds: NavigationBounds }; backdropDiagnostics: BackdropCacheStatistics };
let resultPage: Page | undefined;
try {
  await main.locator('.prose h1').waitFor(); await invoke(main, 'settings-set', { id: 'appearance.theme', value: 'light' }); await invoke(main, 'settings-set', { id: 'appearance.motion', value: 'off' }); await invoke(main, 'settings-set', { id: 'translation.selectionAuto', value: false });
  const configured = await invoke<{ profiles: { id: string }[] }>(main, 'connections-upsert', { name: 'Isolated AI result test', protocol: 'chat-completions', modelId: 'test-model', baseUrl: 'http://127.0.0.1:' + modelAddress.port }); await invoke(main, 'connections-route', { tool: 'chat', id: configured.profiles[0].id });
  await main.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click(); await until(async () => (await invoke<ReadingContext>(main, 'context')).quality === 'confirmed', 'real native webpage context ready');
  const before = await workspace(), view = before.views.find(view => view.id === before.activeViewId)!, fixture = app.context().pages().find(page => page.url() === `http://127.0.0.1:${port}/fixtures/interaction.html`)!; assert.ok(fixture); assert.equal(await fixture.evaluate(() => typeof window.agentViewer), 'undefined');
  await main.getByRole('button', { name: 'AI 工具', exact: true }).click(); await main.getByRole('radio', { name: '当前可见', exact: true }).click(); await main.locator('button[data-ai-tool="summary"]').click();
  await until(async () => app.context().pages().some(page => page.url().includes('#/ai-result-toolbar')), 'trusted native result route mounts'); resultPage = app.context().pages().find(page => page.url().includes('#/ai-result-toolbar'))!;
  const resultState = () => invoke<ResultState>(resultPage!, 'toolbar-state');
  await until(async () => { const state = await resultState(); return state.visible && state.viewId === view.id && !!state.backdropImage && !!state.backdropSample && state.task.status === 'completed'; }, 'actual AI result reaches trusted panel');
  await resultPage.getByText('真实 UI 分析结果：这份冻结材料描述网页交互测试。', { exact: false }).waitFor(); assert.equal(await main.locator('.ai-result-popover').count(), 0, 'web result is not obscured below native webpage');
  await invoke(main, 'settings-set', { id: 'appearance.theme', value: 'dark' });
  await resultPage.locator('html[data-theme="dark"]').waitFor();
  await resultPage.locator('.native-ai-result-popover[data-surface="light"]').waitFor();
  const contrast = await resultPage.locator('.native-ai-result-popover').evaluate(element => ({ ink: getComputedStyle(element).color, muted: getComputedStyle(element).getPropertyValue('--muted'), tint: getComputedStyle(element).getPropertyValue('--liquid-glass-tint') }));
  assert.equal(contrast.ink, 'rgb(37, 52, 64)', 'actual light webpage keeps dark readable result ink even under dark app theme'); results.contrast = contrast;
  await until(async () => { const actual = await resultPage!.locator('.ai-result-popover').evaluate(element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }), sample = (await resultState()).backdropSample; return !!sample && ['x', 'y', 'width', 'height'].every(key => Math.abs(actual[key as keyof NavigationBounds] - sample.capsuleBounds[key as keyof NavigationBounds]) < .5); }, 'native result uses actual panel geometry');
  const sampled = await resultState(); assert.ok(Math.abs(sampled.backdropSample!.density.x - scale) < .07);
  const pixel = await app.evaluate(async ({ nativeImage, webContents }, args) => {
    const source = webContents.fromId(args.sample.sourceContentsId)!; if (source.getURL() !== args.url) throw new Error('Wrong result backdrop source');
    const fresh = await source.capturePage(args.sample.captureBounds), expected = nativeImage.createFromDataURL(args.image), overlay = webContents.getAllWebContents().find(contents => contents.getURL().includes('#/ai-result-toolbar'))!, capture = await overlay.capturePage(), size = capture.getSize(), bitmap = capture.toBitmap();
    return { equal: fresh.toBitmap().equals(expected.toBitmap()), corners: [0, size.width - 1, (size.height - 1) * size.width, size.width * size.height - 1].map(index => bitmap[index * 4 + 3]), size };
  }, { sample: sampled.backdropSample!, image: sampled.backdropImage!, url: fixture.url() });
  assert.equal(pixel.equal, true, 'actual webpage body pixels feed the native result material'); assert.ok(pixel.corners.every(alpha => alpha <= 8), 'panel exterior stays transparent'); results.pixel = { sample: sampled.backdropSample, pixel };
  await assert.rejects(invoke(resultPage, 'ai-result-action', { action: 'close', viewId: view.id, taskId: 'another-task' }), /AUTH_SCOPE_DENIED/); await assert.rejects(invoke(resultPage, 'harness-cancel', { taskId: sampled.taskId }), /AUTH_SCOPE_DENIED/); await assert.rejects(invoke(resultPage, 'toolbar-action', { action: 'navigate', viewId: view.id, url: 'https://example.com' }), /AUTH_SCOPE_DENIED/);
  await resultPage.screenshot({ path: join(evidence, 'native-ai-result.png'), omitBackground: true, scale: 'css' }); await resultPage.getByRole('button', { name: '保存分析为独立文档', exact: true }).click(); await until(async () => (await workspace()).documents.some(document => document.format === 'markdown' && document.model.text === sampled.task.text), 'UI saves the bound result as an independent document');
  await until(async () => !(await resultState()).visible, 'save hides source result pane'); const hidden = (await resultState()).backdropDiagnostics; await main.waitForTimeout(850); assert.equal((await resultState()).backdropDiagnostics.captures, hidden.captures, 'hidden result has no capture watchdog'); results.hidden = hidden;
  await main.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click(); await main.getByRole('button', { name: 'AI 工具', exact: true }).click(); await main.getByRole('radio', { name: '当前可见', exact: true }).click(); responseDelay = 5000; await main.locator('button[data-ai-tool="summary"]').click(); await until(async () => (await resultState()).visible && (await resultState()).task.status === 'running', 'second genuine task running in result panel');
  const runningId = (await resultState()).taskId; await resultPage.getByRole('button', { name: '取消分析', exact: true }).click(); await until(async () => (await workspace()).tasks.find(task => task.id === runningId)?.status === 'cancelled', 'native cancellation addresses its bound active task');
  assert.equal((await workspace()).tasks.find(task => task.id === sampled.taskId)?.status, 'completed', 'other completed task remains untouched'); await resultPage.getByRole('button', { name: '关闭分析结果', exact: true }).click(); await until(async () => !(await resultState()).visible, 'native close dismisses current result');
  assert.ok(requests.length >= 2); assert.ok(requests[0].prompt.includes('网页交互测试')); assert.deepEqual(errors, []); results.tasks = { completed: sampled.taskId, cancelled: runningId }; results.modelRequests = requests.map(request => ({ promptLength: request.prompt.length, aborted: request.aborted })); await writeFile(join(evidence, 'results.json'), JSON.stringify(results, null, 2)); console.log('Native AI result: real UI task / source bitmap / transparent exterior / scoped actions / save-cancel-close / no hidden watchdog: PASS', evidence);
} catch (error) {
  await main.screenshot({ path: join(evidence, 'failure-main.png'), scale: 'css' }).catch(() => {}); if (resultPage) { await resultPage.screenshot({ path: join(evidence, 'failure-result.png'), omitBackground: true, scale: 'css' }).catch(() => {}); results.state = await invoke(resultPage, 'toolbar-state').catch(() => undefined); } await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), errors, results }, null, 2)); console.error('Native AI result evidence:', evidence); throw error;
} finally { await app.close(); await new Promise<void>(done => model.close(() => done())); }
