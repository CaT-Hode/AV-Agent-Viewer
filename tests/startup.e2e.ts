import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ReadingContext, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';

// A real single-instance lock is essential here. All processes share this
// disposable profile; none connect to or manipulate the installed user app.
const require = createRequire(import.meta.url), executable = require('electron') as string;
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-startup-')), evidence = join(directory, 'evidence');
await mkdir(evidence);
const port = await new Promise<number>((done, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); });
});
const env: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port),
};
for (const key of ['ELECTRON_RUN_AS_NODE', 'AGENTVIEWER_TEST_MODE', 'AGENTVIEWER_TEST_TRANSLATOR', 'AGENTVIEWER_VITE_URL']) delete env[key];
const application = await electron.launch({ executablePath: executable, args: ['.'], cwd: resolve('.'), env, timeout: 45000 });
const primary = application.process(), errors: string[] = [], stderr: string[] = [], secondaries = new Set<ChildProcess>();
const activations: { label: string; pid?: number; code: number | null; signal: string | null; output: string }[] = [];
const checks: string[] = [], stages: Record<string, unknown> = {};
let stopped = false;
primary.stderr?.on('data', value => stderr.push(String(value)));
const watch = (target: Page) => target.on('pageerror', error => errors.push(`${target.url()}: ${error.message}`));
application.context().pages().forEach(watch); application.context().on('page', watch);
const pause = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds));
const until = async (check: () => Promise<boolean>, label: string, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(75); }
  throw new Error(`Startup regression timed out: ${label}`);
};
const windows = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()&&!win.webContents.isDestroyed()).map(win => ({
  id: win.id, url: win.webContents.getURL(), visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(),
  children: win.contentView.children.filter((child: any)=>!child.webContents||!child.webContents.isDestroyed()).map((child: any) => ({ contentsId: child.webContents?.id as number | undefined, url: child.webContents?.getURL() as string | undefined })),
})));
const endpoint = `http://127.0.0.1:${port}/`, fixture = endpoint + 'fixtures/interaction.html';
const readers = async () => (await windows()).filter(win => win.url === endpoint);
const invoke = <T = unknown>(target: Page, method: string, args: Record<string, unknown> = {}) => target.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const launchAgain = (label: string) => new Promise<void>((done, reject) => {
  const child = spawn(executable, ['.'], { cwd: resolve('.'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  secondaries.add(child); let output = '';
  const capture = (value: Buffer) => { output = (output + value.toString()).slice(-12000); };
  child.stdout?.on('data', capture); child.stderr?.on('data', capture);
  const deadline = setTimeout(() => { child.kill(); reject(new Error(`Secondary instance retained a process: ${label}`)); }, 15000);
  child.once('error', error => { clearTimeout(deadline); secondaries.delete(child); reject(error); });
  child.once('exit', (code, signal) => {
    clearTimeout(deadline); secondaries.delete(child); activations.push({ label, pid: child.pid, code, signal, output });
    if (code !== 0 || signal) reject(new Error(`Secondary instance failed: ${label}, code=${code}, signal=${signal}\n${output}`)); else done();
  });
});
const visibleReader = async () => (await readers()).some(win => win.visible && !win.minimized);
const mainPage = async () => {
  await until(async () => application.context().pages().some(page => !page.isClosed() && page.url() === endpoint), 'main renderer page');
  return application.context().pages().find(page => !page.isClosed() && page.url() === endpoint)!;
};

try {
  let main = await mainPage(); await main.locator('.prose h1').waitFor();
  await until(async () => (await invoke<WorkspaceState>(main, 'state')).views.length === 3, 'default document restoration');
  const identity = await application.evaluate(({ app }) => ({ pid: process.pid, profile: app.getPath('userData'), lock: app.hasSingleInstanceLock(), testMode: process.env.AGENTVIEWER_TEST_MODE }));
  assert.equal(resolve(identity.profile), resolve(directory)); assert.equal(identity.lock, true); assert.equal(identity.testMode, undefined);
  const initial = await invoke<WorkspaceState>(main, 'state'), documentIds = initial.documents.map(doc => doc.id).sort(), viewIds = initial.views.map(view => view.id).sort();
  const webDocument = initial.documents.find(doc => doc.format === 'web')!, webView = initial.views.find(view => view.documentId === webDocument.id)!;
  assert.ok(webDocument && webView);
  const mainId = (await readers())[0].id; stages.initial = { identity, windows: await windows(), documentIds, viewIds };

  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.hide(), mainId);
  assert.equal((await readers())[0].visible, false);
  await launchAgain('hidden-primary'); await until(visibleReader, 'hidden primary shown by real second instance');
  assert.equal((await readers())[0].id, mainId); assert.equal((await readers()).length, 1);
  stages.hiddenRestored = await windows(); checks.push('hidden primary is shown by a real secondary process');

  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.minimize(), mainId);
  await until(async () => (await readers())[0].minimized, 'primary minimized');
  await launchAgain('minimized-primary'); await until(visibleReader, 'minimized primary restored by real second instance');
  assert.equal((await readers())[0].id, mainId); stages.minimizedRestored = await windows();
  checks.push('minimized primary is restored without creating another window');

  await invoke(main, 'activate', { viewId: webView.id }); await main.locator('.reader-format-web').waitFor();
  await until(async () => (await readers())[0].children.some(child => child.url === fixture), 'original native web view');
  const beforeWebContents = (await readers())[0].children.find(child => child.url === fixture)!.contentsId;
  let beforeContext!: ReadingContext;
  await until(async () => { beforeContext = await invoke<ReadingContext>(main, 'context', { viewId: webView.id }); return beforeContext.quality === 'confirmed' && /网页交互测试|验证真实选中/.test(beforeContext.visibleText); }, 'original webpage DOM/context ready');
  await invoke(main, 'settings-open', { category: '通用与多开' });
  await until(async () => (await windows()).some(win => win.url.includes('#/settings')), 'independent settings window');
  const settingsId = (await windows()).find(win => win.url.includes('#/settings'))!.id;
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(), mainId);
  await until(async () => (await readers()).length === 0, 'main closed while settings keeps the process alive');
  assert.ok((await windows()).some(win => win.id === settingsId));
  assert.equal(primary.exitCode, null); stages.onlySettings = await windows();

  await launchAgain('settings-only-recreate'); await until(visibleReader, 'reader recreated with settings still open');
  main = await mainPage(); await main.locator('.reader-format-web').waitFor();
  await until(async () => (await readers())[0].children.some(child => child.url === fixture), 'native web view recreated');
  const restored = await invoke<WorkspaceState>(main, 'state');
  assert.deepEqual(restored.documents.map(doc => doc.id).sort(), documentIds); assert.deepEqual(restored.views.map(view => view.id).sort(), viewIds);
  const restoredWebContents = (await readers())[0].children.find(child => child.url === fixture)!.contentsId;
  assert.notEqual(restoredWebContents, beforeWebContents);
  let restoredContext!: ReadingContext;
  await until(async () => { restoredContext = await invoke<ReadingContext>(main, 'context', { viewId: webView.id }); return restoredContext.quality === 'confirmed' && /网页交互测试|验证真实选中/.test(restoredContext.visibleText); }, 'recreated webpage DOM/context ready');
  assert.equal(restoredContext.documentId, webDocument.id); assert.match(restoredContext.visibleText, /网页交互测试|验证真实选中/);
  assert.notEqual(restoredContext.viewport!.navigationId, beforeContext.viewport!.navigationId);
  const recoveredId = (await readers())[0].id; assert.notEqual(recoveredId, mainId);
  stages.recreated = { windows: await windows(), beforeWebContents, restoredWebContents, navigationId: restoredContext.viewport!.navigationId };
  checks.push('main closes while settings survives; relaunch recreates the reader and native webpage with the same document/view IDs');
  await main.screenshot({ path: join(evidence, 'reader-recreated.png'), scale: 'css' });

  // Stress the missing-window creation flight, rather than just focusing an
  // already existing window. Four second processes race through the real lock.
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(), recoveredId);
  await until(async () => (await readers()).length === 0, 'main closed before rapid relaunch');
  await Promise.all(Array.from({ length: 4 }, (_, index) => launchAgain(`rapid-recreate-${index + 1}`)));
  await until(visibleReader, 'rapid relaunch creates a reader'); main = await mainPage();
  await main.locator('.reader-format-web').waitFor();
  await until(async () => (await readers())[0].children.some(child => child.url === fixture), 'rapid relaunch webpage');
  await pause(300);
  assert.equal((await readers()).length, 1, 'rapid repeated launches create one reader');
  assert.equal((await windows()).filter(win => win.url.includes('#/settings')).length, 1);
  const afterRapid = await invoke<WorkspaceState>(main, 'state');
  assert.deepEqual(afterRapid.documents.map(doc => doc.id).sort(), documentIds); assert.deepEqual(afterRapid.views.map(view => view.id).sort(), viewIds);
  stages.rapidRecreated = await windows(); checks.push('four real concurrent secondary processes share one reader creation flight');

  // Add a draft immediately before quitting. before-quit persistence must
  // write it even if the ordinary debounced workspace save has not fired yet.
  const marker = '# 正常退出恢复验证\n由 startup 回归测试生成。';
  const draft = await invoke<ViewInfo>(main, 'create-text', { title: 'startup-recovery.md', text: marker });
  const officeDraft = await invoke<ViewInfo>(main, 'new-document', { format: 'docx', windowId: 'main' });
  const officeMarker = 'Still-focused Office text must survive normal application quit.';
  await main.locator('.office-word-paragraph').first().waitFor();
  await main.locator('.office-word-paragraph').first().fill(officeMarker);
  assert.equal(await main.locator('.office-word-paragraph').first().evaluate(element => document.activeElement === element), true);
  const beforeQuitOffice = (await invoke<WorkspaceState>(main, 'state')).documents.find(document => document.id === officeDraft.documentId)!;
  assert.ok(!beforeQuitOffice.model.blocks?.some(block => block.text === officeMarker), 'Office text is still a local draft before the quit handshake');
  const exit = new Promise<{ code: number | null; signal: string | null }>(done => primary.once('exit', (code, signal) => done({ code, signal })));
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  let quitDeadline: NodeJS.Timeout | undefined;
  const result = await Promise.race([exit, new Promise<never>((_, reject) => { quitDeadline = setTimeout(() => reject(new Error('Primary did not quit normally')), 15000); })]).finally(() => clearTimeout(quitDeadline));
  stopped = true; assert.deepEqual(result, { code: 0, signal: null });
  const workspace = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as { documents: { info: { id: string }; bytes: string }[]; views: ViewInfo[] };
  for (const id of documentIds) assert.ok(workspace.documents.some(doc => doc.info.id === id));
  for (const id of viewIds) assert.ok(workspace.views.some(view => view.id === id));
  const savedDraft = workspace.documents.find(doc => doc.info.id === draft.documentId)!;
  assert.equal(Buffer.from(savedDraft.bytes, 'base64').toString('utf8'), marker); assert.ok(workspace.views.some(view => view.id === draft.id));
  const persistedOffice = workspace.documents.find(doc => doc.info.id === officeDraft.documentId) as unknown as { info: { dirty: boolean; model: { blocks: { text: string }[] } }; bytes: string };
  assert.ok(persistedOffice.info.model.blocks.some(block => block.text === officeMarker), 'normal app quit flushes the focused Office editor before saving recovery');
  assert.equal(persistedOffice.info.dirty, true, 'recovery preserves unsaved Office status');
  assert.ok(Buffer.from(persistedOffice.bytes, 'base64').length > 0);
  assert.equal(secondaries.size, 0); assert.deepEqual(errors, []);
  stages.shutdown = { result, documentCount: workspace.documents.length, viewCount: workspace.views.length, draftDocumentId: draft.documentId };
  checks.push('normal primary exit persists original documents, a just-created draft, and an unblurred Office editor through the close handshake');
  const report = { passed: true, checks, evidence, stages, activations, rendererErrors: errors };
  await writeFile(join(evidence, 'startup-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(evidence, 'startup-failure.json'), JSON.stringify({ error: String(error), stages, activations, rendererErrors: errors, stderr: stderr.join('').slice(-20000), windows: stopped ? [] : await windows().catch(() => []) }, null, 2));
  throw error;
} finally {
  for (const child of secondaries) child.kill();
  await writeFile(join(evidence, 'primary-stderr.log'), stderr.join(''));
  if (!stopped) {
    const closing = application.close(), deadline = setTimeout(() => primary.kill(), 15000);
    try { await closing; } finally { clearTimeout(deadline); }
  }
}
