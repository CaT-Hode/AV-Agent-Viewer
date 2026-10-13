import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navigationExitDuration } from '../apps/desktop/src/main/toolbar-motion';

test('dismissal retains the current exit after an immediate address focus', () => {
  assert.equal(navigationExitDuration(650, 0), 650);
  assert.equal(navigationExitDuration(380, 650), 380);
});

test('explicit disabled and reduced motion override the previous duration', () => {
  assert.equal(navigationExitDuration(0, 650), 0);
  assert.equal(navigationExitDuration(80, 650), 80);
});

test('missing and invalid host durations have finite bounded fallbacks', () => {
  assert.equal(navigationExitDuration(undefined, 380), 380);
  assert.equal(navigationExitDuration(null, 650), 650);
  assert.equal(navigationExitDuration(NaN, 80), 80);
  assert.equal(navigationExitDuration(Infinity, NaN), 650);
  assert.equal(navigationExitDuration(-1, 650), 0);
  assert.equal(navigationExitDuration(1200, 650), 900);
});
