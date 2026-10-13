import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReadingContext } from '../packages/contracts/src/index';
import { SelectionTranslationService } from '../packages/translation/src/selection';

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(retainedSources = 128, timeoutMs = 1000) {
  let revision = 0, model = 'model-a';
  let context: ReadingContext = { viewId: 'view', documentId: 'doc', contentRevision: 0, viewRevision: 1, capturedAt: '', quality: 'confirmed', actor: 'human', locator: { kind: 'markdown' }, visibleText: 'Alpha', selection: { kind: 'text', text: 'Alpha', locator: { kind: 'markdown', from: 0, to: 5 } } };
  const calls: { source: string; language: string; model: string; signal: AbortSignal }[] = [];
  let generate = async (source: string, language: string, selected: string) => `${selected}:${language}:${source}`;
  let readContext = async () => context;
  const service = new SelectionTranslationService({ context: () => readContext(), revision: () => revision, capture: connectionId => {
    const selected = connectionId ?? model;
    return { fingerprint: selected, model: selected, translate: (source, language, signal) => { calls.push({ source, language, model: selected, signal }); return generate(source, language, selected); } };
  }, retainedSources, timeoutMs });
  const request = (requestId: string) => ({ requestId, viewId: 'view', text: 'Alpha', sourceRevision: 0, targetLanguage: 'zh-CN' });
  return { service, calls, request, setContext: (next: ReadingContext) => { context = next; }, context: () => context, setRevision: (next: number) => { revision = next; }, setModel: (next: string) => { model = next; }, setGenerate: (next: typeof generate) => { generate = next; }, setReadContext: (next: typeof readContext) => { readContext = next; } };
}

test('selection requests freeze source/locator/model/language, and pinned retry uses saved source after an edit', async () => {
  const f = fixture(), answer = gate<string>();
  f.setGenerate(() => answer.promise);
  const pending = f.service.translate('owner', f.request('first'));
  await new Promise(resolve => setImmediate(resolve));
  f.setModel('model-b'); f.setRevision(1);
  f.setContext({ ...f.context(), contentRevision: 1, selection: { kind: 'cells', text: 'Other cells', locator: { kind: 'xlsx', cell: 'B2', sheetId: 'sheet' } } });
  answer.resolve('译文');
  const first = await pending;
  assert.equal(first.model, 'model-a'); assert.equal(first.targetLanguage, 'zh-CN'); assert.equal(first.source, 'Alpha'); assert.equal(first.sourceUpdated, true); assert.deepEqual(first.locator, { kind: 'markdown', from: 0, to: 5 });
  f.setGenerate(async (source, language, model) => `${model}:${language}:${source}`);
  const retry = await f.service.translate('owner', { requestId: 'retry', retryOf: first.requestId, viewId: 'view', text: 'untrusted old text', sourceRevision: 99, targetLanguage: 'EN', connectionId: 'model-c' });
  assert.equal(retry.text, 'model-c:en:Alpha'); assert.equal(retry.sourceRevision, 0); assert.equal(retry.sourceUpdated, true); assert.deepEqual(retry.locator, first.locator);
});

test('cancel rejects immediately and suppresses a driver which ignores its signal', async () => {
  const f = fixture(), answer = gate<string>(); f.setGenerate(() => answer.promise);
  const pending = f.service.translate('owner', f.request('cancelled')), rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.service.cancel('owner', 'view', 'cancelled'), { cancelled: true });
  await rejected; assert.equal(f.calls[0].signal.aborted, true);
  answer.resolve('late result'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.service.cancel('owner', 'view', 'cancelled'), { cancelled: false });
});

test('cancel during context capture never sends the request to a model', async () => {
  const f = fixture(), context = gate<ReadingContext>(); f.setReadContext(() => context.promise);
  const pending = f.service.translate('owner', f.request('early')), rejected = assert.rejects(pending, { code: 'CANCELLED' });
  f.service.cancel('owner', 'view', 'early'); await rejected;
  context.resolve(f.context()); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
});

