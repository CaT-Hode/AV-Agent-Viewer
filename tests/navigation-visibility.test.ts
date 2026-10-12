import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNavigationVisibilityState, reduceNavigationVisibility, type NavigationVisibilityState } from '../apps/desktop/src/renderer/lib/navigation-visibility';

const initial = () => reduceNavigationVisibility(createNavigationVisibilityState(), { type: 'scroll', y: 100, now: 0 });
const scroll = (state: NavigationVisibilityState, y: number, now: number) => reduceNavigationVisibility(state, { type: 'scroll', y, now });

test('slow scrolling needs 72 px before progressive 48 px hiding', () => {
  let state = initial();
  for (let i = 1; i <= 9; i++) state = scroll(state, 100 + i * 8, i * 100);
  assert.equal(state.downAccum, 72); assert.equal(state.progress, 0);
  state = scroll(state, 196, 1200); assert.equal(state.progress, .5);
  state = scroll(state, 220, 1500); assert.equal(state.progress, 1);
});

test('fast scrolling accelerates interpolation without bypassing threshold', () => {
  let slow = initial(), fast = initial();
  slow = scroll(slow, 172, 300); fast = scroll(fast, 172, 20);
  assert.equal(slow.progress, 0); assert.equal(fast.progress, 0);
  slow = scroll(slow, 196, 600); fast = scroll(fast, 196, 40);
  assert.equal(slow.progress, .5); assert.equal(fast.progress, .5);
  assert.ok(fast.durationMs < slow.durationMs);
  assert.equal(fast.durationMs, 380); assert.equal(slow.durationMs, 650);
  assert.equal(scroll(initial(), 170, 5).progress, 0);
});

test('idle hide is slower while focus reveals immediately', () => {
  const hidden = reduceNavigationVisibility(scroll(initial(), 220, 100), { type: 'idle' });
  assert.equal(hidden.durationMs, 650);
  assert.equal(reduceNavigationVisibility(hidden, { type: 'focus' }).durationMs, 0);
  assert.equal(reduceNavigationVisibility(hidden, { type: 'reveal' }).durationMs, 380);
});

test('small scroll and sub-2-px jitter do not toggle visibility', () => {
  let state = scroll(initial(), 130, 40);
  state = scroll(state, 131, 60); state = scroll(state, 129.5, 70);
  assert.equal(state.downAccum, 30); assert.equal(state.progress, 0);
  state = scroll(state, 141, 80); assert.equal(state.downAccum, 41);
});

test('upward 16 px reveals and direction reversal starts a fresh down threshold', () => {
  let state = scroll(initial(), 220, 100);
  state = scroll(state, 210, 150); assert.equal(state.progress, 1);
  state = scroll(state, 204, 200); assert.equal(state.progress, 0);
  state = scroll(state, 254, 250); assert.equal(state.downAccum, 50); assert.equal(state.progress, 0);
  state = scroll(state, 252, 300); state = scroll(state, 277, 350);
  assert.equal(state.downAccum, 25); assert.equal(state.progress, 0);
});

test('focus and hover keep the navigation shown and idle cannot override them', () => {
  let state = reduceNavigationVisibility(scroll(initial(), 220, 100), { type: 'focus' });
  state = scroll(state, 500, 150); state = reduceNavigationVisibility(state, { type: 'idle' });
  assert.equal(state.progress, 0); assert.equal(state.downAccum, 0);
  state = reduceNavigationVisibility(state, { type: 'hover' });
  state = reduceNavigationVisibility(state, { type: 'blur' }); state = scroll(state, 700, 200);
  assert.equal(state.progress, 0); assert.equal(state.hovered, true);
  state = reduceNavigationVisibility(state, { type: 'leave' }); state = scroll(state, 730, 250);
  assert.equal(state.progress, 0); assert.equal(state.downAccum, 30);
});

test('a stop over 400 ms resets accumulated downward travel', () => {
  let state = scroll(initial(), 150, 100);
  state = scroll(state, 180, 501); assert.equal(state.downAccum, 30); assert.equal(state.progress, 0);
  state = scroll(state, 222, 601); assert.equal(state.downAccum, 72); assert.equal(state.progress, 0);
  state = scroll(state, 246, 701); assert.equal(state.progress, .5);
});

test('top position, disabled auto-hide, identity reset and reveal reset', () => {
  let state = scroll(initial(), 220, 100);
  state = scroll(state, 16, 200); state = reduceNavigationVisibility(state, { type: 'idle' }); assert.equal(state.progress, 0);
  state = reduceNavigationVisibility(state, { type: 'reset', enabled: false });
  state = scroll(state, 300, 300); state = reduceNavigationVisibility(state, { type: 'idle' }); assert.equal(state.progress, 0);
  state = reduceNavigationVisibility(state, { type: 'reset', enabled: true });
  state = scroll(state, 500, 400); assert.equal(state.progress, 0); assert.equal(state.downAccum, 0);
  state = scroll(state, 550, 450); state = reduceNavigationVisibility(state, { type: 'reveal' });
  state = scroll(state, 580, 500); assert.equal(state.downAccum, 30); assert.equal(state.progress, 0);
  state = reduceNavigationVisibility(state, { type: 'idle' }); assert.equal(state.progress, 1);
});
