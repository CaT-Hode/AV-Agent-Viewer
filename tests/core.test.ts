import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository, WorkspacePersistenceBusyError, type WorkspaceDocumentSnapshot } from '../packages/persistence/src/index';
import { blobStorageReference, collectFrozenBlobs, freezeWorkspaceBlob, readWorkspaceBlob } from '../packages/persistence/src/workspace-blobs';
import { DocumentHistory, DocumentSessions } from '../packages/document-core/src/document-session';
import { blankBytes } from '../packages/document-core/src/fixtures';
import { dispatch } from '../packages/sdk/src/dispatch';
import { startServer } from '../apps/local-service/src/server';
import { browserRequestSchema, type EditOperation } from '../packages/contracts/src/index';
import { nativeOfficeInteractionBlocked, type NativeOfficeDriver, type NativeOfficeState } from '../packages/contracts/src/native-office';
import type { OfficeSurfaceState } from '../packages/contracts/src/office-surface';
import { OfficeSurfaceInputController } from '../apps/desktop/src/renderer/lib/office-surface-controller';
import { nativeOfficeStatusKey } from '../apps/desktop/src/renderer/lib/native-office-tools';
import { createNativeOfficeStateObserver } from '../apps/desktop/src/renderer/lib/native-office-observer';
import { nativeOfficeReadMessages, updateNativeOfficeReadErrors } from '../apps/desktop/src/renderer/lib/native-office-read-errors';
import { flushOfficeSurfaceDraft } from '../apps/desktop/src/renderer/lib/office-surface-draft';
import { DocumentTranslationService, translateDocumentBytes } from '../packages/translation/src/index';
import { SettingsService } from '../packages/settings/src/index';
import { mergeTextDraft, textReplacement } from '../apps/desktop/src/renderer/lib/text-drafts';
import { markdownLinks, replaceMarkdownLinks } from '../packages/markdown/src/links';
import { MarkdownWorkspace } from '../packages/markdown/src/workspace';

async function setup() { const directory = await mkdtemp(join(tmpdir(), 'agentviewer-test-')); const core = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))); return { directory, core }; }
async function modify(core: ViewerCore, id: string, operation: EditOperation, key = crypto.randomUUID()) { const patch = core.prepare(id, core.getDocument(id).info.revision, operation); return { patch, receipt: await core.commit(patch.id, key) }; }

function editGate() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('Agent 提交和撤销都经过草稿检查，拒绝时保留原内容与事务', async () => {
  const { core } = await setup(), view = await core.openBytes('draft.md', new TextEncoder().encode('abc'), 'markdown');
  const operation: EditOperation = { kind: 'text.replace', from: 1, to: 2, expectedText: 'b', text: 'B' };
  const patch = core.prepare(view.documentId, 0, operation), gate = editGate(), entered = editGate();
  const before = core.getDocument(view.documentId).bytes.slice(), eventCount = core.eventLog.length;
  core.extensions.set('before-agent-edit', async (args, actor) => { assert.equal(actor, 'agent'); assert.equal(args.documentId, view.documentId); assert.deepEqual(args.operation, operation); entered.resolve(); await gate.promise; });
  const committing = core.commit(patch.id, 'blocked-agent-edit'), rejected = assert.rejects(committing, /reader has a local draft/);
  await entered.promise;
  assert.equal(core.getDocument(view.documentId).info.revision, 0);
  assert.deepEqual(core.getDocument(view.documentId).bytes, before);
  gate.reject(new Error('reader has a local draft')); await rejected;
  assert.equal(core.getDocument(view.documentId).info.revision, 0);
  assert.deepEqual(core.getDocument(view.documentId).bytes, before);
  assert.equal(core.receipts.size, 0); assert.equal(core.transactions.size, 0); assert.equal(core.eventLog.length, eventCount);
  const accepted = await core.commit(patch.id, 'human-with-draft', 'human');
  core.extensions.set('before-agent-edit', async args => { assert.equal(args.operation.kind, 'document.undo'); throw new Error('reader has a local draft'); });
  await assert.rejects(core.undo(accepted.transactionId), /reader has a local draft/);
  assert.equal(core.getDocument(view.documentId).info.model.text, 'aBc');
  assert.equal(core.getDocument(view.documentId).info.revision, 1);
  assert.ok(core.transactions.has(accepted.transactionId));
});

test('用户提交跳过 Agent 草稿检查，已经完成的幂等重试不再检查', async () => {
  const { core } = await setup(), view = await core.openBytes('draft.md', new TextEncoder().encode('abc'), 'markdown');
  let checks = 0, rejectCheck = true;
  core.extensions.set('before-agent-edit', async () => { checks++; if (rejectCheck) throw new Error('draft blocked'); });
  const human = core.prepare(view.documentId, 0, { kind: 'text.replace', from: 0, to: 1, expectedText: 'a', text: 'A' });
  await core.commit(human.id, 'human-edit', 'human');
  assert.equal(checks, 0); assert.equal(core.getDocument(view.documentId).info.model.text, 'Abc');
  rejectCheck = false;
  const agent = core.prepare(view.documentId, 1, { kind: 'text.replace', from: 1, to: 2, expectedText: 'b', text: 'B' });
  const receipt = await core.commit(agent.id, 'agent-edit');
  assert.equal(checks, 1);
  rejectCheck = true;
  assert.deepEqual(await core.commit(agent.id, 'agent-edit'), receipt);
  assert.equal(checks, 1); assert.equal(core.getDocument(view.documentId).info.revision, 2);
  const next = core.prepare(view.documentId, 2, { kind: 'text.replace', from: 2, to: 3, expectedText: 'c', text: 'C' });
  await assert.rejects(core.commit(next.id, 'new-agent-edit'), /draft blocked/);
  assert.equal(checks, 2); assert.equal(core.receipts.has('new-agent-edit'), false);
});

test('Agent 草稿检查期间用户可以提交，新版本使等待中的 Agent 计划失效', async () => {
  const { core } = await setup(), view = await core.openBytes('draft.md', new TextEncoder().encode('abc'), 'markdown');
  const gate = editGate(), entered = editGate();
  core.extensions.set('before-agent-edit', async () => { entered.resolve(); await gate.promise; });
  const agent = core.prepare(view.documentId, 0, { kind: 'text.replace', from: 0, to: 3, expectedText: 'abc', text: 'agent' });
  const committing = core.commit(agent.id, 'waiting-agent-edit'), rejected = assert.rejects(committing, /内容已改变/);
  await entered.promise;
  const human = core.prepare(view.documentId, 0, { kind: 'text.replace', from: 0, to: 3, expectedText: 'abc', text: 'human' });
  await core.commit(human.id, 'concurrent-human-edit', 'human');
  const humanBytes = core.getDocument(view.documentId).bytes.slice();
  gate.resolve(); await rejected;
  assert.equal(core.getDocument(view.documentId).info.revision, 1);
  assert.equal(core.getDocument(view.documentId).info.model.text, 'human');
  assert.deepEqual(core.getDocument(view.documentId).bytes, humanBytes);
  assert.equal(core.receipts.has('waiting-agent-edit'), false); assert.equal(core.transactions.size, 1);
  const undoEntered = editGate(), undoGate = editGate(), latestTransaction = [...core.transactions.keys()][0];
  core.extensions.set('before-agent-edit', async () => { undoEntered.resolve(); await undoGate.promise; });
  const undoing = core.undo(latestTransaction), undoRejected = assert.rejects(undoing, /其他编辑/);
  await undoEntered.promise;
  const further = core.prepare(view.documentId, 1, { kind: 'text.replace', from: 5, to: 5, expectedText: '', text: '!' });
  await core.commit(further.id, 'human-during-undo', 'human');
  undoGate.resolve(); await undoRejected;
  assert.equal(core.getDocument(view.documentId).info.model.text, 'human!');
  core.extensions.delete('before-agent-edit');
  // Renderer drafts retain their original source. A remote edit may be rebased
  // only when both source ranges are provably independent.
  const base = 'alpha\nbeta\n', textView = await core.openBytes('merge.md', new TextEncoder().encode(base), 'markdown');
  await modify(core, textView.documentId, { kind: 'text.replace', from: 0, to: 5, expectedText: 'alpha', text: 'ALPHA' });
  const latest = core.getDocument(textView.documentId).info;
  const merged = mergeTextDraft(base, 'alpha\nBETA\n', latest.model.text!);
  assert.ok(merged?.operation); assert.equal(merged.text, 'ALPHA\nBETA\n');
  const rebased = core.prepare(textView.documentId, latest.revision, { kind: 'text.replace', ...merged.operation });
  await core.commit(rebased.id, 'independent-local-draft', 'human');
  assert.equal(core.getDocument(textView.documentId).info.model.text, 'ALPHA\nBETA\n');
  assert.equal(mergeTextDraft(base, 'local\nbeta\n', 'remote\nbeta\n'), undefined);
  assert.equal(mergeTextDraft('ab', 'aXb', 'aYb'), undefined, 'same-boundary insertion is ambiguous');
  assert.deepEqual(mergeTextDraft(base, base, 'remote'), { text: 'remote' });
  assert.deepEqual(textReplacement('A😀Z', 'A😁Z'), { from: 1, to: 3, expectedText: '😀', text: '😁' });
  const wide='a'.repeat(65535)+'😀'+'b'.repeat(65537);
  for(const position of [0,65535,65536,65537,wide.length]){
    const changed=wide.slice(0,position)+'新'+wide.slice(position),range=textReplacement(wide,changed)!;
    assert.equal(wide.slice(range.from,range.to),range.expectedText);assert.equal(wide.slice(0,range.from)+range.text+wide.slice(range.to),changed,'chunk boundaries preserve exact UTF-16 source, including split surrogate edits');
  }
  assert.equal(textReplacement(base, base), undefined);
});

