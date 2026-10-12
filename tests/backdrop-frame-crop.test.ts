import assert from 'node:assert/strict';
import test from 'node:test';
import { alignFrameCapture, physicalFrameCrop, type BackdropFrameRect } from '../apps/desktop/src/main/backdrop-frame-crop';

const odd = { x: 13, y: 17, width: 73, height: 39 }, viewport = { width: 200, height: 200 };

test('150% aligns all four DIP edges to a 2-DIP grid and reports the real expanded crop', () => {
  const aligned = alignFrameCapture(odd, viewport, 1.5);
  assert.deepEqual(aligned, { x: 12, y: 16, width: 74, height: 40 });
  assert.deepEqual(physicalFrameCrop(aligned!, 1.5), { x: 18, y: 24, width: 111, height: 60 });
  assert.equal(physicalFrameCrop(odd, 1.5), undefined, 'never floor a fractional-pixel original origin');
});

test('125% and 175% use a 4-DIP grid, while 100% and 200% keep integer DIP boundaries', () => {
  for (const density of [1.25, 1.75]) {
    const aligned = alignFrameCapture(odd, viewport, density)!;
    assert.deepEqual(aligned, { x: 12, y: 16, width: 76, height: 40 });
    assert.deepEqual(physicalFrameCrop(aligned, density), { x: 12 * density, y: 16 * density, width: 76 * density, height: 40 * density });
  }
  for (const density of [1, 2]) {
    assert.deepEqual(alignFrameCapture(odd, viewport, density), odd);
    assert.deepEqual(physicalFrameCrop(odd, density), { x: 13 * density, y: 17 * density, width: 73 * density, height: 39 * density });
  }
});

test('clamp uses the aligned viewport interior and handles negative or overflowing ROIs', () => {
  const small = { width: 101, height: 99 };
  assert.deepEqual(alignFrameCapture({ x: -3, y: -5, width: 9, height: 11 }, small, 1.5), { x: 0, y: 0, width: 6, height: 6 });
  assert.deepEqual(alignFrameCapture({ x: 97, y: 95, width: 20, height: 20 }, small, 1.5), { x: 96, y: 94, width: 4, height: 4 });
  assert.deepEqual(alignFrameCapture({ x: 0, y: 0, width: 101, height: 99 }, small, 1.25), { x: 0, y: 0, width: 100, height: 96 });
  assert.equal(alignFrameCapture({ x: 100, y: 0, width: 1, height: 5 }, small, 1.5), undefined, 'the unaligned viewport tail has no integer-pixel crop');
});

test('fractional DIP requests expand outward and both ends map to whole pixels', () => {
  const requested = { x: 13.2, y: 17.8, width: 73.1, height: 39.1 };
  assert.deepEqual(alignFrameCapture(requested, viewport, 1.5), { x: 12, y: 16, width: 76, height: 42 });
  assert.equal(physicalFrameCrop({ x: .5, y: 0, width: 2, height: 2 }, 2), undefined, 'the contract requires integer DIP as well as integer pixels');
});

test('small rational display densities are approximated conservatively up to denominator 16', () => {
  assert.deepEqual(alignFrameCapture(odd, viewport, 4 / 3), { x: 12, y: 15, width: 75, height: 42 });
  assert.deepEqual(alignFrameCapture(odd, viewport, 1.3333333), { x: 12, y: 15, width: 75, height: 42 });
  assert.deepEqual(alignFrameCapture(odd, viewport, .5), { x: 12, y: 16, width: 74, height: 40 });
  assert.deepEqual(alignFrameCapture(odd, viewport, 17 / 16), { x: 0, y: 16, width: 96, height: 48 });
  for (const density of [Math.SQRT2, 17 / 17.5, 18 / 17, 1.5001, 0, -1, NaN, Infinity]) assert.equal(alignFrameCapture(odd, viewport, density), undefined);
});

test('empty, outside, too-small and unsafe requests select capturePage fallback', () => {
  for (const rect of [{ x: 2, y: 2, width: 0, height: 5 }, { x: 2, y: 2, width: 5, height: -1 }, { x: 201, y: 2, width: 5, height: 5 }, { x: -10, y: 2, width: 5, height: 5 }, { x: NaN, y: 2, width: 5, height: 5 }, { x: 0, y: 0, width: Infinity, height: 5 }]) assert.equal(alignFrameCapture(rect, viewport, 1.5), undefined);
  assert.equal(alignFrameCapture({ x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 }, 1.5), undefined);
  assert.equal(alignFrameCapture(odd, { width: 0, height: 200 }, 1.5), undefined);
  assert.equal(physicalFrameCrop({ x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 }, 2), undefined);
});

test('preconverted zoomed DIP geometry remains independent of display density', () => {
  const zoomedDip = { x: 16.25, y: 21.25, width: 91.25, height: 48.75 };
  assert.deepEqual(alignFrameCapture(zoomedDip, viewport, 1.5), { x: 16, y: 20, width: 92, height: 50 });
  const crop = physicalFrameCrop(alignFrameCapture(zoomedDip, viewport, 1.5)!, 1.5)!;
  assert.deepEqual(crop, { x: 24, y: 30, width: 138, height: 75 });
});

test('a grid of representative ROIs has integer pixel edges and exactly matching extents', () => {
  for (const density of [1, 1.25, 1.5, 1.75, 2, 4 / 3, 17 / 16]) for (let x = -3; x < 120; x += 7) for (let y = -3; y < 120; y += 11) {
    const requested: BackdropFrameRect = { x, y, width: 13, height: 17 }, bounds = { width: 103, height: 101 }, aligned = alignFrameCapture(requested, bounds, density);
    if (!aligned) continue;
    const pixels = physicalFrameCrop(aligned, density)!;
    assert.ok([aligned.x, aligned.y, aligned.width, aligned.height, pixels.x, pixels.y, pixels.width, pixels.height].every(Number.isSafeInteger));
    assert.ok(aligned.x >= 0 && aligned.y >= 0 && aligned.x + aligned.width <= bounds.width && aligned.y + aligned.height <= bounds.height);
    assert.equal(pixels.x + pixels.width, Math.round((aligned.x + aligned.width) * density));
    assert.equal(pixels.y + pixels.height, Math.round((aligned.y + aligned.height) * density));
  }
});
