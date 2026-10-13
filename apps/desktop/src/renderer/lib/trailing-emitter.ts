type Timer = ReturnType<typeof setTimeout>;
type Timing = { now(): number; schedule(callback: () => void, delay: number): Timer; cancel(timer: Timer): void };
const defaultTiming: Timing = { now: () => performance.now(), schedule: (callback, delay) => setTimeout(callback, delay), cancel: clearTimeout };

/** Leading reports are bounded, but the last request is always sampled fresh. */
export function createTrailingEmitter<Args extends unknown[]>(interval: number, initial: (...args: Args) => void, timing: Timing = defaultTiming) {
  let emit = initial, last = -Infinity, timer: Timer | undefined, pending: Args | undefined;
  const cancel = () => { if (timer !== undefined) timing.cancel(timer); timer = undefined; pending = undefined; };
  const report = (args: Args) => { last = timing.now(); emit(...args); };
  return {
    update(callback: (...args: Args) => void) { emit = callback; },
    request(args: Args, force = false) {
      const remaining = interval - (timing.now() - last);
      if (force || remaining <= 0) { cancel(); report(args); return; }
      pending = args;
      if (timer === undefined) timer = timing.schedule(() => {
        timer = undefined; const latest = pending; pending = undefined;
        if (latest) report(latest);
      }, remaining);
    },
    cancel,
  };
}
