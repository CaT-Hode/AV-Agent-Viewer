import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeBackdropCache } from '../apps/desktop/src/main/backdrop-cache';

test('exact source identity reuses captured pixels and preserves actual capture time', () => {
  const cache = new NativeBackdropCache(), bitmap = new Uint8Array([1, 2, 3, 255]); let encodes = 0;
  const encode = () => { encodes++; return { image: 'actual-png', pixelSize: { width: 1, height: 1 } }; };
  cache.accept('page:nav:layout:revision:scroll:crop:dpr', '1x1@1', bitmap, encode, 100);
  const reused = cache.reuse('page:nav:layout:revision:scroll:crop:dpr')!;
  assert.equal(reused.image, 'actual-png'); assert.equal(reused.capturedAt, 100); assert.equal(encodes, 1);
  for (const invalid of ['page2', 'nav2', 'layout2', 'revision2', 'scroll2', 'crop2', 'dpr2']) assert.equal(cache.reuse(invalid), undefined);
});

test('watchdog still obtains new pixels but skips PNG only after exact bitmap equality', () => {
  const cache = new NativeBackdropCache(); let encodes = 0;
  const encode = () => { encodes++; return { image: 'png-' + encodes, pixelSize: { width: 2, height: 1 } }; };
  cache.accept('first', '2x1@1', new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]), encode, 100);
  const unchanged = cache.accept('new-source-revision', '2x1@1', new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]), encode, 500);
  assert.equal(unchanged.reusedEncoding, true); assert.equal(encodes, 1); assert.equal(unchanged.pixels.capturedAt, 500);
  const changed = cache.accept('new-source-revision', '2x1@1', new Uint8Array([1, 2, 3, 255, 4, 5, 7, 255]), encode, 900);
  assert.equal(changed.reusedEncoding, false); assert.equal(encodes, 2); assert.equal(changed.pixels.image, 'png-2');
});

test('crop shape/DPR changes cannot reuse a coincidentally equal byte array', () => {
  const cache = new NativeBackdropCache(); let encodes = 0;
  const encode = () => { encodes++; return { image: 'png-' + encodes, pixelSize: { width: encodes, height: 1 } }; };
  cache.accept('a', '2x1@1', new Uint8Array(8), encode, 1);
  assert.equal(cache.accept('b', '1x2@1', new Uint8Array(8), encode, 2).reusedEncoding, false);
  assert.equal(cache.accept('c', '1x2@1.5', new Uint8Array(8), encode, 3).reusedEncoding, false);
  assert.equal(encodes, 3); cache.clear(); assert.equal(cache.reuse('c'), undefined);
});