test('快照固定未保存正文；多个视图有独立选择；版本冲突阻止过期提交', async () => {
  const { core } = await setup(); const first = await core.openBytes('test.md', new TextEncoder().encode('原文片段'), 'markdown'); const second = core.addView(first.documentId);
  core.updateContext(first.id, { selection: { kind: 'text', text: '原文' }, visibleText: '原文片段', locator: { kind: 'source', from: 0, to: 2 } });
  core.updateContext(second.id, { selection: { kind: 'text', text: '片段' } });
  core.activate(first.id, 'human'); core.activate(second.id, 'agent'); assert.equal((await core.context()).viewId, first.id);
  const snapshot = await core.snapshot(first.id), pending = core.prepare(first.documentId, 0, { kind: 'text.replace', from: 0, to: 2, expectedText: '原文', text: '替换' });
  const changed = await modify(core, first.documentId, { kind: 'text.replace', from: 4, to: 4, expectedText: '', text: '新增' });
  const inverse = core.transactions.get(changed.receipt.transactionId);
  assert.equal(inverse?.kind, 'text', 'text undo retains only the inverse source range');
  if (inverse?.kind === 'text') assert.deepEqual(inverse.inverse, { kind: 'text.replace', from: 4, to: 6, expectedText: '新增', text: '' });
  assert.ok(inverse && !('before' in inverse), 'ordinary text history does not clone the complete document');
  assert.equal(core.getDocument(first.documentId).info.model.text, '原文片段新增'); assert.equal(snapshot.document.model.text, '原文片段'); assert.equal(snapshot.context.selection.text, '原文');
  await assert.rejects(core.commit(pending.id, 'stale'), /内容已改变/);
  assert.equal((await core.context(first.id)).quality, 'not-ready');
  await core.undo(changed.receipt.transactionId); assert.equal(core.getDocument(first.documentId).info.model.text, '原文片段');
});

test('提交重试不重复插入；重启后的回执仍可识别', async () => {
  const { core, directory } = await setup(); const view = await core.openBytes('test.md', new TextEncoder().encode('a'), 'markdown'); const patch = core.prepare(view.documentId, 0, { kind: 'text.replace', from: 1, to: 1, expectedText: '', text: 'b' });
  const [first, second] = await Promise.all([core.commit(patch.id, 'same-key'), core.commit(patch.id, 'same-key')]); assert.deepEqual(first, second); assert.equal(core.getDocument(view.documentId).info.model.text, 'ab');
  assert.equal(core.patches.has(patch.id),false,'completed previews release historical text');assert.match(core.receipts.get('same-key')!.payload,/^sha256:[0-9a-f]{64}$/);
  const restored = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))); await restored.initialize(); assert.deepEqual(await restored.commit(patch.id, 'same-key'), first); assert.equal(restored.getDocument(view.documentId).info.model.text, 'ab');
  const other = core.prepare(view.documentId, 1, { kind: 'text.replace', from: 2, to: 2, expectedText: '', text: 'c' }); await assert.rejects(core.commit(other.id, 'same-key'), /幂等键/);
  const legacy=await core.repository.load<any>();legacy.patches=[];legacy.receipts=[['historic-key',{payload:JSON.stringify(patch),receipt:first}]];
  legacy.documents=legacy.documents.map((entry:any)=>({...entry,bytes:Buffer.from(entry.bytes).toString('base64')}));
  const legacyPath=join(directory,'legacy-receipts.json');await writeFile(legacyPath,JSON.stringify(legacy));
  const migrated=new ViewerCore(new JsonWorkspaceRepository(legacyPath));await migrated.initialize();assert.deepEqual(await migrated.commit(patch.id,'historic-key'),first,'legacy completed previews can be absent from the old 1000-entry preparation window');
  const undone = await core.undo(first.transactionId);
  assert.deepEqual(await core.undo(first.transactionId), undone);
  const afterUndo = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))); await afterUndo.initialize();
  assert.equal(afterUndo.getDocument(view.documentId).info.model.text, 'a');
  assert.deepEqual(await afterUndo.undo(first.transactionId), undone, 'undo receipt is durable before the response');
});

