/** Consume the originating home slot after an asynchronous open completes.
 * If that home was closed meanwhile, retain an existing target exactly where
 * it is rather than removing it and losing its place. */
export function replaceHomeTabSlot(order: readonly string[], homeId: string, viewId: string): string[] {
  const origin = order.indexOf(homeId);
  if (origin < 0) return order.includes(viewId) ? [...order] : [...order, viewId];
  return order.flatMap((id, index) => index === origin ? [viewId] : id === viewId ? [] : [id]);
}
