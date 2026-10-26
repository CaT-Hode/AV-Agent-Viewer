// Extracted from AgentViewer apps/desktop/src/renderer/lib/liquid-glass-optics.ts.
import { glassOpticsKey, type GlassOptics, type GlassOpticsBlobs, type GlassOpticsOptions, type GlassWorkerResponse } from './optics-model';
export { glassOpticsKey, glassGeometryStyleSignature, readGlassRadii, normalizeGlassRadii, glassRoundedPath, glassBoundary, glassBevelDisplacement } from './optics-model';
export type { GlassProfile, GlassRadius, GlassRadii, GlassGeometry, GlassOpticsOptions, GlassOptics } from './optics-model';

export const GLASS_OPTICS_CACHE_LIMITS = { entries: 64, decodedBytes: 64 * 1024 * 1024, encodedBytes: 8 * 1024 * 1024, pending: 12 } as const;
export type GlassOpticsLease = { optics: GlassOptics; release(): void };
type Asset = { optics: GlassOptics; decodedBytes: number; encodedBytes: number; references: number };
type Consumer = { complete(lease?: GlassOpticsLease): void };
type Job = { id: number; key: string; options: GlassOpticsOptions; decodedBytes: number; consumers: Set<Consumer> };
const cache = new Map<string, Asset>(), pending = new Map<string, Job>();
const counters = { hits: 0, builds: 0, evictions: 0, encodedBytes: 0, decodedBytes: 0, generatedPixels: 0, pngEncodes: 0, canceled: 0, fallbacks: 0 };
let worker: Worker | undefined, unavailable = false, serial = 0, running: Job | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;

/** Retained asset/decode estimates, excluding Chromium's separate GPU caches. */
export function glassOpticsCacheStats() { return { ...counters, entries: cache.size, pending: pending.size, running: !!running, workerAvailable: !unavailable }; }
function discard(key: string, asset: Asset) {
  cache.delete(key);
  for (const url of [asset.optics.map, asset.optics.highlight, asset.optics.centerMap]) if (url) URL.revokeObjectURL(url);
  counters.decodedBytes -= asset.decodedBytes; counters.encodedBytes -= asset.encodedBytes; counters.evictions++;
}
function makeRoom(decodedBytes = 0, encodedBytes = 0, entries = 0) {
  for (const [key, asset] of cache) {
    if (cache.size + entries <= GLASS_OPTICS_CACHE_LIMITS.entries && counters.decodedBytes + decodedBytes <= GLASS_OPTICS_CACHE_LIMITS.decodedBytes && counters.encodedBytes + encodedBytes <= GLASS_OPTICS_CACHE_LIMITS.encodedBytes) break;
    if (!asset.references) discard(key, asset);
  }
  return cache.size + entries <= GLASS_OPTICS_CACHE_LIMITS.entries && counters.decodedBytes + decodedBytes <= GLASS_OPTICS_CACHE_LIMITS.decodedBytes && counters.encodedBytes + encodedBytes <= GLASS_OPTICS_CACHE_LIMITS.encodedBytes;
}
function lease(asset: Asset): GlassOpticsLease {
  asset.references++;
  let released = false;
  return { optics: asset.optics, release() { if (!released) { released = true; asset.references--; makeRoom(); } } };
}
function finish(job: Job, asset?: Asset) {
  if (pending.get(job.key) === job) pending.delete(job.key);
  if (running === job) { running = undefined; clearTimeout(watchdog); watchdog = undefined; }
  for (const consumer of job.consumers) consumer.complete(asset ? lease(asset) : undefined);
  job.consumers.clear();
}
function stopWorker() {
  unavailable = true; worker?.terminate(); worker = undefined;
  for (const job of [...pending.values()]) { counters.fallbacks++; finish(job); }
  if (running) finish(running);
}
function materialize(blobs: GlassOpticsBlobs): GlassOptics {
  return { ...blobs, map: URL.createObjectURL(blobs.map), highlight: URL.createObjectURL(blobs.highlight), centerMap: blobs.centerMap ? URL.createObjectURL(blobs.centerMap) : undefined };
}
function engine() {
  if (unavailable) return;
  if (worker) return worker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') { unavailable = true; return; }
  try {
    worker = new Worker(new URL('./optics.worker.ts', import.meta.url), { type: 'module', name: 'glass-optics' });
    worker.onmessage = ({ data }: MessageEvent<GlassWorkerResponse>) => {
      const job = running;
      if (!job || job.id !== data.id) return;
      if (data.error) { stopWorker(); return; }
      const result = data.result;
      if (result && job.consumers.size) {
        const blobs = result.optics;
        const encodedBytes = blobs.map.size + blobs.highlight.size + (blobs.centerMap?.size ?? 0) + (blobs.ring.length + blobs.centerClip.length) * 2;
        if (makeRoom(job.decodedBytes, encodedBytes, 1)) {
          const asset = { optics: materialize(blobs), decodedBytes: job.decodedBytes, encodedBytes, references: 0 };
          cache.set(job.key, asset); counters.decodedBytes += asset.decodedBytes; counters.encodedBytes += encodedBytes;
          counters.generatedPixels += result.pixels; counters.pngEncodes += result.pngEncodes;
          finish(job, asset);
        } else { counters.fallbacks++; finish(job); }
      } else finish(job);
      drain();
    };
    worker.onerror = event => { event.preventDefault(); stopWorker(); };
    worker.onmessageerror = stopWorker;
    return worker;
  } catch { stopWorker(); }
}
function drain() {
  if (running) return;
  const job = pending.values().next().value as Job | undefined;
  if (!job) return;
  const target = engine();
  if (!target) { for (const waiting of [...pending.values()]) { counters.fallbacks++; finish(waiting); } return; }
  if (!makeRoom(job.decodedBytes)) { counters.fallbacks++; finish(job); drain(); return; }
  running = job; counters.builds++;
  // A failed/unresponsive worker must leave a usable CSS surface, never a
  // waiting control or a second synchronous renderer implementation.
  watchdog = setTimeout(stopWorker, 5000);
  try { target.postMessage({ type: 'build', id: job.id, options: job.options }); } catch { stopWorker(); }
}

