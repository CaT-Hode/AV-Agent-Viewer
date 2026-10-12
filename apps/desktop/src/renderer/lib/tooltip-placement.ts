export type TooltipRect = { x: number; y: number; width: number; height: number };
export type TooltipSize = { width: number; height: number };
export type TooltipPlacement = { x: number; y: number; above: boolean };
export type NativeTooltipPointer = { x: number; y: number; screenX: number; screenY: number; offsetY: number };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(Math.max(low, high), value));
/** Moving a native view's origin can re-hit-test its last client coordinates
 * without moving the physical pointer. Only that offset change is corrected;
 * real screen movement or a point outside the original target is never kept. */
export function isNativeTooltipRelocation(current: NativeTooltipPointer, previous: NativeTooltipPointer | undefined, target: TooltipRect) {
  if (!previous || !Object.values(current).every(Number.isFinite) || !Object.values(previous).every(Number.isFinite) || !Object.values(target).every(Number.isFinite)) return false;
  if (current.offsetY === previous.offsetY || current.screenX !== previous.screenX || current.screenY !== previous.screenY) return false;
  const x = previous.x, y = previous.y + current.offsetY - previous.offsetY;
  return target.width > 0 && target.height > 0 && x >= target.x && x < target.x + target.width && y >= target.y && y < target.y + target.height;
}
/** CSS-pixel placement uses the measured bubble, not a guessed width. */
export function placeTooltip(anchor: TooltipRect, size: TooltipSize, viewport: TooltipSize, gap = 7, margin = 6): TooltipPlacement {
  const below = viewport.height - margin - anchor.y - anchor.height - gap;
  const above = below < size.height && anchor.y - gap - margin > below;
  return { x: clamp(anchor.x + anchor.width / 2 - size.width / 2, margin, viewport.width - size.width - margin), y: clamp(above ? anchor.y - gap - size.height : anchor.y + anchor.height + gap, margin, viewport.height - size.height - margin), above };
}
/** Native bounds are DIP; DOM rectangles are CSS pixels. DPR is not involved.
 * Add empty viewport space while preserving the control's owner position. */
export function nativeTooltipLayout(anchor: TooltipRect, size: TooltipSize, current: TooltipRect, base: TooltipRect, owner: TooltipSize, zoom = 1) {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const globalAnchor = { x: current.x / factor + anchor.x, y: current.y / factor + anchor.y, width: anchor.width, height: anchor.height };
  const placed = placeTooltip(globalAnchor, size, { width: owner.width / factor, height: owner.height / factor });
  placed.x = clamp(placed.x, base.x / factor + 6, (base.x + base.width) / factor - size.width - 6);
  const top = Math.max(0, Math.floor(Math.min(base.y, (placed.y - 6) * factor)));
  const bottom = Math.min(owner.height, Math.ceil(Math.max(base.y + base.height, (placed.y + size.height + 6) * factor)));
  const bounds = { x: base.x, y: top, width: base.width, height: Math.max(1, bottom - top) };
  return { bounds, offsetY: (base.y - top) / factor, placement: { x: placed.x - bounds.x / factor, y: placed.y - bounds.y / factor, above: placed.above } };
}