test('恢复迁移校验二进制与冻结队列，撤销预算和文档队列保持独立', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-recovery-')), path = join(directory, 'workspace.json');
  const binary = Uint8Array.from([0, 255, 1, 128, 13, 10, 0, 254]), model = { text: '恢复正文😀', nested: { preserved: true } };
  const legacy = { schemaVersion: 1, documents: [{ info: { id: 'binary', revision: 0, model }, bytes: Buffer.from(binary).toString('base64') }] };
  const legacySource = JSON.stringify(legacy); await writeFile(path, legacySource);
  const repository = new JsonWorkspaceRepository(path);
  assert.deepEqual(await repository.load(), legacy);
  await repository.saveDocuments({ documents: [] });
  assert.equal(await readFile(path + '.v1.bak', 'utf8'), legacySource, 'even migration to an empty workspace backs up v1 first');
  const info = { id: 'binary', revision: 0, model, title: 'before metadata update' }, snapshot: WorkspaceDocumentSnapshot = { documents: [{ info, bytes: binary }], views: [{ id: 'view', zoom: 1 }] };
  await repository.saveDocuments(snapshot);
  const encoded = repository.statistics;
  info.title = 'after metadata update';
  await repository.saveDocuments({ ...snapshot, views: [{ id: 'view', zoom: 1.25 }] }, { mode: 'checkpoint' });
  assert.equal(repository.statistics.frozenSourceBytes, encoded.frozenSourceBytes, 'metadata checkpoints reuse frozen source and model bodies');
  assert.equal(repository.statistics.blobWrites, encoded.blobWrites);
  const restored = await new JsonWorkspaceRepository(path).load<WorkspaceDocumentSnapshot>();
  assert.deepEqual(restored?.documents[0].bytes, binary); assert.deepEqual(restored?.documents[0].info.model, model);
  assert.equal(await readFile(path + '.v1.bak', 'utf8'), legacySource, 'later v2 writes preserve the original backup');
  const goodManifest = await readFile(path, 'utf8'), hash = createHash('sha256').update(binary).digest('hex');
  await writeFile(join(path + '.data', 'blobs', hash), new Uint8Array(binary.length));
  await assert.rejects(new JsonWorkspaceRepository(path).load(), /WORKSPACE_BLOB_CORRUPT/);
  assert.equal(await readFile(path, 'utf8'), goodManifest, 'a corrupt restore does not overwrite the last manifest');

  class HeldRepository extends JsonWorkspaceRepository {
    readonly entered = editGate(); readonly release = editGate(); readonly payloads: string[] = []; private hold = true;
    protected override async writePayload(payload: string) {
      this.payloads.push(payload);
      if (this.hold) { this.hold = false; this.entered.resolve(); await this.release.promise; }
      await super.writePayload(payload);
    }
  }
  const queued = new HeldRepository(join(directory, 'queue.json'), { maxPendingBytes: 4096, maxPendingEntries: 3, maxWaiters: 3 });
  const original = { label: 'barrier', nested: { text: 'frozen' } }, first = queued.save(original); original.nested.text = 'mutated after save';
  await queued.entered.promise;
  const displaced = queued.save({ label: 'old-checkpoint' }, { mode: 'checkpoint' }), latestValue = { label: 'latest-checkpoint' };
  const latest = queued.save(latestValue, { mode: 'checkpoint' }); latestValue.label = 'mutated checkpoint';
  const barrier = queued.save({ label: 'last-barrier' });
  await assert.rejects(queued.save({ label: 'overflow' }), WorkspacePersistenceBusyError);
  queued.release.resolve(); await Promise.all([first, displaced, latest, barrier]);
  assert.deepEqual(queued.payloads.map(payload => JSON.parse(payload)), [{ label: 'barrier', nested: { text: 'frozen' } }, { label: 'latest-checkpoint' }, { label: 'last-barrier' }]);
  assert.equal(queued.statistics.coalesced, 1); assert.equal(queued.statistics.rejected, 1); assert.equal(queued.statistics.retainedBytes, 0);
  assert.ok(queued.statistics.maximumRetainedBytes <= queued.statistics.maxPendingBytes);

  const blobQueue = new HeldRepository(join(directory, 'blob-queue.json'), { maxPendingEntries: 2 });
  const document = (id: string, text: string): WorkspaceDocumentSnapshot => ({ documents: [{ info: { id, revision: 0, model: { text } }, bytes: new TextEncoder().encode(text) }] });
  const activeBody = document('active', 'active'), active = blobQueue.saveDocuments(activeBody); await blobQueue.entered.promise;
  const oldBody = document('old', 'old body'), newBody = document('new', 'new body'), rejectedBody = document('rejected', 'rejected body');
  const oldCheckpoint = blobQueue.saveDocuments(oldBody, { mode: 'checkpoint' }), newCheckpoint = blobQueue.saveDocuments(newBody, { mode: 'checkpoint' });
  await assert.rejects(blobQueue.saveDocuments(rejectedBody), WorkspacePersistenceBusyError);
  blobQueue.release.resolve(); await Promise.all([active, oldCheckpoint, newCheckpoint]);
  const frozenBeforeRetry = blobQueue.statistics.frozenSourceBytes;
  await blobQueue.saveDocuments(oldBody); await blobQueue.saveDocuments(rejectedBody);
  assert.ok(blobQueue.statistics.frozenSourceBytes > frozenBeforeRetry, 'evicted/rejected buffers are released and can be frozen again');
  assert.deepEqual((await new JsonWorkspaceRepository(blobQueue.path).load<WorkspaceDocumentSnapshot>())?.documents[0].bytes, rejectedBody.documents[0].bytes);
  const collecting = blobQueue.collectGarbage(), retainedWhileCollecting = blobQueue.saveDocuments(activeBody);
  await Promise.all([collecting, retainedWhileCollecting]);
  assert.deepEqual((await new JsonWorkspaceRepository(blobQueue.path).load<WorkspaceDocumentSnapshot>())?.documents[0].bytes, activeBody.documents[0].bytes, 'maintenance cannot delete a newly queued reference that reused a known blob');

  const textRepository = new JsonWorkspaceRepository(join(directory, 'text-deltas.json'));
  const blockBody = Uint8Array.from({ length: 3 * 65536 + 37 }, (_, index) => (index * 31 + (index >> 10)) & 255), blockBase = freezeWorkspaceBlob(blockBody);
  for (const position of [0, 65535, 65536, 65537, blockBody.length - 1, blockBody.length]) for (const [removed, insertion] of [[0, [254, 127, 1]], [1, []], [1, [254, 127, 1]]] as const) {
    if (position + removed > blockBody.length) continue;
    const next = Buffer.concat([blockBody.subarray(0, position), Uint8Array.from(insertion), blockBody.subarray(position + removed)]);
    const offset = new Uint8Array(next.length + 17); offset.set(next, 11); const view = offset.subarray(11, 11 + next.length);
    const blob = freezeWorkspaceBlob(view, { bytes: blockBody, blob: blockBase });
    assert.ok(blob.reference.delta, 'small edits at chunk boundaries remain incremental');
    const stored = new Map(collectFrozenBlobs([blob]).map(dependency => [blobStorageReference(dependency.reference).sha256, dependency.data!]));
    const loaded = await readWorkspaceBlob(blob.reference, async reference => stored.get(reference.sha256)!);
    assert.deepEqual(loaded, next, 'chunk comparisons preserve offset views, insertions and replacements at both ends');
  }
  assert.equal(freezeWorkspaceBlob(blockBody.slice(), { bytes: blockBody, blob: blockBase }), blockBase, 'equal source reuses the original blob');
  const textSnapshot = (revision: number): WorkspaceDocumentSnapshot => {
    const text = '恢复文本😀\r\n'.repeat(16000) + `revision ${revision}`;
    return { documents: [{ info: { id: 'text', revision, format: 'markdown', model: { format: 'markdown', text } }, bytes: new TextEncoder().encode('\ufeff' + text) }] };
  };
  const initialSource = textSnapshot(0); let finalText = initialSource;
  for (let index = 0; index < 35; index++) {
    finalText = index === 0 ? initialSource : textSnapshot(index); await textRepository.saveDocuments(finalText);
    if (index === 32 || index === 33) {
      const manifest = JSON.parse(await readFile(textRepository.path, 'utf8')), entry = manifest.workspace.documents[0];
      assert.equal(entry.content.delta?.depth ?? 0, index === 32 ? 32 : 0, 'delta depth is bounded by a complete checkpoint');
      assert.deepEqual(entry.model, { kind: 'text', format: 'markdown' }, 'plain text models are reconstructed without a second full-body blob');
    }
  }
  const textRestored = new JsonWorkspaceRepository(textRepository.path), loadedText = await textRestored.load<WorkspaceDocumentSnapshot>();
  assert.deepEqual(loadedText?.documents[0].bytes, finalText.documents[0].bytes); assert.deepEqual(loadedText?.documents[0].info.model, finalText.documents[0].info.model);
  assert.ok(textRepository.statistics.deltaWrites >= 32); assert.ok(textRepository.statistics.blobBytesWritten < finalText.documents[0].bytes.byteLength * 4, 'small edits do not write two complete bodies for every revision');
  await textRestored.saveDocuments(loadedText!); assert.equal(textRestored.statistics.blobWrites, 0, 'restored text metadata reuses the existing chain');
  const orphanBytes = Buffer.from('unreachable workspace blob'), orphanHash = createHash('sha256').update(orphanBytes).digest('hex'), blobDirectory = textRepository.path + '.data/blobs';
  await writeFile(join(blobDirectory, orphanHash), orphanBytes); await writeFile(join(blobDirectory, 'keep-user-note.txt'), 'not a managed blob');
  const rewrittenText = 'independent checkpoint '.repeat(18000);
  await textRepository.saveDocuments({ documents: [{ info: { id: 'text', revision: 35, format: 'markdown', model: { format: 'markdown', text: rewrittenText } }, bytes: new TextEncoder().encode(rewrittenText) }] });
  await textRepository.collectGarbage();
  await assert.rejects(readFile(join(blobDirectory, orphanHash)), { code: 'ENOENT' }); assert.equal(await readFile(join(blobDirectory, 'keep-user-note.txt'), 'utf8'), 'not a managed blob');
  assert.ok(textRepository.statistics.removedBlobs > 0);
  const currentManifest = await readFile(textRepository.path, 'utf8'), rollbackManifest = await readFile(textRepository.path + '.v2.bak', 'utf8');
  await writeFile(textRepository.path, rollbackManifest);
  assert.deepEqual((await new JsonWorkspaceRepository(textRepository.path).load<WorkspaceDocumentSnapshot>())?.documents[0].bytes, finalText.documents[0].bytes, 'rollback manifest and all delta dependencies remain recoverable');
  await writeFile(textRepository.path, currentManifest);
  await textRepository.saveDocuments(initialSource);
  assert.deepEqual((await new JsonWorkspaceRepository(textRepository.path).load<WorkspaceDocumentSnapshot>())?.documents[0].bytes, initialSource.documents[0].bytes, 'a collected weak-cache entry is regenerated rather than treated as a missing known blob');
  await textRepository.saveDocuments(textSnapshot(1));
  const validDeltaManifest = await readFile(textRepository.path, 'utf8'), forged = JSON.parse(validDeltaManifest);
  forged.workspace.documents[0].content.sha256 = '0'.repeat(64); await writeFile(textRepository.path, JSON.stringify(forged));
  await assert.rejects(new JsonWorkspaceRepository(textRepository.path).load(), /WORKSPACE_BLOB_CORRUPT/); await writeFile(textRepository.path, validDeltaManifest);

  const textQueue = new HeldRepository(join(directory, 'text-delta-queue.json'), { maxPendingEntries: 2 });
  const initialText = textQueue.saveDocuments(textSnapshot(0)); await textQueue.entered.promise;
  const queuedText = textQueue.saveDocuments(textSnapshot(1), { mode: 'checkpoint' }), latestText = textQueue.saveDocuments(textSnapshot(2), { mode: 'checkpoint' });
  await assert.rejects(textQueue.saveDocuments(textSnapshot(3)), WorkspacePersistenceBusyError);
  textQueue.release.resolve(); await Promise.all([initialText, queuedText, latestText]);
  assert.deepEqual((await new JsonWorkspaceRepository(textQueue.path).load<WorkspaceDocumentSnapshot>())?.documents[0].bytes, textSnapshot(2).documents[0].bytes, 'coalesced snapshots retain any required unwritten delta base');
  await textQueue.saveDocuments(textSnapshot(3)); assert.deepEqual((await new JsonWorkspaceRepository(textQueue.path).load<WorkspaceDocumentSnapshot>())?.documents[0].bytes, textSnapshot(3).documents[0].bytes);
  const loadedQueue = new JsonWorkspaceRepository(textQueue.path), oldLoadedChain = (await loadedQueue.load<WorkspaceDocumentSnapshot>())!;
  for (const letter of ['x', 'y']) { const text = letter.repeat(300000); await loadedQueue.saveDocuments({ documents: [{ info: { id: 'text', revision: 5, format: 'markdown', model: { format: 'markdown', text } }, bytes: new TextEncoder().encode(text) }] }); }
  const chainGc = loadedQueue.collectGarbage(), pendingLoadedChain = loadedQueue.saveDocuments(oldLoadedChain);
  await Promise.all([chainGc, pendingLoadedChain]);
  assert.deepEqual((await new JsonWorkspaceRepository(loadedQueue.path).load<WorkspaceDocumentSnapshot>())?.documents[0].bytes, oldLoadedChain.documents[0].bytes, 'newly queued restored delta references retain their entire dependency graph during collection');

  const exportRepository = new JsonWorkspaceRepository(join(directory, 'export-source.json')), exportCore = new ViewerCore(exportRepository);
  const exportView = await exportCore.openBytes('legacy-compatible.md', new TextEncoder().encode('legacy compatible content '.repeat(2000)), 'markdown');
  await modify(exportCore, exportView.documentId, { kind: 'text.replace', from: 0, to: 6, expectedText: 'legacy', text: 'latest' });
  const exportPath = join(directory, 'legacy-recovery.json'), originalExportManifest = await readFile(exportRepository.path, 'utf8');
  await exportRepository.exportLegacy(exportPath);
  const legacyExport = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(legacyExport.storageVersion, undefined); assert.equal(typeof legacyExport.documents[0].bytes, 'string'); assert.equal(legacyExport.documents[0].content, undefined); assert.equal(legacyExport.documents[0].model, undefined);
  const legacyCore = new ViewerCore(new JsonWorkspaceRepository(exportPath)); await legacyCore.initialize();
  assert.deepEqual(legacyCore.getDocument(exportView.documentId).info.model, exportCore.getDocument(exportView.documentId).info.model); assert.deepEqual(legacyCore.getDocument(exportView.documentId).bytes, exportCore.getDocument(exportView.documentId).bytes);
  assert.equal(await readFile(exportRepository.path, 'utf8'), originalExportManifest, 'export does not switch the active store');
  await assert.rejects(exportRepository.exportLegacy(exportRepository.path), /WORKSPACE_EXPORT_TARGET_INVALID/);
  await assert.rejects(exportRepository.exportLegacy(exportPath), { code: 'EEXIST' });
  assert.equal(await readFile(exportPath, 'utf8'), JSON.stringify(legacyExport), 'an existing recovery package is never silently replaced');
  const userFile = join(directory, 'user-owned.json'); await writeFile(userFile, 'user content');
  await assert.rejects(exportRepository.exportLegacy(userFile), { code: 'EEXIST' });
  assert.equal(await readFile(userFile, 'utf8'), 'user content');
  class HeldExportRepository extends JsonWorkspaceRepository {
    readonly entered = editGate(); readonly release = editGate(); held = false;
    override async load<T>(): Promise<T | undefined> { if (this.held) { this.held = false; this.entered.resolve(); await this.release.promise; } return super.load<T>(); }
  }
  const exportQueue = new HeldExportRepository(join(directory, 'export-queue.json'));
  await exportQueue.saveDocuments(textSnapshot(0)); exportQueue.held = true;
  const heldExportPath = join(directory, 'held-export.json'), heldExport = exportQueue.exportLegacy(heldExportPath);
  await exportQueue.entered.promise;
  const writesBeforeExport = exportQueue.statistics.written;
  const duringExportA = exportQueue.saveDocuments(document('new-a', 'completely different a')), duringExportB = exportQueue.saveDocuments(document('new-b', 'completely different b')), gcDuringExport = exportQueue.collectGarbage();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(exportQueue.statistics.written, writesBeforeExport, 'the export pins its manifest and blobs by blocking physical writes and GC');
  exportQueue.release.resolve(); await heldExport; await Promise.all([duringExportA, duringExportB, gcDuringExport]);
  const heldLegacy = await new JsonWorkspaceRepository(heldExportPath).load<any>();
  assert.deepEqual(Buffer.from(heldLegacy.documents[0].bytes, 'base64'), Buffer.from(textSnapshot(0).documents[0].bytes), 'the export reads its protected pre-save content');
  assert.deepEqual((await new JsonWorkspaceRepository(exportQueue.path).load<WorkspaceDocumentSnapshot>())?.documents[0].bytes, document('new-b', 'completely different b').documents[0].bytes, 'queued saves resume after export');

  const history = new DocumentHistory<{ documentId: string; bytes: number }>(entry => entry.bytes, 5, 8);
  history.set('a-old', { documentId: 'a', bytes: 3 }); history.set('b', { documentId: 'b', bytes: 3 }); history.set('a-new', { documentId: 'a', bytes: 3 });
  assert.deepEqual([...history.keys()], ['b', 'a-new']); assert.equal(history.retainedBytes, 6);
  history.set('oversized', { documentId: 'a', bytes: 9 }); assert.equal(history.has('oversized'), false);
  history.delete('b'); assert.equal(history.retainedBytes, 3); history.clear(); assert.equal(history.retainedBytes, 0);
  history.set('valid', { documentId: 'a', bytes: 2 }); assert.throws(() => history.set('valid', { documentId: 'a', bytes: NaN }), RangeError); assert.equal(history.retainedBytes, 2);

  const sessions = new DocumentSessions(), entered = editGate(), release = editGate(), order: string[] = [];
  const blocked = sessions.run('a', async () => { order.push('a-first'); entered.resolve(); await release.promise; throw new Error('failed a command'); });
  const rejected = assert.rejects(blocked, /failed a command/), next = sessions.run('a', async () => { order.push('a-next'); return 'recovered'; });
  await entered.promise;
  assert.equal(await sessions.run('b', async () => { order.push('b'); return 'independent'; }), 'independent');
  assert.deepEqual(order, ['a-first', 'b'], 'another document does not wait for the blocked lane');
  release.resolve(); await rejected; assert.equal(await next, 'recovered'); await sessions.drain(); assert.equal(sessions.pendingDocuments, 0);
  assert.deepEqual(order, ['a-first', 'b', 'a-next']);
});

