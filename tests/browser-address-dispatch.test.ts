import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { dispatch } from '../packages/sdk/src/dispatch';
import { ViewerError, type BrowserRuntime, type ViewInfo } from '../packages/contracts/src/index';

type Navigation = { viewId: string; action: 'back' | 'forward' | 'reload' | 'url'; url?: string };
function recordingBrowser() {
  const opened: { viewId: string; url: string }[] = [], navigated: Navigation[] = [];
  const browser: BrowserRuntime = {
    open: async (viewId, url) => { opened.push({ viewId, url }); },
    navigate: async (viewId, action, url) => { navigated.push({ viewId, action, url }); },
    layout: () => {}, close: () => {},
    context: async () => { throw new Error('address dispatch must not read webpage content'); },
    input: async () => { throw new Error('address dispatch must not perform browser input'); },
    capture: async () => { throw new Error('address dispatch must not capture the page'); },
    html: async () => { throw new Error('address dispatch must not export the page'); },
  };
  return { browser, opened, navigated };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-browser-address-'));
  const core = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))), runtime = recordingBrowser();
  core.browser = runtime.browser;
  const foreground = await core.openBytes('foreground.md', new TextEncoder().encode('unsaved original'), 'markdown');
  core.activate(foreground.id, 'human');
  return { core, runtime, directory, foreground };
}
function protectedState(core: ViewerCore) {
  return structuredClone({
    state: core.state(), lastHumanViewId: core.lastHumanViewId,
    documents: [...core.documents.entries()], transactions: [...core.transactions.entries()],
    receipts: [...core.receipts.entries()], patches: [...core.patches.entries()], events: core.eventLog,
  });
}
const invalidAddress = (error: unknown) => error instanceof ViewerError && error.code === 'INVALID_URL';

test('SDK open sends bare website addresses and uppercase explicit HTTP(S) to the web engine', async t => {
  const { core, runtime } = await setup(); t.after(() => core.persist());
  const cases = [
    ['example.com/docs?q=one#part', 'https://example.com/docs?q=one#part'],
    [' www.example.org ', 'https://www.example.org/'],
    ['HTTPS://Example.COM:443/Document', 'https://example.com/Document'],
    ['localhost:3210/fixture', 'http://localhost:3210/fixture'],
  ];
  for (const [input, expected] of cases) {
    const beforeDocuments = core.documents.size, beforeViews = core.views.size;
    const view = await dispatch(core, 'open', { uri: input }, 'human') as ViewInfo;
    const document = core.getDocument(view.documentId);
    assert.equal(document.info.format, 'web', input);
    assert.equal(document.info.path, undefined, input);
    assert.equal(document.info.model.url, expected, input);
    assert.equal(document.bytes.byteLength, 0, input);
    assert.deepEqual(runtime.opened.at(-1), { viewId: view.id, url: expected });
    assert.equal(core.documents.size, beforeDocuments + 1);
    assert.equal(core.views.size, beforeViews + 1);
    assert.equal(core.activeViewId, view.id); assert.equal(core.lastHumanViewId, view.id);
  }
  assert.equal(runtime.opened.length, cases.length); assert.equal(runtime.navigated.length, 0);
});

test('direct core openWeb canonicalizes IDN, explicit uppercase and an unlisted navigation suffix', async t => {
  const { core, runtime, foreground } = await setup(); t.after(() => core.persist());
  const cases = [
    ['例子.中国/资料', 'https://xn--fsqu00a.xn--fiqs8s/%E8%B5%84%E6%96%99'],
    [' HTTP://Example.COM:80/a ', 'http://example.com/a'],
    ['portal.unlisted-suffix/docs', 'https://portal.unlisted-suffix/docs'],
  ];
  for (const [input, expected] of cases) {
    const view = await core.openWeb(input, 'secondary', false), document = core.getDocument(view.documentId).info;
    assert.equal(view.windowId, 'secondary'); assert.equal(document.format, 'web');
    assert.equal(document.model.url, expected); assert.equal(document.title, new URL(expected).hostname);
    assert.deepEqual(runtime.opened.at(-1), { viewId: view.id, url: expected });
    assert.equal(core.activeViewId, foreground.id); assert.equal(core.lastHumanViewId, foreground.id);
    assert.equal(core.eventLog.filter(event => event.type === 'view.activated' && (event.data as { viewId: string }).viewId === view.id).length, 0);
  }
});

test('address navigation canonicalizes a URL in the existing view without opening another document or tab', async t => {
  const { core, runtime } = await setup(); t.after(() => core.persist());
  const view = await dispatch(core, 'open', { uri: 'https://example.com/start' }, 'human') as ViewInfo;
  const before = protectedState(core), openCount = runtime.opened.length;
  const cases = [
    ['example.org/next', 'https://example.org/next'],
    ['localhost:3210/new', 'http://localhost:3210/new'],
    ['127.0.0.1:3210/new', 'http://127.0.0.1:3210/new'],
    ['[::1]:3210/new', 'http://[::1]:3210/new'],
    ['HTTPS://Example.NET:443/final', 'https://example.net/final'],
  ];
  for (const [input, expected] of cases) {
    await dispatch(core, 'browser-navigate', { viewId: view.id, action: 'url', url: input }, 'human');
    assert.deepEqual(runtime.navigated.at(-1), { viewId: view.id, action: 'url', url: expected });
    // This runtime only records requests. Navigation completion owns any real
    // page context/model update; dispatch must not create or edit documents.
    assert.deepEqual(protectedState(core), before);
    assert.equal(runtime.opened.length, openCount);
  }
});

