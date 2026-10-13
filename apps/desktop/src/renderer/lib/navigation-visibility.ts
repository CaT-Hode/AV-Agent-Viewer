import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NAVIGATION_EDGE_REVEAL_PX } from '../../../../../packages/contracts/src/index';

export const NAVIGATION_SCROLL = {
  downThreshold: 72,
  hideTravel: 48,
  upThreshold: 16,
  jitter: 2,
  stopAfterMs: 400,
  top: 16,
} as const;
/** Distance from the reading viewport's top edge, in CSS pixels. */
export const NAVIGATION_REVEAL_EDGE_PX = NAVIGATION_EDGE_REVEAL_PX;

export type NavigationVisibilityState = {
  enabled: boolean;
  /** A user dismissal survives scrolling, hover, focus and preference changes. */
  manualHidden: boolean;
  /** Zero is fully shown; one is fully hidden. */
  progress: number;
  durationMs: number;
  y: number | null;
  lastScrollAt: number | null;
  direction: -1 | 0 | 1;
  downAccum: number;
  upAccum: number;
  hideBase: number;
  speed: number;
  focused: boolean;
  hovered: boolean;
};

export type NavigationVisibilityEvent =
  | { type: 'scroll'; y: number; now: number }
  | { type: 'reveal'; resetScrollAccum?: boolean }
  | { type: 'dismiss' }
  | { type: 'edge'; y: number }
  | { type: 'focus' | 'blur' | 'hover' | 'leave' | 'idle' }
  | { type: 'configure'; enabled: boolean }
  | { type: 'reset'; enabled?: boolean; preserveDismissal?: boolean };

export function createNavigationVisibilityState(enabled = true): NavigationVisibilityState {
  return { enabled, manualHidden: false, progress: 0, durationMs: 650, y: null, lastScrollAt: null, direction: 0, downAccum: 0, upAccum: 0, hideBase: 0, speed: 0, focused: false, hovered: false };
}

function resetTravel(state: NavigationVisibilityState) {
  return { ...state, direction: 0 as const, downAccum: 0, upAccum: 0, hideBase: state.progress, lastScrollAt: null, speed: 0 };
}

function speedDuration(speed: number) {
  // Travel still gates hiding. Velocity only changes the interpolation time.
  return Math.round(650 - 270 * Math.max(0, Math.min(1, (speed - .15) / 1.05)));
}
function inRevealEdge(y: number) { return Number.isFinite(y) && y >= 0 && y <= NAVIGATION_REVEAL_EDGE_PX; }

/** Pure reducer: all positions are CSS pixels and timestamps are monotonic ms. */
export function reduceNavigationVisibility(state: NavigationVisibilityState, event: NavigationVisibilityEvent): NavigationVisibilityState {
  if (event.type === 'reset') {
    const next = createNavigationVisibilityState(event.enabled ?? state.enabled);
    // A new reader resets its travel/position, not an application-level user
    // dismissal. Only the reading edge or an explicit command clears it.
    return event.preserveDismissal && state.manualHidden ? { ...next, manualHidden: true, progress: 1, hideBase: 1 } : next;
  }
  if (event.type === 'configure') {
    if (state.enabled === event.enabled) return state;
    const next = { ...state, enabled: event.enabled };
    // An auto-hide preference does not cancel the user's explicit dismissal.
    return event.enabled || state.manualHidden ? next : resetTravel({ ...next, progress: 0, durationMs: 380 });
  }
  if (event.type === 'dismiss') {
    if (state.manualHidden) return state;
    return resetTravel({ ...state, manualHidden: true, progress: 1, durationMs: 650, focused: false, hovered: false });
  }
  if (event.type === 'edge') {
    if (!inRevealEdge(event.y)) return state;
    return resetTravel({ ...state, manualHidden: false, progress: 0, durationMs: 380, hideBase: 0 });
  }
  if (event.type === 'focus' || event.type === 'hover') {
    if (state.manualHidden) return state;
    const next = resetTravel({ ...state, progress: 0, durationMs: event.type === 'focus' ? 0 : 380 });
    return { ...next, focused: event.type === 'focus' || state.focused, hovered: event.type === 'hover' || state.hovered };
  }
  if (event.type === 'blur' || event.type === 'leave') {
    return resetTravel({ ...state, focused: event.type === 'blur' ? false : state.focused, hovered: event.type === 'leave' ? false : state.hovered });
  }
  if (event.type === 'reveal') {
    const next = { ...state, manualHidden: false, progress: 0, durationMs: 380, hideBase: 0 };
    return event.resetScrollAccum === false ? next : resetTravel(next);
  }
  if (event.type === 'idle') {
    if (state.manualHidden || !state.enabled || state.focused || state.hovered || (state.y !== null && state.y <= NAVIGATION_SCROLL.top)) return state;
    return resetTravel({ ...state, progress: 1, durationMs: 650 });
  }
  if (event.type !== 'scroll') return state;
  if (!Number.isFinite(event.y) || !Number.isFinite(event.now)) return state;
  const y = Math.max(0, event.y);
  // Keep the real scroll baseline while latched, without an upward/top reveal.
  if (state.manualHidden) return { ...resetTravel(state), y, lastScrollAt: event.now };
  if (y <= NAVIGATION_SCROLL.top || !state.enabled || state.focused || state.hovered) {
    return { ...resetTravel({ ...state, progress: 0, durationMs: 380 }), y, lastScrollAt: event.now };
  }
  // The first report after a page switch establishes its restored position.
  if (state.y === null) return { ...state, y, lastScrollAt: event.now };
  const delta = y - state.y;
  if (Math.abs(delta) < NAVIGATION_SCROLL.jitter) return state;
  const stopped = state.lastScrollAt === null || event.now - state.lastScrollAt > NAVIGATION_SCROLL.stopAfterMs || event.now < state.lastScrollAt;
  const previous = stopped ? resetTravel(state) : state;
  const direction = delta > 0 ? 1 : -1;
  const elapsed = state.lastScrollAt === null || stopped ? 120 : Math.max(1, event.now - state.lastScrollAt);
  const speed = Math.abs(delta) / elapsed;
  const sameDirection = previous.direction === direction;
  const durationMs = speedDuration(speed);
  if (direction === -1) {
    const upAccum = (sameDirection ? previous.upAccum : 0) + Math.abs(delta);
    return { ...previous, y, lastScrollAt: event.now, direction, speed, durationMs, downAccum: 0, upAccum, hideBase: previous.progress, progress: upAccum >= NAVIGATION_SCROLL.upThreshold ? 0 : previous.progress };
  }
  const downAccum = (sameDirection ? previous.downAccum : 0) + delta;
  const hideBase = sameDirection ? previous.hideBase : previous.progress;
  const progress = Math.min(1, hideBase + Math.max(0, downAccum - NAVIGATION_SCROLL.downThreshold) / NAVIGATION_SCROLL.hideTravel);
  return { ...previous, y, lastScrollAt: event.now, direction, speed, durationMs, downAccum, upAccum: 0, hideBase, progress };
}

