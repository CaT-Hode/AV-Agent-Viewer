import type { Rect } from '../../../../../packages/contracts/src/index';

export type SelectionToolbarPosition = { x: number; y: number; width: number };
export type SelectionToolbarScene = { viewport: Rect; height: number; obstacles: readonly Rect[]; selection?: Rect; gap?: number };
const finiteRect = (rect: Rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
const sceneBlockers=(scene:SelectionToolbarScene)=>(scene.selection?[scene.selection,...scene.obstacles]:scene.obstacles).filter(finiteRect);

/** Shared by layout and every spring sample. Neither chrome nor the selected
 * text/caret can become a landing zone when the preferred position is blocked. */
export function selectionToolbarFits(position: SelectionToolbarPosition, scene: SelectionToolbarScene) {
  const { viewport, height, gap = 10 } = scene, inset = 8;
  return finiteRect(viewport) && [position.x, position.y, position.width, height, gap].every(Number.isFinite) && position.width > 0 && height > 0 && gap >= 0
    && position.x >= viewport.x + inset - 1e-6 && position.y >= viewport.y + inset - 1e-6
    && position.x + position.width <= viewport.x + viewport.width - inset + 1e-6 && position.y + height <= viewport.y + viewport.height - inset + 1e-6
    && sceneBlockers(scene).every(rect => position.x + position.width + gap <= rect.x + 1e-6 || position.x >= rect.x + rect.width + gap - 1e-6 || position.y + height + gap <= rect.y + 1e-6 || position.y >= rect.y + rect.height + gap - 1e-6);
}

/** Project an interrupted/overshooting pose back into the nearest legal region.
 * Width is already chosen by placement; changing it here would regenerate the
 * optical assets at every animation sample. */
export function constrainSelectionToolbar(position: SelectionToolbarPosition, scene: SelectionToolbarScene): SelectionToolbarPosition | undefined {
  if (selectionToolbarFits(position, scene)) return position;
  const { viewport, height, gap = 10 } = scene, width = position.width;
  if (!finiteRect(viewport) || ![position.x, position.y, width, height, gap].every(Number.isFinite) || width <= 0 || height <= 0 || gap < 0) return;
  const minX = viewport.x + 8, maxX = viewport.x + viewport.width - 8 - width, minY = viewport.y + 8, maxY = viewport.y + viewport.height - 8 - height;
  if (maxX < minX || maxY < minY) return;
  const clampX = (x: number) => Math.max(minX, Math.min(maxX, x)), clampY = (y: number) => Math.max(minY, Math.min(maxY, y));
  const blockers = sceneBlockers(scene), xs = [clampX(position.x), minX, maxX, ...blockers.flatMap(rect => [clampX(rect.x - width - gap), clampX(rect.x + rect.width + gap)])], ys = [clampY(position.y), minY, maxY, ...blockers.flatMap(rect => [clampY(rect.y - height - gap), clampY(rect.y + rect.height + gap)])];
  const candidates = ys.flatMap(y => xs.map(x => ({ x, y, width }))).filter(candidate => selectionToolbarFits(candidate, scene));
  candidates.sort((a, b) => (a.x - position.x) ** 2 + (a.y - position.y) ** 2 - (b.x - position.x) ** 2 - (b.y - position.y) ** 2);
  return candidates[0];
}

/** Collision test for the whole motion segment, rather than just its endpoint. */
export function selectionToolbarSegmentClear(from: SelectionToolbarPosition, to: SelectionToolbarPosition, scene: SelectionToolbarScene) {
  if (from.width !== to.width || !selectionToolbarFits(from, scene) || !selectionToolbarFits(to, scene)) return false;
  const gap = scene.gap ?? 10, epsilon = 1e-6;
  return sceneBlockers(scene).every(rect => {
    // Top-left points forbidden by the Minkowski sum of capsule + obstacle.
    const limits = [[rect.x - from.width - gap + epsilon, rect.x + rect.width + gap - epsilon, from.x, to.x - from.x], [rect.y - scene.height - gap + epsilon, rect.y + rect.height + gap - epsilon, from.y, to.y - from.y]];
    let enter = 0, exit = 1;
    for (const [low, high, origin, delta] of limits) {
      if (Math.abs(delta) < 1e-10) { if (origin <= low || origin >= high) return true; continue; }
      const a = (low - origin) / delta, b = (high - origin) / delta;
      enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
      if (enter >= exit) return true;
    }
    return enter >= exit;
  });
}

/** Short visibility-graph route around the real navigation and side panels.
 * A direct spring is preferred; at most four corners per obstacle are needed
 * when a diagonal would otherwise cut through a floating panel. */
export function selectionToolbarRoute(from: SelectionToolbarPosition, to: SelectionToolbarPosition, scene: SelectionToolbarScene): SelectionToolbarPosition[] | undefined {
  if (selectionToolbarSegmentClear(from, to, scene)) return [to];
  if (from.width !== to.width || !selectionToolbarFits(from, scene) || !selectionToolbarFits(to, scene)) return;
  const { viewport, height, gap = 10 } = scene;
  const clampX = (x: number) => Math.max(viewport.x + 8, Math.min(viewport.x + viewport.width - 8 - from.width, x)), clampY = (y: number) => Math.max(viewport.y + 8, Math.min(viewport.y + viewport.height - 8 - height, y));
  const points = [from, to];
  for (const rect of sceneBlockers(scene)) for (const x of [rect.x - from.width - gap, rect.x + rect.width + gap]) for (const y of [rect.y - height - gap, rect.y + rect.height + gap]) {
    const candidate = { x: clampX(x), y: clampY(y), width: from.width };
    if (selectionToolbarFits(candidate, scene) && !points.some(point => Math.abs(point.x - candidate.x) < 1e-6 && Math.abs(point.y - candidate.y) < 1e-6)) points.push(candidate);
  }
  const distance = points.map(() => Infinity), previous = points.map(() => -1), visited = new Set<number>(); distance[0] = 0;
  for (;;) {
    let current = -1;
    for (let index = 0; index < points.length; index++) if (!visited.has(index) && (current < 0 || distance[index] < distance[current])) current = index;
    if (current < 0 || !Number.isFinite(distance[current])) return;
    if (current === 1) break;
    visited.add(current);
    for (let next = 0; next < points.length; next++) {
      if (visited.has(next) || !selectionToolbarSegmentClear(points[current], points[next], scene)) continue;
      const cost = distance[current] + Math.hypot(points[next].x - points[current].x, points[next].y - points[current].y);
      if (cost < distance[next]) { distance[next] = cost; previous[next] = current; }
    }
  }
  const route: SelectionToolbarPosition[] = [];
  for (let index = 1; index !== 0; index = previous[index]) { if (index < 0) return; route.unshift(points[index]); }
  return route;
}

/** Keep the popover tied to the visible selection, including nested scrollers. */
export function placeSelectionToolbar(anchor: Rect, viewport: Rect, size: { width: number; height: number }, gap = 10, obstacles: readonly Rect[] = []) {
  if (![anchor.x, anchor.y, anchor.width, anchor.height, viewport.x, viewport.y, viewport.width, viewport.height, size.width, size.height].every(Number.isFinite)) return;
  const right = Math.min(anchor.x + anchor.width, viewport.x + viewport.width), bottom = Math.min(anchor.y + anchor.height, viewport.y + viewport.height);
  const left = Math.max(anchor.x, viewport.x), top = Math.max(anchor.y, viewport.y);
  if (right <= left || bottom <= top || size.width <= 0 || size.height <= 0) return;
  const inset = 8, width = Math.min(size.width, Math.max(1, viewport.width - inset * 2));
  if (viewport.width <= inset * 2 || viewport.height < size.height + inset * 2) return;
  const x = Math.max(viewport.x + inset, Math.min(viewport.x + viewport.width - width - inset, anchor.x + anchor.width / 2 - width / 2));
  const above = anchor.y - size.height - gap;
  const y = above >= viewport.y + inset ? above : Math.min(viewport.y + viewport.height - size.height - inset, anchor.y + anchor.height + gap);
  const preferred = { x, y: Math.max(viewport.y + inset, y), width };
  const scene={viewport,height:size.height,obstacles,selection:anchor,gap},blockers=sceneBlockers(scene);
  const fits = (candidate: {x:number;y:number;width:number}) => selectionToolbarFits(candidate,scene);
  if (fits(preferred)) return preferred;
  // Keep the nearest legal placement. Try the other selection edge before
  // moving around chrome, then compact the row into an available side lane.
  const ys = [above, bottom + gap, ...blockers.flatMap(rect => [rect.y + rect.height + gap, rect.y - size.height - gap]), viewport.y + inset, viewport.y + viewport.height - size.height - inset];
  const xs = [x, ...blockers.flatMap(rect => [rect.x - width - gap, rect.x + rect.width + gap]), viewport.x + inset, viewport.x + viewport.width - width - inset];
  const candidates = ys.flatMap(y => xs.map(x => ({x,y,width}))).filter(fits);
  candidates.sort((a,b) => Math.abs(a.y-preferred.y)+Math.abs(a.x-preferred.x)-Math.abs(b.y-preferred.y)-Math.abs(b.x-preferred.x));
  if (candidates.length) return candidates[0];
  // Intersect all free horizontal lanes at each candidate row. Looking at one
  // obstacle at a time can miss the narrow lane between selection and chrome.
  const compactCandidates:SelectionToolbarPosition[]=[];
  for(const y of ys){
    let lanes=[{x:viewport.x+inset,right:viewport.x+viewport.width-inset}];
    for(const rect of blockers){
      if(y+size.height+gap<=rect.y||y>=rect.y+rect.height+gap)continue;
      lanes=lanes.flatMap(lane=>rect.x-gap>=lane.right||rect.x+rect.width+gap<=lane.x?[lane]:[{x:lane.x,right:Math.min(lane.right,rect.x-gap)},{x:Math.max(lane.x,rect.x+rect.width+gap),right:lane.right}]).filter(lane=>lane.right-lane.x>=64);
    }
    for(const lane of lanes){const compact=Math.min(width,lane.right-lane.x),candidate={x:Math.max(lane.x,Math.min(lane.right-compact,x)),y,width:compact};if(fits(candidate))compactCandidates.push(candidate);}
  }
  compactCandidates.sort((a,b)=>Math.abs(a.y-preferred.y)+Math.abs(a.x-preferred.x)-Math.abs(b.y-preferred.y)-Math.abs(b.x-preferred.x)||b.width-a.width);
  return compactCandidates[0];
}

export const SELECTION_NAVIGATION_EVENT = 'agentviewer:selection-navigation-bounds';
export type SelectionNavigationBounds = { visible: boolean; bounds?: Rect };
/** Actual capsule geometry, rather than the full-width transparent host. */
export function readSelectionNavigationBounds(): Rect | undefined {
  const capsule = document.querySelector('.reader-toolbar:not([aria-hidden="true"]) .navigation-capsule');
  const rect = capsule?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
}

/** Read painted, transformed bounds: sidebar springs and drag previews do not
 * necessarily change their CSS width or the application setting yet. A native
 * sidebar's hidden owner anchor reserves the same space as its separate window
 * and remains an obstacle until that window has finished its exit. */
export function readSelectionPanelBounds(workbench = document.querySelector('.workbench')): Rect[] {
  if (!workbench) return [];
  return [...workbench.querySelectorAll<HTMLElement>(':scope > .floating-side-panel,:scope > .activity-rail,:scope > .ai-rail')].flatMap(node => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (node.dataset.panelAnchor === 'true' || getComputedStyle(node).visibility !== 'hidden') ? [{ x: box.x, y: box.y, width: box.width, height: box.height }] : [];
  });
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
