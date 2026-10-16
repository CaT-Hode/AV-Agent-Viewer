/** One fetch flight may mix its last visible pixels with offscreen prefetch.
 * Track only initially missing visible keys; the final live check prevents an
 * intervening eviction/invalidation from announcing an incomplete viewport.
 * If that check fails, normal batch-end painting/retry remains authoritative. */
export function createOfficeVisibleTileCompletion(keys: readonly string[], has: (key: string) => boolean, current: () => boolean) {
  const required = [...new Set(keys)], missing = new Set(required.filter(key => !has(key)));
  let checked = missing.size === 0;
  return {
    /** Call only after successful cache admission. At most one completion edge
     * is checked per flight; halo and duplicate admissions are constant-time. */
    admitted(key: string): boolean {
      if (checked || !missing.delete(key) || missing.size > 0) return false;
      checked = true;
      return current() && required.every(has);
    },
  };
}
