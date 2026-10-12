import { cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { motionDuration, useMotionSnapshot } from '../lib/motion';
type Options = { duration?: number; identity?: unknown; keyboardImmediate?: boolean };
export function usePresence(show: boolean, { duration: base = 180, identity, keyboardImmediate = true }: Options = {}) {
  const mode = useMotionSnapshot(), duration = motionDuration(base, mode, keyboardImmediate);
  const [state, setState] = useState({ present: show, phase: show ? 'enter' : 'exit', identity });
  const previous = useRef({ show, identity });
  const identityChanged = state.identity !== identity;
  useLayoutEffect(() => {
    let first = 0, second = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const changed = previous.current.identity !== identity;
    previous.current = { show, identity };
    if (changed || duration === 0) setState({ present: show, phase: show ? 'open' : 'exit', identity });
    else if (show) {
      setState(old => ({ present: true, phase: old.present && old.phase !== 'enter' ? 'open' : 'enter', identity }));
      first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setState({ present: true, phase: 'open', identity })); });
    } else {
      setState(old => ({ ...old, phase: 'exit', identity }));
      timer = setTimeout(() => setState({ present: false, phase: 'exit', identity }), duration);
    }
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); clearTimeout(timer); };
  }, [show, identity, duration]);
  const present = identityChanged || duration === 0 ? show : show || state.present;
  const phase = identityChanged || duration === 0 ? 'open' : !show ? 'exit' : state.phase;
  return { present, duration, props: {
    'data-motion-phase': phase,
    style: { '--motion-duration': `${duration}ms` } as CSSProperties,
    inert: !show || undefined,
    'aria-hidden': !show || undefined,
  } };
}
export function MotionPresence({ show, children, surface = 'popover', duration = 180, identity, keyboardImmediate = true }: Options & { show: boolean; children: ReactNode; surface?: string }) {
  const motion = usePresence(show, { duration, identity, keyboardImmediate });
  const retained = useRef<ReactElement | null>(null);
  if (show && isValidElement(children)) retained.current = children;
  const element = show && isValidElement(children) ? children : retained.current;
  if (!motion.present || !element) return null;
  const props = element.props as { style?: CSSProperties };
  return cloneElement(element as ReactElement<Record<string, unknown>>, { ...motion.props, 'data-motion-surface': surface, style: { ...props.style, ...motion.props.style } });
}
export function AnimatedDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false), id = useId(), motion = usePresence(open, { duration: 200 });
  return <div className="animated-disclosure" data-open={open} style={{ '--motion-duration': `${motion.duration}ms` } as CSSProperties}>
    <button className="disclosure-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><span className="disclosure-chevron" aria-hidden="true">›</span>{label}</button>
    <div id={id} className="disclosure-body" {...motion.props} data-motion-surface="disclosure">{motion.present && <div>{children}</div>}</div>
  </div>;
}
