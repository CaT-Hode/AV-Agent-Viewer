export type NavigationLane = { left: number; right: number; width: number; center: number };
type Rect = { left: number; right: number };
const reservationProperties = ['--navigation-reservation-left','--navigation-reservation-right','--sidebar-space-scale-x'];

/** The pane's requested geometry, before its presence scale. Measuring its
 * current transformed box here would continually move the navigation target. */
function panelLayoutBounds(panel: HTMLElement) {
  const parent = panel.offsetParent as HTMLElement | null;
  if (!parent) return panel.getBoundingClientRect();
  const box = parent.getBoundingClientRect(), sx = box.width / (parent.offsetWidth || box.width || 1), sy = box.height / (parent.offsetHeight || box.height || 1);
  const left = box.left + (parent.clientLeft + panel.offsetLeft - parent.scrollLeft) * sx;
  const top = box.top + (parent.clientTop + panel.offsetTop - parent.scrollTop) * sy;
  return {left,right:left + panel.offsetWidth * sx,top,bottom:top + panel.offsetHeight * sy,width:panel.offsetWidth * sx,height:panel.offsetHeight * sy,sx};
}
function readingPanels(reader: HTMLElement) { return [...(reader.closest('.workbench')?.querySelectorAll<HTMLElement>(':scope > .floating-side-panel') ?? [])]; }
function localLane(reader: DOMRect, lane: NavigationLane) { return {...lane,left:lane.left-reader.left,right:lane.right-reader.left,center:lane.center-reader.left}; }

/** Entering panes announce their final width immediately. A closing pane keeps
 * its reservation until removal: navigation can then grow without racing it. */
export function readNavigationTargetLane(reader: HTMLElement): NavigationLane {
  const box = reader.getBoundingClientRect();
  const panels = readingPanels(reader).flatMap(panel => {
    const side = panel.dataset.side, bounds = panelLayoutBounds(panel);
    if ((side !== 'left' && side !== 'right') || bounds.width <= 0 || bounds.height <= 0 || getComputedStyle(panel).display === 'none' || bounds.bottom <= box.top + 12 || bounds.top >= box.top + 72) return [];
    return [{side,bounds} as {side:'left'|'right';bounds:Rect}];
  });
  return localLane(box,navigationLane(box,panels));
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
export function syncSidebarNavigationReservation(reader:HTMLElement,left:number,right:number) {
  setVariable(reader,'--navigation-reservation-left',left.toFixed(3)+'px');
  setVariable(reader,'--navigation-reservation-right',right.toFixed(3)+'px');
  const box = reader.getBoundingClientRect();
  for (const panel of readingPanels(reader)) {
    const side = panel.dataset.side; if (side !== 'left' && side !== 'right') continue;
    const bounds = panelLayoutBounds(panel), sx = 'sx' in bounds ? bounds.sx : 1;
    const translation = (Number.parseFloat(panel.style.getPropertyValue('--sidebar-spring-x')) || 0) * sx;
    const scale = sidebarNavigationScale(side,bounds,{left:box.left+left,right:box.left+right},translation,12*sx);
    setVariable(panel,'--sidebar-space-scale-x',scale.toFixed(6));
  }
}
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
  const lane = navigationLane(box, panels);
  return localLane(box,lane);
}
/** Width previews happen outside React, and closing panes remain present until
 * their real exit ends. Observe actual boxes instead of just open booleans. */
export function observeNavigationLane(reader: HTMLElement, update: (beforePaint?:boolean) => void) {
  const workbench = reader.closest<HTMLElement>('.workbench') ?? reader;
  let frame = 0, movingUntil = 0, disposed = false;
  const observed = new Set<Element>();
  const tick = () => { frame = 0; if (disposed) return; update(true); if (performance.now() < movingUntil) frame = requestAnimationFrame(tick); };
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(tick); };
  const resize = new ResizeObserver(() => { if (!disposed) update(true); schedule(); });
  const changes = new MutationObserver(records => {
    if (records.every(record => record.type === 'attributes' && record.attributeName === 'style' && withoutReservation(record.oldValue) === withoutReservation((record.target as HTMLElement).getAttribute('style')))) return;
    for (const record of records) if (record.attributeName === 'data-motion-phase') {
      const duration = Number.parseFloat(getComputedStyle(record.target as Element).getPropertyValue('--motion-duration')) || 220;
      movingUntil = performance.now() + Math.min(1600,duration + 80);
    }
    observe(); if (!disposed) update(true); schedule();
  });
  const observe = () => {
    for (const element of [reader,workbench,...workbench.querySelectorAll(':scope > .floating-side-panel')]) if (!observed.has(element)) {
      observed.add(element); resize.observe(element);
      changes.observe(element,{attributes:true,attributeOldValue:true,attributeFilter:['style','data-motion-phase'],...(element === workbench ? {childList:true} : {})});
    }
  };
  observe(); update();
  return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); changes.disconnect(); };
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
