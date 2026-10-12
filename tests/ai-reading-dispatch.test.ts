import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { dispatch } from '../packages/sdk/src/dispatch';
import { AI_READING_TOOLS, type ScopedReadingSnapshot } from '../packages/ai-reading-tools/src/index';
import type { HarnessTask, ReadingSnapshot } from '../packages/contracts/src/index';

type ReadingResult = { task: HarnessTask; toolId: string; scope: string };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-ai-dispatch-'));
  const core = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json')));
  const path = join(directory, 'private-original.md');
  const source = '# Reading\nSELECTION_ONLY\nVISIBLE_ONLY\nSECRET_FULL_MODEL\n';
  await writeFile(path, source); const view = await core.openFile(path);
  const initial = core.getDocument(view.documentId);
  const from = source.indexOf('SECRET_FULL_MODEL');
  const patch = core.prepare(view.documentId, initial.info.revision, { kind: 'text.replace', from, to: from + 'SECRET_FULL_MODEL'.length, expectedText: 'SECRET_FULL_MODEL', text: 'SECRET_EDITED_MODEL' });
  const edited = await core.commit(patch.id, 'preexisting-human-edit', 'human');
  const report = (selection = 'SELECTION_ONLY', visible = 'VISIBLE_ONLY') => core.updateContext(view.id, {
    quality: 'confirmed', visibleText: visible,
    locator: { kind: 'text-range', from: 24, to: 36, quote: 'SECRET_VISIBLE_METADATA' },
    selection: { kind: selection ? 'text' : 'none', text: selection, locator: { kind: 'text-range', from: 10, to: 24, quote: 'SECRET_SELECTION_METADATA' } },
  });
  report();
  const received: { prompt: string; snapshot: ReadingSnapshot }[] = [];
  core.drivers.set('fake-reader', { id: 'fake-reader', capabilities: { streaming: false, cancellation: true, attachExistingSession: false }, submit: async (prompt, snapshot, emit) => { received.push({ prompt, snapshot: structuredClone(snapshot) }); emit('analysis-only'); } });
  core.extensions.set('ai-reading-driver', async () => ({ driverId: 'fake-reader' }));
  return { core, directory, path, view, report, received, edited };
}

test('real core submission scopes selection/visible at the driver without changing bytes, document or undo', async () => {
  const { core, path, view, received, edited } = await setup();
  const snapshot = await core.snapshot(view.id), before = structuredClone(core.getDocument(view.documentId));
  const disk = await readFile(path), transactions = structuredClone([...core.transactions]), receipts = structuredClone([...core.receipts]);
  const selectionTask = await core.submitTask('fake-reader', 'explain', view.id, snapshot.id, 'selection');
  const visibleTask = await core.submitTask('fake-reader', 'summary', view.id, snapshot.id, 'visible');
  assert.notEqual(selectionTask.id, visibleTask.id); assert.equal(received.length, 2);
  const selected = received[0].snapshot as ScopedReadingSnapshot, visible = received[1].snapshot as ScopedReadingSnapshot;
  assert.equal(selected.sourceScope, 'selection'); assert.equal(selected.sourceText, 'SELECTION_ONLY');
  assert.equal(selected.context.visibleText, ''); assert.equal(selected.context.selection.text, 'SELECTION_ONLY');
  assert.deepEqual(selected.document.model, { format: 'markdown', text: 'SELECTION_ONLY' });
  assert.equal(visible.sourceScope, 'visible'); assert.equal(visible.sourceText, 'VISIBLE_ONLY');
  assert.deepEqual(visible.context.selection, { kind: 'none', text: '' });
  assert.deepEqual(visible.document.model, { format: 'markdown', text: 'VISIBLE_ONLY' });
  for (const item of received) {
    assert.equal(item.snapshot.id, snapshot.id);
    assert.equal(item.snapshot.document.path, undefined);
    assert.doesNotMatch(JSON.stringify(item.snapshot), /SECRET_|agentviewer-ai-dispatch-|workspace\.json/);
    assert.equal(item.snapshot.document.title, snapshot.document.title, 'document title is allowed source identity metadata');
    assert.equal(item.snapshot.document.revision, before.info.revision);
  }
  assert.deepEqual(core.readSnapshot(snapshot.id), snapshot, 'full frozen snapshot remains available for formal edit APIs');
  assert.deepEqual(core.getDocument(view.documentId), before); assert.deepEqual(await readFile(path), disk);
  assert.deepEqual([...core.transactions], transactions); assert.deepEqual([...core.receipts], receipts);
  await core.undo(edited.transactionId);
  assert.match(core.getDocument(view.documentId).info.model.text!, /SECRET_FULL_MODEL/, 'existing human undo remains usable after analysis');
});

test('SDK catalog and run share canonical tool IDs, explicit scope and actual scoped driver input', async () => {
  const { core, view, received } = await setup();
  const catalog = await dispatch(core, 'ai-reading-tools', { viewId: view.id }) as { tools: typeof AI_READING_TOOLS; scopes: string[]; availability: { selection: { available: boolean }; visible: { available: boolean } } };
  assert.deepEqual(catalog.tools, AI_READING_TOOLS); assert.deepEqual(catalog.scopes, ['selection', 'visible']);
  assert.equal(catalog.availability.selection.available, true); assert.equal(catalog.availability.visible.available, true);
  for (const scope of ['selection', 'visible'] as const) {
    const result = await dispatch(core, 'ai-reading-run', { viewId: view.id, toolId: 'evidence', scope, idempotencyKey: 'scope-' + scope }) as ReadingResult;
    assert.equal(result.scope, scope); assert.equal(result.toolId, 'evidence');
    assert.equal((received.at(-1)!.snapshot as ScopedReadingSnapshot).sourceScope, scope);
    assert.match(received.at(-1)!.prompt, /摘录必须逐字来自本次材料/);
  }
});

