import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNavigationVisibilityState, NAVIGATION_REVEAL_EDGE_PX, reduceNavigationVisibility, type NavigationVisibilityState } from '../apps/desktop/src/renderer/lib/navigation-visibility';

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

test('manual dismissal stays hidden through top/up scroll, hover, focus and idle', () => {
  let state = reduceNavigationVisibility(initial(), { type: 'focus' });
  state = reduceNavigationVisibility(state, { type: 'hover' });
  state = reduceNavigationVisibility(state, { type: 'dismiss' });
  assert.equal(state.progress, 1); assert.equal(state.manualHidden, true);
  assert.equal(state.durationMs, 650); assert.equal(state.focused, false); assert.equal(state.hovered, false);
  state = scroll(state, 900, 100); state = scroll(state, 0, 200);
  for (const type of ['hover', 'focus', 'idle', 'blur', 'leave'] as const) {
    state = reduceNavigationVisibility(state, { type });
    assert.equal(state.progress, 1); assert.equal(state.manualHidden, true);
  }
  assert.equal(state.y, 0); assert.equal(state.downAccum, 0); assert.equal(state.upAccum, 0);
});

test('manual dismissal is available when automatic hiding is disabled', () => {
  let state = reduceNavigationVisibility(createNavigationVisibilityState(false), { type: 'dismiss' });
  assert.equal(state.enabled, false); assert.equal(state.progress, 1); assert.equal(state.manualHidden, true);
  state = scroll(state, 0, 100); state = reduceNavigationVisibility(state, { type: 'hover' });
  assert.equal(state.progress, 1);
  state = reduceNavigationVisibility(state, { type: 'reveal' });
  assert.equal(state.enabled, false); assert.equal(state.manualHidden, false); assert.equal(state.progress, 0);
  assert.equal(scroll(state, 500, 200).progress, 0);
});

test('only the finite inclusive 0–6 CSS px reading edge clears manual dismissal', () => {
  const hidden = reduceNavigationVisibility(initial(), { type: 'dismiss' });
  assert.equal(NAVIGATION_REVEAL_EDGE_PX, 6);
  for (const y of [-1, -.001, 6.001, 16, 65, NaN, Infinity, -Infinity]) {
    assert.equal(reduceNavigationVisibility(hidden, { type: 'edge', y }), hidden);
  }
  for (const y of [0, .5, 5.999, 6]) {
    const shown = reduceNavigationVisibility(hidden, { type: 'edge', y });
    assert.equal(shown.manualHidden, false); assert.equal(shown.progress, 0); assert.equal(shown.durationMs, 380);
    assert.equal(shown.downAccum, 0); assert.equal(shown.upAccum, 0);
  }
});

test('ordinary automatic hiding can also be revealed by the narrow reading edge', () => {
  const hidden = scroll(initial(), 220, 100);
  assert.equal(hidden.manualHidden, false); assert.equal(hidden.progress, 1);
  assert.equal(reduceNavigationVisibility(hidden, { type: 'edge', y: 7 }), hidden);
  const shown = reduceNavigationVisibility(hidden, { type: 'edge', y: 6 });
  assert.equal(shown.progress, 0); assert.equal(shown.manualHidden, false);
});

test('explicit reveal clears the manual latch and establishes a fresh scroll threshold', () => {
  let state = reduceNavigationVisibility(scroll(initial(), 196, 100), { type: 'dismiss' });
  state = scroll(state, 400, 200);
  state = reduceNavigationVisibility(state, { type: 'reveal' });
  assert.equal(state.manualHidden, false); assert.equal(state.progress, 0); assert.equal(state.y, 400);
  state = scroll(state, 460, 300); assert.equal(state.downAccum, 60); assert.equal(state.progress, 0);
  state = scroll(state, 472, 400); assert.equal(state.progress, 0);
  state = scroll(state, 496, 500); assert.equal(state.progress, .5);
});

test('preference changes preserve manual intent; generic fresh reset retains its default semantics', () => {
  const hidden = reduceNavigationVisibility(initial(), { type: 'dismiss' });
  const disabled = reduceNavigationVisibility(hidden, { type: 'configure', enabled: false });
  assert.equal(disabled.enabled, false); assert.equal(disabled.progress, 1); assert.equal(disabled.manualHidden, true);
  const enabled = reduceNavigationVisibility(disabled, { type: 'configure', enabled: true });
  assert.equal(enabled.progress, 1); assert.equal(enabled.manualHidden, true);
  const pageChanged = reduceNavigationVisibility(enabled, { type: 'reset' });
  assert.equal(pageChanged.progress, 0); assert.equal(pageChanged.manualHidden, false); assert.equal(pageChanged.y, null);
  assert.equal(pageChanged.enabled, true);
});

test('reader/home/tab identity reset preserves manual dismissal while clearing scroll travel', () => {
  let state = reduceNavigationVisibility(initial(), { type: 'dismiss' });
  state = scroll(state, 700, 200);
  state = reduceNavigationVisibility(state, { type: 'reset', enabled: false, preserveDismissal: true });
  assert.equal(state.enabled, false); assert.equal(state.manualHidden, true); assert.equal(state.progress, 1);
  assert.equal(state.y, null); assert.equal(state.lastScrollAt, null); assert.equal(state.direction, 0);
  assert.equal(state.downAccum, 0); assert.equal(state.upAccum, 0); assert.equal(state.hideBase, 1);
  state = scroll(state, 0, 300); state = reduceNavigationVisibility(state, { type: 'focus' });
  assert.equal(state.progress, 1); assert.equal(state.manualHidden, true);
  state = reduceNavigationVisibility(state, { type: 'reset', enabled: true, preserveDismissal: true });
  assert.equal(state.progress, 1); assert.equal(state.manualHidden, true);
});

test('edge and explicit commands clear the dismissal before later reader identity changes', () => {
  for (const event of [{ type: 'edge', y: 5 }, { type: 'reveal' }] as const) {
    let state = reduceNavigationVisibility(initial(), { type: 'dismiss' });
    state = reduceNavigationVisibility(state, { type: 'reset', preserveDismissal: true });
    state = reduceNavigationVisibility(state, event);
    assert.equal(state.manualHidden, false); assert.equal(state.progress, 0);
    state = reduceNavigationVisibility(state, { type: 'reset', preserveDismissal: true });
    assert.equal(state.manualHidden, false); assert.equal(state.progress, 0); assert.equal(state.y, null);
  }
});

test('disabling automatic hide still reveals a toolbar hidden by ordinary scrolling', () => {
  const hidden = scroll(initial(), 220, 100);
  const disabled = reduceNavigationVisibility(hidden, { type: 'configure', enabled: false });
  assert.equal(disabled.manualHidden, false); assert.equal(disabled.progress, 0); assert.equal(disabled.enabled, false);
});

test('repeated dismiss is idempotent and cannot restart the closing animation', () => {
  const hidden = reduceNavigationVisibility(initial(), { type: 'dismiss' });
  assert.equal(reduceNavigationVisibility(hidden, { type: 'dismiss' }), hidden);
});
