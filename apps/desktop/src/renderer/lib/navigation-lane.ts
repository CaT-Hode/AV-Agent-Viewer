import { scheduleLayoutRead } from './layout-frame';
import { FLOATING_HITBOX_EVENT, floatingHitboxes, planFloatingRoom } from './floating-hitboxes';

export type NavigationLane = { left: number; right: number; width: number; center: number };
type Rect = { left: number; right: number };
const reservationProperties = ['--navigation-reservation-left','--navigation-reservation-right','--sidebar-space-scale-x'];

/** The pane's requested geometry, before its presence scale. Measuring its
 * current transformed box here would continually move the navigation target. */
export function panelLayoutBounds(panel: HTMLElement) {
  const parent = panel.offsetParent as HTMLElement | null;
  if (!parent) return panel.getBoundingClientRect();
  const box = parent.getBoundingClientRect(), sx = box.width / (parent.offsetWidth || box.width || 1), sy = box.height / (parent.offsetHeight || box.height || 1);
  const left = box.left + (parent.clientLeft + panel.offsetLeft - parent.scrollLeft) * sx;
  const top = box.top + (parent.clientTop + panel.offsetTop - parent.scrollTop) * sy;
  return {left,right:left + panel.offsetWidth * sx,top,bottom:top + panel.offsetHeight * sy,width:panel.offsetWidth * sx,height:panel.offsetHeight * sy,sx};
}
const panelCache = new WeakMap<Element, HTMLElement[]>();
function readingPanels(reader: HTMLElement) {
  const workbench = reader.closest('.workbench'); if (!workbench) return [];
  let panels = panelCache.get(workbench);
  if (!panels) { panels = [...workbench.querySelectorAll<HTMLElement>(':scope > .floating-side-panel')]; panelCache.set(workbench, panels); }
  return panels;
}
function localLane(reader: DOMRect, lane: NavigationLane) { return {...lane,left:lane.left-reader.left,right:lane.right-reader.left,center:lane.center-reader.left}; }
function clearFloatingLane(box:DOMRect,lane:NavigationLane){
  // Only the managed selection-translation card reserves navigation space.
  // Tooltips inherit their trigger's group for other consumers, but even a
  // translation button's tooltip must not move or shrink the navigation.
  const obstacles=floatingHitboxes().filter(item=>item.group==='translation'&&item.id.startsWith('translation:')&&item.bounds.y<box.top+80&&item.bounds.y+item.bounds.height>box.top+4);
  if(!obstacles.length)return lane;
  let lanes=[{left:lane.left,right:lane.right}];
  for(const {bounds} of obstacles)lanes=lanes.flatMap(item=>bounds.x-8>=item.right||bounds.x+bounds.width+8<=item.left?[item]:[{left:item.left,right:Math.min(item.right,bounds.x-8)},{left:Math.max(item.left,bounds.x+bounds.width+8),right:item.right}]).filter(item=>item.right>item.left);
  lanes.sort((a,b)=>(b.right-b.left)-(a.right-a.left)||Math.abs((a.left+a.right)/2-lane.center)-Math.abs((b.left+b.right)/2-lane.center));
  const best=lanes[0];
  if(best&&best.right-best.left>=68)return {...best,width:best.right-best.left,center:(best.left+best.right)/2};
  const plan=planFloatingRoom({x:lane.center-110,y:box.top+12,width:Math.min(220,lane.width),height:60},{x:lane.left,y:box.top+12,width:lane.width,height:60},obstacles);
  if(plan){for(const change of plan.yields)obstacles.find(item=>item.id===change.id)?.yield?.(change.bounds);const room=plan.bounds;return {left:room.x,right:room.x+room.width,width:room.width,center:room.x+room.width/2};}
  return best?{...best,width:best.right-best.left,center:(best.left+best.right)/2}:{left:lane.center,right:lane.center,width:0,center:lane.center};
}

/** Entering panes announce their final width immediately. A closing pane keeps
 * its reservation until removal: navigation can then grow without racing it. */
