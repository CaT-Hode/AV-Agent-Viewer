import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { dispatch } from '../packages/sdk/src/dispatch';
import { libreOfficePath } from '../apps/office-gateway/src/conversion';
import type { BrowserRuntime, ViewInfo } from '../packages/contracts/src/index';

const bytes = (text: string) => new TextEncoder().encode(text);
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-background-open-'));
  const core = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json')));
  const foreground = await core.openBytes('foreground.md', bytes('foreground'), 'markdown');
  core.activate(foreground.id, 'human');
  return { core, directory, foreground };
}
function gate() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function deferredBrowser(entered: ReturnType<typeof gate>, completion: ReturnType<typeof gate>) {
  const opened: { viewId: string; url: string }[] = [];
  const browser: BrowserRuntime = {
    open: async (viewId, url) => { opened.push({ viewId, url }); entered.resolve(); await completion.promise; },
    layout: () => {}, close: () => {},
    context: async () => { throw new Error('default context unexpectedly drifted into the background browser'); },
    input: async () => { throw new Error('not used'); }, navigate: async () => { throw new Error('not used'); },
    capture: async () => { throw new Error('not used'); }, html: async () => { throw new Error('not used'); },
  };
  return { browser, opened };
}
function assertTarget(core: ViewerCore, id: string) {
  assert.equal(core.activeViewId, id); assert.equal(core.lastHumanViewId, id); assert.equal(core.getView().id, id);
}
function noActivationFor(core: ViewerCore, id: string) {
  assert.equal(core.eventLog.filter(event => event.type === 'view.activated' && (event.data as { viewId: string }).viewId === id).length, 0);
}

test('a real deferred background web open preserves a later foreground human target during and after completion', async t => {
  const { core, directory, foreground } = await setup(); t.after(() => core.persist());
  const other = await core.openBytes('other.md', bytes('other'), 'markdown', undefined, 'main', false);
  const entered = gate(), completion = gate(), runtime = deferredBrowser(entered, completion); core.browser = runtime.browser;
  const opening = dispatch(core, 'open', { uri: 'https://example.com/slow', activate: false }, 'human') as Promise<ViewInfo>;
  await entered.promise;
  assertTarget(core, foreground.id); assert.equal(runtime.opened.length, 1);
  const backgroundId = runtime.opened[0].viewId; assert.notEqual(backgroundId, foreground.id); assert.ok(core.views.has(backgroundId)); noActivationFor(core, backgroundId);
  core.activate(other.id, 'human'); core.updateContext(other.id, { visibleText: 'other', selection: { kind: 'text', text: 'other' }, locator: { kind: 'source', from: 0, to: 5 } });
  assertTarget(core, other.id); assert.equal((await core.context()).viewId, other.id);
  completion.resolve(); const background = await opening;
  assert.equal(background.id, backgroundId); assert.equal(core.getDocument(background.documentId).info.model.url, 'https://example.com/slow');
  assertTarget(core, other.id); noActivationFor(core, backgroundId); assert.equal((await core.context()).selection.text, 'other');
  await core.persist(); const restored = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))); await restored.initialize(); assertTarget(restored, other.id);
});

test('a rejected deferred background web open does not overwrite the foreground or emit human activation', async t => {
  const { core, foreground } = await setup(); t.after(() => core.persist());
  const entered = gate(), completion = gate(), runtime = deferredBrowser(entered, completion); core.browser = runtime.browser;
  const opening = dispatch(core, 'open', { uri: 'https://example.com/failure', activate: false }, 'human'), rejected = assert.rejects(opening, /deferred load failed/);
  await entered.promise; assertTarget(core, foreground.id); completion.reject(new Error('deferred load failed')); await rejected;
  assertTarget(core, foreground.id); noActivationFor(core, runtime.opened[0].viewId);
  // Failed-view cleanup is intentionally unchanged by this activation policy.
  assert.ok(core.views.has(runtime.opened[0].viewId));
});

