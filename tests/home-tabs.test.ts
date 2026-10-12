import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceHomeTabSlot } from '../apps/desktop/src/renderer/lib/home-tabs';

test('a new view consumes its original home slot without changing surrounding order', () => {
  const order = Object.freeze(['first', 'home-a', 'second', 'home-b', 'last']);
  assert.deepEqual(replaceHomeTabSlot(order, 'home-a', 'new-view'), ['first', 'new-view', 'second', 'home-b', 'last']);
  assert.deepEqual(order, ['first', 'home-a', 'second', 'home-b', 'last']);
});

test('an existing target moves into the home slot and every previous duplicate disappears', () => {
  assert.deepEqual(replaceHomeTabSlot(['target', 'first', 'home-a', 'target', 'home-b', 'last', 'target'], 'home-a', 'target'), ['first', 'target', 'home-b', 'last']);
});

test('when the originating home closed, an existing target stays in its original position', () => {
  assert.deepEqual(replaceHomeTabSlot(['first', 'target', 'home-b', 'last'], 'home-a', 'target'), ['first', 'target', 'home-b', 'last']);
});

test('when the originating home closed and the target is new, append without consuming another home', () => {
  assert.deepEqual(replaceHomeTabSlot(['first', 'home-b', 'last'], 'home-a', 'target'), ['first', 'home-b', 'last', 'target']);
  assert.deepEqual(replaceHomeTabSlot([], 'home-a', 'target'), ['target']);
});

test('repeated asynchronous completion is idempotent after either replacement or append', () => {
  for (const initial of [['first', 'home-a', 'home-b', 'last'], ['first', 'home-b', 'last'], ['target', 'first', 'home-a', 'target']]) {
    const once = replaceHomeTabSlot(initial, 'home-a', 'target');
    assert.deepEqual(replaceHomeTabSlot(once, 'home-a', 'target'), once);
  }
});

test('first and last home slots preserve their exact position', () => {
  assert.deepEqual(replaceHomeTabSlot(['home-a', 'other'], 'home-a', 'target'), ['target', 'other']);
  assert.deepEqual(replaceHomeTabSlot(['other', 'home-a'], 'home-a', 'target'), ['other', 'target']);
});

test('a coincident target and home id never removes that slot or unrelated tabs', () => {
  assert.deepEqual(replaceHomeTabSlot(['first', 'same', 'last', 'same'], 'same', 'same'), ['first', 'same', 'last']);
});

test('closed-origin completion returns a fresh array while leaving existing duplicates untouched', () => {
  const order = ['target', 'other', 'target'];
  const result = replaceHomeTabSlot(order, 'missing-home', 'target');
  assert.notEqual(result, order); assert.deepEqual(result, order);
});
