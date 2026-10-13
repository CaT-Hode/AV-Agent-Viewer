import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentViewState, AgentViewStatus, EditOperation, PreparedPatch } from '../packages/contracts/src/index';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { createRegistry, TextAdapter } from '../packages/format-adapters/src/index';
import { dispatch } from '../packages/sdk/src/dispatch';

const bytes = (text: string) => new TextEncoder().encode(text);
const replace = (expectedText = 'abc', text = 'edited'): EditOperation => ({ kind: 'text.replace', from: 0, to: expectedText.length, expectedText, text });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-view-state-'));
  const repository = new JsonWorkspaceRepository(join(directory, 'workspace.json'));
  const core = new ViewerCore(repository), first = await core.openBytes('first.md', bytes('abc'), 'markdown');
  return { core, first, directory, repository };
}
const acquire = (core: ViewerCore, viewId: string, agentId = 'writer') => dispatch(core, 'agent-acquire', { viewId, agentId }) as Promise<AgentViewState>;
const status = (core: ViewerCore, viewId: string) => dispatch(core, 'agent-status', { viewId }) as Promise<AgentViewStatus>;
const plan = (core: ViewerCore, documentId: string, viewId?: string, controlId?: string) => dispatch(core, 'prepare', { documentId, viewId, controlId, expectedRevision: 0, operation: replace() }) as Promise<PreparedPatch>;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('explicit collaboration is view-bound, returns real copies and never activates or locks human input', async () => {
  const { core, first } = await setup(), second = core.addView(first.documentId);
  core.activate(second.id, 'human');
  const session = await acquire(core, first.id);
  assert.equal(session.viewId, first.id); assert.equal(session.documentId, first.documentId); assert.equal(session.phase, 'reading');
  assert.equal(core.activeViewId, second.id); assert.equal(core.lastHumanViewId, second.id);
  core.updateContext(first.id, { visibleText: 'human is reading', selection: { kind: 'text', text: 'human' } });
  assert.equal((await core.context(first.id)).actor, 'human');
  assert.equal((await status(core, second.id)).state, null);
  const copy = core.state(); copy.views.find(view => view.id === first.id)!.agentState!.phase = 'editing';
  assert.equal((await status(core, first.id)).state!.phase, 'reading');
  assert.deepEqual(core.state().agentStates, [(await status(core, first.id)).state]);
  await assert.rejects(dispatch(core, 'agent-acquire', { viewId: first.id, documentId: 'another-document' }), { code: 'INVALID_TARGET' });
  await assert.rejects(acquire(core, first.id, 'other'), { code: 'AGENT_VIEW_BUSY' });
  const updated = await dispatch(core, 'agent-acquire', { viewId: first.id, controlId: session.controlId, phase: 'editing' }) as AgentViewState;
  assert.equal(updated.controlId, session.controlId); assert.equal(updated.phase, 'editing');
});

test('legacy prepare freezes its matching document view before foreground switches; only that tab gets edit metadata', async () => {
  const { core, first } = await setup(), duplicate = core.addView(first.documentId), other = await core.openBytes('other.md', bytes('other'), 'markdown');
  core.activate(first.id, 'human');
  const patch = await plan(core, first.documentId);
  assert.equal(patch.viewId, first.id); assert.equal(patch.agentStateEpoch, 0);
  core.activate(duplicate.id, 'human'); core.activate(other.id, 'human');
  const receipt = await core.commit(patch.id, 'fixed-target');
  const actual = (await status(core, first.id)).state!;
  assert.equal(actual.phase, 'editing'); assert.equal(actual.lastEdit!.transactionId, receipt.transactionId); assert.equal(actual.lastEdit!.revision, 1);
  assert.equal((await status(core, duplicate.id)).state, null); assert.equal((await status(core, other.id)).state, null);
  assert.equal(core.activeViewId, other.id); assert.equal(core.lastHumanViewId, other.id);
  assert.equal(core.getDocument(first.documentId).info.model.text, 'edited');
  assert.equal((core.eventLog.find(event => event.type === 'document.changed')!.data as { viewId: string }).viewId, first.id);
  // No matching human/active view: deterministic first existing view is fixed.
  const next = core.prepare(first.documentId, 1, replace('edited', 'again'));
  assert.equal(next.viewId, first.id);
});

