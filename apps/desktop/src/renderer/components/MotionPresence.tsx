import { cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { motionDuration, useMotionSnapshot } from '../lib/motion';
import { presencePresentation, presenceTarget, type PresenceState } from '../lib/presence-state';
type Options = { duration?: number; identity?: unknown; keyboardImmediate?: boolean };
export function usePresence(show: boolean, { duration: base = 180, identity, keyboardImmediate = true }: Options = {}) {
  const mode = useMotionSnapshot(), duration = motionDuration(base, mode, keyboardImmediate);
  const [state, setState] = useState<PresenceState>({ present: show, phase: show ? 'enter' : 'exit', identity });
  const generation = useRef(0);
  useLayoutEffect(() => {
    let first = 0, second = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const current = ++generation.current;
    setState(old => presenceTarget(old, show, identity, duration === 0));
    if (duration && show) {
      first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
        if (current === generation.current) setState({ present: true, phase: 'open', identity });
      }); });
    } else if (duration && !show) {
      timer = setTimeout(() => {
        if (current === generation.current) setState({ present: false, phase: 'exit', identity });
      }, duration);
    }
    return () => { generation.current++; cancelAnimationFrame(first); cancelAnimationFrame(second); clearTimeout(timer); };
  }, [show, identity, duration]);
  const { present, phase } = presencePresentation(state, show, identity, duration === 0);
  return { present, duration, props: {
    'data-motion-phase': phase,
    style: { '--motion-duration': `${duration}ms` } as CSSProperties,
    inert: !show || undefined,
    'aria-hidden': !show || undefined,
  } };
}
export function MotionPresence({ show, children, surface = 'popover', duration = 180, identity, keyboardImmediate = true }: Options & { show: boolean; children: ReactNode; surface?: string }) {
  const motion = usePresence(show, { duration, identity, keyboardImmediate });
  const retained = useRef<{ identity: unknown; element: ReactElement; key: number } | null>(null);
  const sequence = useRef(0);
  if (retained.current && retained.current.identity !== identity) retained.current = null;
  if (show && isValidElement(children)) retained.current = { identity, element: children, key: retained.current?.key ?? ++sequence.current };
  const element = retained.current?.element;
  if (!motion.present || !element) return null;
  const props = element.props as { style?: CSSProperties };
  return cloneElement(element as ReactElement<Record<string, unknown>>, { ...motion.props, key: `${element.key ?? ''}:${retained.current!.key}`, 'data-motion-surface': surface, style: { ...props.style, ...motion.props.style } });
}
export function AnimatedDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false), id = useId(), motion = usePresence(open, { duration: 200 });
  return <div className="animated-disclosure" data-open={open} style={{ '--motion-duration': `${motion.duration}ms` } as CSSProperties}>
    <button className="disclosure-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><span className="disclosure-chevron" aria-hidden="true">›</span>{label}</button>
    <div id={id} className="disclosure-body" {...motion.props} data-motion-surface="disclosure">{motion.present && <div>{children}</div>}</div>
  </div>;
}
