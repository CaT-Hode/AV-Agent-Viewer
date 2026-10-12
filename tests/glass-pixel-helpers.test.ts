import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeSourceBezel, opaqueInkError, SOURCE_NAVIGATION_SCALE } from './glass-pixel-helpers';

test('faded foreground ink stays fixed while the real background beneath it changes', () => {
  const ink = { x: 0, y: 0, width: 1, height: 1, ink: [37, 55, 70, 255], opacity: .65 };
  // Independent rounded BGRA fixtures: 65% ink over white, then over color.
  const before = Buffer.from([133, 123, 112, 255]), beforeBackground = Buffer.from([250, 250, 250, 255]);
  const after = Buffer.from([81, 88, 94, 255]), afterBackground = Buffer.from([100, 150, 200, 255]);
  assert.ok(opaqueInkError(0, ink, before, beforeBackground, after, afterBackground)! < 1);
  assert.ok(opaqueInkError(0, ink, before, beforeBackground, afterBackground, afterBackground)! > 20, 'displacing the opaque glyph out of this pixel is a real failure');
});

test('transparent button background and low-contrast unknown ink are not mislabeled as glyphs', () => {
  const ink = { x: 0, y: 0, width: 1, height: 1, ink: [37, 55, 70, 255], opacity: 1 };
  const background = Buffer.from([200, 220, 240, 255]);
  assert.equal(opaqueInkError(0, ink, background, background, background, background), undefined);
  const uncertain = Buffer.from([70, 55, 37, 255]);
  assert.equal(opaqueInkError(0, ink, uncertain, uncertain, uncertain, uncertain), undefined);
});

test('active source bezel follows the squircle field while the inner surface flattens', () => {
  assert.ok(SOURCE_NAVIGATION_SCALE > 64 && SOURCE_NAVIGATION_SCALE < 66);
  assert.equal(activeSourceBezel(2, 29, SOURCE_NAVIGATION_SCALE), true);
  assert.equal(activeSourceBezel(28, 29, SOURCE_NAVIGATION_SCALE), false);
  assert.equal(activeSourceBezel(-1, 29, SOURCE_NAVIGATION_SCALE), false);
});