test('release and reacquire invalidate old control epochs without affecting another view or human commits', async () => {
  const { core, first } = await setup(), second = core.addView(first.documentId);
  const firstSession = await acquire(core, first.id), secondSession = await acquire(core, second.id, 'second');
  const stale = await plan(core, first.documentId, first.id, firstSession.controlId);
  await assert.rejects(dispatch(core, 'agent-release', { viewId: second.id, controlId: firstSession.controlId }), { code: 'AGENT_CONTROL_MISMATCH' });
  await dispatch(core, 'agent-release', { viewId: first.id, controlId: firstSession.controlId });
  assert.equal((await status(core, first.id)).state, null); assert.equal((await status(core, second.id)).state!.controlId, secondSession.controlId);
  const renewed = await acquire(core, first.id);
  assert.notEqual(renewed.controlId, firstSession.controlId);
  await assert.rejects(dispatch(core, 'agent-release', { viewId: first.id, controlId: firstSession.controlId }), { code: 'AGENT_CONTROL_MISMATCH' });
  await assert.rejects(core.commit(stale.id, 'stale-owner'), { code: 'AGENT_STATE_CHANGED' });
  assert.equal(core.getDocument(first.documentId).info.revision, 0);
  await core.commit(stale.id, 'human-is-not-locked', 'human');
  assert.equal(core.getDocument(first.documentId).info.model.text, 'edited');
  assert.equal((await status(core, first.id)).state!.controlId, renewed.controlId); assert.equal((await status(core, first.id)).state!.phase, 'reading');
});

test('concurrent idempotent agent commits announce one actual edit and retry cannot resurrect released state', async () => {
  const { core, first } = await setup(), patch = await plan(core, first.documentId, first.id);
  const [left, right] = await Promise.all([core.commit(patch.id, 'once'), core.commit(patch.id, 'once')]);
  assert.deepEqual(left, right); assert.equal(core.getDocument(first.documentId).info.revision, 1);
  assert.equal(core.eventLog.filter(event => event.type === 'agent.acquired').length, 1);
  assert.equal(core.eventLog.filter(event => event.type === 'document.changed').length, 1);
  const session = (await status(core, first.id)).state!;
  await dispatch(core, 'agent-release', { viewId: first.id, controlId: session.controlId });
  core.setAgentControl(first.id, 'paused');
  const eventCount = core.eventLog.length;
  assert.deepEqual(await core.commit(patch.id, 'once'), left);
  assert.equal(core.eventLog.length, eventCount); assert.equal((await status(core, first.id)).state, null);
  assert.equal((await status(core, first.id)).userControl, 'paused');
});

test('human pause and stop are independent of collaboration; agent cannot acquire/edit or auto-resume them', async () => {
  const { core, first } = await setup(), session = await acquire(core, first.id), patch = await plan(core, first.documentId, first.id, session.controlId);
  for (const userControl of ['paused', 'stopped'] as const) {
    core.setAgentControl(first.id, userControl);
    await assert.rejects(core.commit(patch.id, userControl), { code: 'AGENT_PAUSED' });
    await assert.rejects(dispatch(core, 'agent-acquire', { viewId: first.id, controlId: session.controlId, phase: 'editing' }), { code: 'AGENT_PAUSED' });
    assert.equal((await status(core, first.id)).userControl, userControl); assert.equal((await status(core, first.id)).state!.phase, 'reading');
  }
  await core.commit(patch.id, 'human-while-stopped', 'human');
  assert.equal(core.getDocument(first.documentId).info.revision, 1); assert.equal(core.agentControl.get(first.id), 'stopped');
});

test('release during an asynchronous adapter operation prevents writes and receipt creation', async () => {
  const { core, first } = await setup(), entered = gate(), completion = gate(), adapter = new TextAdapter(), registry = createRegistry();
  registry.register({ ...adapter, id: 'gated-real-text', formats: adapter.formats, open: adapter.open.bind(adapter), capabilities: adapter.capabilities.bind(adapter), preview: adapter.preview.bind(adapter), apply: async (source, model, operation) => { entered.resolve(); await completion.promise; return adapter.apply(source, model, operation); } }, true);
  const gatedCore = new ViewerCore(core.repository, registry);
  await core.persist(); await gatedCore.initialize();
  const session = await acquire(gatedCore, first.id), patch = await plan(gatedCore, first.documentId, first.id, session.controlId);
  const committing = gatedCore.commit(patch.id, 'released-during-apply'), rejected = assert.rejects(committing, { code: 'AGENT_STATE_CHANGED' });
  await entered.promise;
  await dispatch(gatedCore, 'agent-release', { viewId: first.id, controlId: session.controlId }); completion.resolve(); await rejected;
  assert.equal(gatedCore.getDocument(first.documentId).info.model.text, 'abc'); assert.equal(gatedCore.getDocument(first.documentId).info.revision, 0);
  assert.equal(gatedCore.receipts.has('released-during-apply'), false); assert.equal((await status(gatedCore, first.id)).state, null);
});

