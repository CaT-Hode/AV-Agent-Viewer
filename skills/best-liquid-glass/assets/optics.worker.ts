// Extracted from AgentViewer apps/desktop/src/renderer/lib/liquid-glass-optics.worker.ts.
import { buildGlassOptics, type GlassWorkerRequest, type GlassWorkerResponse } from './optics-model';

let active: { id: number; cancelled: boolean } | undefined;
self.onmessage = async ({ data }: MessageEvent<GlassWorkerRequest>) => {
  if (data.type === 'cancel') { if (active?.id === data.id) active.cancelled = true; return; }
  const job = { id: data.id, cancelled: false }; active = job;
  try {
    const result = await buildGlassOptics(data.options, () => job.cancelled);
    self.postMessage({ id: job.id, result: job.cancelled ? undefined : result } satisfies GlassWorkerResponse);
  } catch (error) {
    self.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) } satisfies GlassWorkerResponse);
  } finally { if (active === job) active = undefined; }
};