test('concurrent and completed same-key retries create one frozen task; a changed payload is rejected', async () => {
  const { core, view, received, report } = await setup();
  const args = { viewId: view.id, toolId: 'explain', scope: 'selection', idempotencyKey: 'same-reading-request' };
  const [first, second] = await Promise.all([dispatch(core, 'ai-reading-run', args), dispatch(core, 'ai-reading-run', args)]) as ReadingResult[];
  assert.equal(first.task.id, second.task.id); assert.equal(received.length, 1); assert.equal(core.tasks.size, 1);
  report('', 'NEW_LIVE_CONTEXT');
  const retry = await dispatch(core, 'ai-reading-run', args) as ReadingResult;
  assert.equal(retry.task.id, first.task.id); assert.equal(received.length, 1); assert.equal(core.tasks.size, 1);
  assert.equal((received[0].snapshot as ScopedReadingSnapshot).sourceText, 'SELECTION_ONLY');
  await assert.rejects(dispatch(core, 'ai-reading-run', { ...args, scope: 'visible' }), /IDEMPOTENCY_CONFLICT|幂等键/);
  await assert.rejects(dispatch(core, 'ai-reading-run', { ...args, toolId: 'summary' }), /IDEMPOTENCY_CONFLICT|幂等键/);
  assert.equal(received.length, 1); assert.equal(core.tasks.size, 1);
});

test('snapshot/view mismatch is rejected for catalog, action and direct scoped core submission', async () => {
  const { core, view, received } = await setup(); const snapshot = await core.snapshot(view.id), another = core.addView(view.documentId, 'main');
  await assert.rejects(dispatch(core, 'ai-reading-tools', { viewId: another.id, snapshotId: snapshot.id }), /SNAPSHOT_TARGET_MISMATCH|其他视图/);
  await assert.rejects(dispatch(core, 'ai-reading-run', { viewId: another.id, snapshotId: snapshot.id, toolId: 'summary', scope: 'visible', idempotencyKey: 'wrong-view' }), /SNAPSHOT_TARGET_MISMATCH|其他视图/);
  await assert.rejects(core.submitTask('fake-reader', 'summary', another.id, snapshot.id, 'visible'), /SNAPSHOT_TARGET_MISMATCH|其他阅读视图/);
  assert.equal(core.tasks.size, 0); assert.equal(received.length, 0);
});

test('missing/empty/unknown/full scope and unknown tools are rejected without starting a task', async () => {
  const { core, view, received } = await setup();
  const base = { viewId: view.id, toolId: 'summary', idempotencyKey: 'invalid' };
  for (const scope of [undefined, '', 'unknown', 'document']) await assert.rejects(dispatch(core, 'ai-reading-run', { ...base, ...(scope !== undefined ? { scope } : {}) }));
  await assert.rejects(dispatch(core, 'ai-reading-run', { ...base, scope: 'visible', toolId: 'unknown-tool' }), /未知 AI/);
  await assert.rejects(dispatch(core, 'ai-reading-run', { ...base, scope: 'visible', prompt: 'client cannot override the catalog' }));
  assert.equal(core.tasks.size, 0); assert.equal(received.length, 0);
});

test('empty selected source does not fall back to visible text and rejected key can retry after correction', async () => {
  const { core, view, report, received } = await setup(); report('', 'VISIBLE_ONLY');
  const args = { viewId: view.id, toolId: 'explain', scope: 'selection', idempotencyKey: 'retry-after-source-fix' };
  await assert.rejects(dispatch(core, 'ai-reading-run', args), /请先选中/); assert.equal(core.tasks.size, 0); assert.equal(received.length, 0);
  report(); const result = await dispatch(core, 'ai-reading-run', args) as ReadingResult;
  assert.ok(result.task.id); assert.equal(received.length, 1);
  report('SELECTION_ONLY', '');
  await assert.rejects(dispatch(core, 'ai-reading-run', { ...args, scope: 'visible', idempotencyKey: 'empty-visible' }), /暂无可读文字/);
  assert.equal(received.length, 1);
});

test('48000-character budget accepts the boundary and refuses larger source without a task or mutation', async () => {
  const { core, view, report, received } = await setup(), before = structuredClone(core.getDocument(view.documentId));
  const transactions = structuredClone([...core.transactions]);
  for (const scope of ['selection', 'visible'] as const) {
    report(scope === 'selection' ? 'a'.repeat(48001) : 'SELECTION_ONLY', scope === 'visible' ? 'v'.repeat(48001) : 'VISIBLE_ONLY');
    await assert.rejects(dispatch(core, 'ai-reading-run', { viewId: view.id, toolId: 'summary', scope, idempotencyKey: 'too-long-' + scope }), /48000|不会静默截断/);
  }
  assert.equal(received.length, 0); assert.equal(core.tasks.size, 0); assert.deepEqual(core.getDocument(view.documentId), before); assert.deepEqual([...core.transactions], transactions);
  report('a'.repeat(48000), 'VISIBLE_ONLY');
  await dispatch(core, 'ai-reading-run', { viewId: view.id, toolId: 'summary', scope: 'selection', idempotencyKey: 'budget-boundary' });
  assert.equal((received[0].snapshot as ScopedReadingSnapshot).sourceText.length, 48000);
});