test('落盘与外部冲突使用真实文件，撤销不覆盖后续修改', async () => {
  const { core, directory } = await setup(); const path = join(directory, '原件.md'); await writeFile(path, 'abc'); const view = await core.openFile(path);
  const changed = await modify(core, view.documentId, { kind: 'text.replace', from: 1, to: 2, expectedText: 'b', text: 'B' }); await core.save(view.documentId); assert.equal(await readFile(path, 'utf8'), 'aBc');
  await modify(core, view.documentId, { kind: 'text.replace', from: 3, to: 3, expectedText: '', text: '!' }); await assert.rejects(core.undo(changed.receipt.transactionId), /其他编辑/);
  await assert.rejects(core.reloadFromDisk(view.documentId), /先保存或另存/);
  await writeFile(path, 'external'); await assert.rejects(core.save(view.documentId), /其他程序修改/); assert.equal(await readFile(path, 'utf8'), 'external');
  const copy = join(directory, '副本.md'); await core.save(view.documentId, copy); assert.equal(await readFile(copy, 'utf8'), 'aBc!');
  await assert.rejects(core.save(view.documentId, join(directory, '错误.pdf')), /不能通过改扩展名/);
  await writeFile(copy, 'external copy'); const revision = core.getDocument(view.documentId).info.revision;
  await core.reloadFromDisk(view.documentId);
  assert.equal(core.getDocument(view.documentId).info.revision, revision + 1);
  assert.equal(core.getDocument(view.documentId).info.model.text, 'external copy');
  assert.equal(core.getDocument(view.documentId).info.dirty, false);
  assert.equal(core.transactions.size, 0, 'reload retires undo entries from the old source');
  await core.reloadFromDisk(view.documentId); assert.equal(core.getDocument(view.documentId).info.revision, revision + 1);
});