test('invalid, agent-produced and revision-stale sources are rejected before model use; cells work', async () => {
  const f = fixture();
  f.setContext({ ...f.context(), actor: 'agent' }); await assert.rejects(f.service.translate('owner', f.request('agent')), { code: 'STALE_SELECTION' });
  f.setContext({ ...f.context(), actor: 'human' }); f.setRevision(1); await assert.rejects(f.service.translate('owner', f.request('edited')), { code: 'STALE_SELECTION' });
  f.setRevision(0); f.setContext({ ...f.context(), selection: { ...f.context().selection, kind: 'cells' } }); assert.equal((await f.service.translate('owner', f.request('cells'))).source, 'Alpha');
  assert.equal(f.calls.length, 1);
});

test('saved sources and cancellation cannot cross window/view boundaries', async () => {
  const f = fixture(); await f.service.translate('owner', f.request('saved'));
  await assert.rejects(f.service.translate('other', { ...f.request('retry-owner'), retryOf: 'saved' }), { code: 'AUTH_SCOPE_DENIED' });
  await assert.rejects(f.service.translate('owner', { ...f.request('retry-view'), viewId: 'other', retryOf: 'saved' }), { code: 'AUTH_SCOPE_DENIED' });
  assert.throws(() => f.service.cancel('other', 'view', 'saved'), { code: 'AUTH_SCOPE_DENIED' });
  assert.equal(f.calls.length, 1);
});

test('same-view pinned request survives cancel of another request, and request IDs cannot be recycled', async () => {
  const f = fixture(), answers = [gate<string>(), gate<string>()]; let index = 0; f.setGenerate(() => answers[index++].promise);
  const pinned = f.service.translate('owner', f.request('pinned')), temporary = f.service.translate('owner', f.request('temporary'));
  const rejected = assert.rejects(temporary, { code: 'CANCELLED' });
  await new Promise(resolve => setImmediate(resolve)); f.service.cancel('owner', 'view', 'temporary'); await rejected;
  assert.equal(f.calls[0].signal.aborted, false); answers[0].resolve('pinned result'); assert.equal((await pinned).text, 'pinned result');
  await assert.rejects(f.service.translate('owner', f.request('pinned')), { code: 'TRANSLATION_REQUEST_EXISTS' }); answers[1].resolve('ignored');
});

test('bounded saved sources expire explicitly, while a validated manual snapshot need not remain selected', async () => {
  const f = fixture(2); const snapshot = structuredClone(f.context());
  f.setContext({ ...f.context(), selection: { kind: 'none', text: '' } });
  const manual = await f.service.translateSnapshot('owner', { requestId: 'manual', viewId: 'view', targetLanguage: 'en' }, snapshot); assert.equal(manual.source, 'Alpha');
  await f.service.translateSnapshot('owner', { requestId: 'second', viewId: 'view', targetLanguage: 'en' }, snapshot);
  await f.service.translateSnapshot('owner', { requestId: 'third', viewId: 'view', targetLanguage: 'en' }, snapshot);
  await assert.rejects(f.service.translate('owner', { ...f.request('expired'), retryOf: 'manual' }), { code: 'TRANSLATION_SOURCE_EXPIRED' });
});

test('timeout, empty output and unsafe language tags fail explicitly, and owner cleanup cancels work', async () => {
  const f = fixture(128, 10), answer = gate<string>(); f.setGenerate(() => answer.promise);
  await assert.rejects(f.service.translate('owner', f.request('timeout')), { code: 'REQUEST_TIMEOUT' });
  answer.resolve('late'); f.setGenerate(async () => '  '); await assert.rejects(f.service.translate('owner', f.request('empty')), { code: 'TRANSLATION_EMPTY' });
  await assert.rejects(f.service.translate('owner', { ...f.request('bad'), targetLanguage: '../../original' }), { code: 'INVALID_ARGUMENT' });
  const held = gate<string>(); f.setGenerate(() => held.promise); const closing = f.service.translate('owner', f.request('closing')), rejected = assert.rejects(closing, { code: 'CANCELLED' });
  f.service.cancelOwner('owner'); await rejected; held.resolve('late');
  await assert.rejects(f.service.translate('owner', { ...f.request('old'), retryOf: 'empty' }), { code: 'TRANSLATION_SOURCE_EXPIRED' });
});
