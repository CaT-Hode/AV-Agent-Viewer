import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import type { DocumentModel, NativeOfficeState, PreparedPatch, ReadingContext, Receipt, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';

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
let recoveredApplication: ElectronApplication | undefined;
let recoveredPrimary: ChildProcess | undefined;
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
const nativeReady = async (target: Page, view: ViewInfo) => {
  let state: NativeOfficeState | undefined;
  await until(async () => {
    try {
      state = await invoke<NativeOfficeState>(target, 'office-status', { viewId: view.id });
      return state.status === 'ready' && !!state.visible && !!state.nativeGeometry && !!state.viewport && state.viewport.width > 100 && state.viewport.height > 100;
    } catch { return false; }
  }, 'actual Writer controller ready: ' + view.id, 120_000);
  assert.equal(state!.documentId, view.documentId); assert.equal(state!.viewId, view.id);
  assert.match(state!.nativeHwnd ?? '', /^[1-9]\d*$/); assert.ok((state!.nativePid ?? 0) > 0);
  await target.locator(`.native-office-content[data-native-office="${view.id}"][data-native-ready="true"]`).waitFor();
  return state!;
};
const quitNormally = async (target: ElectronApplication) => {
  const process = target.process();
  const exit = new Promise<{ code: number | null; signal: string | null }>(done => process.once('exit', (code, signal) => done({ code, signal })));
  await target.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  let deadline: NodeJS.Timeout | undefined;
  return Promise.race([exit, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Primary did not quit normally with a native checkpoint')), 30_000); })]).finally(() => clearTimeout(deadline));
};
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

  // Normal quit must retain the native engine's unsaved committed content,
  // rather than relying on a contenteditable renderer that no longer exists.
  const marker = '# 正常退出恢复验证\n由 startup 回归测试生成。';
  const draft = await invoke<ViewInfo>(main, 'create-text', { title: 'startup-recovery.md', text: marker });
  const officeDraft = await invoke<ViewInfo>(main, 'new-document', { format: 'docx', windowId: 'main' });
  const nativeBefore = await nativeReady(main, officeDraft);
  const emptyOffice = await invoke<DocumentModel & { revision: number }>(main, 'read', { documentId: officeDraft.documentId });
  assert.ok(emptyOffice.blocks?.length && emptyOffice.blocks.every(block => block.text === ''), 'a new Writer recovery test starts with an explicitly empty paragraph');
  const officeMarker = 'Native unsaved Office text must survive normal application quit.';
  const emptyParagraph = emptyOffice.blocks[0];
  const patch = await invoke<PreparedPatch>(main, 'prepare', { documentId: officeDraft.documentId, viewId: officeDraft.id, expectedRevision: emptyOffice.revision, operation: { kind: 'word.setBlock', blockId: emptyParagraph.id, text: officeMarker } });
  assert.equal(patch.nativeSessionId, nativeBefore.sessionId, 'the patch is bound to the actual native writer');
  const committed = await invoke<Receipt>(main, 'commit', { patchId: patch.id, idempotencyKey: crypto.randomUUID() });
  assert.equal(committed.status, 'applied');
  const sourceBeforeQuit = await invoke<{ data: { text: string } }>(main, 'office-query', { viewId: officeDraft.id, target: { kind: 'document' } });
  assert.equal(sourceBeforeQuit.data.text, officeMarker, 'actual IPC edits reached the native Word document');
  const beforeQuitOffice = (await invoke<WorkspaceState>(main, 'state')).documents.find(document => document.id === officeDraft.documentId)!;
  assert.equal(beforeQuitOffice.capabilities.engine, 'libreoffice-native');
  assert.deepEqual(beforeQuitOffice.model, { format: 'docx' }, 'display state does not transfer a native mirror body');
  const beforeQuitModel = await invoke<DocumentModel>(main, 'read', { documentId: officeDraft.documentId });
  assert.ok(beforeQuitModel.blocks?.some(block => block.text === officeMarker));
  assert.equal(beforeQuitOffice.dirty, true); assert.equal(beforeQuitOffice.path, undefined, 'the test never saves over a source file');
  const result = await quitNormally(application);
  stopped = true; assert.deepEqual(result, { code: 0, signal: null });
  const workspace = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as { documents: { info: { id: string }; bytes: string }[]; views: ViewInfo[] };
  for (const id of documentIds) assert.ok(workspace.documents.some(doc => doc.info.id === id));
  for (const id of viewIds) assert.ok(workspace.views.some(view => view.id === id));
  const savedDraft = workspace.documents.find(doc => doc.info.id === draft.documentId)!;
  assert.equal(Buffer.from(savedDraft.bytes, 'base64').toString('utf8'), marker); assert.ok(workspace.views.some(view => view.id === draft.id));
  const persistedOffice = workspace.documents.find(doc => doc.info.id === officeDraft.documentId) as unknown as { info: { dirty: boolean; model: { blocks: { text: string }[] } }; bytes: string };
  assert.ok(persistedOffice.info.model.blocks.some(block => block.text === officeMarker), 'normal app quit saves the native Word checkpoint');
  assert.equal(persistedOffice.info.dirty, true, 'recovery preserves unsaved Office status');
  const checkpoint = await JSZip.loadAsync(Buffer.from(persistedOffice.bytes, 'base64'));
  const checkpointXml = await checkpoint.file('word/document.xml')?.async('string');
  assert.ok(checkpointXml?.includes(officeMarker), 'the persisted OOXML bytes contain the committed native text');

  // A fresh process must import those bytes into a new real controller. Reading
  // workspace.json alone would not prove that the checkpoint is recoverable.
  recoveredApplication = await electron.launch({ executablePath: executable, args: ['.'], cwd: resolve('.'), env, timeout: 45_000 });
  recoveredPrimary = recoveredApplication.process();
  recoveredApplication.context().pages().forEach(watch); recoveredApplication.context().on('page', watch);
  recoveredPrimary.stderr?.on('data', value => stderr.push('[recovery] ' + String(value)));
  await until(async () => recoveredApplication!.context().pages().some(page => !page.isClosed() && page.url() === endpoint), 'fresh recovered reader');
  const recoveredMain = recoveredApplication.context().pages().find(page => !page.isClosed() && page.url() === endpoint)!;
  const recoveredNative = await nativeReady(recoveredMain, officeDraft);
  assert.notEqual(recoveredNative.engineEpoch, nativeBefore.engineEpoch, 'recovery starts a new native engine instead of retaining a stale controller');
  const recoveredState = await invoke<WorkspaceState>(recoveredMain, 'state');
  assert.equal(recoveredState.activeViewId, officeDraft.id);
  const recoveredOffice = recoveredState.documents.find(document => document.id === officeDraft.documentId)!;
  assert.equal(recoveredOffice.capabilities.engine, 'libreoffice-native'); assert.equal(recoveredOffice.dirty, true);
  assert.deepEqual(recoveredOffice.model, { format: 'docx' });
  const recoveredModel = await invoke<DocumentModel>(recoveredMain, 'read', { documentId: officeDraft.documentId });
  assert.ok(recoveredModel.blocks?.some(block => block.text === officeMarker));
  const recoveredText = await invoke<{ data: { text: string } }>(recoveredMain, 'office-query', { viewId: officeDraft.id, target: { kind: 'document' } });
  assert.equal(recoveredText.data.text, officeMarker, 'the restored native Writer source contains the unsaved text');
  const recoveryExit = await quitNormally(recoveredApplication); assert.deepEqual(recoveryExit, { code: 0, signal: null });
  assert.equal(secondaries.size, 0); assert.deepEqual(errors, []);
  stages.shutdown = { result, recoveryExit, documentCount: workspace.documents.length, viewCount: workspace.views.length, draftDocumentId: draft.documentId, officeDocumentId: officeDraft.documentId, nativeSessionBefore: nativeBefore.sessionId, recoveredNativeSession: recoveredNative.sessionId, officeTransactionId: committed.transactionId };
  checks.push('normal primary exit preserves native unsaved Word OOXML, and a fresh real engine restores the same document/view and dirty content');
  const report = { passed: true, checks, evidence, stages, activations, rendererErrors: errors };
  await writeFile(join(evidence, 'startup-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(evidence, 'startup-failure.json'), JSON.stringify({ error: String(error), stages, activations, rendererErrors: errors, stderr: stderr.join('').slice(-20000), windows: stopped ? [] : await windows().catch(() => []) }, null, 2));
  throw error;
} finally {
  for (const child of secondaries) child.kill();
  await writeFile(join(evidence, 'primary-stderr.log'), stderr.join(''));
  if (recoveredApplication && recoveredPrimary?.exitCode === null) {
    const closing = recoveredApplication.close(), deadline = setTimeout(() => recoveredPrimary?.kill(), 30_000);
    try { await closing; } finally { clearTimeout(deadline); }
  }
  if (!stopped) {
    const closing = application.close(), deadline = setTimeout(() => primary.kill(), 15000);
    try { await closing; } finally { clearTimeout(deadline); }
  }
}
