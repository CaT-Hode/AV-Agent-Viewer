import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { dispatch } from '../packages/sdk/src/dispatch';
import { readAIReadingResult, type AIReadingResult } from '../packages/sdk/src/ai-reading';
import { getAIReadingTool, scopedReadingSnapshot, type ScopedReadingSnapshot } from '../packages/ai-reading-tools/src/index';
import { ViewerError, type HarnessDriver, type HarnessTask, type ReadingSnapshot, type ViewInfo } from '../packages/contracts/src/index';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-ai-reliability-'));
  const core = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))), path = join(directory, 'original.md');
  await writeFile(path, '# Original\nSELECTED_SOURCE\nVISIBLE_SOURCE\nPRIVATE_OTHER_TEXT');
  const view = await core.openFile(path);
  const report = (selection = 'SELECTED_SOURCE', visibleText = 'VISIBLE_SOURCE') => core.updateContext(view.id, {
    quality: 'confirmed', visibleText, locator: { kind: 'markdown', from: 28, to: 42, quote: 'PRIVATE_LOCATOR_QUOTE' },
    selection: { kind: selection ? 'text' : 'none', text: selection, locator: { kind: 'source-range', from: 11, to: 26, quote: 'PRIVATE_SELECTION_QUOTE' } },
  });
  report();
  return { core, path, view, directory, report };
}
function model(core: ViewerCore, submit: HarnessDriver['submit']) {
  const driver: HarnessDriver = { id: 'frozen-model', capabilities: { streaming: true, cancellation: true, attachExistingSession: false }, submit };
  core.drivers.set(driver.id, driver); core.extensions.set('ai-reading-driver', async () => ({ driverId: driver.id, driver, model: 'test:model-A' }));
  return driver;
}
async function ended(core: ViewerCore, taskId: string): Promise<HarnessTask> {
  if (core.tasks.get(taskId)?.status !== 'running') return core.tasks.get(taskId)!;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); core.off('change', changed); resolve(); };
    const changed = () => { if (core.tasks.get(taskId)?.status !== 'running') finish(); };
    const timer = setTimeout(() => { core.off('change', changed); reject(new Error('task did not reach a terminal state')); }, 1500);
    core.on('change', changed); changed();
  });
  return core.tasks.get(taskId)!;
}
const run = (core: ViewerCore, viewId: string, key: string, toolId = 'summary') => dispatch(core, 'ai-reading-run', { viewId, toolId, scope: 'selection', idempotencyKey: key }, 'human') as Promise<AIReadingResult>;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('rewrite and proofread produce independent saved Markdown drafts with host provenance and preserve original bytes/undo', async t => {
  const { core, view, path, directory } = await setup(); t.after(() => core.persist());
  const before = structuredClone(core.getDocument(view.documentId)), disk = await readFile(path), transactions = [...core.transactions], receipts = [...core.receipts];
  const received: ReadingSnapshot[] = [], body = '## 独立草稿\n\n<script>untrusted()</script>\n\n## 改动说明\n保留含义。';
  model(core, async (prompt, snapshot, emit) => { assert.match(prompt, /独立草稿|校对草稿/); assert.match(prompt, /不应用到原件/); received.push(snapshot); emit(body); });
  for (const toolId of ['rewrite', 'proofread']) {
    const started = await run(core, view.id, 'draft-' + toolId, toolId); await ended(core, started.task.id);
    const result = await dispatch(core, 'ai-reading-result', { taskId: started.task.id }) as ReturnType<typeof readAIReadingResult>;
    assert.equal(result.outputKind, 'draft'); assert.equal(result.sourceText, 'SELECTED_SOURCE'); assert.equal(result.task.text, body);
    assert.equal(result.sourceRevision, before.info.revision); assert.equal(result.documentId, view.documentId); assert.equal(result.viewId, view.id);
    assert.equal(result.source.model, 'test:model-A'); assert.match(result.source.fingerprint, /^[a-f0-9]{64}$/);
    assert.match(result.markdown!, /这是独立草稿，尚未应用到原文/); assert.match(result.markdown!, /## 冻结来源/);
    assert.ok(result.markdown!.includes(body), 'model output stays document text rather than executing a command');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|agentviewer-ai-reliability-/);
    assert.doesNotMatch(result.markdown!, /SELECTED_SOURCE/, 'export provenance does not silently copy the selected original');
    const created = await dispatch(core, 'create-text', { title: result.label + '.md', text: result.markdown }, 'human') as ViewInfo;
    assert.notEqual(created.documentId, view.documentId);
    const savedPath = join(directory, toolId + '.md'); await core.save(created.documentId, savedPath);
    assert.equal(await readFile(savedPath, 'utf8'), result.markdown);
    const reopened = await core.openFile(savedPath); assert.equal(core.getDocument(reopened.documentId).info.model.text, result.markdown);
  }
  assert.equal(received.length, 2);
  for (const snapshot of received) assert.deepEqual(snapshot.document.model, { format: 'markdown', text: 'SELECTED_SOURCE' });
  assert.deepEqual(core.getDocument(view.documentId), before); assert.deepEqual(await readFile(path), disk);
  assert.deepEqual([...core.transactions], transactions); assert.deepEqual([...core.receipts], receipts);
});

