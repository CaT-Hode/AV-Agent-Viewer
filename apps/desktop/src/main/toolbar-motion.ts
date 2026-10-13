/** Native retention must match this transition, not the preceding focus event. */
export function navigationExitDuration(current: unknown, previous: unknown): number {
  for (const value of [current, previous, 650]) {
    if (value === undefined || value === null) continue;
    const duration = Number(value);
    if (Number.isFinite(duration)) return Math.max(0, Math.min(900, duration));
  }
  return 650;
}
