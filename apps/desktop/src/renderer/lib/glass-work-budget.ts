const listeners = new Set<(busy: boolean) => void>();
let observer: PerformanceObserver | undefined, timer: ReturnType<typeof setTimeout> | undefined, busy = false;
function publish(value: boolean) { if (busy !== value) { busy = value; for (const listener of listeners) listener(value); } }

/** During renderer stalls use the same CSS material shell. One observer is
 * shared by mounted optical surfaces and retires with the final subscriber. */
export function observeGlassBusy(listener: (busy: boolean) => void) {
  listeners.add(listener); listener(busy);
  if (!observer && typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    observer = new PerformanceObserver(list => {
      if (!list.getEntries().some(entry => entry.duration >= 80)) return;
      publish(true); clearTimeout(timer); timer = setTimeout(() => publish(false), 500);
    });
    observer.observe({ type: 'longtask' });
  }
  return () => { listeners.delete(listener); if (!listeners.size) { observer?.disconnect(); observer = undefined; clearTimeout(timer); timer = undefined; busy = false; } };
}
