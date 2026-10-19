import { call, ready } from './transport';

/** One replayable SSE connection replaces the renderer's event polling loop.
 * A disconnected stream has a slow fallback; sequence gaps request a snapshot. */
export function subscribeWorkspaceEvents<T extends { seq: number }>(options: { after(): number; receive(events: T[]): void; resync(): void }) {
  let disposed = false, connected = false, source: EventSource | undefined, scheduled = false;
  let queue: T[] = [];
  let accepted = options.after();
  const flush = () => { scheduled = false; const events = queue; queue = []; if (!disposed && events.length) options.receive(events); };
  const receive = (event: T) => {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq <= Math.max(accepted, options.after())) return;
    if (accepted && event.seq !== accepted + 1) options.resync();
    accepted = event.seq;
    queue.push(event);
    if (queue.length > 1000) { queue = queue.slice(-1000); options.resync(); }
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  };
  void ready.then(() => {
    if (disposed) return;
    source = new EventSource('/internal/events?after=' + options.after(), { withCredentials: true });
    source.onopen = () => { connected = true; };
    source.onerror = () => { connected = false; };
    source.addEventListener('resync_required', () => options.resync());
    source.onmessage = message => { try { receive(JSON.parse(message.data) as T); } catch { options.resync(); } };
  }).catch(() => {});
  const timer = setInterval(() => {
    if (disposed || connected) return;
    void call<T[]>('events', { after: options.after() }).then(events => { if (!disposed) { for (const event of events) receive(event); options.resync(); } }).catch(() => {});
  }, 5000);
  return () => { disposed = true; clearInterval(timer); queue = []; source?.close(); };
}
