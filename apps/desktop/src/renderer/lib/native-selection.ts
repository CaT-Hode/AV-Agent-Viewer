import type { ReadingContext, Rect } from '../../../../../packages/contracts/src/index';
import { placeSelectionToolbar } from './selection-position';

/** Human-only automation must be revalidated when an async snapshot returns:
 * an agent can acquire the same range without changing its text or geometry. */
export function humanNativeSelection(context:ReadingContext|undefined){
  return !!context&&context.actor==='human'&&!!context.selection.rect&&context.selection.kind!=='none'&&!!context.selection.text;
}

/** Selection rectangles from a native surface use its CSS viewport, not host pixels. */
export function nativeSelectionAnchor(context: ReadingContext, reader: Rect): Rect | undefined {
  const rect = context.selection.rect, viewport = context.viewport;
  if (!rect || !viewport?.width || !viewport.height) return;
  const sx = reader.width / viewport.width, sy = reader.height / viewport.height;
  return { x: reader.x + rect.x * sx, y: reader.y + rect.y * sy, width: rect.width * sx, height: rect.height * sy };
}
export function nativeSelectionKey(context: ReadingContext) {
  // Native selection identity belongs to the engine's range lease. Its screen
  // rectangle and layout change while scrolling, without changing that range.
  const native = context.nativeOffice;
  if (native) return JSON.stringify([context.viewId, context.contentRevision, native.sessionId, native.engineEpoch,
    native.engineRevision, native.selectionEpoch, context.selection.kind, context.selection.text, context.selection.locator]);
  const { selection, viewport } = context, rect = selection.rect;
  return JSON.stringify([context.viewId, context.contentRevision, viewport?.navigationId, viewport?.layoutRevision, selection.kind, selection.text, selection.locator,
    rect && Math.round(rect.x + (viewport?.scrollX ?? 0)), rect && Math.round(rect.y + (viewport?.scrollY ?? 0))]);
}
export function nativeSelectionLayout(context: ReadingContext, reader: Rect, actionCount: number, surface:Rect=reader, obstacles: readonly Rect[] = []) {
  const anchor = nativeSelectionAnchor(context, surface); if (!anchor) return;
  const width = Math.min(600, (actionCount + 1) * 32 + 16, reader.width);
  const placement = placeSelectionToolbar(anchor, reader, { width, height: 46 },10,obstacles); if (!placement) return;
  return { x: placement.x - 8, y: placement.y - 8, width: placement.width + 16, height: 62 };
}
