import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { DocumentTranslationService, translateDocumentBytes } from '../packages/translation/src/index';

const bytes = (text: string) => new TextEncoder().encode(text);
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'agentviewer-translation-')); return { directory, root: join(directory, 'translations'), core: new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))) }; }
async function until(check: () => boolean, message: string) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error(message); }

test('full translation cancellation cannot publish a late ignored-driver answer or change its source', async () => {
  const { core, root } = await fixture(), view = await core.openBytes('cancel.md', bytes('Original'), 'markdown'), answer = gate<string>(); let calls = 0;
  const service = new DocumentTranslationService(core, root, async () => { calls++; return answer.promise; }, 'test');
  const job = await service.start(view.documentId, 'en'); await until(() => calls === 1, 'translator started'); service.cancel(job.id);
  await until(() => job.status !== 'running', 'cancellation completes without waiting for ignored driver'); assert.equal(job.status, 'cancelled'); assert.equal(service.artifacts.size, 0);
  answer.resolve('Late answer'); await new Promise(resolve => setImmediate(resolve)); assert.equal(service.artifacts.size, 0); assert.deepEqual(core.getDocument(view.documentId).bytes, bytes('Original'));
  const checkpoint = JSON.parse(await readFile(join(root, 'checkpoints', job.id + '.json'), 'utf8')); assert.equal(checkpoint.job.status, 'cancelled'); assert.deepEqual(checkpoint.segments, []);
});

test('concurrent start is deduplicated and shutdown pause persists a recoverable checkpoint', async () => {
  const { core, root } = await fixture(), view = await core.openBytes('pause.md', bytes('First\nSecond'), 'markdown'); let calls = 0; const ignored = gate<string>();
  const service = new DocumentTranslationService(core, root, async () => { calls++; return calls === 1 ? '第一行' : ignored.promise; }, 'test');
  const [first, duplicate] = await Promise.all([service.start(view.documentId, 'zh-CN'), service.start(view.documentId, 'zh-CN')]); assert.equal(first.id, duplicate.id); assert.equal(service.jobs.size, 1);
  await until(() => calls === 2, 'first segment checkpoint is persisted before second request'); await service.pauseAll(); assert.equal(first.status, 'paused'); ignored.resolve('ignored');
  const checkpoint = JSON.parse(await readFile(join(root, 'checkpoints', first.id + '.json'), 'utf8')); assert.equal(checkpoint.job.completed, 1); assert.deepEqual(checkpoint.segments, ['第一行']); assert.equal(checkpoint.job.status, 'paused');
  let resumedCalls = 0; const restored = new DocumentTranslationService(core, root, async text => { resumedCalls++; return '译:' + text; }, 'test'); await restored.load();
  const results = await Promise.allSettled([restored.resume(first.id), restored.resume(first.id)]); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  await until(() => restored.jobs.get(first.id)?.status !== 'running', 'resumed translation completes'); assert.equal(restored.jobs.get(first.id)?.status, 'completed'); assert.equal(resumedCalls, 1);
  assert.equal(await readFile(restored.jobs.get(first.id)!.artifact!.path, 'utf8'), '第一行\n译:Second');
});

test('two same-title jobs preserve an existing user file and publish different durable artifacts', async () => {
  const { core, root } = await fixture(), first = await core.openBytes('same.md', bytes('Alpha'), 'markdown'), second = await core.openBytes('same.md', bytes('Beta'), 'markdown');
  const output = join(root, 'documents'); await mkdir(output, { recursive: true }); const userFile = join(output, 'same.en.md'); await writeFile(userFile, 'User-authored translation');
  const held = gate<void>(); const service = new DocumentTranslationService(core, root, async text => { await held.promise; return 'Translated:' + text; }, 'test');
  const [a, b] = await Promise.all([service.start(first.documentId, 'en'), service.start(second.documentId, 'en')]); held.resolve();
  await until(() => a.status !== 'running' && b.status !== 'running', 'both same-title jobs publish'); assert.equal(a.status, 'completed'); assert.equal(b.status, 'completed'); assert.notEqual(a.artifact!.path, b.artifact!.path);
  assert.equal(await readFile(userFile, 'utf8'), 'User-authored translation'); assert.equal(await readFile(a.artifact!.path, 'utf8'), 'Translated:Alpha'); assert.equal(await readFile(b.artifact!.path, 'utf8'), 'Translated:Beta');
  const restored = new DocumentTranslationService(core, root, async text => text); await restored.load(); assert.equal(restored.artifacts.size, 2); assert.deepEqual(core.getDocument(first.documentId).bytes, bytes('Alpha')); assert.deepEqual(core.getDocument(second.documentId).bytes, bytes('Beta'));
});

test('one corrupt checkpoint does not block valid recovery or get silently overwritten', async () => {
  const { core, root } = await fixture(), view = await core.openBytes('recover.md', bytes('Original'), 'markdown'), held = gate<string>();
  const service = new DocumentTranslationService(core, root, async () => held.promise, 'test'); const job = await service.start(view.documentId, 'en'); await service.pauseAll(); held.resolve('ignored');
  const corruptPath = join(root, 'checkpoints', randomUUID() + '.json'), corrupt = '{"job": invalid checkpoint containing private text'; await writeFile(corruptPath, corrupt);
  const restored = new DocumentTranslationService(core, root, async text => text, 'test'); await restored.load(); assert.equal(restored.jobs.get(job.id)?.status, 'paused'); assert.equal(await readFile(corruptPath, 'utf8'), corrupt);
  const event = core.eventLog.find(event => event.type === 'translation.recovery-error'); assert.ok(event); assert.doesNotMatch(JSON.stringify(event.data), /private text/);
});

test('abort after the last saved segment rejects output; unsafe target tags cannot form paths', async () => {
  const controller = new AbortController(); let segments = 0;
  await assert.rejects(translateDocumentBytes('markdown', bytes('Original'), 'en', async () => 'Translated', controller.signal, undefined, [], async () => { segments++; controller.abort(); }), { code: 'CANCELLED' }); assert.equal(segments, 1);
  const { core, root } = await fixture(), view = await core.openBytes('source.md', bytes('Original'), 'markdown'), service = new DocumentTranslationService(core, root, async text => text);
  await assert.rejects(service.start(view.documentId, '../../original'), { code: 'INVALID_ARGUMENT' }); assert.equal(service.jobs.size, 0); assert.deepEqual(core.getDocument(view.documentId).bytes, bytes('Original'));
});

test('PDF cancellation also rejects a late adapter which ignores its signal', async () => {
  const { core, root } = await fixture(), adapter = gate<{ bytes: Uint8Array; warnings: string[] }>();
  // A PDF translation service only needs a frozen source; the registry controls the real PDF parser.
  const { PDFDocument } = await import('pdf-lib'); const pdf = await PDFDocument.create(); pdf.addPage(); const view = await core.openBytes('source.pdf', await pdf.save(), 'pdf');
  const service = new DocumentTranslationService(core, root, async text => text, 'test', async () => adapter.promise); const job = await service.start(view.documentId, 'en'); service.cancel(job.id);
  await until(() => job.status !== 'running', 'PDF cancel finishes before adapter completion'); assert.equal(job.status, 'cancelled'); adapter.resolve({ bytes: core.getDocument(view.documentId).bytes, warnings: [] }); assert.equal(service.artifacts.size, 0);
});