test('back, forward and reload still route to the bound view without requiring an address', async t => {
  const { core, runtime } = await setup(); t.after(() => core.persist());
  const view = await core.openWeb('example.com'), before = protectedState(core);
  for (const action of ['back', 'forward', 'reload'] as const) {
    await dispatch(core, 'browser-navigate', { viewId: view.id, action }, 'human');
    assert.deepEqual(runtime.navigated.at(-1), { viewId: view.id, action, url: undefined });
    assert.deepEqual(protectedState(core), before);
  }
});

test('invalid direct web opens reject before registering a document, changing a target or invoking the runtime', async t => {
  const { core, runtime } = await setup(); t.after(() => core.persist());
  const before = protectedState(core);
  for (const input of [
    'ftp://example.com/file', 'custom://launch', 'javascript:alert(1)', 'file:///C:/private.md',
    'https://user:password@example.com', 'user@example.com', 'https:example.com',
    'https://', 'https://[::1', 'https://example.com:65536', 'https://example.com one',
    'https://example.com\u0009@evil.com', 'https:\\example.com',
  ]) {
    await assert.rejects(core.openWeb(input), invalidAddress, input);
    assert.deepEqual(protectedState(core), before, input);
    assert.equal(runtime.opened.length, 0, input); assert.equal(runtime.navigated.length, 0, input);
  }
});

test('invalid SDK opens and explicit URL navigation reject without routing or changing unsaved documents', async t => {
  const { core, runtime, foreground } = await setup(); t.after(() => core.persist());
  const view = await core.openWeb('https://example.com/start'); core.activate(foreground.id, 'human');
  const before = protectedState(core), openedBefore = structuredClone(runtime.opened);
  for (const input of ['ftp://example.com/file', 'custom://launch', 'x://launch', 'https://user:password@example.com', 'https:example.com', 'https://[::1', 'https://example.com:65536']) {
    await assert.rejects(dispatch(core, 'open', { uri: input }, 'human'), invalidAddress, input);
    await assert.rejects(dispatch(core, 'browser-navigate', { viewId: view.id, action: 'url', url: input }, 'human'), invalidAddress, input);
    assert.deepEqual(protectedState(core), before, input);
    assert.deepEqual(runtime.opened, openedBefore, input); assert.equal(runtime.navigated.length, 0, input);
  }
  for (const url of ['', 'ordinary search words', 'http://']) {
    await assert.rejects(dispatch(core, 'browser-navigate', { viewId: view.id, action: 'url', url }, 'human'), invalidAddress, url);
    assert.deepEqual(protectedState(core), before); assert.equal(runtime.navigated.length, 0);
  }
});

test('a real local Markdown path preserves its path and bytes, including unsaved reopen identity', async t => {
  const { core, runtime, directory, foreground } = await setup(); t.after(() => core.persist());
  const path = join(directory, '本地文件 local.md'), diskBytes = Buffer.from('# 本地文件\r\n原始内容\r\n', 'utf8');
  await writeFile(path, diskBytes);
  const view = await dispatch(core, 'open', { uri: path, activate: false }, 'human') as ViewInfo;
  const document = core.getDocument(view.documentId);
  assert.equal(document.info.format, 'markdown'); assert.equal(document.info.path, resolve(path));
  assert.deepEqual(document.bytes, new Uint8Array(diskBytes)); assert.equal(document.info.dirty, false);
  assert.equal(core.activeViewId, foreground.id); assert.equal(core.lastHumanViewId, foreground.id);
  assert.equal(runtime.opened.length, 0); assert.equal(runtime.navigated.length, 0);
  const original = document.info.model.text!, patch = core.prepare(view.documentId, document.info.revision, { kind: 'text.replace', from: 0, to: original.length, expectedText: original, text: '# 尚未保存' });
  const receipt = await core.commit(patch.id, 'local-file-unsaved', 'human'), edited = structuredClone(core.getDocument(view.documentId)), documentCount = core.documents.size;
  const reopened = await dispatch(core, 'open', { uri: path, activate: false }, 'human') as ViewInfo;
  assert.equal(reopened.documentId, view.documentId); assert.equal(core.documents.size, documentCount);
  assert.deepEqual(core.getDocument(view.documentId), edited); assert.equal(core.transactions.has(receipt.transactionId), true);
  assert.deepEqual(await readFile(path), diskBytes);
  assert.equal(core.activeViewId, foreground.id); assert.equal(core.lastHumanViewId, foreground.id);
  assert.equal(runtime.opened.length, 0); assert.equal(runtime.navigated.length, 0);
});

test('Windows drive-relative Markdown paths still read the real local file rather than becoming URL schemes', { skip: process.platform !== 'win32' }, async t => {
  const { core, runtime, foreground } = await setup(); t.after(() => core.persist());
  const path = resolve('README.md'), driveRelative = path.slice(0, 2) + basename(path), original = await readFile(path);
  assert.equal(resolve(driveRelative), path);
  const view = await dispatch(core, 'open', { uri: driveRelative, activate: false }, 'human') as ViewInfo;
  const document = core.getDocument(view.documentId);
  assert.equal(document.info.format, 'markdown'); assert.equal(document.info.path, path);
  assert.deepEqual(document.bytes, new Uint8Array(original)); assert.equal(document.info.dirty, false);
  assert.equal(core.activeViewId, foreground.id); assert.equal(core.lastHumanViewId, foreground.id);
  assert.equal(runtime.opened.length, 0); assert.equal(runtime.navigated.length, 0);
});
