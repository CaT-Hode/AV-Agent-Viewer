/** Native retention must match this transition, not the preceding focus event. */
export function navigationExitDuration(current: unknown, previous: unknown): number {
  for (const value of [current, previous, 650]) {
    if (value === undefined || value === null) continue;
    const duration = Number(value);
    if (Number.isFinite(duration)) return Math.max(0, Math.min(900, duration));
  }
  return 650;
}

/** Accessibility modes shorten an already retained exit. Ordinary geometry/speed
 * updates keep its deadline: a CSS timing-token change alone does not retarget
 * an in-flight transition. Off must remove the transparent input surface now. */
export function retainedSurfaceExit(currentDuration: number, previousDuration: unknown): 'keep' | 'restart' | 'hide' {
  if (!(currentDuration > 0)) return 'hide';
  if (currentDuration > 80) return 'keep';
  return Number(previousDuration) === currentDuration ? 'keep' : 'restart';
}