/** Shared, cancellable requests. The mounted surface owns its returned lease;
 * revocation happens only after both cache ownership and live references end. */
export function requestGlassOptics(options: GlassOpticsOptions, signal?: AbortSignal): Promise<GlassOpticsLease | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  const key = glassOpticsKey(options), cached = cache.get(key);
  if (cached) { counters.hits++; cache.delete(key); cache.set(key, cached); return Promise.resolve(lease(cached)); }
  const pixels = Math.ceil((options.width + options.overscan * 2) * options.density) * Math.ceil((options.height + options.overscan * 2) * options.density);
  const decodedBytes = pixels * 4 * (options.profile === 'lens' ? 3 : 2);
  if (unavailable || !Number.isFinite(decodedBytes) || decodedBytes <= 0 || decodedBytes > GLASS_OPTICS_CACHE_LIMITS.decodedBytes) { counters.fallbacks++; return Promise.resolve(undefined); }
  let job = pending.get(key);
  if (!job) {
    if (pending.size >= GLASS_OPTICS_CACHE_LIMITS.pending) { counters.fallbacks++; return Promise.resolve(undefined); }
    job = { id: ++serial, key, options, decodedBytes, consumers: new Set() }; pending.set(key, job);
  }
  const requested = job;
  return new Promise(resolve => {
    const consumer: Consumer = { complete(result) { signal?.removeEventListener('abort', cancel); resolve(result); } };
    const cancel = () => {
      requested.consumers.delete(consumer); consumer.complete();
      if (!requested.consumers.size) {
        if (pending.get(key) === requested) pending.delete(key);
        counters.canceled++;
        if (running === requested) worker?.postMessage({ type: 'cancel', id: requested.id });
      }
    };
    requested.consumers.add(consumer); signal?.addEventListener('abort', cancel, { once: true }); drain();
  });
}
