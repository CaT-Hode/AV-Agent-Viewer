import type { Rect } from '../../../../../packages/contracts/src/index';

/** Keep the popover tied to the visible selection, including nested scrollers. */
export function placeSelectionToolbar(anchor: Rect, viewport: Rect, size: { width: number; height: number }, gap = 10) {
  if (![anchor.x, anchor.y, anchor.width, anchor.height, viewport.x, viewport.y, viewport.width, viewport.height, size.width, size.height].every(Number.isFinite)) return;
  const right = Math.min(anchor.x + anchor.width, viewport.x + viewport.width), bottom = Math.min(anchor.y + anchor.height, viewport.y + viewport.height);
  const left = Math.max(anchor.x, viewport.x), top = Math.max(anchor.y, viewport.y);
  if (right <= left || bottom <= top || size.width <= 0 || size.height <= 0) return;
  const inset = 8, width = Math.min(size.width, Math.max(1, viewport.width - inset * 2));
  const x = Math.max(viewport.x + inset, Math.min(viewport.x + viewport.width - width - inset, anchor.x + anchor.width / 2 - width / 2));
  const above = anchor.y - size.height - gap;
  const y = above >= viewport.y + inset ? above : Math.min(viewport.y + viewport.height - size.height - inset, anchor.y + anchor.height + gap);
  return { x, y: Math.max(viewport.y + inset, y), width };
}

export function clippedReaderViewport(element: Element): Rect | undefined {
  const reader = element.closest('.document-content');
  if (!reader) return;
  let box = reader.getBoundingClientRect(), left = box.left, right = box.right, top = box.top, bottom = box.bottom;
  for (let node = element.parentElement; node && node !== reader; node = node.parentElement) {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
