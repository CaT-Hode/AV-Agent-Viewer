import type { ViewInfo, WorkspaceState } from '../../../../../packages/contracts/src/index';
import type { ViewZoomDelta } from '../../../../../packages/contracts/src/view-zoom';
import { sharePolledValue } from './polled-state';

const maxBufferedViews = 128, maxUnknownViews = 8;

function zoomDelta(value: Record<string, unknown>): value is Record<string, unknown> & ViewZoomDelta {
  if (value.action !== 'view-zoom-state' || !Number.isSafeInteger(value.seq) || Number(value.seq) <= 0 || typeof value.viewId !== 'string' || !value.viewId || typeof value.documentId !== 'string' || !value.documentId || typeof value.windowId !== 'string' || typeof value.zoom !== 'number' || !Number.isFinite(value.zoom) || value.zoom < .25 || value.zoom > 4) return false;
  const context = value.context as ViewZoomDelta['context'];
  return context === undefined || !!context && context.viewId === value.viewId && context.documentId === value.documentId && Number.isSafeInteger(context.contentRevision) && context.contentRevision >= 0 && Number.isSafeInteger(context.viewRevision) && context.viewRevision >= 0;
}

function project(view: ViewInfo, delta: ViewZoomDelta): ViewInfo {
  if (view.id !== delta.viewId || view.documentId !== delta.documentId || view.windowId !== delta.windowId) return view;
  // Context can advance without a new event when only capture freshness changes.
  // Never replace a newer selection/capture with the context of an older zoom.
  const newerContext = delta.context && (!view.context || delta.context.contentRevision >= view.context.contentRevision && delta.context.viewRevision >= view.context.viewRevision);
  const context = newerContext ? sharePolledValue(view.context, delta.context) : view.context;
  return view.zoom === delta.zoom && context === view.context ? view : { ...view, zoom: delta.zoom, context };
}

/** Immediate zoom deltas share the Core event sequence with full snapshots.
 * Keep eventsSeq as the last complete workspace: advancing it for one field
 * would falsely claim that document/task/activation updates were received. */
export class WorkspaceZoomProjection {
  private completeSeq = -1;
  private minimumSnapshotSeq = -1;
  private invalidationSeq = -1;
  private readonly pending = new Map<string, ViewZoomDelta>();
  private readonly retired = new Map<string, number>();

  constructor(private readonly windowId: string) {}

  /** A structural hint is not a complete state or an activation instruction.
   * Retain only its minimum read sequence so a slower old request cannot undo
   * an already announced open/activation/close. */
  invalidate(previous: WorkspaceState, event: Record<string, unknown>): boolean {
    if (event.action !== 'workspace-invalidated' || event.windowId !== this.windowId || !Number.isSafeInteger(event.seq) || Number(event.seq) <= Math.max(this.completeSeq, previous.eventsSeq, this.invalidationSeq)) return false;
    this.invalidationSeq = Number(event.seq); return true;
  }

  receive(previous: WorkspaceState, event: Record<string, unknown>): WorkspaceState {
    const covered = Math.max(this.completeSeq, this.minimumSnapshotSeq, previous.eventsSeq);
    if (event.action === 'view-zoom-retired') {
      if (typeof event.viewId !== 'string' || !event.viewId || !Number.isSafeInteger(event.seq) || Number(event.seq) <= covered) return previous;
      const seq = Number(event.seq);
      if (seq <= (this.retired.get(event.viewId) ?? -1)) return previous;
      this.pending.delete(event.viewId);
      this.retired.delete(event.viewId); this.retired.set(event.viewId, seq);
      this.minimumSnapshotSeq = Math.max(this.minimumSnapshotSeq, seq);
      while (this.retired.size > maxBufferedViews) this.retired.delete(this.retired.keys().next().value!);
      return previous;
    }
    if (!zoomDelta(event) || event.windowId !== this.windowId || event.seq <= covered || this.retired.has(event.viewId) || event.seq <= (this.pending.get(event.viewId)?.seq ?? -1)) return previous;
    const index = previous.views.findIndex(view => view.id === event.viewId), view = previous.views[index];
    if (view && (view.documentId !== event.documentId || view.windowId !== this.windowId)) { this.pending.delete(event.viewId); return previous; }
    this.pending.delete(event.viewId); this.pending.set(event.viewId, event);
    // A push may beat the first/open-file snapshot. Buffer only a few matching
    // owner identities, without inventing a view, document or active tab.
    const known = new Set(previous.views.filter(view => view.windowId === this.windowId).map(view => view.id));
    const unknown = [...this.pending.keys()].filter(id => !known.has(id));
    for (const id of unknown.slice(0, Math.max(0, unknown.length - maxUnknownViews))) this.pending.delete(id);
    while (this.pending.size > maxBufferedViews) {
      const id = this.pending.keys().next().value!, evicted = this.pending.get(id)!;
      // A bounded cache must not sacrifice the already-displayed zoom of an
      // evicted known view. Wait for a covering complete snapshot instead.
      if (known.has(id)) this.minimumSnapshotSeq = Math.max(this.minimumSnapshotSeq, evicted.seq);
      this.pending.delete(id);
    }
    if (!view) return previous;
    const nextView = project(view, event);
    if (nextView === view) return previous;
    const views = previous.views.slice(); views[index] = nextView;
    return { ...previous, views };
  }

  snapshot(previous: WorkspaceState, incoming: WorkspaceState): WorkspaceState {
    if (incoming.eventsSeq < Math.max(this.completeSeq, this.minimumSnapshotSeq, this.invalidationSeq, previous.eventsSeq)) return previous;
    this.completeSeq = incoming.eventsSeq;
    for (const [id, seq] of this.retired) if (seq <= this.completeSeq) this.retired.delete(id);
    let views = incoming.views;
    for (const [id, delta] of this.pending) {
      if (delta.seq <= incoming.eventsSeq) { this.pending.delete(id); continue; }
      const index = views.findIndex(view => view.id === id), view = views[index];
      if (!view) continue;
      if (view.documentId !== delta.documentId || view.windowId !== this.windowId) { this.pending.delete(id); continue; }
      const next = project(view, delta);
      if (next !== view) { if (views === incoming.views) views = views.slice(); views[index] = next; }
    }
    return sharePolledValue(previous, views === incoming.views ? incoming : { ...incoming, views });
  }
}