test('explicit retry retains frozen source and captured model after edits, selection changes and normal snapshot eviction', async t => {
  const { core, view, report } = await setup(); t.after(() => core.persist());
  const received: ScopedReadingSnapshot[] = []; let captures = 0, modelBCalls = 0;
  const driver = model(core, async (_prompt, snapshot, emit) => { received.push(structuredClone(snapshot) as ScopedReadingSnapshot); emit('Analysis from model A'); });
  core.extensions.set('ai-reading-driver', async () => { captures++; return { driverId: driver.id, driver, model: 'test:model-A' }; });
  const first = await run(core, view.id, 'original-request'); await ended(core, first.task.id);
  const old = readAIReadingResult(core, first.task.id), document = core.getDocument(view.documentId);
  const patch = core.prepare(view.documentId, document.info.revision, { kind: 'text.replace', from: 0, to: 1, expectedText: '#', text: '# Changed' });
  await core.commit(patch.id, 'later-human-edit', 'human'); report('NEW_SELECTION', 'NEW_VISIBLE');
  core.drivers.set(driver.id, { ...driver, submit: async (_prompt, _snapshot, emit) => { modelBCalls++; emit('MODEL_B'); } });
  core.extensions.set('ai-reading-driver', async () => { captures++; return { driverId: driver.id, driver: core.drivers.get(driver.id), model: 'test:model-B' }; });
  for (let index = 0; index < 101; index++) await core.snapshot(view.id);
  assert.equal(core.snapshots.has(first.task.snapshotId), false, 'exercise real 100-snapshot eviction');
  const retryArgs = { taskId: first.task.id, idempotencyKey: 'explicit-retry' };
  const [retry, duplicate] = await Promise.all([dispatch(core, 'ai-reading-retry', retryArgs, 'human'), dispatch(core, 'ai-reading-retry', retryArgs, 'human')]) as AIReadingResult[];
  await ended(core, retry.task.id);
  assert.notEqual(retry.task.id, first.task.id); assert.equal(retry.task.id, duplicate.task.id); assert.equal(retry.retryOf, first.task.id);
  assert.equal(received.length, 2); assert.equal(modelBCalls, 0); assert.equal(captures, 1);
  assert.equal(received[1].sourceText, 'SELECTED_SOURCE'); assert.equal(received[1].document.revision, old.sourceRevision);
  assert.equal(received[1].id, first.task.snapshotId); assert.equal(retry.source.fingerprint, first.source.fingerprint);
  const current = readAIReadingResult(core, retry.task.id); assert.equal(current.sourceUpdated, true); assert.equal(current.source.model, 'test:model-A');
  current.source.locator.from = 999; assert.notEqual(readAIReadingResult(core, retry.task.id).source.locator.from, 999);
  const again = await dispatch(core, 'ai-reading-retry', retryArgs, 'human') as AIReadingResult;
  assert.equal(again.task.status, 'completed'); assert.equal(core.tasks.size, 2);
  await assert.rejects(dispatch(core, 'ai-reading-retry', { ...retryArgs, taskId: retry.task.id }, 'human'), /幂等键/);
  assert.equal(getAIReadingTool(current.toolId)?.label, current.label);
});

