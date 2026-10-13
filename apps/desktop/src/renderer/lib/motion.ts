import { useSyncExternalStore } from 'react';
import { motionDurationForMode, resolveMotionMode } from './motion-policy';
export { motionDurationForMode, resolveMotionMode, animatedMotion, type MotionMode } from './motion-policy';

type Input = 'pointer' | 'keyboard';
let input: Input = 'pointer';
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;
const media = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-reduced-motion: reduce)');
const notify = () => listeners.forEach(listener => listener());
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { input = 'pointer'; document.documentElement.dataset.motionInput = input; notify(); }, true);
  document.addEventListener('keydown', () => { input = 'keyboard'; document.documentElement.dataset.motionInput = input; notify(); }, true);
}
export function motionSnapshot() { return `${resolveMotionMode(typeof document === 'undefined' ? undefined : document.documentElement.dataset.motion, media?.matches)}:${input}`; }
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer && typeof document !== 'undefined') { observer = new MutationObserver(notify); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] }); media?.addEventListener('change', notify); }
  return () => { listeners.delete(listener); if (!listeners.size) { observer?.disconnect(); observer = undefined; media?.removeEventListener('change', notify); } };
}
export function useMotionSnapshot() { return useSyncExternalStore(subscribe, motionSnapshot, motionSnapshot); }
export function motionDuration(base: number, snapshot = motionSnapshot(), keyboardImmediate = true) {
  const [mode, source] = snapshot.split(':');
  return keyboardImmediate && source === 'keyboard' ? 0 : motionDurationForMode(base, resolveMotionMode(mode));
}

/** Navigation already derives its timing from scroll speed; only accessibility limits it. */
export function navigationMotionDuration(base: number, snapshot = motionSnapshot()) {
  const mode = resolveMotionMode(snapshot.split(':')[0]);
  return mode === 'off' ? 0 : mode === 'reduced' ? Math.min(80, base) : base;
}
