export type OfficeNavigationTarget = { kind: 'slide'; slideId: string } | { kind: 'cell'; sheetId: string; address: string } | { kind: 'paragraph'; blockId: string } | { kind: 'html-heading'; blockId: string };
export type OfficeNavigationRequest = { requestId: string; viewId: string; documentId: string; expectedRevision: number; target: OfficeNavigationTarget; actor: 'agent' };
export type OfficeNavigationResult = { requestId: string; status: 'rendered' | 'failed'; error?: string };

export function parseOfficeNavigationRequest(value: unknown): OfficeNavigationRequest | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>, target = input.target as Record<string, unknown> | undefined;
  const identity = (field: unknown): field is string => typeof field === 'string' && field.length > 0 && field.length <= 200 && !/[\x00-\x20]/.test(field);
  if (!identity(input.requestId) || !identity(input.viewId) || !identity(input.documentId) || input.actor !== 'agent' || !Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 || !target) return;
  let location: OfficeNavigationTarget;
  if (target.kind === 'slide' && identity(target.slideId)) location = { kind: 'slide', slideId: target.slideId };
  else if (target.kind === 'paragraph' && identity(target.blockId)) location = { kind: 'paragraph', blockId: target.blockId };
  else if (target.kind === 'html-heading' && identity(target.blockId)) location = { kind: 'html-heading', blockId: target.blockId };
  else if (target.kind === 'cell' && identity(target.sheetId) && typeof target.address === 'string') {
    const address = target.address.toUpperCase(), match = /^([A-Z]+)([1-9]\d*)$/.exec(address);
    if (!match) return;
    let column = 0; for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
    if (column > 50 || Number(match[2]) > 1000) return;
    location = { kind: 'cell', sheetId: target.sheetId, address };
  } else return;
  return { requestId: input.requestId, viewId: input.viewId, documentId: input.documentId, expectedRevision: Number(input.expectedRevision), target: location, actor: 'agent' };
}

type OfficeClip = { left: number; top: number; right: number; bottom: number; gridHeaderBottom?: number; gridFrozenBottom?: number; gridHeaderRight?: number; gridFrozenRight?: number };
const clipsOverflow = (value: string) => /auto|scroll|hidden|clip/.test(value);
function fixedCellAxes(node: HTMLElement) {
  const cell = node.closest<HTMLElement>('td[data-address]'), style = cell && getComputedStyle(cell);
  return { x: style?.position === 'sticky' && !!style.left && style.left !== 'auto', y: style?.position === 'sticky' && !!style.top && style.top !== 'auto' };
}
/** Measure actual pinned headers once per context report, including CSS zoom. */
function officeGridClip(scroller: HTMLElement, clips: Map<HTMLElement, OfficeClip>) {
  let clip = clips.get(scroller);
  if (clip?.gridHeaderBottom !== undefined) return clip;
  const box = scroller.getBoundingClientRect(), scaleX = scroller.offsetWidth ? box.width / scroller.offsetWidth : 1, scaleY = scroller.offsetHeight ? box.height / scroller.offsetHeight : 1;
  const left = box.left + scroller.clientLeft * scaleX, top = box.top + scroller.clientTop * scaleY;
  clip = { left, top, right: left + scroller.clientWidth * scaleX, bottom: top + scroller.clientHeight * scaleY };
  const head = scroller.querySelector<HTMLElement>('thead th')?.getBoundingClientRect(), rowHead = scroller.querySelector<HTMLElement>('tbody th')?.getBoundingClientRect();
  clip.gridHeaderBottom = Math.min(clip.bottom, Math.max(top, head?.bottom ?? top));
  clip.gridHeaderRight = Math.min(clip.right, Math.max(left, rowHead?.right ?? left));
  clip.gridFrozenBottom = clip.gridHeaderBottom; clip.gridFrozenRight = clip.gridHeaderRight;
  for (const header of scroller.querySelectorAll<HTMLElement>('thead th[style],tbody th[style]')) {
    const rect = header.getBoundingClientRect();
    if (header.style.top && header.style.top !== 'auto') clip.gridFrozenBottom = Math.min(clip.bottom, Math.max(clip.gridFrozenBottom, rect.bottom));
    if (header.style.left && header.style.left !== 'auto') clip.gridFrozenRight = Math.min(clip.right, Math.max(clip.gridFrozenRight, rect.right));
  }
  clips.set(scroller, clip); return clip;
}
function cellReadingClip(node: HTMLElement, scroller: HTMLElement, clips: Map<HTMLElement, OfficeClip>) {
  const clip = officeGridClip(scroller, clips), fixed = fixedCellAxes(node);
  return { ...clip, top: fixed.y ? clip.gridHeaderBottom! : clip.gridFrozenBottom!, left: fixed.x ? clip.gridHeaderRight! : clip.gridFrozenRight!, fixed };
}

/** Visible DOM evidence obeys nested clips and excludes pinned row/column occlusion. */
export function officeNodeVisible(node: HTMLElement, root: HTMLElement, clips = new Map<HTMLElement, OfficeClip>()) {
  const box = node.getBoundingClientRect(), viewport = root.getBoundingClientRect();
  let left = Math.max(box.left, viewport.left, 0), top = Math.max(box.top, viewport.top, 0), right = Math.min(box.right, viewport.right, window.innerWidth), bottom = Math.min(box.bottom, viewport.bottom, window.innerHeight);
  if (right <= left || bottom <= top) return false;
  for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
    let clip = clips.get(parent);
    if (!clip) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
      clip = { left: clipsOverflow(style.overflowX) ? rect.left : -Infinity, right: clipsOverflow(style.overflowX) ? rect.right : Infinity, top: clipsOverflow(style.overflowY) ? rect.top : -Infinity, bottom: clipsOverflow(style.overflowY) ? rect.bottom : Infinity };
      clips.set(parent, clip);
    }
    left = Math.max(left, clip.left); right = Math.min(right, clip.right); top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
    if (right <= left || bottom <= top) return false;
  }
  const scroller = node.closest<HTMLElement>('.office-grid-scroll');
  if (scroller && node.closest('td[data-address]')) {
    const clip = cellReadingClip(node, scroller, clips);
    left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
  }
  if (right <= left || bottom <= top) return false;
  return true;
}

export function scrollOfficeCell(node: HTMLElement) {
  const scroller = node.closest<HTMLElement>('.office-grid-scroll'); if (!scroller) return;
  const box = node.getBoundingClientRect(), clip = cellReadingClip(node, scroller, new Map());
  const delta = (start: number, end: number, min: number, max: number) => max <= min ? 0 : start < min || end - start > max - min ? start - min : end > max ? end - max : 0;
  // The scroll container is unzoomed; its table may be zoomed, and these are
  // already the actual CSS-pixel edges. Pinned target axes must never scroll.
  if (!clip.fixed.y) scroller.scrollTop += delta(box.top, box.bottom, clip.top, clip.bottom);
  if (!clip.fixed.x) scroller.scrollLeft += delta(box.left, box.right, clip.left, clip.right);
}