test('PPTX 阅读和编辑遵循演示文稿的页序，而非 ZIP 文件名', async () => {
  const { core } = await setup(), zip = await JSZip.loadAsync(await blankBytes('pptx'));
  const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
  zip.file('ppt/slides/slide2.xml', slide1.replace('阅读与协作', '第二页内容'));
  zip.file('ppt/presentation.xml', (await zip.file('ppt/presentation.xml')!.async('string')).replace('<p:sldIdLst>', '<p:sldIdLst><p:sldId id="1024" r:id="rIdReordered"/>'));
  zip.file('ppt/_rels/presentation.xml.rels', (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace('</Relationships>', '<Relationship Id="rIdReordered" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'));
  const view = await core.openBytes('reordered.pptx', await zip.generateAsync({ type: 'uint8array' }), 'pptx'), document = core.getDocument(view.documentId);
  assert.equal(document.info.model.slides![0].id, 'ppt/slides/slide2.xml');
  await modify(core, view.documentId, { kind: 'slides.setText', slideId: document.info.model.slides![0].id, shapeId: document.info.model.slides![0].blocks[0].id, text: '实际第一页已编辑' });
  const saved = await JSZip.loadAsync(document.bytes);
  assert.equal(await saved.file('ppt/slides/slide1.xml')!.async('string'), slide1);
  assert.equal(document.info.model.slides![0].blocks[0].text, '实际第一页已编辑');
});

test('任务使用用户固定的快照，继续编辑不会改变提问内容', async () => {
  const { core } = await setup(), view = await core.openBytes('question.md', new TextEncoder().encode('提问时正文'), 'markdown');
  core.updateContext(view.id, { visibleText: '提问时正文', selection: { kind: 'text', text: '提问时' } });
  const snapshot = await core.snapshot(view.id);
  await modify(core, view.documentId, { kind: 'text.replace', from: 0, to: 5, expectedText: '提问时正文', text: '后续修改' });
  let supplied: string | undefined;
  core.drivers.set('test-driver', { id: 'test-driver', capabilities: { streaming: true, cancellation: true, attachExistingSession: false }, async submit(_prompt, frozen, emit) { supplied = frozen.document.model.text; emit('依据固定内容回答'); } });
  const task = await core.submitTask('test-driver', '解释选择', view.id, snapshot.id);
  assert.equal(task.snapshotId, snapshot.id); assert.equal(supplied, '提问时正文');
  const other = core.addView(view.documentId);
  await assert.rejects(core.submitTask('test-driver', '错误目标', other.id, snapshot.id), /其他阅读视图/);
});

test('PDF 增补和新增页面实际落盘，旋转页拒绝不支持的文字坐标', async () => {
  const { core, directory } = await setup();
  const pdfView = await core.openBytes('test.pdf', await blankBytes('pdf'), 'pdf'); const pdf = core.getDocument(pdfView.documentId);
  const original = pdf.bytes.slice(); await modify(core, pdf.info.id, { kind: 'pdf.addText', pageIndex: 0, x: 0.2, y: 0.4, text: 'Persistent note', size: 16 }); await modify(core, pdf.info.id, { kind: 'pdf.addPage' });
  await core.save(pdf.info.id, join(directory, 'test.pdf')); const saved = new Uint8Array(await readFile(join(directory, 'test.pdf'))); assert.equal((await PDFDocument.load(saved)).getPageCount(), 4); assert.notDeepEqual(saved, original);
  await modify(core, pdf.info.id, { kind: 'pdf.rotate', pageIndex: 0, degrees: 90 }); await assert.rejects(modify(core, pdf.info.id, { kind: 'pdf.addText', pageIndex: 0, x: 0.1, y: 0.1, text: 'bad', size: 16 }), /未旋转/);
});

test('外部接口不能伪造界面上下文；不支持能力显式失败', async () => {
  const { core } = await setup(); await assert.rejects(dispatch(core, 'report-context', { viewId: 'x', actor: 'human' }, 'agent'), /伪造/);
  await assert.rejects(dispatch(core, 'browser-input', { viewId: 'x', expectedNavigationId: 'nav', idempotencyKey: 'key', action: { kind: 'click', x: 0, y: 0 } }), /桌面应用/);
  assert.throws(() => browserRequestSchema.parse({ viewId: 'x', expectedNavigationId: 'n', idempotencyKey: 'key', action: { kind: 'click', x: -1, y: 0 } }));
});

test('HTTP 拒绝错误凭据、外部网页 Origin 与角色伪造', async () => {
  const { core, directory } = await setup(); const port = 3299; const runtime = await startServer(core, process.cwd(), directory, port);
  try {
    assert.equal((await fetch(runtime.endpoint + '/api/state')).status, 401);
    assert.equal((await fetch(runtime.endpoint + '/api/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(runtime.endpoint + '/api/state', { headers: { Authorization: 'Bearer ' + runtime.token, Origin: 'https://untrusted.example' } })).status, 403);
    const response = await fetch(runtime.endpoint + '/api/command', { method: 'POST', headers: { Authorization: 'Bearer ' + runtime.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'report-context', args: { viewId: 'x', actor: 'human' } }) }); assert.equal(response.status, 400); assert.match(await response.text(), /AUTH_SCOPE_DENIED/);
    core.browser = {} as never;
    const invalidInput = await fetch(runtime.endpoint + '/v1/browser/input', { method: 'POST', headers: { Authorization: 'Bearer ' + runtime.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ viewId: 'invalid', action: { kind: 'click', x: -1, y: 0 } }) });
    assert.equal(invalidInput.status, 400); assert.match(await invalidInput.text(), /INVALID_ARGUMENT/);
    core.event('qa.sse.before',{});const cursor=core.eventLog.at(-1)!.seq;core.event('qa.sse.after',{});
    const stream=await fetch(runtime.endpoint+'/api/events?after=0',{headers:{Authorization:'Bearer '+runtime.token,'Last-Event-ID':String(cursor)},signal:AbortSignal.timeout(2000)}),reader=stream.body!.getReader();
    let replay='';try{while(!replay.includes('\n\n')){const chunk=await reader.read();if(chunk.done)break;replay+=new TextDecoder().decode(chunk.value);}}finally{await reader.cancel();}
    assert.match(replay,new RegExp('id: '+(cursor+1)+'\\n'));assert.match(replay,/qa\.sse\.after/);assert.doesNotMatch(replay,/qa\.sse\.before/,'SSE reconnect cursor does not replay previously delivered events');
  } finally { await new Promise<void>(resolve => runtime.server.close(() => resolve())); }
});

test('设置验证、持久化和版本号', async () => {
  const { directory } = await setup(), path = join(directory, 'settings.json');
  const settings = new SettingsService(path); await settings.load();
  assert.equal(settings.get('translation.selectionDelayMs'), 500);
  await assert.rejects(settings.set('translation.selectionDelayMs', 50));
  await settings.set('translation.selectionDelayMs', 700);
  const restored = new SettingsService(path); await restored.load();
  assert.equal(restored.get('translation.selectionDelayMs'), 700);
  assert.equal(restored.snapshot().revision, 1);
});

test('结构译文生成独立文件，原始字节与公式保持不变', async () => {
  const { core, directory } = await setup();
  const translator = async (text: string) => '译文:' + text;
  for (const format of ['markdown', 'html', 'docx', 'pptx', 'xlsx'] as const) {
    const bytes = format === 'markdown' ? new TextEncoder().encode('# Heading\n\nBody text\n') : format === 'html' ? new TextEncoder().encode('<h1>Heading</h1><script>doNotTranslate()</script><p>Body text</p>') : await blankBytes(format);
    const source = bytes.slice();
    const result = await translateDocumentBytes(format, bytes, 'zh-CN', translator, new AbortController().signal);
    assert.deepEqual(bytes, source);
    assert.ok(result.units > 0);
    assert.notDeepEqual(result.bytes, source);
    const original = await core.registry.resolve(format).open(source, format), translated = await core.registry.resolve(format).open(result.bytes, format);
    if (format === 'markdown') { assert.match(translated.text!, /^# 译文:Heading/); assert.equal(original.text, '# Heading\n\nBody text\n'); }
    if (format === 'html') { assert.match(translated.text!, /译文:Heading/); assert.match(translated.text!, /doNotTranslate\(\)/); }
    if (format === 'docx') assert.notDeepEqual(translated.blocks?.map(b => b.text), original.blocks?.map(b => b.text));
    if (format === 'pptx') assert.notDeepEqual(translated.slides?.map(s => s.blocks.map(b => b.text)), original.slides?.map(s => s.blocks.map(b => b.text)));
    if (format === 'xlsx') { assert.equal(translated.sheets?.[0].rows[7][2].formula, original.sheets?.[0].rows[7][2].formula); assert.notEqual(translated.sheets?.[0].rows[0][0].value, original.sheets?.[0].rows[0][0].value); }
  }
  const view = await core.openBytes('source.md', new TextEncoder().encode('# Source\nText'), 'markdown');
  const sourceId = view.documentId, before = core.getDocument(sourceId).bytes.slice(), active = core.activeViewId;
  const service = new DocumentTranslationService(core, join(directory, 'translations'), async text => '译文:' + text, 'test');
  const job = await service.start(sourceId, 'zh-CN');
  for (let i = 0; i < 100 && service.jobs.get(job.id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.jobs.get(job.id)?.status, 'completed');
  const artifact = service.jobs.get(job.id)!.artifact!;
  assert.notEqual(artifact.documentId, sourceId); assert.equal(core.activeViewId, active);
  assert.deepEqual(core.getDocument(sourceId).bytes, before);
  assert.match(await readFile(artifact.path, 'utf8'), /译文:/);
  const restored = new DocumentTranslationService(core, join(directory, 'translations'), async text => text); await restored.load();
  assert.equal(restored.artifacts.size, 1);
});

test('全文翻译从冻结快照和已完成片段继续，不读取之后的原文修改', async () => {
  const { core, directory } = await setup(), root = join(directory, 'translations');
  const view = await core.openBytes('resume.md', new TextEncoder().encode('First line\nSecond line'), 'markdown');
  let calls = 0;
  const first = new DocumentTranslationService(core, root, async (_text, _language, signal) => { calls++; if (calls === 1) return '第一行'; await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); return ''; });
  const job = await first.start(view.documentId, 'zh-CN');
  const checkpoint = join(root, 'checkpoints', job.id + '.json');
  for (let i = 0; i < 100; i++) { const saved = JSON.parse(await readFile(checkpoint, 'utf8')) as { segments: string[] }; if (saved.segments.length === 1) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  first.cancel(job.id);
  for (let i = 0; i < 100 && first.jobs.get(job.id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(first.jobs.get(job.id)?.status, 'cancelled');
  await modify(core, view.documentId, { kind: 'text.replace', from: 0, to: 5, expectedText: 'First', text: 'Changed' });
  const mismatched = new DocumentTranslationService(core, root, async text => text, 'codex', undefined, () => ({ fingerprint: 'another-model', model: 'another-model', translate: async text => text }));
  await mismatched.load();
  await assert.rejects(mismatched.resume(job.id), /模型配置已变化/);
  let resumedCalls = 0;
  const second = new DocumentTranslationService(core, root, async text => { resumedCalls++; return '译:' + text; }); await second.load();
  assert.equal(second.jobs.get(job.id)?.status, 'paused'); await second.resume(job.id);
  for (let i = 0; i < 100 && second.jobs.get(job.id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(second.jobs.get(job.id)?.status, 'completed'); assert.equal(resumedCalls, 1);
  const result = await readFile(second.jobs.get(job.id)!.artifact!.path, 'utf8');
  assert.match(result, /第一行/); assert.match(result, /译:Second line/); assert.doesNotMatch(result, /Changed/);
});

test('运行中的全文翻译固定发起时的模型配置', async () => {
  const { core, directory } = await setup();
  const view = await core.openBytes('profile.md', new TextEncoder().encode('Alpha\nBeta'), 'markdown');
  let selected = 'model-a';
  const used: string[] = [];
  const service = new DocumentTranslationService(core, join(directory, 'translations'), async text => text, 'test', undefined, () => {
    const fixed = selected;
    return { fingerprint: fixed, model: fixed, translate: async text => { used.push(fixed); selected = 'model-b'; return fixed + ':' + text; } };
  });
  const job = await service.start(view.documentId, 'zh-CN');
  for (let i = 0; i < 100 && service.jobs.get(job.id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.jobs.get(job.id)?.status, 'completed');
  assert.deepEqual(used, ['model-a', 'model-a']);
  assert.equal(service.jobs.get(job.id)?.artifact?.model, 'model-a');
});

test('用户可按视图暂停或停止 Agent，用户编辑仍可继续', async () => {
  const { core } = await setup(); const view = await core.openBytes('control.md', new TextEncoder().encode('hello'), 'markdown');
  const patch = core.prepare(view.documentId, 0, { kind: 'text.replace', from: 0, to: 5, expectedText: 'hello', text: 'world' });
  core.setAgentControl(view.id, 'paused');
  await assert.rejects(core.commit(patch.id, 'agent-attempt', 'agent'), /暂停或停止/);
  await assert.rejects(dispatch(core, 'agent-control', { viewId: view.id, status: 'running' }, 'agent'), /仅用户/);
  const human = await core.commit(patch.id, 'human-edit', 'human'); assert.equal(human.status, 'applied');
  await assert.rejects(core.undo(human.transactionId), /暂停或停止/);
  core.setAgentControl(view.id, 'running');
  const next = core.prepare(view.documentId, 1, { kind: 'text.replace', from: 0, to: 5, expectedText: 'world', text: 'again' });
  const resumed = await core.commit(next.id, 'agent-resumed', 'agent'); assert.equal(resumed.status, 'applied');
  const entered = editGate(), gate = editGate();
  core.extensions.set('before-agent-edit', async () => { entered.resolve(); await gate.promise; });
  const undoing = core.undo(resumed.transactionId), rejected = assert.rejects(undoing, /暂停或停止/);
  await entered.promise; core.setAgentControl(view.id, 'stopped'); gate.resolve(); await rejected;
  await core.undo(resumed.transactionId, 'human'); assert.equal(core.getDocument(view.documentId).info.model.text, 'world');
});

test('选区工具保留快照与幂等：Markdown/HTML 格式、批注持久化且不写原文', async () => {
  const [{ markdown, markdownLanguage }, { TreeFragment }, { BoundedMarkdownParser }, { typoraMarkdownSyntax }] = await Promise.all([
    import('@codemirror/lang-markdown'), import('@lezer/common'),
    import('../apps/desktop/src/renderer/lib/markdown-language'), import('../apps/desktop/src/renderer/lib/markdown-syntax'),
  ]);
  const parser = markdown({ base: markdownLanguage, extensions: [typoraMarkdownSyntax] }).language.parser;
  const longParagraph = '# Heading\n\n' + 'plain 中文 😀 '.repeat(8000), inserted = '**bold**', changed = longParagraph + inserted;
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(parser.parse(longParagraph)), [{ fromA: longParagraph.length, toA: longParagraph.length, fromB: longParagraph.length, toB: changed.length }]);
  let inputReads = 0;
  const parsed = new BoundedMarkdownParser(parser).parse({ length: changed.length, lineChunks: false, chunk: from => changed.slice(from), read: (from, to) => { inputReads++; return changed.slice(from, to); } }, fragments);
  assert.equal(parsed.length, changed.length);
  assert.equal(parsed.toString(), parser.parse(changed).toString(), 'a changed long paragraph retains the complete grammar and formatting');
  assert.ok(inputReads < 4096, 'fragment reuse must not search a huge line with per-character input reads');
  const {core,directory}=await setup();const view=await core.openBytes('selection.md',new TextEncoder().encode('one target two'),'markdown');
  core.updateContext(view.id,{selection:{kind:'text',text:'target',locator:{kind:'source-range',from:4,to:10}}});
  const tools=await dispatch(core,'selection-tools',{viewId:view.id}) as any;
  const bytes=core.getDocument(view.documentId).bytes.slice();
  const note=await dispatch(core,'selection-action',{snapshotId:tools.snapshot.id,action:'note',value:'test note',idempotencyKey:'note-1'}) as any;
  assert.deepEqual(core.getDocument(view.documentId).bytes,bytes);
  const args={snapshotId:tools.snapshot.id,action:'bold',idempotencyKey:'bold-1'};
  const [a,b]=await Promise.all([dispatch(core,'selection-action',args),dispatch(core,'selection-action',args)]);assert.deepEqual(a,b);
  assert.equal(core.getDocument(view.documentId).info.model.text,'one **target** two');
  await assert.rejects(dispatch(core,'selection-action',{...args,idempotencyKey:'stale'}),/选区所属内容已变化/);
  const restarted=new ViewerCore(new JsonWorkspaceRepository(join(directory,'workspace.json')));await restarted.initialize();assert.equal(restarted.annotations.get(note.annotation.id)?.text,'test note');
  assert.deepEqual(await dispatch(restarted,'selection-action',args),a,'selection receipts retain their compact fingerprint across restart without needing an ephemeral snapshot');
  const html=await core.openBytes('safe.html',new TextEncoder().encode('<p title="target">safe text</p>'),'html');
  core.updateContext(html.id,{selection:{kind:'text',text:'target',locator:{kind:'source-range',from:10,to:16}}});
  const unsafe=await core.snapshot(html.id);await assert.rejects(dispatch(core,'selection-action',{snapshotId:unsafe.id,action:'bold',idempotencyKey:'html-attr'}),/HTML 标签或属性/);
  core.updateContext(html.id,{selection:{kind:'text',text:'safe text'}});const safe=await core.snapshot(html.id);await dispatch(core,'selection-action',{snapshotId:safe.id,action:'italic',idempotencyKey:'html-safe'});assert.match(core.getDocument(html.documentId).info.model.text!,/<em>safe text<\/em>/);
  const textCore=new ViewerCore({load:async<T>()=>undefined as T|undefined,save:async()=>{}}),outside='unselected body '.repeat(Math.ceil(10*1024*1024/16)),selectedText='chosen range';
  const largeView=await textCore.openBytes('large-selection.md',new TextEncoder().encode(outside+selectedText),'markdown'),from=outside.length,to=from+selectedText.length;
  const textSelection={kind:'text' as const,text:selectedText,locator:{kind:'source-range',from,to},rect:{x:10,y:20,width:120,height:24}};
  textCore.updateContext(largeView.id,{visibleText:'unrelated viewport text',selection:textSelection,locator:{kind:'source-range',from:0,to:outside.length,quote:'unrelated viewport quote'}});
  let aiSource:any;textCore.extensions.set('selection-ai',async input=>{aiSource=input;return {task:{id:'selection-ai-task'}};});
  const snapshotCount=textCore.snapshots.size,light=await dispatch(textCore,'selection-tools',{viewId:largeView.id,lightweight:true,expected:{kind:'text-selection',revision:0,selection:textSelection}})as any;
  assert.equal(light.snapshot.kind,'selection-context');assert.equal('model' in light.snapshot.document,false);assert.equal(light.snapshot.context.visibleText,'');assert.deepEqual(light.snapshot.context.locator,textSelection.locator);
  assert.ok(JSON.stringify(light).length<8000,'a small selection from a 10 MiB document never serializes the document body or unrelated viewport');assert.equal(textCore.snapshots.size,snapshotCount);
  const fullDefault=await dispatch(textCore,'selection-tools',{viewId:largeView.id})as any;assert.equal(fullDefault.snapshot.document.model.text,outside+selectedText,'the default SDK snapshot remains complete');
  await assert.rejects(dispatch(textCore,'selection-tools',{viewId:largeView.id,lightweight:true,expected:{kind:'text-selection',revision:1,selection:textSelection}}),/版本/);
  await assert.rejects(dispatch(textCore,'selection-tools',{viewId:largeView.id,lightweight:true,expected:{kind:'text-selection',revision:0,selection:{...textSelection,locator:{kind:'source-range',from:0,to:selectedText.length}}}}),/选区/);
  textCore.updateContext(largeView.id,{selection:{...textSelection,locator:{kind:'source-range',from:0,to:selectedText.length}}});
  await assert.rejects(dispatch(textCore,'selection-tools',{viewId:largeView.id,lightweight:true}),/源码范围/,'a reported range must match the actual current source, not only the caller lease');
  textCore.updateContext(largeView.id,{selection:textSelection});
  const selectionArgs={selectionContextId:light.snapshot.id,action:'copy',idempotencyKey:'text-light-copy'};
  assert.deepEqual(await dispatch(textCore,'selection-action',selectionArgs),{text:selectedText});
  const originalRepositorySave=textCore.repository.save;let failSelectionPersist=true;
  textCore.repository.save=async()=>{if(failSelectionPersist){failSelectionPersist=false;throw new Error('selection recovery failed');}};
  const recoveryCopy={...selectionArgs,idempotencyKey:'text-light-recovery'};
  await assert.rejects(dispatch(textCore,'selection-action',recoveryCopy),/selection recovery failed/);assert.ok(textCore.lastPersistenceError);
  assert.deepEqual(await dispatch(textCore,'selection-action',recoveryCopy),{text:selectedText});assert.equal(textCore.lastPersistenceError,undefined);textCore.repository.save=originalRepositorySave;
  const replayCore=new ViewerCore({load:async<T>()=>({schemaVersion:textCore.state().protocolVersion,documents:[],views:[],receipts:[...textCore.receipts]}as T),save:async()=>{}});await replayCore.initialize();
  assert.deepEqual(await dispatch(replayCore,'selection-action',selectionArgs),{text:selectedText},'lightweight selection copy replays after restart even though its context is ephemeral');
  const largeBytes=textCore.getDocument(largeView.documentId).bytes,lightNote=await dispatch(textCore,'selection-action',{...selectionArgs,action:'note',value:'selected note',idempotencyKey:'text-light-note'})as any;
  assert.equal(lightNote.annotation.selection.text,selectedText);assert.equal(textCore.getDocument(largeView.documentId).bytes,largeBytes,'lightweight annotations preserve the source buffer');
  await dispatch(textCore,'selection-action',{...selectionArgs,action:'ask',value:'explain',idempotencyKey:'text-light-ai'});
  assert.equal(aiSource.frozenSource.sourceScope,'selection');assert.equal(aiSource.frozenSource.document.model.text,selectedText);assert.equal(aiSource.frozenSource.context.visibleText,'');assert.ok(JSON.stringify(aiSource).length<8000);
  textCore.updateContext(largeView.id,{selection:{...textSelection,rect:{x:50,y:40,width:120,height:24}}});
  assert.deepEqual(await dispatch(textCore,'selection-action',{...selectionArgs,idempotencyKey:'text-light-copy-geometry'}),{text:selectedText},'geometry changes do not invalidate a matching source range');
  textCore.updateContext(largeView.id,{selection:{kind:'text',text:'unselected',locator:{kind:'source-range',from:0,to:10}}});
  await assert.rejects(dispatch(textCore,'selection-action',{...selectionArgs,action:'note',value:'stale',idempotencyKey:'text-light-stale-range'}),/选区/);
  assert.deepEqual(await dispatch(textCore,'selection-action',{...selectionArgs,idempotencyKey:'text-light-frozen-copy'}),{text:selectedText},'a new copy request uses its frozen range after the live selection changes');
  await dispatch(textCore,'selection-action',{...selectionArgs,action:'ask',value:'frozen question',idempotencyKey:'text-light-frozen-ai'});assert.equal(aiSource.frozenSource.document.model.text,selectedText);assert.equal(aiSource.frozenSource.document.revision,0);
  textCore.updateContext(largeView.id,{selection:textSelection});
  const lightEdit=await dispatch(textCore,'selection-action',{...selectionArgs,action:'bold',idempotencyKey:'text-light-bold'})as any;
  assert.equal(textCore.getDocument(largeView.documentId).info.model.text,outside+'**'+selectedText+'**');assert.equal(lightEdit.receipt.status,'applied');assert.ok(JSON.stringify(lightEdit).length<8000);
  await assert.rejects(dispatch(textCore,'selection-action',{...selectionArgs,action:'note',value:'stale',idempotencyKey:'text-light-stale-revision'}),/版本/);
  assert.deepEqual(await dispatch(textCore,'selection-action',{...selectionArgs,idempotencyKey:'text-light-copy-after-edit'}),{text:selectedText});
  const frozenCitation=await dispatch(textCore,'selection-action',{...selectionArgs,action:'citation',idempotencyKey:'text-light-citation-after-edit'})as{text:string};assert.match(frozenCitation.text,/chosen range/);
  await dispatch(textCore,'selection-action',{...selectionArgs,action:'ask',value:'old source',idempotencyKey:'text-light-ai-after-edit'});assert.equal(aiSource.frozenSource.document.model.text,selectedText);assert.equal(aiSource.frozenSource.document.revision,0);assert.equal(aiSource.frozenSource.context.contentRevision,0,'AI retains the selected source revision instead of relabeling old text as the latest document');
  assert.deepEqual(await dispatch(textCore,'selection-action',selectionArgs),{text:selectedText},'a completed retry retains its original selected receipt');
  const lightHtml=await textCore.openBytes('light.html',new TextEncoder().encode('<p title="target">safe text &amp; more</p>'),'html');
  textCore.updateContext(lightHtml.id,{selection:{kind:'text',text:'target',locator:{kind:'source-range',from:10,to:16}}});
  const lightAttribute=await dispatch(textCore,'selection-tools',{viewId:lightHtml.id,lightweight:true})as any;
  await assert.rejects(dispatch(textCore,'selection-action',{selectionContextId:lightAttribute.snapshot.id,action:'bold',idempotencyKey:'light-html-attribute'}),/HTML 标签或属性/);
  textCore.updateContext(lightHtml.id,{selection:{kind:'text',text:'safe text & more',locator:{kind:'html-text-quote',quote:'safe text & more'}}});
  const quotedHtml=await dispatch(textCore,'selection-tools',{viewId:lightHtml.id,lightweight:true})as any;
  assert.deepEqual(await dispatch(textCore,'selection-action',{selectionContextId:quotedHtml.snapshot.id,action:'copy',idempotencyKey:'light-html-quote'}),{text:'safe text & more'});
  textCore.updateContext(lightHtml.id,{selection:{kind:'text',text:'safe text',locator:{kind:'source-range',from:18,to:27}}});
  const editableHtml=await dispatch(textCore,'selection-tools',{viewId:lightHtml.id,lightweight:true})as any;
  await dispatch(textCore,'selection-action',{selectionContextId:editableHtml.snapshot.id,action:'bold',idempotencyKey:'light-html-bold'});
  assert.match(textCore.getDocument(lightHtml.documentId).info.model.text!,/<strong>safe text<\/strong>/);
  const nativeCore=new ViewerCore({load:async<T>()=>undefined as T|undefined,save:async()=>{}});await nativeCore.initialize();
  const ppt=await nativeCore.openBytes('selection.pptx',await blankBytes('pptx'),'pptx');let native:NativeOfficeState,reads=0,inspections=0,exports=0;
  const importEntered=editGate(),importRelease=editGate();
  const driver:NativeOfficeDriver={
    open:async input=>{importEntered.resolve();await importRelease.promise;return native={sessionId:'selection-session',documentId:input.documentId,viewId:input.viewId,format:'pptx',engineEpoch:'selection-engine',engineRevision:0,selectionEpoch:1,status:'ready',dirty:false,pendingInput:true,inputState:{composing:false,inFlight:false,editing:'text',modal:false},visible:true,nativeGeometry:true,actor:'human',selection:{kind:'text',text:'selected text',rect:{x:20,y:20,width:100,height:24}},viewport:{width:800,height:600,deviceScaleFactor:1,bounds:{x:0,y:0,width:800,height:600},screenBounds:{x:0,y:0,width:800,height:600}},selectionActions:['bold'],visibleTextReady:true,visibleTextSource:'actual-model-projection',visibleText:'selected text'};},
    state:async()=>{reads++;return structuredClone(native);},snapshot:async()=>{exports++;throw new Error('selection must not export the complete file');},commands:async()=>[],query:async()=>{throw new Error('atomic inspect expected');},inspect:async()=>{inspections++;return {state:structuredClone(native),data:{targetKind:'text',fields:{bold:{value:false,state:'direct',available:true}}}};},execute:async()=>({status:'no-change',state:structuredClone(native)}),undo:async()=>({status:'no-change',state:structuredClone(native)}),close:async()=>{},
  };
  nativeCore.registerNativeOfficeDriver(driver);
  await assert.rejects(nativeCore.nativeOfficeState(ppt.id),{code:'NATIVE_NOT_READY'},'a first status read does not claim an unopened page is an expired session');
  const opening=nativeCore.openNativeOffice(ppt.id,{deferInitialMirror:true});await importEntered.promise;
  let statusSettled=false;const openingStatus=nativeCore.nativeOfficeState(ppt.id).then(value=>{statusSettled=true;return value;});
  await Promise.resolve();assert.equal(statusSettled,false,'status joins the existing import instead of failing or starting a second writer');
  importRelease.resolve();await opening;assert.equal((await openingStatus).sessionId,'selection-session');
  assert.equal(nativeOfficeInteractionBlocked(native!),false,'normal Outliner text editing does not block selection or formatting');
  assert.notEqual(nativeOfficeStatusKey(native!),nativeOfficeStatusKey({...native!,inputState:{...native!.inputState!,editing:'none'}}),'entering native text editing invalidates the inspector even before a text range is selected');
  const baseline=reads,lease={sessionId:native!.sessionId,engineEpoch:native!.engineEpoch,engineRevision:0,selectionEpoch:1};
  const lightweight=await dispatch(nativeCore,'selection-context',{viewId:ppt.id,expected:lease}) as any;
  assert.equal('model' in lightweight.selectionContext.document,false);assert.equal(lightweight.selectionContext.context.selection.text,'selected text');assert.equal(reads,baseline);assert.equal(exports,0);
  await dispatch(nativeCore,'office-query',{viewId:ppt.id,target:{kind:'style',target:'text'}});assert.equal(inspections,1);assert.equal(reads,baseline,'atomic inspection does not surround its result with extra state RPCs');
  const selected={selectionContextId:lightweight.selectionContext.id,action:'copy',idempotencyKey:'native-copy'};
  assert.deepEqual(await dispatch(nativeCore,'selection-action',selected),{text:'selected text'});assert.equal(exports,0);
  native!.selectionEpoch=2;nativeCore.updateNativeOfficeState(native!);
  await assert.rejects(dispatch(nativeCore,'selection-context',{viewId:ppt.id,expected:lease}),/选区已变化/);
  await assert.rejects(dispatch(nativeCore,'selection-action',{...selected,action:'bold',idempotencyKey:'native-stale'}),/选区已变化/);
  assert.deepEqual(await dispatch(nativeCore,'selection-action',selected),{text:'selected text'},'completed copy retry retains its original receipt');
  let surface:OfficeSurfaceState={...native!,surfaceKind:'tiled',viewId:ppt.id,sizeTwips:{width:10000,height:7500},parts:[{index:0,name:'slide'}],partIndex:0,layoutRevision:1,renderGeneration:1,eventSequence:1,selectionRects:[]};const posted:any[]=[];
  const inputController=new OfficeSurfaceInputController(ppt.id,{state:()=>surface,beforeInput:async()=>{},accept:state=>{surface=state;},request:async<T>(_method:string,args?:Record<string,unknown>)=>{posted.push(args!.event);return {state:surface,streamId:args!.streamId,ackSequence:args!.sequence,composing:false} as T;}});
  await flushOfficeSurfaceDraft(inputController,surface,undefined,async()=>{throw new Error('selection-preserving toolbar must not checkpoint');},{preserveSelection:true});assert.equal(posted.length,0);
  assert.equal(await inputController.history('undo'),true);assert.deepEqual(posted.map(event=>[event.kind,event.phase,event.key,event.modifiers.control]),[['key','down','z',true],['key','up','z',true]],'Outliner undo uses the actual ordered native input stream without consuming document undo history');
  surface={...surface,inputState:{...surface.inputState!,composing:true}};await assert.rejects(inputController.history('undo'),/中文输入/);assert.equal(posted.length,2);
  const initialNotReady=new Error('NATIVE_NOT_READY: 尚未加载'),expired=new Error('NATIVE_SESSION_EXPIRED: 已关闭');
  let readError:Error=initialNotReady,nextPoll:(()=>void)|undefined;const observerErrors:unknown[]=[],observed:NativeOfficeState[]=[];
  const observer=createNativeOfficeStateObserver(async<T>(method:string)=>{assert.equal(method,'office-status');throw readError;},{now:()=>0,visible:()=>true,setTimer:callback=>{nextPoll=callback;return callback;},clearTimer:timer=>{if(nextPoll===timer)nextPoll=undefined;}});
  const unsubscribe=observer.subscribe(ppt.id,ppt.documentId,{state:value=>observed.push(value),error:cause=>observerErrors.push(cause)});
  const settleRead=()=>new Promise<void>(resolve=>setImmediate(resolve));await settleRead();assert.equal(observerErrors.length,0,'only an initial not-ready read stays in loading');
  readError=expired;nextPoll!();await settleRead();assert.deepEqual(observerErrors,[expired],'session expiry is visible even before a first successful read');
  observer.receive({action:'office-state',state:native!});assert.equal(observed.length,1);
  readError=initialNotReady;nextPoll!();await settleRead();assert.deepEqual(observerErrors,[expired,initialNotReady],'a previously bound page cannot hide not-ready as initial loading');
  unsubscribe();
  const readKeys={poll:'view',catalog:'',status:'',navigation:''},initialReadError=updateNativeOfficeReadErrors({},{kind:'poll',key:'view',outcome:'failure',cause:initialNotReady});
  assert.deepEqual(nativeOfficeReadMessages(initialReadError,readKeys,true),[]);
  assert.deepEqual(nativeOfficeReadMessages(updateNativeOfficeReadErrors({},{kind:'poll',key:'view',outcome:'failure',cause:expired}),readKeys,true),[expired.message]);
});

test('Word 和 PPT 选区字体格式拆分文字 run，保留其他文字并可保存重开', async()=>{
  const {core}=await setup();for(const format of ['docx','pptx'] as const){
    const view=await core.openBytes('sample.'+format,await blankBytes(format),format);let doc=core.getDocument(view.documentId).info;
    const block=format==='docx'?doc.model.blocks![0]:doc.model.slides![0].blocks[0],slide=doc.model.slides?.[0];
    await modify(core,doc.id,format==='docx'?{kind:'word.setBlock',blockId:block.id,text:'before target after'}:{kind:'slides.setText',slideId:slide!.id,shapeId:block.id,text:'before target after'});
    core.updateContext(view.id,{selection:{kind:'text',text:'target',locator:{kind:'text',blockId:format==='docx'?block.id:undefined,shapeId:format==='pptx'?block.id:undefined,slideId:slide?.id,from:7,to:13}}});const snapshot=await core.snapshot(view.id);
    await dispatch(core,'selection-action',{snapshotId:snapshot.id,action:'bold',idempotencyKey:format+'-bold'});doc=core.getDocument(view.documentId).info;
    const updated=format==='docx'?doc.model.blocks![0]:doc.model.slides![0].blocks[0];assert.equal(updated.text,'before target after');assert.deepEqual(updated.runs?.map(r=>[r.text,!!r.bold]),[['before ',false],['target',true],[' after',false]]);
  }
});

test('PDF 逐行标记包含旋转页；Excel 格式工具保留公式', async()=>{
  const {core}=await setup();const pdf=await core.openBytes('selection.pdf',await blankBytes('pdf'),'pdf');await modify(core,pdf.documentId,{kind:'pdf.rotate',pageIndex:0,degrees:90});
  core.updateContext(pdf.id,{selection:{kind:'text',text:'sample',pageRects:[{pageIndex:0,x:.1,y:.2,width:.3,height:.02},{pageIndex:0,x:.1,y:.23,width:.2,height:.02}]}});const snapshot=await core.snapshot(pdf.id);
  await dispatch(core,'selection-action',{snapshotId:snapshot.id,action:'underline',idempotencyKey:'pdf-lines'});const reopened=await PDFDocument.load(core.getDocument(pdf.documentId).bytes);assert.equal(reopened.getPages()[0].getRotation().angle,90);
  const xlsx=await core.openBytes('cells.xlsx',await blankBytes('xlsx'),'xlsx');const sheet=core.getDocument(xlsx.documentId).info.model.sheets![0];await modify(core,xlsx.documentId,{kind:'sheets.setCell',sheetId:sheet.id,address:'A1',value:'',formula:'SUM(B1:B2)'});
  core.updateContext(xlsx.id,{selection:{kind:'cells',text:'=SUM(B1:B2)',locator:{kind:'cell',sheetId:sheet.id,cell:'A1'}}});const wasBold=!!core.getDocument(xlsx.documentId).info.model.sheets![0].rows[0][0].bold;const cellSnapshot=await core.snapshot(xlsx.id);await dispatch(core,'selection-action',{snapshotId:cellSnapshot.id,action:'bold',idempotencyKey:'cell-bold'});
  const cell=core.getDocument(xlsx.documentId).info.model.sheets![0].rows[0][0];assert.equal(!!cell.bold,!wasBold);assert.equal(cell.formula,'SUM(B1:B2)');
});


test('Markdown 图片批处理绑定版本；文件树的移动与回收可撤销', async () => {
  const {core,directory}=await setup(), root=join(directory,'notes'); await mkdir(root);
  const path=join(root,'source.md');await writeFile(path,'# Source\n');const view=await core.openFile(path);
  const dataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eFQAAAAASUVORK5CYII=';
  const imported=await dispatch(core,'markdown-import-image',{documentId:view.documentId,name:'截图.png',mimeType:'image/png',dataUrl},'human') as {path:string};
  assert.match(imported.path,/^assets\//);assert.match((await dispatch(core,'markdown-resource',{documentId:view.documentId,path:imported.path}) as {url:string}).url,/^data:image\/png;base64,/);
  await writeFile(join(directory,'outside.png'),Buffer.from(dataUrl.split(',')[1],'base64'));
  await assert.rejects(dispatch(core,'markdown-resource',{documentId:view.documentId,path:'../outside.png'}),/超出/);
  const text='# Source\n![image]('+imported.path+')\n\n'+String.fromCharCode(96,96,96)+'md\n![literal](not-a-resource.png)\n'+String.fromCharCode(96,96,96)+'\n';
  await modify(core,view.documentId,{kind:'text.replace',from:0,to:9,expectedText:'# Source\n',text});
  const listed=await dispatch(core,'markdown-resources-list',{documentId:view.documentId}) as {revision:number;resources:{source:string}[]};assert.equal(listed.resources.length,1);
  const embedded=await dispatch(core,'markdown-resources-apply',{documentId:view.documentId,expectedRevision:listed.revision,action:'embed',sources:[imported.path]},'human') as {revision:number};
  assert.equal(embedded.revision,listed.revision+1);assert.match(core.getDocument(view.documentId).info.model.text!,/!\[image\]\(<?data:image\/png;base64,/);
  await assert.rejects(dispatch(core,'markdown-resources-apply',{documentId:view.documentId,expectedRevision:listed.revision,action:'embed',sources:[imported.path]},'human'),/过期/);
  await core.save(view.documentId);
  const workspace=new MarkdownWorkspace(core,directory);core.extensions.set('markdown-workspace-root',async args=>workspace.resourceRoot(String(args.documentId)));await workspace.change({documentId:view.documentId,action:'new-file',path:'child.md'});
  await writeFile(join(root,'child.md'),'unique workspace phrase');
  const moved=await workspace.change({documentId:view.documentId,action:'rename',path:'child.md',destination:'renamed.md'});assert.equal(await readFile(moved.uri!,'utf8'),'unique workspace phrase');
  const search=await workspace.search(view.documentId,'workspace phrase');assert.equal(search.results[0].line,1);assert.equal(search.results[0].path,'renamed.md');
  const trashed=await workspace.change({documentId:view.documentId,action:'trash',path:'renamed.md'});assert.equal((await workspace.list(view.documentId)).entries.some(entry=>entry.name==='renamed.md'),false);
  await workspace.change({documentId:view.documentId,action:'undo',transactionId:trashed.transactionId});assert.equal(await readFile(join(root,'renamed.md'),'utf8'),'unique workspace phrase');
  await writeFile(join(root,'a#b%.png'),Buffer.from(dataUrl.split(',')[1],'base64'));
  const linked='# Move\n\n![resource]('+imported.path+')\n![special](a%23b%25.png?color=1#sample)\n[peer](source.md#source)\n\n```md\n![literal](keep.png)\n```\n';
  await writeFile(join(root,'linked.mdown'),linked);const linkedView=await core.openFile(join(root,'linked.mdown'));
  await workspace.change({documentId:view.documentId,action:'new-folder',path:'nested'});
  const relocated=await workspace.change({documentId:view.documentId,action:'move',path:'linked.mdown',destination:'nested/linked.mdown'});
  assert.equal(core.getDocument(linkedView.documentId).info.path,relocated.uri);
  assert.equal(core.getDocument(linkedView.documentId).info.title,'linked.mdown');
  const relocatedText=await readFile(relocated.uri!,'utf8');assert.match(relocatedText,/\.\.\/assets\//);assert.match(relocatedText,/\.\.\/source\.md#source/);assert.match(relocatedText,/!\[literal\]\(keep.png\)/);
  assert.match(relocatedText,/\.\.\/a%23b%25\.png\?color=1#sample/);assert.equal((await dispatch(core,'markdown-resource',{documentId:linkedView.documentId,path:'../a%23b%25.png?color=1#sample'}) as {url:string}).url,dataUrl);
  await workspace.change({documentId:view.documentId,action:'undo',transactionId:relocated.transactionId});assert.match(await readFile(join(root,'linked.mdown'),'utf8'),/<assets\//);
  await workspace.change({documentId:view.documentId,action:'rename',path:'linked.mdown',destination:'title.txt'});assert.equal(core.getDocument(linkedView.documentId).info.title,'title.txt');
  const large=join(root,'large.txt');await writeFile(large,'x'.repeat(16*1024*1024+17)+'\nBeyondOldSizeLimit');
  const largeSearch=await workspace.search(view.documentId,'BeyondOldSizeLimit');assert.equal(largeSearch.results[0]?.path,'large.txt');assert.equal(largeSearch.results[0]?.line,2);assert.equal(largeSearch.limitReached,false);
  const unsaved=await core.openBytes('unsaved.md',new TextEncoder().encode('# Pending\n'),'markdown');
  const temporary=await dispatch(core,'markdown-import-image',{documentId:unsaved.documentId,name:'pending.png',mimeType:'image/png',dataUrl},'human') as {path:string};
  assert.match(temporary.path,/^agentviewer-asset:\/\//);assert.ok(temporary.path.length<200,'unsaved images do not become multi-megabyte source lines');
  const pendingSource='# Pending\n\n![pending](<'+temporary.path+'>)\n<img src="'+temporary.path+'" alt="pending">\n\n```md\n![literal]('+temporary.path+')\n```\n';
  await modify(core,unsaved.documentId,{kind:'text.replace',from:0,to:10,expectedText:'# Pending\n',text:pendingSource});
  const recovered=new ViewerCore(new JsonWorkspaceRepository(join(directory,'workspace.json')));await recovered.initialize();
  assert.equal((await dispatch(recovered,'markdown-resource',{documentId:unsaved.documentId,path:temporary.path}) as {url:string}).url,dataUrl,'profile assets survive recovery');
  const output=join(directory,'saved-image.md');await core.save(unsaved.documentId,output);
  const savedImageSource=await readFile(output,'utf8'), savedImages=markdownLinks(savedImageSource).filter(link=>link.image);
  assert.equal(savedImages.length,2);assert.ok(savedImages.every(link=>link.source.startsWith('assets/')));assert.ok(savedImageSource.includes('![literal]('+temporary.path+')'),'save does not rewrite code examples');
  for(const link of savedImages)assert.equal((await dispatch(core,'markdown-resource',{documentId:unsaved.documentId,path:link.source}) as {url:string}).url,dataUrl);
  const savedCopy=join(directory,'other-folder','copy.md');await core.save(unsaved.documentId,savedCopy);
  for(const link of markdownLinks(await readFile(savedCopy,'utf8')).filter(link=>link.image))assert.equal((await dispatch(core,'markdown-resource',{documentId:unsaved.documentId,path:link.source}) as {url:string}).url,dataUrl,'Save As copies local images to the new resource directory');
  const html='<img src="assets/a.png?x=1&amp;y=2"><!-- <img src="comment.png"> --><script>const x="<img src=\'script.png\'>"</script>\n';
  const htmlLinks=markdownLinks(html);assert.equal(htmlLinks.length,1);assert.equal(htmlLinks[0].source,'assets/a.png?x=1&y=2');
  const address='https://example.test/image name.png?x="quoted"&value=2', encoded=replaceMarkdownLinks(html,[{link:htmlLinks[0],value:address}]);
  assert.equal(markdownLinks(encoded)[0].source,address);assert.match(encoded,/&quot;/);assert.match(encoded,/comment\.png/);assert.match(encoded,/script\.png/);
  const referenceImages=markdownLinks('![alt][picture]\n\n[picture]: <assets/a b.png>\n');assert.equal(referenceImages.filter(link=>link.image).length,1);assert.equal(referenceImages[0].source,'assets/a b.png');
  const rootedPath=join(root,'rooted.md');await writeFile(rootedPath,'---\ntypora-root-url: media-root\ntypora-copy-images-to: images/${filename}\n---\n\n# Rooted\n');const rooted=await core.openFile(rootedPath);
  const rootedImage=await dispatch(core,'markdown-import-image',{documentId:rooted.documentId,name:'rooted.png',mimeType:'image/png',dataUrl},'human')as{path:string};
  assert.match(rootedImage.path,/^images\/rooted\//);assert.equal((await dispatch(core,'markdown-resource',{documentId:rooted.documentId,path:rootedImage.path})as{url:string}).url,dataUrl,'image import and lookup share the Frontmatter root');
  await modify(core,rooted.documentId,{kind:'text.replace',from:core.getDocument(rooted.documentId).info.model.text!.length,to:core.getDocument(rooted.documentId).info.model.text!.length,expectedText:'',text:'\n![rooted]('+rootedImage.path+')\n'});
  const rootedCopy=join(directory,'root-copy','copied.md');await core.save(rooted.documentId,rootedCopy);const rootedLink=markdownLinks(await readFile(rootedCopy,'utf8')).find(link=>link.image)!;
  assert.match(rootedLink.source,/^images\/copied\//);assert.equal((await dispatch(core,'markdown-resource',{documentId:rooted.documentId,path:rootedLink.source})as{url:string}).url,dataUrl,'Save As shares the same Frontmatter root and filename substitution');
  const escapedRoot=join(root,'escaped-root.md');await writeFile(escapedRoot,'---\ntypora-root-url: ../../unapproved-media\n---\n');const escaped=await core.openFile(escapedRoot);
  await assert.rejects(dispatch(core,'markdown-import-image',{documentId:escaped.documentId,name:'escape.png',mimeType:'image/png',dataUrl},'human'),/超出/);
});
