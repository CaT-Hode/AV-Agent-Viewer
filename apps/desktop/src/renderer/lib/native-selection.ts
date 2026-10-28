import type { ReadingContext, Rect } from '../../../../../packages/contracts/src/index';
import { placeSelectionToolbarWithYield } from './selection-position';

/** Human-only automation must be revalidated when an async snapshot returns:
 * an agent can acquire the same range without changing its text or geometry. */
export function humanNativeSelection(context:ReadingContext|undefined){
  return !!context&&context.actor==='human'&&!!context.selection.rect&&context.selection.kind!=='none'&&!!context.selection.text;
}

/** WebContentsView selection rectangles use its CSS viewport, not host pixels. */
export function nativeSelectionAnchor(context: ReadingContext, reader: Rect): Rect | undefined {
  const rect = context.selection.rect, viewport = context.viewport;
  if (!rect || !viewport?.width || !viewport.height) return;
  const sx = reader.width / viewport.width, sy = reader.height / viewport.height;
  return { x: reader.x + rect.x * sx, y: reader.y + rect.y * sy, width: rect.width * sx, height: rect.height * sy };
}
export function nativeSelectionKey(context: ReadingContext) {
  const { selection, viewport } = context, rect = selection.rect;
  return JSON.stringify([context.viewId, context.contentRevision, viewport?.navigationId, viewport?.layoutRevision, selection.kind, selection.text, selection.locator,
    rect && Math.round(rect.x + (viewport?.scrollX ?? 0)), rect && Math.round(rect.y + (viewport?.scrollY ?? 0))]);
}
export function nativeSelectionLayout(context: ReadingContext, reader: Rect, actionCount: number, obstacles: readonly Rect[] = []) {
  const anchor = nativeSelectionAnchor(context, reader); if (!anchor) return;
  const width = Math.min(600, (actionCount + 1) * 32 + 16, reader.width);
  const placement = placeSelectionToolbarWithYield(anchor, reader, { width, height: 46 },10,obstacles); if (!placement) return;
  return { x: placement.x - 8, y: placement.y - 8, width: placement.width + 16, height: 62 };
}
