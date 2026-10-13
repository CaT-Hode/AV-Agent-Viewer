import test from 'node:test';
import assert from 'node:assert/strict';
import { placeSelectionToolbar } from '../apps/desktop/src/renderer/lib/selection-position';
const viewport = { x: 200, y: 70, width: 800, height: 650 }, size = { width: 320, height: 42 };
test('a selection and its floating toolbar move by the same scrolling distance', () => {
  const before = placeSelectionToolbar({ x: 400, y: 300, width: 200, height: 24 }, viewport, size)!;
  const after = placeSelectionToolbar({ x: 400, y: 210, width: 200, height: 24 }, viewport, size)!;
  assert.equal(before.x, 340); assert.equal(before.y, 248); assert.equal(after.y, before.y - 90);
});
test('near the reading edge the toolbar flips below; a fully clipped selection is hidden', () => {
  assert.deepEqual(placeSelectionToolbar({ x: 400, y: 82, width: 200, height: 24 }, viewport, size), { x: 340, y: 116, width: 320 });
  assert.equal(placeSelectionToolbar({ x: 400, y: 30, width: 200, height: 24 }, viewport, size), undefined);
  assert.equal(placeSelectionToolbar({ x: 1001, y: 300, width: 100, height: 24 }, viewport, size), undefined);
});
test('large tool rows stay inside the reader and invalid geometry cannot show a stale popover', () => {
  const small = { x: 500, y: 70, width: 260, height: 650 };
  assert.deepEqual(placeSelectionToolbar({ x: 600, y: 300, width: 80, height: 20 }, small, size), { x: 508, y: 248, width: 244 });
  assert.equal(placeSelectionToolbar({ x: NaN, y: 300, width: 20, height: 20 }, viewport, size), undefined);
});
