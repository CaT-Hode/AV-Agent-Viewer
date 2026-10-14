import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfficeSurfaceDispatchQueue } from '../apps/desktop/src/renderer/lib/office-surface-dispatch';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
test('a focus layout cannot interleave between coordinate synchronization and the one input dispatch', async () => {
  const queue = new OfficeSurfaceDispatchQueue(), entered = deferred(), release = deferred(); let revision = 1;
  const seen: string[] = [];
  const input = queue.run(async () => { revision++; const expected = revision; seen.push('synchronized'); entered.resolve(); await release.promise; assert.equal(revision, expected, 'input is bound to the actual synchronized coordinate version'); seen.push('input'); });
  await entered.promise;
  const focus = queue.run(async () => { revision++; seen.push('focus layout'); });
  await new Promise(done => setTimeout(done, 0)); assert.deepEqual(seen, ['synchronized']); release.resolve(); await Promise.all([input, focus]); assert.deepEqual(seen, ['synchronized', 'input', 'focus layout']);
});
test('a failed native input is never replayed and does not strand a following read/layout', async () => {
  const queue = new OfficeSurfaceDispatchQueue(); let edits = 0, layouts = 0;
  const failed = assert.rejects(queue.run(async () => { edits++; throw new Error('unknown native acknowledgement'); }), /unknown native/);
  const layout = queue.run(async () => { layouts++; return 7; });
  await failed; assert.equal(await layout, 7); assert.equal(edits, 1); assert.equal(layouts, 1);
});
