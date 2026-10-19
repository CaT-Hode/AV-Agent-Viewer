import { useLayoutEffect, useRef, type RefObject } from 'react';
import { glassSpringParameters, stepGlassSpring, type SpringAxis } from './glass-elasticity';
import { KUBE_GLASS_SPRINGS } from './glass-presets';
import { animatedMotion, resolveMotionMode, useMotionSnapshot } from './motion';
import { boundedNavigationPresentation, type NavigationLane } from './navigation-lane';
import { scheduleLayoutRead } from './layout-frame';

export const NAVIGATION_CONTENT_EVENT = 'agentviewer:navigation-content';
const number = (value: string) => Number.parseFloat(value) || 0;
const horizontalChrome = (style: CSSStyleDeclaration) => number(style.paddingLeft) + number(style.paddingRight) + number(style.borderLeftWidth) + number(style.borderRightWidth);

/** Measure the one live control tree, independently of its animated flex box.
 * Input values are properties, so input/draft events explicitly request this
 * read. Neither a hidden copy of the editors nor a fixed title slot is needed. */
function intrinsicNavigationWidth(capsule: HTMLElement, context: CanvasRenderingContext2D | null) {
  const owner = capsule.ownerDocument.defaultView!, style = owner.getComputedStyle(capsule);
  const boxWidth = (element: Element) => element instanceof owner.HTMLElement ? element.offsetWidth : number(owner.getComputedStyle(element).width);
  const textWidth = (input: HTMLInputElement) => {
    const computed = owner.getComputedStyle(input), text = input.value || input.placeholder;
    if (context) context.font = computed.font || `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
    return Math.max(24, number(computed.minWidth), (context?.measureText(text).width ?? text.length * number(computed.fontSize)) + Math.max(0, text.length - 1) * number(computed.letterSpacing) + horizontalChrome(computed) + 2);
  };
  const flowWidth = (element: HTMLElement) => {
    const computed = owner.getComputedStyle(element), children = [...element.children].filter(child => owner.getComputedStyle(child).display !== 'none');
    return horizontalChrome(computed) + Math.max(0, children.length - 1) * number(computed.columnGap) + children.reduce((sum, child) => {
      const childStyle = owner.getComputedStyle(child);
      if (childStyle.display === 'none') return sum;
      return sum + (child instanceof owner.HTMLInputElement ? textWidth(child) : boxWidth(child)) + number(childStyle.marginLeft) + number(childStyle.marginRight);
    }, 0);
  };
  const modules = [...capsule.children].filter((child): child is HTMLElement => child instanceof owner.HTMLElement && !child.classList.contains('navigation-glass'));
  const widths = modules.flatMap(element => {
    const computed = owner.getComputedStyle(element); if (computed.display === 'none') return [];
    let width = element.offsetWidth;
    if (element.matches('.capsule-document-title')) {
      const label = element.querySelector<HTMLElement>(':scope > span:last-child');
      // scrollWidth rounds to whole pixels. Reserve its fractional remainder
      // so even a short filename never acquires an ellipsis at the last glyph.
      width = horizontalChrome(computed) + (label ? label.scrollWidth + 1 : 0) + [...element.children].filter(child => child !== label).reduce((sum, child) => sum + boxWidth(child), 0) + Math.max(0, element.children.length - 1) * number(computed.columnGap);
      const maximum = Number.parseFloat(computed.maxWidth); if (Number.isFinite(maximum)) width = Math.min(width, maximum);
    } else if (element.matches('.address')) {
      const input = element.querySelector<HTMLInputElement>('input'); if (input) width = textWidth(input) + horizontalChrome(computed);
      width = Math.max(width, number(computed.minWidth));
      const maximum = Number.parseFloat(computed.maxWidth); if (Number.isFinite(maximum)) width = Math.min(width, maximum);
    } else if (element.matches('.navigation-formula-slot')) {
      const bar = element.querySelector<HTMLElement>('.native-office-formula-bar'); width = bar ? flowWidth(bar) + horizontalChrome(computed) : 0;
    }
    return [width + number(computed.marginLeft) + number(computed.marginRight)];
  });
  return horizontalChrome(style) + widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * number(style.columnGap);
}

/** One interruptible spring writes layout variables without a React render
 * per frame. Shared-frame reads all finish before this controller paints. */
export function useNavigationLayout(nav: RefObject<HTMLElement | null>, capsule: RefObject<HTMLDivElement | null>, lane: NavigationLane, canvas: NavigationLane, contentIdentity: string, instant: boolean) {
  const mode = resolveMotionMode(useMotionSnapshot().split(':')[0]);
  const latest = useRef({ lane, canvas, instant }); latest.current = { lane, canvas, instant };
  const refresh = useRef<(() => void) | undefined>(undefined);
  const axes = useRef<{ width: SpringAxis; center: SpringAxis } | undefined>(undefined);
  useLayoutEffect(() => {
    const toolbar = nav.current, host = capsule.current; if (!toolbar || !host) return;
    const owner = host.ownerDocument.defaultView!;
    const context = host.ownerDocument.createElement('canvas').getContext('2d');
    let cancelRead: (() => void) | undefined, cancelTick: (() => void) | undefined, disposed = false, previous = 0, started = 0;
    let target = { width: 0, center: 0 };
    const paint = (moving: boolean) => {
      const actual = boundedNavigationPresentation(latest.current.canvas, axes.current!.width.value, axes.current!.center.value);
      toolbar.style.setProperty('--navigation-slot-left', actual.center.toFixed(3) + 'px');
      toolbar.style.setProperty('--navigation-slot-width', actual.width.toFixed(3) + 'px');
      const resizing = String(moving), widthTarget = target.width.toFixed(3), available = latest.current.lane.width.toFixed(3);
      if (host.dataset.navigationResizing !== resizing) host.dataset.navigationResizing = resizing;
      if (toolbar.dataset.navigationWidthTarget !== widthTarget) toolbar.dataset.navigationWidthTarget = widthTarget;
      if (toolbar.dataset.navigationAvailableWidth !== available) toolbar.dataset.navigationAvailableWidth = available;
    };
    const tick = () => {
      if (cancelTick || disposed) return;
      cancelTick = scheduleLayoutRead(() => {
        cancelTick = undefined; if (disposed) return;
        const now = owner.performance.now(), seconds = (now - previous) / 1000; previous = now;
        const spring = glassSpringParameters(KUBE_GLASS_SPRINGS.lensShape, mode);
        axes.current = { width: stepGlassSpring(axes.current!.width, target.width, seconds, spring), center: stepGlassSpring(axes.current!.center, target.center, seconds, spring) };
        const settled = [axes.current.width.value - target.width, axes.current.center.value - target.center].every(value => Math.abs(value) < .05) && [axes.current.width.velocity, axes.current.center.velocity].every(value => Math.abs(value) < .1) || now - started > 1500;
        if (settled) axes.current = { width: { value: target.width, velocity: 0 }, center: { value: target.center, velocity: 0 } };
        return () => { paint(!settled); if (!settled) tick(); };
      });
    };
    const measure = () => {
      if (cancelRead || disposed) return;
      cancelRead = scheduleLayoutRead(() => {
        cancelRead = undefined; if (disposed) return;
        const { lane, instant } = latest.current;
        const next = { width: Math.min(lane.width, Math.ceil(intrinsicNavigationWidth(host, context))), center: lane.center };
        const changed = Math.abs(next.width - target.width) > .25 || Math.abs(next.center - target.center) > .25;
        target = next;
        return () => {
          if (!axes.current || instant || !animatedMotion(mode)) {
            cancelTick?.(); cancelTick = undefined;
            axes.current = { width: { value: target.width, velocity: 0 }, center: { value: target.center, velocity: 0 } }; paint(false);
          } else if (changed) { previous = started = owner.performance.now(); paint(true); tick(); }
        };
      });
    };
    refresh.current = measure;
    const changes = new owner.MutationObserver(records => {
      if (records.some(record => !(record.target instanceof owner.Element ? record.target : record.target.parentElement)?.closest('.navigation-glass'))) measure();
    });
    changes.observe(host, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'data-dirty', 'data-stale', 'aria-invalid'] });
    host.addEventListener('input', measure); host.addEventListener(NAVIGATION_CONTENT_EVENT, measure);
    host.ownerDocument.fonts.addEventListener('loadingdone', measure); measure();
    return () => { disposed = true; refresh.current = undefined; cancelRead?.(); cancelTick?.(); changes.disconnect(); host.removeEventListener('input', measure); host.removeEventListener(NAVIGATION_CONTENT_EVENT, measure); host.ownerDocument.fonts.removeEventListener('loadingdone', measure); };
  }, [nav, capsule, mode]);
  useLayoutEffect(() => { refresh.current?.(); }, [lane.left, lane.right, lane.width, lane.center, canvas.left, canvas.right, canvas.width, contentIdentity, instant]);
}