export type NavigationVisibilityOptions = { enabled: boolean; delayMs?: number; identity?: string | number };
export type NavigationRevealOptions = { resetScrollAccum?: boolean };

/** App owns this state; pass progress/duration/visible to its trusted native host. */
export function useNavigationVisibility({ enabled, delayMs = 2500, identity }: NavigationVisibilityOptions) {
  const state = useRef(createNavigationVisibilityState(enabled));
  const previousIdentity = useRef(identity);
  const options = useRef({ enabled, delayMs, identity });
  options.current = { enabled, delayMs, identity };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [display, setDisplay] = useState({ progress: 0, durationMs: 650, manualHidden: false });
  const transition = useCallback((event: NavigationVisibilityEvent) => {
    const next = reduceNavigationVisibility(state.current, event);
    state.current = next;
    setDisplay(previous => previous.progress === next.progress && previous.durationMs === next.durationMs && previous.manualHidden === next.manualHidden ? previous : { progress: next.progress, durationMs: next.durationMs, manualHidden: next.manualHidden });
    return next;
  }, []);
  const armIdle = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const current = state.current;
    if (current.manualHidden || !current.enabled || current.focused || current.hovered || current.progress >= 1 || (current.y !== null && current.y <= NAVIGATION_SCROLL.top)) return;
    const delay = Number.isFinite(options.current.delayMs) ? Math.max(0, options.current.delayMs) : 2500;
    timer.current = setTimeout(() => { timer.current = undefined; transition({ type: 'idle' }); }, delay);
  }, [transition]);
  const dispatch = useCallback((event: NavigationVisibilityEvent) => { transition(event); armIdle(); }, [transition, armIdle]);
  useLayoutEffect(() => {
    const identityChanged = previousIdentity.current !== identity;
    previousIdentity.current = identity;
    transition(identityChanged ? { type: 'reset', enabled, preserveDismissal: true } : { type: 'configure', enabled });
    armIdle();
    return () => clearTimeout(timer.current);
  }, [enabled, identity, transition, armIdle]);
  useEffect(() => { armIdle(); return () => clearTimeout(timer.current); }, [delayMs, armIdle]);
  const onScroll = useCallback((y: number, now = performance.now()) => dispatch({ type: 'scroll', y, now }), [dispatch]);
  const reveal = useCallback((value: NavigationRevealOptions = {}) => dispatch({ type: 'reveal', ...value }), [dispatch]);
  const dismiss = useCallback(() => dispatch({ type: 'dismiss' }), [dispatch]);
  // Ignore ordinary pointer motion entirely; it must not keep resetting idle.
  const revealFromEdge = useCallback((y: number) => { if (inRevealEdge(y)) dispatch({ type: 'edge', y }); }, [dispatch]);
  const onFocus = useCallback(() => dispatch({ type: 'focus' }), [dispatch]);
  const onBlur = useCallback(() => dispatch({ type: 'blur' }), [dispatch]);
  const onHover = useCallback(() => dispatch({ type: 'hover' }), [dispatch]);
  const onLeave = useCallback(() => dispatch({ type: 'leave' }), [dispatch]);
  return { visible: display.progress < 1, progress: display.progress, durationMs: display.durationMs, manualHidden: display.manualHidden, onScroll, reveal, dismiss, revealFromEdge, onFocus, onBlur, onHover, onLeave };
}
