/** The trusted Host may retain this independent JSON state, never the mutable runtime receipt. */
export function immutableOfficeObservation<T>(source: T): T {
  const copy = structuredClone(source);
  const freeze = (value: unknown) => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