test('retry refuses running and generic tasks; failed task partial text is explicitly incomplete on export', async t => {
  const { core, view } = await setup(); t.after(() => core.persist());
  const held = gate(); model(core, async (_prompt, _snapshot, emit) => { emit('partial'); await held.promise; throw new Error('provider failed'); });
  const task = await run(core, view.id, 'running'); assert.equal(readAIReadingResult(core, task.task.id).canRetry, false);
  assert.equal(readAIReadingResult(core, task.task.id).markdown, undefined);
  await assert.rejects(dispatch(core, 'ai-reading-retry', { taskId: task.task.id, idempotencyKey: 'running-retry' }, 'human'), /仍在运行/);
  held.resolve(); await ended(core, task.task.id);
  const result = readAIReadingResult(core, task.task.id); assert.equal(result.task.status, 'failed'); assert.equal(result.canRetry, true); assert.match(result.markdown!, /未完成结果/);
  core.drivers.set('generic', { id: 'generic', capabilities: { streaming: false, cancellation: true, attachExistingSession: false }, submit: async (_p, _s, emit) => emit('generic') });
  const generic = await core.submitTask('generic', 'ordinary chat', view.id); await ended(core, generic.id);
  await assert.rejects(dispatch(core, 'ai-reading-result', { taskId: generic.id }), /没有冻结阅读结果/);
  await assert.rejects(dispatch(core, 'ai-reading-retry', { taskId: generic.id, idempotencyKey: 'generic-retry' }), /没有可重试/);
});

test('cancellation is immediately terminal and ignores a non-cooperative driver late output/rejection', async t => {
  const { core, view } = await setup(); t.after(() => core.persist());
  const held = gate(); let emitLate!: (text: string) => void;
  const driver = model(core, async (_p, _s, emit) => { emitLate = emit; emit('before cancellation'); await held.promise; emit('after cancellation'); throw new Error('late failure'); });
  const snapshot = scopedReadingSnapshot(await core.snapshot(view.id), 'selection');
  const task = await core.submitFrozenReadingTask(driver, 'read', snapshot);
  core.cancelTask(task.id); core.cancelTask(task.id);
  assert.equal(core.tasks.get(task.id)?.status, 'cancelled');
  const count = core.eventLog.length; emitLate('extra late chunk'); held.resolve(); await new Promise<void>(done => setImmediate(done));
  assert.equal(core.tasks.get(task.id)?.text, 'before cancellation'); assert.equal(core.tasks.get(task.id)?.status, 'cancelled');
  assert.equal(core.eventLog.length, count); assert.equal(core.eventLog.filter(event => event.type === 'harness.completed' && (event.data as { taskId: string }).taskId === task.id).length, 1);
});

test('immediate cancellation before driver invocation performs no provider work', async t => {
  const { core, view } = await setup(); t.after(() => core.persist()); let calls = 0;
  const driver = model(core, async (_p, _s, emit) => { calls++; emit('unwanted'); });
  // The trusted entrypoint returns a promise; its task is registered before the
  // driver microtask runs, so a synchronous stop can genuinely win this race.
  const pending = core.submitFrozenReadingTask(driver, 'read', scopedReadingSnapshot(await core.snapshot(view.id), 'selection'));
  const taskId = [...core.tasks.keys()].at(-1)!; core.cancelTask(taskId); await pending; await new Promise<void>(done => setImmediate(done));
  assert.equal(calls, 0); assert.equal(core.tasks.get(taskId)?.status, 'cancelled'); assert.equal(core.tasks.get(taskId)?.text, '');
});

test('synchronous driver errors, empty responses, timeout and oversize output each reach exactly one failed terminal state', async t => {
  const { core, view } = await setup(); t.after(() => core.persist());
  const snapshot = scopedReadingSnapshot(await core.snapshot(view.id), 'selection');
  const base = { id: 'driver', capabilities: { streaming: true, cancellation: true, attachExistingSession: false } };
  const synchronous = await core.submitFrozenReadingTask({ ...base, submit: () => { throw new Error('synchronous throw'); } }, 'read', snapshot);
  assert.match((await ended(core, synchronous.id)).error!, /synchronous throw/);
  const empty = await core.submitFrozenReadingTask({ ...base, submit: async () => {} }, 'read', snapshot);
  assert.match((await ended(core, empty.id)).error!, /未返回可读结果/);
  const oversized = await core.submitFrozenReadingTask({ ...base, submit: async (_p, _s, emit) => { emit('valid prefix'); emit('x'.repeat(160001)); emit('after limit'); } }, 'read', snapshot);
  assert.match((await ended(core, oversized.id)).error!, /160000/); assert.equal(core.tasks.get(oversized.id)?.text, 'valid prefix');
  const held = gate(); let emitLate!: (text: string) => void, timeoutSignal!: AbortSignal;
  const timeout = await core.submitFrozenReadingTask({ ...base, submit: async (_p, _s, emit, signal) => { timeoutSignal = signal; emitLate = emit; emit('partial before timeout'); await held.promise; emit('late'); } }, 'read', snapshot, 20);
  assert.equal((await ended(core, timeout.id)).status, 'failed'); assert.equal(timeoutSignal.aborted, true);
  emitLate('late external'); held.resolve(); await new Promise<void>(done => setImmediate(done));
  assert.equal(core.tasks.get(timeout.id)?.text, 'partial before timeout');
  for (const item of [synchronous, empty, oversized, timeout]) assert.equal(core.eventLog.filter(event => event.type === 'harness.completed' && (event.data as { taskId: string }).taskId === item.id).length, 1);
});

