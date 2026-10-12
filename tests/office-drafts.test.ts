import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfficeDraftRegistry, type OfficeDraft } from '../apps/desktop/src/renderer/components/office/OfficeDrafts';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const nextTurn = () => new Promise<void>(done => setImmediate(done));

test('Office drafts flush sequentially and remain dirty until the last asynchronous editor finishes', async () => {
  const changes: boolean[] = [], log: string[] = [], first = deferred(), second = deferred();
  const registry = new OfficeDraftRegistry('view-a', dirty => changes.push(dirty));
  let aDirty = true, bDirty = true;
  registry.register('a', { isDirty: () => aDirty, flush: async () => { log.push('a:start'); await first.promise; aDirty = false; log.push('a:done'); }, discard: () => { aDirty = false; } });
  registry.register('b', { isDirty: () => bDirty, flush: async () => { log.push('b:start'); await second.promise; bDirty = false; log.push('b:done'); }, discard: () => { bDirty = false; } });
  const saving = registry.flush();
  assert.deepEqual(log, ['a:start']);
  first.resolve(); await nextTurn();
  assert.deepEqual(log, ['a:start', 'a:done', 'b:start']);
  assert.equal(registry.hasDrafts(), true);
  second.resolve(); await saving;
  assert.deepEqual(log, ['a:start', 'a:done', 'b:start', 'b:done']);
  assert.equal(registry.hasDrafts(), false);
  assert.deepEqual(changes, [true, false]);
});

test('reentrant Office flush calls share the pending promise without submitting twice', async () => {
  const gate = deferred(), registry = new OfficeDraftRegistry('view-a', () => {});
  let dirty = true, calls = 0;
  registry.register('text', { isDirty: () => dirty, flush: async () => { calls++; await gate.promise; dirty = false; }, discard: () => { dirty = false; } });
  const a = registry.flush(), b = registry.flush(), c = registry.flush();
  assert.equal(a, b); assert.equal(b, c); assert.equal(calls, 1);
  gate.resolve(); await Promise.all([a, b, c]);
  await registry.flush();
  assert.equal(calls, 1);
});

test('typing while an Office transaction is pending remains a draft for the next flush', async () => {
  const gate = deferred(), changes: boolean[] = [], submitted: string[] = [];
  const registry = new OfficeDraftRegistry('view-a', dirty => changes.push(dirty));
  let value = 'first', dirty = true;
  registry.register('text', { isDirty: () => dirty, flush: async () => {
    const text = value; submitted.push(text);
    if (submitted.length === 1) await gate.promise;
    dirty = value !== text;
  }, discard: () => { dirty = false; } });
  const saving = registry.flush();
  value = 'first plus new input'; dirty = true; registry.notify(); registry.notify();
  gate.resolve(); await saving;
  assert.deepEqual(submitted, ['first']);
  assert.equal(registry.hasDrafts(), true, 'a completed snapshot is not permission to discard later typing');
  assert.deepEqual(changes, [true]);
  await registry.flush();
  assert.deepEqual(submitted, ['first', 'first plus new input']);
  assert.equal(registry.hasDrafts(), false);
  assert.deepEqual(changes, [true, false]);
});

test('an editor becoming dirty during a pending flush is discovered on the next flush', async () => {
  const gate = deferred(), registry = new OfficeDraftRegistry('view-a', () => {});
  let aDirty = true, bDirty = false, bCalls = 0;
  registry.register('a', { isDirty: () => aDirty, flush: async () => { await gate.promise; aDirty = false; }, discard: () => { aDirty = false; } });
  registry.register('b', { isDirty: () => bDirty, flush: async () => { bCalls++; bDirty = false; }, discard: () => { bDirty = false; } });
  const saving = registry.flush(); bDirty = true; registry.notify();
  assert.equal(registry.flush(), saving);
  gate.resolve(); await saving;
  assert.equal(bCalls, 0); assert.equal(registry.hasDrafts(), true);
  await registry.flush(); assert.equal(bCalls, 1); assert.equal(registry.hasDrafts(), false);
});

test('a rejected Office draft stops the sequence, preserves dirty editors and allows a later retry', async () => {
  const gate = deferred(), changes: boolean[] = [], log: string[] = [];
  const registry = new OfficeDraftRegistry('view-a', dirty => changes.push(dirty));
  let firstDirty = true, secondDirty = true, firstCalls = 0;
  registry.register('first', { isDirty: () => firstDirty, flush: async () => { log.push('first'); if (++firstCalls === 1) await gate.promise; firstDirty = false; }, discard: () => { firstDirty = false; } });
  registry.register('second', { isDirty: () => secondDirty, flush: async () => { log.push('second'); secondDirty = false; }, discard: () => { secondDirty = false; } });
  const saving = registry.flush(), rejected = assert.rejects(saving, /version changed/);
  gate.reject(new Error('version changed')); await rejected;
  assert.deepEqual(log, ['first']);
  assert.equal(firstDirty, true); assert.equal(secondDirty, true); assert.equal(registry.hasDrafts(), true);
  assert.deepEqual(changes, [true]);
  await registry.flush();
  assert.deepEqual(log, ['first', 'first', 'second']);
  assert.deepEqual(changes, [true, false]);
});

test('discard resets registered Office drafts without submitting an edit', async () => {
  const changes: boolean[] = [], discarded: string[] = [];
  const registry = new OfficeDraftRegistry('view-a', dirty => changes.push(dirty));
  let firstDirty = true, secondDirty = true, commits = 0;
  registry.register('a', { isDirty: () => firstDirty, flush: async () => { commits++; }, discard: () => { discarded.push('a'); firstDirty = false; } });
  registry.register('b', { isDirty: () => secondDirty, flush: async () => { commits++; }, discard: () => { discarded.push('b'); secondDirty = false; } });
  registry.discard(); await registry.flush();
  assert.deepEqual(discarded, ['a', 'b']); assert.equal(commits, 0);
  assert.equal(registry.hasDrafts(), false); assert.deepEqual(changes, [true, false]);
});

test('old cleanup cannot unregister a replacement Office editor with the same identity', async () => {
  const registry = new OfficeDraftRegistry('view-a', () => {});
  let dirty = true, submitted = 0;
  const old: OfficeDraft = { isDirty: () => true, flush: async () => { throw new Error('obsolete editor must not flush'); }, discard: () => {} };
  const cleanup = registry.register('text', old);
  const replacement = registry.register('text', { isDirty: () => dirty, flush: async () => { submitted++; dirty = false; }, discard: () => { dirty = false; } });
  cleanup(); assert.equal(registry.hasDrafts(), true);
  await registry.flush(); assert.equal(submitted, 1);
  replacement(); assert.equal(registry.hasDrafts(), false);
});
