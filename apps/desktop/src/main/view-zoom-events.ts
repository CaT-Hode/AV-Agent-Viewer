import type { ViewInfo } from '../../../../packages/contracts/src/index';
import type { ViewZoomDelta, ViewZoomRetired } from '../../../../packages/contracts/src/view-zoom';

export interface CoreViewEvent { seq: number; type: string; data: { viewId?: string } }

/** Capture during the synchronous event callback, before another command can
 * change its context. Sending a full ViewInfo would overwrite unrelated state. */
export function viewZoomEvent(event: CoreViewEvent, view?: ViewInfo): ViewZoomDelta | ViewZoomRetired | undefined {
  if (!Number.isSafeInteger(event.seq) || event.seq <= 0 || !event.data.viewId) return;
  if (event.type === 'view.closed') return { action: 'view-zoom-retired', seq: event.seq, viewId: event.data.viewId };
  if (event.type !== 'view.zoom' || !view || view.id !== event.data.viewId || !Number.isFinite(view.zoom) || view.zoom! < .25 || view.zoom! > 4) return;
  return { action: 'view-zoom-state', seq: event.seq, viewId: view.id, documentId: view.documentId, windowId: view.windowId, zoom: view.zoom!, context: view.context && structuredClone(view.context) };
}
