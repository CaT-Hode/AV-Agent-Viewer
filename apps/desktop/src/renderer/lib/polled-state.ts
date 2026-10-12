/** Preserve references in JSON-like poll results without omitting any fields.
 * Revisions alone are insufficient: save metadata, selection, context freshness,
 * streamed tasks and future model fields can change independently of a revision.
 */
export function sharePolledValue<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next)) return next;
    let changed = previous.length !== next.length;
    let shared: unknown[] | undefined;
    for (let index = 0; index < next.length; index++) {
      const item = sharePolledValue(previous[index], next[index]);
      if (!Object.is(item, previous[index])) changed = true;
      if (!Object.is(item, next[index])) { shared ??= next.slice(); shared[index] = item; }
    }
    return (changed ? shared ?? next : previous) as T;
  }
  // Poll contracts contain plain records. Keep unfamiliar object types intact
  // rather than calling two Dates/typed arrays equal because they have no keys.
  const previousPrototype = Object.getPrototypeOf(previous), nextPrototype = Object.getPrototypeOf(next);
  if (previousPrototype !== nextPrototype || (nextPrototype !== Object.prototype && nextPrototype !== null)) return next;
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let changed = Object.keys(before).length !== keys.length;
  let shared: Record<string, unknown> | undefined;
  for (const key of keys) {
    const present = Object.prototype.hasOwnProperty.call(before, key);
    const value = present ? sharePolledValue(before[key], after[key]) : after[key];
    if (!present || !Object.is(value, before[key])) changed = true;
    if (!Object.is(value, after[key])) { shared ??= { ...after }; shared[key] = value; }
  }
  return (changed ? shared ?? next : previous) as T;
}
