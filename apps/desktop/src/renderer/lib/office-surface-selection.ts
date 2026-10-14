import type { ReadingSnapshot, Rect } from '../../../../../packages/contracts/src/index';
import type { OfficeSurfaceSelectionProjection } from '../../../../../packages/contracts/src/office-surface';

export const OFFICE_SELECTION_EVENTS = { projection: 'agentviewer:office-surface-selection', ready: 'agentviewer:office-surface-selection-tools', dismiss: 'agentviewer:office-surface-selection-dismiss' } as const;
export type OfficeSelectionToolState = { snapshot: ReadingSnapshot; actions: { id: string; label: string; input: boolean }[] };
export type OfficeSelectionToolsEvent = { viewId: string; lease: string; visible: boolean; state?: OfficeSelectionToolState; rect?: Rect; viewport?: Rect; error?: string };
const validRect = (rect: Rect | undefined) => !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0;
export function isOfficeSelectionProjection(value: unknown): value is OfficeSurfaceSelectionProjection {
  if (!value || typeof value !== 'object') return false;
  const projection = value as OfficeSurfaceSelectionProjection;
  return [projection.viewId, projection.documentId, projection.sessionId, projection.engineEpoch].every(value => typeof value === 'string' && value.length > 0)
    && Number.isSafeInteger(projection.engineRevision) && projection.engineRevision >= 0 && Number.isSafeInteger(projection.layoutRevision) && projection.layoutRevision >= 0
    && (projection.selectionEpoch === undefined || Number.isSafeInteger(projection.selectionEpoch) && projection.selectionEpoch >= 0)
    && Array.isArray(projection.rects) && projection.rects.every(validRect) && validRect(projection.viewportCss) && validRect(projection.visibleTwips);
}
/** Scrolling and resizing change geometry, never the selected engine target lease. */
export function officeSelectionLease(projection: OfficeSurfaceSelectionProjection): string {
  const selection = projection.selection;
  return JSON.stringify([projection.viewId, projection.documentId, projection.sessionId, projection.engineEpoch, projection.engineRevision, projection.selectionEpoch ?? null, selection?.kind ?? 'none', selection?.text, selection?.locator, selection?.range, selection?.objectNames]);
}
export function officeSelectionSnapshotMatches(projection: OfficeSurfaceSelectionProjection, snapshot: ReadingSnapshot): boolean {
  const context = snapshot.context, native = context.nativeOffice, selection = projection.selection;
  return snapshot.document.id === projection.documentId && context.documentId === projection.documentId && context.viewId === projection.viewId && context.quality === 'confirmed'
    && !!native && native.sessionId === projection.sessionId && native.engineEpoch === projection.engineEpoch && native.engineRevision === projection.engineRevision
    && native.selectionEpoch === projection.selectionEpoch && !!selection && selection.kind !== 'none' && context.selection.kind === selection.kind && context.selection.text === selection.text;
}
export function officeSelectionRect(rects: Rect[]): Rect | undefined {
  const visible = rects.filter(rect => validRect(rect) && rect.width > 0 && rect.height > 0); if (!visible.length) return;
  const x = Math.min(...visible.map(rect => rect.x)), y = Math.min(...visible.map(rect => rect.y));
  return { x, y, width: Math.max(...visible.map(rect => rect.x + rect.width)) - x, height: Math.max(...visible.map(rect => rect.y + rect.height)) - y };
}

/** Engine snapshots are already authoritative. This bridge must never call report-context. */
export class OfficeSurfaceSelectionBridge {
  private alive = true;
  private sequence = 0;
  private current?: OfficeSurfaceSelectionProjection;
  private cached?: { lease: string; state: OfficeSelectionToolState };
  private dismissed?: string;
  private requested?: string;
  constructor(readonly viewId: string, private options: { request(viewId: string): Promise<OfficeSelectionToolState>; publish(event: OfficeSelectionToolsEvent): void }) {}
  private publish(visible: boolean, state?: OfficeSelectionToolState, error?: string) {
    if (!this.alive || !this.current) return;
    this.options.publish({ viewId: this.viewId, lease: officeSelectionLease(this.current), visible, state, rect: officeSelectionRect(this.current.rects), viewport: this.current.viewportCss, error });
  }
  update(value: unknown) {
    if (!this.alive || !isOfficeSelectionProjection(value) || value.viewId !== this.viewId) return;
    const previous = this.current;
    if (previous && previous.sessionId === value.sessionId && previous.engineEpoch === value.engineEpoch && (value.engineRevision < previous.engineRevision || value.engineRevision === previous.engineRevision && (value.selectionEpoch ?? 0) < (previous.selectionEpoch ?? 0))) return;
    const oldLease = previous && officeSelectionLease(previous), lease = officeSelectionLease(value); this.current = value;
    if (oldLease !== lease) { this.sequence++; this.requested = undefined; this.cached = undefined; this.dismissed = undefined; }
    if (!value.selection || value.selection.kind === 'none' || value.actor !== 'human' || !officeSelectionRect(value.rects) || this.dismissed === lease) { this.publish(false); return; }
    if (this.cached?.lease === lease) { this.publish(true, this.cached.state); return; }
    this.publish(false); if (this.requested === lease) return;
    this.requested = lease; const sequence = ++this.sequence;
    void this.options.request(this.viewId).then(state => {
      if (!this.alive || sequence !== this.sequence || !this.current || officeSelectionLease(this.current) !== lease || this.dismissed === lease) return;
      if (!officeSelectionSnapshotMatches(this.current, state.snapshot)) { this.requested = undefined; this.publish(false); return; }
      this.cached = { lease, state };
      this.publish(this.current.actor === 'human' && !!officeSelectionRect(this.current.rects), state);
    }).catch(cause => { if (this.alive && sequence === this.sequence) { this.requested = undefined; this.publish(false, undefined, cause instanceof Error ? cause.message : String(cause)); } });
  }
  dismiss(lease?: string) {
    if (!this.current || lease && lease !== officeSelectionLease(this.current)) return;
    this.dismissed = officeSelectionLease(this.current); this.sequence++; this.publish(false);
  }
  dispose() { this.publish(false); this.alive = false; this.sequence++; this.current = undefined; this.cached = undefined; }
}