test('background file reopen and existing document view reuse preserve unsaved bytes, revision and transaction identity', async t => {
  const { core, directory, foreground } = await setup(); t.after(() => core.persist());
  const path = join(directory, 'loaded.md'); await writeFile(path, 'disk original');
  const loaded = await core.openFile(path, 'main', false), patch = core.prepare(loaded.documentId, 0, { kind: 'text.replace', from: 0, to: 13, expectedText: 'disk original', text: 'UNSAVED EDIT' });
  const receipt = await core.commit(patch.id, 'background-unsaved-edit', 'human'), before = structuredClone(core.getDocument(loaded.documentId)), documentCount = core.documents.size;
  assertTarget(core, foreground.id);
  const reopened = await dispatch(core, 'open', { uri: path, activate: false }, 'human') as ViewInfo;
  assert.equal(reopened.documentId, loaded.documentId); assert.notEqual(reopened.id, loaded.id); assert.equal(core.documents.size, documentCount);
  assert.deepEqual(core.getDocument(loaded.documentId), before); assert.equal(await readFile(path, 'utf8'), 'disk original'); assertTarget(core, foreground.id); noActivationFor(core, reopened.id);
  const count = core.views.size, reused = await dispatch(core, 'document-open-view', { documentId: loaded.documentId, activate: false }, 'human') as ViewInfo;
  assert.equal(reused.id, loaded.id); assert.equal(core.views.size, count); assert.deepEqual(core.getDocument(loaded.documentId), before); assert.equal(core.transactions.has(receipt.transactionId), true); assertTarget(core, foreground.id); noActivationFor(core, loaded.id);
});

test('a retained pathless draft obtains a new background view without saving or replacing its unsaved model', async t => {
  const { core, foreground } = await setup(); t.after(() => core.persist());
  const draft = await core.openBytes('draft.md', bytes('never saved'), 'markdown', undefined, 'main', false);
  core.closeView(draft.id, true); const before = structuredClone(core.getDocument(draft.documentId)), documentCount = core.documents.size;
  const reopened = await dispatch(core, 'document-open-view', { documentId: draft.documentId, windowId: 'secondary', activate: false }, 'human') as ViewInfo;
  assert.notEqual(reopened.id, draft.id); assert.equal(reopened.windowId, 'secondary'); assert.equal(reopened.documentId, draft.documentId);
  assert.equal(core.documents.size, documentCount); assert.deepEqual(core.getDocument(draft.documentId), before); assert.equal(before.info.path, undefined); assert.equal(before.info.dirty, true); assert.equal(before.info.diskRevision, -1);
  assertTarget(core, foreground.id); noActivationFor(core, reopened.id);
});

test('direct core background creation through openBytes, addView and a new disk file keeps both target identities', async t => {
  const { core, directory, foreground } = await setup(); t.after(() => core.persist());
  const draft = await core.openBytes('background.md', bytes('background'), 'markdown', undefined, 'main', false); assertTarget(core, foreground.id);
  const view = core.addView(draft.documentId, 'secondary', false); assert.equal(view.windowId, 'secondary'); assertTarget(core, foreground.id);
  const path = join(directory, 'new.md'); await writeFile(path, 'new disk content'); const disk = await core.openFile(path, 'main', false);
  assert.equal(core.getDocument(disk.documentId).info.model.text, 'new disk content'); assert.equal(core.getDocument(disk.documentId).info.dirty, false); assertTarget(core, foreground.id);
  for (const id of [draft.id, view.id, disk.id]) noActivationFor(core, id);
});

test('background agent dispatch does not change the human target, while omitted activation retains historical foreground behavior', async t => {
  const { core, directory, foreground } = await setup(); t.after(() => core.persist());
  const path = join(directory, 'default.md'); await writeFile(path, 'default');
  const background = await dispatch(core, 'open', { uri: path, activate: false }, 'agent') as ViewInfo; assertTarget(core, foreground.id); noActivationFor(core, background.id);
  const defaultOpen = await dispatch(core, 'open', { uri: path }, 'human') as ViewInfo; assertTarget(core, defaultOpen.id);
  await dispatch(core, 'document-open-view', { documentId: foreground.documentId }, 'human'); assertTarget(core, foreground.id);
  const direct = core.addView(defaultOpen.documentId); assert.equal(core.activeViewId, direct.id); assert.equal(core.lastHumanViewId, foreground.id, 'direct addView still leaves human-target identity to explicit human activation');
});

test('legacy-extension conversion propagates background activation through the real isolated headless converter', { skip: !libreOfficePath() }, async t => {
  const { core, directory, foreground } = await setup(); t.after(() => core.persist());
  // A valid RTF document with a .doc name selects the legacy-conversion branch.
  // LibreOffice uses its existing temporary profile and windowsHide behavior;
  // this does not start Electron UI or use an installed user's Office session.
  const path = join(directory, 'legacy.doc'); await writeFile(path, '{\\rtf1\\ansi Background legacy open\\par}');
  const converted = await dispatch(core, 'open', { uri: path, activate: false }, 'human') as ViewInfo;
  const document = core.getDocument(converted.documentId).info;
  assert.equal(document.format, 'docx'); assert.equal(document.path, undefined); assert.equal(document.dirty, true); assert.ok(document.model.blocks?.some(block => block.text.includes('Background legacy open')));
  assert.ok(document.warnings.some(warning => warning.includes(path))); assertTarget(core, foreground.id); noActivationFor(core, converted.id);
});
