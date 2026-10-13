import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presencePresentation, presenceTarget, type PresenceState } from '../apps/desktop/src/renderer/lib/presence-state';
import { AI_POPOVER_MOTION_BASE_MS, motionDurationForMode } from '../apps/desktop/src/renderer/lib/motion-policy';
import { retainedSurfaceExit } from '../apps/desktop/src/main/toolbar-motion';

test('native async identity receives an entrance instead of snapping open', () => {
  const empty: PresenceState = { present: false, phase: 'exit', identity: undefined };
  assert.deepEqual(presencePresentation(empty, true, 'view:task', false), { present: true, phase: 'enter' });
  assert.deepEqual(presenceTarget(empty, true, 'view:task', false), { present: true, phase: 'enter', identity: 'view:task' });
});
test('close and reversal retain the same surface while a new source clears the old body', () => {
  const open: PresenceState = { present: true, phase: 'open', identity: 'view:task' };
  const exit = presenceTarget(open, false, open.identity, false);
  assert.equal(exit.present, true);
  assert.equal(presenceTarget(exit, true, open.identity, false).phase, 'open');
  assert.deepEqual(presencePresentation(exit, false, 'other-view', false), { present: false, phase: 'exit' });
  assert.deepEqual(presenceTarget(exit, false, 'other-view', false), { present: false, phase: 'exit', identity: 'other-view' });
  assert.equal(presenceTarget(exit, true, 'view:new-task', false).phase, 'enter');
});
test('off removes content immediately and reduced mode has no elastic waiting period', () => {
  const open: PresenceState = { present: true, phase: 'open', identity: 'view:task' };
  assert.deepEqual(presencePresentation(open, false, open.identity, true), { present: false, phase: 'exit' });
  assert.equal(motionDurationForMode(AI_POPOVER_MOTION_BASE_MS, 'off'), 0);
  assert.equal(motionDurationForMode(AI_POPOVER_MOTION_BASE_MS, 'reduced'), 80);
  assert.equal(motionDurationForMode(AI_POPOVER_MOTION_BASE_MS, 'standard'), 390);
  assert.equal(motionDurationForMode(AI_POPOVER_MOTION_BASE_MS, 'elegant'), 650);
});
test('a native retained exit preserves layout updates but shortened modes cancel its old input deadline', () => {
  assert.equal(retainedSurfaceExit(650, 650), 'keep');
  assert.equal(retainedSurfaceExit(80, 650), 'restart');
  assert.equal(retainedSurfaceExit(0, 650), 'hide');
  assert.equal(retainedSurfaceExit(390, 80), 'keep');
  assert.equal(retainedSurfaceExit(380, 650), 'keep');
  assert.equal(retainedSurfaceExit(650, 390), 'keep');
});
