import { Children, cloneElement, isValidElement, useContext, useLayoutEffect, useRef, type HTMLAttributes, type ReactElement, type RefObject } from 'react';
import { stepGlassSpring, type SpringAxis } from '../lib/glass-elasticity';
import { advancePanelHeight, measurePanelHeight, panelContentPresentation, panelHeightSettled, panelResizeSpring } from '../lib/adaptive-panel';
import { resolveMotionMode, useMotionSnapshot } from '../lib/motion';
import { NativePanelHeightContext } from '../lib/native-panel-height';

type Props = HTMLAttributes<HTMLElement> & { availableHost: RefObject<HTMLElement | null>; contentIdentity: string; bodyClassName: string };
/** A single widget/controller tree; changing categories never mounts a second
 * hidden set of editors. Its natural body is measured independently of clipping. */
export function AdaptivePanel({ availableHost, contentIdentity, bodyClassName, children, ...attributes }: Props) {
  const frame = useRef<HTMLElement>(null), natural = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  const height = useRef<SpringAxis>({ value: 0, velocity: 0 }), content = useRef<SpringAxis>({ value: 1, velocity: 0 });
  const target = useRef(0), naturalHeight = useRef(0), maximum = useRef(1), identity = useRef(contentIdentity), initialized = useRef(false);
  const notifyNative = useContext(NativePanelHeightContext), mode = resolveMotionMode(useMotionSnapshot().split(':')[0]);
  useLayoutEffect(() => {
    const host = frame.current, body = natural.current, viewport = scroll.current; if (!host || !body || !viewport) return;
    let animation = 0, previous = 0, started = 0, disposed = false;
    const draw = () => {
      const presentation = panelContentPresentation(content.current);
      host.style.setProperty('--adaptive-panel-height', height.current.value.toFixed(3) + 'px');
      body.style.opacity = String(presentation.alpha); body.style.transform = mode === 'reduced' || mode === 'off' ? 'none' : 'translateY(' + presentation.y.toFixed(3) + 'px)';
      host.dataset.panelNaturalHeight = naturalHeight.current.toFixed(3); host.dataset.panelHeightTarget = target.current.toFixed(3); host.dataset.panelMaximumHeight = maximum.current.toFixed(3);
      notifyNative?.(height.current.value);
    };
    const tick = (now: number) => {
      animation = 0; if (disposed) return;
      const seconds = Math.max(0, Math.min(.064, (now - previous) / 1000)); previous = now;
      height.current = advancePanelHeight(height.current, target.current, seconds, mode, maximum.current);
      content.current = mode === 'off' ? { value: 1, velocity: 0 } : stepGlassSpring(content.current, 1, seconds, mode === 'reduced' ? { stiffness: 1600, damping: 80 } : panelResizeSpring(mode));
      const settled = panelHeightSettled(height.current, target.current) && Math.abs(content.current.value - 1) < .0005 && Math.abs(content.current.velocity) < .008;
      if (settled || now - started > 2500) { height.current = { value: target.current, velocity: 0 }; content.current = { value: 1, velocity: 0 }; }
      draw(); host.dataset.panelResizing = settled || now - started > 2500 ? 'false' : 'true';
      if (!settled && now - started <= 2500) animation = requestAnimationFrame(tick);
    };
    const animate = () => {
      if (animation || disposed) return;
      previous = started = performance.now(); animation = requestAnimationFrame(tick);
    };
    const measure = () => {
      if (disposed) return;
      // Owner workbench survives popup opening at 1px and is never transformed.
      const available = availableHost.current?.clientHeight || window.innerHeight;
      const measured = measurePanelHeight(host, body, viewport, available), next = measured.target;
      maximum.current = measured.maximum; naturalHeight.current = measured.natural;
      const changed = Math.abs(next - target.current) > .25; target.current = next;
      if (!initialized.current || mode === 'off' || mode === 'reduced') {
        initialized.current = true; height.current = { value: next, velocity: 0 };
        if (mode === 'off' || mode === 'reduced') content.current = { value: 1, velocity: 0 };
        draw();
      }
      else if (changed) { started = performance.now(); animate(); }
    };
    if (identity.current !== contentIdentity) {
      identity.current = contentIdentity; viewport.scrollTop = 0;
      // During an interrupted swap keep its current opacity and velocity. A
      // settled old category starts a small incoming reveal for the new one.
      if (Math.abs(content.current.value - 1) < .002 && Math.abs(content.current.velocity) < .02) content.current = { value: mode === 'off' ? 1 : .28, velocity: 0 };
    }
    const observer = new ResizeObserver(measure); observer.observe(body);
    if (availableHost.current) observer.observe(availableHost.current);
    for (const child of host.children) if (child !== viewport && getComputedStyle(child).position !== 'absolute') observer.observe(child);
    measure(); draw(); if (content.current.value !== 1 || !panelHeightSettled(height.current, target.current)) animate();
    window.addEventListener('resize', measure);
    return () => { disposed = true; cancelAnimationFrame(animation); observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [availableHost, contentIdentity, mode, notifyNative]);
  const body = Children.map(children, child => {
    if (!isValidElement<{ className?: string }>(child) || !child.props.className?.split(/\s+/).includes(bodyClassName)) return child;
    const element = child as ReactElement<{ className?: string }>;
    return <div className="adaptive-panel-scroll" ref={scroll} data-panel-content={contentIdentity}><div className="adaptive-panel-natural" ref={natural}>{cloneElement(element, { className: element.props.className?.replace(/\bmotion-swap\b/g, '').trim() })}</div></div>;
  });
  return <aside {...attributes} ref={frame} data-panel-adaptive="true">{body}</aside>;
}
