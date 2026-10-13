import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGlassControlDrag, glassPointerCoordinate, glassSelectionFillOpacity, nearestGlassOption, rubberBandGlassControl } from '../apps/desktop/src/renderer/lib/glass-control-drag';

test('pointer coordinates preserve scroll and CSS geometry under ancestor scale', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const coordinate = glassPointerCoordinate(40 + 70 * scale, { left: 40, width: 200 * scale, clientWidth: 200, scrollLeft: 130 });
    assert.equal(coordinate, 200);
  }
  assert.equal(glassPointerCoordinate(-20, { left: -100, width: 200, clientWidth: 100, scrollLeft: 15 }), 55);
  assert.equal(glassPointerCoordinate(25, { left: 10, width: 0, clientWidth: 0 }), 15, 'unmeasured geometry does not divide by zero');
});

test('nearest valid segment follows centers of unequal widths and skips disabled options', () => {
  const options = [{ value: 'short', x: 3, width: 65 }, { value: 'disabled', x: 68, width: 120, disabled: true }, { value: 'long', x: 188, width: 180 }];
  assert.equal(nearestGlassOption(options, 120)?.value, 'short');
  assert.equal(nearestGlassOption(options, 190)?.value, 'long');
  assert.equal(nearestGlassOption(options, -100)?.value, 'short');
  assert.equal(nearestGlassOption(options, 5000)?.value, 'long');
  assert.equal(nearestGlassOption(options.map(option => ({ ...option, disabled: true })), 200), undefined);
  assert.equal(nearestGlassOption([], 0), undefined);
  assert.equal(nearestGlassOption([{ value: 'zero', x: 0, width: 0 }], 0), undefined);
  assert.equal(nearestGlassOption([{ value: 'a', x: 0, width: 100 }, { value: 'b', x: 100, width: 100 }], 100)?.value, 'a', 'ties keep stable order');
});

test('selected green fill fades continuously with travel rather than at a binary boundary', () => {
  const values = [0, 8, 16, 24, 32, 40, 50].map(distance => glassSelectionFillOpacity(distance, 90));
  assert.equal(values[0], 1); assert.equal(values.at(-1), 0);
  assert.ok(values.slice(1, -1).every(value => value > 0 && value < 1));
  assert.ok(values.every((value, index) => index === 0 || value < values[index - 1]));
  assert.equal(glassSelectionFillOpacity(-24, 90), glassSelectionFillOpacity(24, 90));
  assert.equal(glassSelectionFillOpacity(10000, 65), 0);
  assert.ok(Math.abs(glassSelectionFillOpacity(23.99, 90) - glassSelectionFillOpacity(24.01, 90)) < .001, 'crossing the old midpoint does not switch the fill');
});

test('gesture tracks direct content movement and consumes release once', () => {
  const drag = createGlassControlDrag();
  assert.equal(drag.begin({ pointerId: 1, clientX: 20, contentX: 70 }), true);
  assert.equal(drag.begin({ pointerId: 2, clientX: 20, contentX: 70 }), false, 'a secondary pointer cannot steal the drag');
  assert.equal(drag.update({ pointerId: 2, clientX: 80, contentX: 130 }), undefined);
  assert.deepEqual(drag.update({ pointerId: 1, clientX: 23, contentX: 73 }), { contentX: 73, delta: 3, moved: false });
  assert.deepEqual(drag.update({ pointerId: 1, clientX: 30, contentX: 80 }), { contentX: 80, delta: 10, moved: true });
  assert.deepEqual(drag.update({ pointerId: 1, clientX: 30, contentX: 130 }), { contentX: 130, delta: 60, moved: true }, 'scroll during capture uses the new content coordinate');
  assert.deepEqual(drag.finish({ pointerId: 1, clientX: 40, contentX: 140 }), { contentX: 140, delta: 70, moved: true }, 'release uses its own last pointer sample');
  assert.equal(drag.finish({ pointerId: 1, clientX: 40, contentX: 140 }), undefined, 'up plus lost capture produces only one commit opportunity');
  assert.equal(drag.pointerId, undefined);
});

test('cancel/disable ownership creates no release and small presses remain clicks', () => {
  const drag = createGlassControlDrag();
  drag.begin({ pointerId: 3, clientX: 5, contentX: 5 });
  drag.cancel(2); assert.equal(drag.pointerId, 3, 'unrelated pointer cancellation is ignored');
  drag.cancel(); assert.equal(drag.finish({ pointerId: 3, clientX: 50, contentX: 50 }), undefined);
  drag.begin({ pointerId: 4, clientX: 5, contentX: 5 });
  assert.deepEqual(drag.finish({ pointerId: 4, clientX: 7, contentX: 7 }), { contentX: 7, delta: 2, moved: false });
});

test('switch overtravel has bounded resistance and continuous return', () => {
  assert.equal(rubberBandGlassControl(15, 0, 30), 15);
  assert.equal(rubberBandGlassControl(-22, 0, 30), -1);
  assert.equal(rubberBandGlassControl(52, 0, 30), 31);
  assert.ok(Math.abs(rubberBandGlassControl(30.01, 0, 30) - 30) < .001);
});