test('a closed bound view never redirects pending edits or clones collaboration state onto duplicates', async () => {
  const { core, first } = await setup(), session = await acquire(core, first.id), duplicate = core.addView(first.documentId);
  const patch = await plan(core, first.documentId, first.id, session.controlId);
  assert.equal(core.getView(duplicate.id).agentState, undefined);
  core.closeView(first.id, true);
  assert.equal(core.state().agentStates!.length, 0);
  await assert.rejects(core.commit(patch.id, 'closed-owner'), { code: 'TARGET_NOT_FOUND' });
  assert.equal(core.getDocument(first.documentId).info.revision, 0); assert.equal(core.getView(duplicate.id).agentState, undefined);
  assert.equal((core.eventLog.find(event => event.type === 'agent.released')!.data as { reason: string }).reason, 'view-closed');
});

test('workspace recovery strips live state; saved receipts remain valid without restoring online agents', async () => {
  const { core, first, repository } = await setup(), patch = await plan(core, first.documentId, first.id);
  const receipt = await core.commit(patch.id, 'before-restart');
  assert.ok((await status(core, first.id)).state);
  const persisted = JSON.parse(await readFile(repository.path, 'utf8'));
  assert.equal(persisted.views[0].agentState, undefined); assert.equal(persisted.agentStates, undefined);
  const restored = new ViewerCore(repository); await restored.initialize();
  assert.equal((await status(restored, first.id)).state, null); assert.equal(restored.state().agentStates!.length, 0);
  assert.deepEqual(await restored.commit(patch.id, 'before-restart'), receipt); assert.equal((await status(restored, first.id)).state, null);
  // Defensive migration: older recovery files may accidentally contain badges.
  persisted.views[0].agentState = { controlId: 'stale-control', phase: 'editing' }; await repository.save(persisted);
  const migrated = new ViewerCore(repository); await migrated.initialize(); assert.equal((await status(migrated, first.id)).state, null);
});

test('SDK schemas reject ambiguous binding and acquisition remains atomic across concurrent callers', async () => {
  const { core, first } = await setup();
  const attempted = await Promise.allSettled([acquire(core, first.id, 'a'), acquire(core, first.id, 'b')]);
  assert.equal(attempted.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempted.filter(result => result.status === 'rejected' && result.reason.code === 'AGENT_VIEW_BUSY').length, 1);
  await assert.rejects(dispatch(core, 'agent-release', { viewId: first.id }));
  await assert.rejects(dispatch(core, 'agent-status', {}));
  const other = await core.openBytes('other.md', bytes('abc'), 'markdown');
  await assert.rejects(plan(core, first.documentId, other.id), { code: 'INVALID_TARGET' });
  await assert.rejects(plan(core, first.documentId, ''), { code: 'TARGET_NOT_FOUND' });
  await assert.rejects(dispatch(core, 'prepare', { documentId: first.documentId, expectedRevision: 0, operation: replace(), viewId: 1 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(plan(core, first.documentId, first.id, 'wrong-control'), { code: 'AGENT_CONTROL_MISMATCH' });
});

test('a frozen selection edit announces its actual source view, even when another view of that document is foreground', async () => {
  const { core, first } = await setup(), second = core.addView(first.documentId);
  core.updateContext(first.id, { visibleText: 'abc', selection: { kind: 'text', text: 'abc', locator: { kind: 'source-range', from: 0, to: 3 } } });
  const snapshot = await core.snapshot(first.id);
  core.activate(second.id, 'human');
  await dispatch(core, 'selection-action', { snapshotId: snapshot.id, action: 'bold', idempotencyKey: 'frozen-selection' });
  assert.equal(core.getDocument(first.documentId).info.model.text, '**abc**');
  assert.equal((await status(core, first.id)).state!.phase, 'editing'); assert.equal((await status(core, second.id)).state, null);
  assert.equal(core.lastHumanViewId, second.id); assert.equal(core.activeViewId, second.id);
});

test('human pause during the actual asynchronous draft check aborts before an adapter writes or announces editing', async () => {
  const { core, first } = await setup(), session = await acquire(core, first.id), patch = await plan(core, first.documentId, first.id, session.controlId);
  const entered = gate(), completion = gate();
  core.extensions.set('before-agent-edit', async () => { entered.resolve(); await completion.promise; });
  const committing = core.commit(patch.id, 'paused-during-drafts'), rejected = assert.rejects(committing, { code: 'AGENT_PAUSED' });
  await entered.promise; core.setAgentControl(first.id, 'paused'); completion.resolve(); await rejected;
  assert.equal(core.getDocument(first.documentId).info.model.text, 'abc'); assert.equal(core.getDocument(first.documentId).info.revision, 0);
  assert.equal(core.receipts.has('paused-during-drafts'), false); assert.equal((await status(core, first.id)).state!.phase, 'reading');
});
