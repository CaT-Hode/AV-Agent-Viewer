import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animatedMotion, motionDurationForMode, resolveMotionMode } from '../apps/desktop/src/renderer/lib/motion-policy';
import { motionDuration } from '../apps/desktop/src/renderer/lib/motion';

test('elegant is an animated mode; system reduction and explicit off retain precedence', () => {
  assert.equal(resolveMotionMode('elegant'), 'elegant');
  assert.equal(animatedMotion(resolveMotionMode('elegant')), true);
  assert.equal(resolveMotionMode('elegant', true), 'reduced');
  assert.equal(resolveMotionMode('off', true), 'off');
  assert.equal(resolveMotionMode('unknown'), 'standard');
});
test('native retention and renderer presence use the same slower duration policy', () => {
  for (const [base, expected] of [[140,420],[180,468],[200,520],[220,572],[300,650]]) {
    assert.equal(motionDurationForMode(base,'elegant'),expected);
    assert.equal(motionDuration(base,'elegant:pointer',false),expected);
  }
  assert.equal(motionDurationForMode(200,'standard'),260);
  assert.equal(motionDurationForMode(0,'elegant'),0);
});
test('keyboard actions are immediate and accessibility settings never inherit elegant delay', () => {
  assert.equal(motionDuration(220,'elegant:keyboard'),0);
  assert.equal(motionDuration(200,'elegant:keyboard',false),520);
  assert.equal(motionDurationForMode(220,'reduced'),80);
  assert.equal(motionDurationForMode(220,'off'),0);
});