test('unsupported capability and source budget fail before model capture, and paused agents cannot create retries', async t => {
  const { core, view, report } = await setup(); t.after(() => core.persist()); let captures = 0;
  const driver = model(core, async (_p, _s, emit) => emit('valid result'));
  core.extensions.set('ai-reading-driver', async () => { captures++; return { driverId: driver.id, driver }; });
  const document = core.getDocument(view.documentId); document.info.capabilities.readSelection = false;
  const catalog = await dispatch(core, 'ai-reading-tools', { viewId: view.id }) as { availability: { selection: { available: boolean; reason: string } } };
  assert.equal(catalog.availability.selection.available, false); assert.match(catalog.availability.selection.reason, /不支持读取选中/);
  await assert.rejects(run(core, view.id, 'missing-capability'), /不支持读取选中/);
  document.info.capabilities.readSelection = true; report('x'.repeat(48001));
  await assert.rejects(run(core, view.id, 'budget'), /48000/); assert.equal(captures, 0); assert.equal(core.tasks.size, 0);
  report(); const first = await run(core, view.id, 'valid'); await ended(core, first.task.id);
  core.setAgentControl(view.id, 'paused');
  await assert.rejects(dispatch(core, 'ai-reading-retry', { taskId: first.task.id, idempotencyKey: 'agent-retry' }, 'agent'), error => error instanceof ViewerError && error.code === 'AGENT_PAUSED');
  const human = await dispatch(core, 'ai-reading-retry', { taskId: first.task.id, idempotencyKey: 'human-retry' }, 'human') as AIReadingResult;
  await ended(core, human.task.id); assert.equal(captures, 1, 'retry keeps its captured model');
});

test('bounded completed request eviction expires source records explicitly without falsely promising durable replay', async t => {
  const { core, view } = await setup(); t.after(() => core.persist());
  model(core, async (_p, _s, emit) => emit('analysis'));
  const first = await run(core, view.id, 'first'); await ended(core, first.task.id);
  for (let index = 0; index < 256; index++) { const next = await run(core, view.id, 'later-' + index); await ended(core, next.task.id); }
  assert.throws(() => readAIReadingResult(core, first.task.id), /过期/);
  assert.equal(core.tasks.get(first.task.id)?.status, 'completed', 'ordinary task history is not erased with the source cache');
  await assert.rejects(dispatch(core, 'ai-reading-retry', { taskId: first.task.id, idempotencyKey: 'expired-retry' }, 'human'), /过期/);
  const newest = [...core.tasks.keys()].at(-1)!; assert.equal(readAIReadingResult(core, newest).sourceText, 'SELECTED_SOURCE');
});

test('retry of the oldest retained result at full capacity succeeds even when its request is evicted to admit the retry', async t => {
  const { core, view } = await setup(); t.after(() => core.persist());
  let calls = 0; model(core, async (_p, _s, emit) => { calls++; emit('analysis'); });
  const first = await run(core, view.id, 'first'); await ended(core, first.task.id);
  for (let index = 0; index < 255; index++) { const next = await run(core, view.id, 'later-' + index); await ended(core, next.task.id); }
  const source = readAIReadingResult(core, first.task.id).source;
  const retry = await dispatch(core, 'ai-reading-retry', { taskId: first.task.id, idempotencyKey: 'full-capacity-retry' }, 'human') as AIReadingResult;
  await ended(core, retry.task.id);
  assert.equal(calls, 257); assert.equal(retry.retryOf, first.task.id); assert.equal(retry.source.fingerprint, source.fingerprint);
  assert.equal(readAIReadingResult(core, retry.task.id).sourceText, 'SELECTED_SOURCE');
});