export function readNavigationTargetLane(reader: HTMLElement): NavigationLane {
  const box = reader.getBoundingClientRect();
  const panels = readingPanels(reader).flatMap(panel => {
    const side = panel.dataset.side, bounds = panelLayoutBounds(panel);
    if ((side !== 'left' && side !== 'right') || bounds.width <= 0 || bounds.height <= 0 || getComputedStyle(panel).display === 'none' || bounds.bottom <= box.top + 12 || bounds.top >= box.top + 72) return [];
    return [{side,bounds} as {side:'left'|'right';bounds:Rect}];
  });
  return localLane(box,clearFloatingLane(box,navigationLane(box,panels)));
}

/** Only the pane's visible shape yields to the continuously moving capsule.
 * This does not clip the capsule, resize the canvas, or change pane contents. */
export function sidebarNavigationScale(side:'left'|'right', panel:Rect, navigation:Rect, translation=0, gap=12) {
  const width = panel.right-panel.left;
  if (width <= 0) return 0;
  const space = side === 'left' ? navigation.left-gap-panel.left-translation : panel.right+translation-navigation.right-gap;
  return Math.max(0,Math.min(1.12,space/width));
}
function setVariable(element:HTMLElement,name:string,value:string) { if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name,value); }
/** Coordinates are reader-local CSS pixels. The trusted Web toolbar forwards
 * the same actual capsule bounds, rather than its full transparent window. */
export function prepareSidebarNavigationReservation(reader:HTMLElement,left:number,right:number,box=reader.getBoundingClientRect()) {
  const updates = readingPanels(reader).flatMap(panel => {
    const side = panel.dataset.side; if (side !== 'left' && side !== 'right') return [];
    const bounds = panelLayoutBounds(panel), sx = 'sx' in bounds ? bounds.sx : 1;
    const translation = (Number.parseFloat(panel.style.getPropertyValue('--sidebar-spring-x')) || 0) * sx;
    const scale = sidebarNavigationScale(side,bounds,{left:box.left+left,right:box.left+right},translation,12*sx);
    return [{panel,scale:scale.toFixed(6)}];
  });
  // Read every pane before writing reservation variables. Their CSS can
  // affect transformed bounds, so interleaving these creates forced layout.
  return () => {
    setVariable(reader,'--navigation-reservation-left',left.toFixed(3)+'px');
    setVariable(reader,'--navigation-reservation-right',right.toFixed(3)+'px');
    for (const {panel,scale} of updates) setVariable(panel,'--sidebar-space-scale-x',scale);
  };
}
export function syncSidebarNavigationReservation(reader:HTMLElement,left:number,right:number) { prepareSidebarNavigationReservation(reader,left,right)(); }
export function clearSidebarNavigationReservation(reader:HTMLElement) {
  for (const name of reservationProperties.slice(0,2)) reader.style.removeProperty(name);
  for (const panel of readingPanels(reader)) panel.style.removeProperty('--sidebar-space-scale-x');
}
/** Presence/drag style changes need observation; our own reservation paint
 * writes do not. Ignoring those avoids observer -> style -> observer loops. */
function withoutReservation(style:string|null) { return (style??'').split(';').filter(part => !reservationProperties.some(name => part.trim().startsWith(name+':'))).join(';'); }

/** Space belongs to the real reading canvas. Only chrome avoids the panes;
 * the document keeps the same full-width viewport underneath them. */
export function navigationLane(reader: Rect, panels: { side: 'left' | 'right'; bounds: Rect }[] = []): NavigationLane {
  let left = reader.left, right = reader.right;
  for (const panel of panels) {
    if (panel.side === 'left') left = Math.max(left, panel.bounds.right);
    else right = Math.min(right, panel.bounds.left);
  }
  const space = Math.max(0, right - left), inset = Math.min(12, Math.max(0, (space - 32) / 2));
  left += inset; right -= inset;
  const width = Math.max(0, right - left);
  return { left, right, width, center: left + width / 2 };
}
export function readNavigationLane(reader: HTMLElement): NavigationLane {
  const box = reader.getBoundingClientRect(), workbench = reader.closest('.workbench');
  const panels = [...(workbench?.querySelectorAll<HTMLElement>(':scope > .floating-side-panel') ?? [])].flatMap(panel => {
    const side = panel.dataset.side, bounds = panel.getBoundingClientRect();
    if ((side !== 'left' && side !== 'right') || bounds.width <= 0 || bounds.height <= 0 || getComputedStyle(panel).display === 'none') return [];
    if (bounds.bottom <= box.top + 12 || bounds.top >= box.top + 72) return [];
    return [{ side, bounds } as { side:'left'|'right'; bounds: DOMRect }];
  });
  const lane = clearFloatingLane(box,navigationLane(box, panels));
  return localLane(box,lane);
}
/** Width previews happen outside React, and closing panes remain present until
 * their real exit ends. Observe actual boxes instead of just open booleans. */
