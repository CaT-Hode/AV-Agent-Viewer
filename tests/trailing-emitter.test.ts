import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTrailingEmitter } from '../apps/desktop/src/renderer/lib/trailing-emitter';

function clock() {
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    timing: { now: () => now, schedule: (callback: () => void, delay: number) => { timers.set(++id, { at: now + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; }, cancel: (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer as unknown as number); } },
    advance(milliseconds: number) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

test('the last scroll request inside 120ms is emitted at the trailing boundary', () => {
  const time = clock(), reports: string[] = [];
  const emitter = createTrailingEmitter<[string]>(120, value => reports.push(value), time.timing);
  emitter.request(['initial']); time.advance(25); emitter.request(['intermediate']); time.advance(25); emitter.request(['final paragraph']);
  assert.deepEqual(reports, ['initial']); assert.equal(time.pending(), 1);
  time.advance(69); assert.deepEqual(reports, ['initial']);
  time.advance(1); assert.deepEqual(reports, ['initial', 'final paragraph']); assert.equal(time.pending(), 0);
});

test('a deferred report reads the latest sampler closure and geometry at execution, not request time', () => {
  const time = clock(), reports: { revision: number; paragraph: number; request: string }[] = [];
  let visibleParagraph = 0;
  const emitter = createTrailingEmitter<[string]>(120, request => reports.push({ revision: 1, paragraph: visibleParagraph, request }), time.timing);
  emitter.request(['initial']); time.advance(15); emitter.request(['directory jump']);
  visibleParagraph = 109;
  emitter.update(request => reports.push({ revision: 2, paragraph: visibleParagraph, request }));
  time.advance(105);
  assert.deepEqual(reports, [{ revision: 1, paragraph: 0, request: 'initial' }, { revision: 2, paragraph: 109, request: 'directory jump' }]);
});

test('force reports cancel old pending input and establish the next trailing interval', () => {
  const time = clock(), reports: string[] = [];
  const emitter = createTrailingEmitter<[string]>(120, value => reports.push(value), time.timing);
  emitter.request(['initial']); time.advance(20); emitter.request(['stale scroll']); time.advance(10); emitter.request(['confirmed selection'], true);
  assert.equal(time.pending(), 0); time.advance(30); emitter.request(['new scroll']); time.advance(60);
  assert.deepEqual(reports, ['initial', 'confirmed selection']);
  time.advance(30); assert.deepEqual(reports, ['initial', 'confirmed selection', 'new scroll']);
});

test('identity/unmount cancellation prevents old trailing callbacks from reporting into another view', () => {
  const time = clock(), reports: string[] = [];
  const oldView = createTrailingEmitter<[string]>(120, value => reports.push('old:' + value), time.timing);
  oldView.request(['initial']); time.advance(30); oldView.request(['obsolete']); oldView.cancel();
  const nextView = createTrailingEmitter<[string]>(120, value => reports.push('new:' + value), time.timing);
  nextView.request(['current']); time.advance(500);
  assert.deepEqual(reports, ['old:initial', 'new:current']); assert.equal(time.pending(), 0);
  nextView.request(['last']); time.advance(1); nextView.request(['unmounted']); nextView.cancel(); time.advance(500);
  assert.deepEqual(reports, ['old:initial', 'new:current', 'new:last']);
});
