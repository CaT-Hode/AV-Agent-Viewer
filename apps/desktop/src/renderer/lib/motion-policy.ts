/** Shared renderer/native-host policy; contains no DOM, timers or React. */
export type MotionMode = 'standard' | 'elegant' | 'reduced' | 'off';
/** Renderer presence and native retained views must share this base. */
export const AI_POPOVER_MOTION_BASE_MS = 300;
/** Selection tools are direct manipulation feedback, including native hosts. */
export const SELECTION_POPOVER_MOTION_BASE_MS = 110;
export function resolveMotionMode(value: string | undefined, prefersReducedMotion = false): MotionMode {
  if (value === 'off') return 'off';
  if (prefersReducedMotion || value === 'reduced') return 'reduced';
  return value === 'elegant' ? 'elegant' : 'standard';
}
export function animatedMotion(mode: MotionMode) { return mode === 'standard' || mode === 'elegant'; }
export function motionDurationForMode(base: number, mode: MotionMode) {
  if (mode === 'off' || !(base > 0)) return 0;
  if (mode === 'reduced') return Math.min(80, base);
  return mode === 'elegant' ? Math.round(Math.max(420, Math.min(650, base * 2.6))) : Math.round(Math.min(650, base * 1.3));
}