export function observeNavigationLane(reader: HTMLElement, update: (beforePaint?:boolean) => void | (() => void), followMotion = true) {
  const workbench = reader.closest<HTMLElement>('.workbench') ?? reader;
  let cancelFrame: (() => void) | undefined, disposed = false, movingUntil = 0;
  const observed = new Set<Element>();
  // The target lane uses untransformed layout bounds. Presence springs do
  // not change that target and require no duration-based polling loop.
  const schedule = () => { if (!disposed && !cancelFrame) cancelFrame = scheduleLayoutRead(() => {
    cancelFrame = undefined; if (disposed) return;
    const write = update();
    return () => { write?.(); if (followMotion && performance.now() < movingUntil) schedule(); };
  }); };
  const resize = new ResizeObserver(schedule);
  const changes = new MutationObserver(records => {
    if (records.every(record => record.type === 'attributes' && record.attributeName === 'style' && withoutReservation(record.oldValue) === withoutReservation((record.target as HTMLElement).getAttribute('style')))) return;
    if (followMotion && records.some(record => record.attributeName === 'data-motion-phase')) {
      const target = records.find(record => record.attributeName === 'data-motion-phase')!.target as Element;
      const duration = Number.parseFloat(getComputedStyle(target).getPropertyValue('--motion-duration')) || 220;
      movingUntil = performance.now() + Math.min(1600,duration + 80);
    }
    if (records.some(record => record.type === 'childList')) { panelCache.delete(workbench); changes.disconnect(); for (const target of observed) resize.unobserve(target); observed.clear(); observe(); }
    schedule();
  });
  const observe = () => {
    const targets = new Set([reader,workbench,...readingPanels(reader)]);
    for (const element of observed) if (!targets.has(element as HTMLElement)) { observed.delete(element); resize.unobserve(element); }
    for (const element of targets) if (!observed.has(element)) {
      observed.add(element); resize.observe(element);
      changes.observe(element,{attributes:true,attributeOldValue:true,attributeFilter:['style','data-motion-phase'],...(element === workbench ? {childList:true} : {})});
    }
  };
  observe(); const write = update(); write?.();
  window.addEventListener(FLOATING_HITBOX_EVENT,schedule);
  return () => { disposed = true; cancelFrame?.(); resize.disconnect(); changes.disconnect(); panelCache.delete(workbench);window.removeEventListener(FLOATING_HITBOX_EVENT,schedule); };
}
export type NavigationDensity = 'wide'|'tight'|'compact'|'small'|'minimal'|'micro';
export function navigationDensity(width: number): NavigationDensity { return width >= 760 ? 'wide' : width >= 580 ? 'tight' : width >= 400 ? 'compact' : width >= 330 ? 'small' : width >= 110 ? 'minimal' : 'micro'; }
export function navigationControlMetrics(density:NavigationDensity) { return {height:60,radius:30,buttonSize:density === 'wide' ? 30 : density === 'tight' ? 28 : density === 'minimal' || density === 'micro' ? 22 : 26}; }
export function preferredNavigationWidth(width: number) { const density = navigationDensity(width); return Math.min(width,density === 'wide' ? 820 : density === 'tight' ? 700 : density === 'compact' ? 540 : density === 'small' ? 390 : density === 'minimal' ? 190 : 68); }
export function boundedNavigationPresentation(lane: NavigationLane, animatedWidth: number, animatedCenter: number) {
  const width = Math.max(0,Math.min(lane.width,animatedWidth));
  const center = Math.max(lane.left + width / 2,Math.min(lane.right - width / 2,animatedCenter));
  return {width,center};
}
