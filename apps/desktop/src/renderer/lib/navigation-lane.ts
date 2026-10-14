export type NavigationLane = { left: number; right: number; width: number; center: number };
type Rect = { left: number; right: number };

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
  return { ...lane, left: lane.left - box.left, right: lane.right - box.left, center: lane.center - box.left };
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
    for (const record of records) if (record.attributeName === 'data-motion-phase') {
      const duration = Number.parseFloat(getComputedStyle(record.target as Element).getPropertyValue('--motion-duration')) || 220;
      movingUntil = performance.now() + Math.min(1600,duration + 80);
    }
    observe(); if (!disposed) update(true); schedule();
  });
  const observe = () => {
    for (const element of [reader,workbench,...workbench.querySelectorAll(':scope > .floating-side-panel')]) if (!observed.has(element)) {
      observed.add(element); resize.observe(element);
      changes.observe(element,{attributes:true,attributeFilter:['style','data-motion-phase'],...(element === workbench ? {childList:true} : {})});
    }
  };
  observe(); update();
  return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); changes.disconnect(); };
}
export type NavigationDensity = 'wide'|'tight'|'compact'|'small'|'minimal'|'micro';
export function navigationDensity(width: number): NavigationDensity { return width >= 760 ? 'wide' : width >= 580 ? 'tight' : width >= 400 ? 'compact' : width >= 330 ? 'small' : width >= 110 ? 'minimal' : 'micro'; }
export function navigationControlMetrics(density:NavigationDensity) { const height = density === 'wide' ? 60 : density === 'tight' ? 52 : density === 'compact' ? 48 : 44; return {height,radius:height/2,buttonSize:density === 'wide' ? 30 : density === 'tight' ? 28 : density === 'minimal' || density === 'micro' ? 22 : 26}; }
export function preferredNavigationWidth(width: number) { const density = navigationDensity(width); return Math.min(width,density === 'wide' ? 820 : density === 'tight' ? 700 : density === 'compact' ? 540 : density === 'small' ? 390 : density === 'minimal' ? 190 : 68); }
export function boundedNavigationPresentation(lane: NavigationLane, animatedWidth: number, animatedCenter: number) {
  const width = Math.max(0,Math.min(lane.width,animatedWidth));
  const center = Math.max(lane.left + width / 2,Math.min(lane.right - width / 2,animatedCenter));
  return {width,center};
}
