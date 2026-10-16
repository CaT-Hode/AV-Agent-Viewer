type LayoutRead = () => (() => void) | void;
const reads = new Map<number, LayoutRead>();
let frame = 0, serial = 0;

/** Share a frame between independent chrome surfaces: read all geometry
 * before any observer-triggered style/React writes can invalidate layout. */
export function scheduleLayoutRead(read: LayoutRead) {
  const id = ++serial; reads.set(id, read);
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0;
    const batch = [...reads.values()]; reads.clear();
    const writes = batch.map(measure => measure()).filter((write): write is () => void => !!write);
    for (const write of writes) write();
  });
  return () => { reads.delete(id); if (!reads.size && frame) { cancelAnimationFrame(frame); frame = 0; } };
}
