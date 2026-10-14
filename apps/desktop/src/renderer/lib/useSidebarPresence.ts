import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { advanceSidebarSpring, sidebarExitFinished, sidebarSpringPresentation, sidebarSpringSettled } from './sidebar-presence';
import type { MotionMode } from './motion-policy';
import type { PresenceState } from './presence-state';

export function useSidebarPresence(show: boolean, identity: unknown, side: string, mode: MotionMode, enabled: boolean) {
  const [state, setState] = useState<PresenceState & { progress: number }>({ present: show, phase: show ? 'enter' : 'exit', identity, progress: 0 });
  const axis = useRef({ value: 0, velocity: 0 }), currentIdentity = useRef(identity), generation = useRef(0);
  useLayoutEffect(() => {
    const ticket = ++generation.current; let frame = 0;
    const changed = currentIdentity.current !== identity; currentIdentity.current = identity;
    if (changed) axis.current = { value: 0, velocity: 0 };
    if (!enabled) { axis.current = { value: show ? 1 : 0, velocity: 0 }; setState({ present: show, phase: show ? 'open' : 'exit', identity, progress: axis.current.value }); return; }
    setState(previous => ({ present: show || !changed && previous.present, phase: show ? 'enter' : 'exit', identity, progress: axis.current.value }));
    if (!show && (changed || sidebarSpringSettled(axis.current, false))) { setState({ present: false, phase: 'exit', identity, progress: 0 }); return; }
    const started = performance.now(); let previous = started;
    const tick = (now: number) => {
      if (ticket !== generation.current) return;
      const seconds = Math.max(0, Math.min(.064, (now - previous) / 1000)); previous = now;
      axis.current = advanceSidebarSpring(axis.current, show, seconds, mode);
      const settled = (show ? sidebarSpringSettled(axis.current, true) : sidebarExitFinished(axis.current)) || now - started > 2500;
      if (settled) axis.current = { value: show ? 1 : 0, velocity: 0 };
      setState({ present: show || !settled, phase: show ? settled ? 'open' : 'enter' : 'exit', identity, progress: axis.current.value });
      if (!settled) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { generation.current++; cancelAnimationFrame(frame); };
  }, [show, identity, side, mode, enabled]);
  const changed = state.identity !== identity, present = changed ? show : show || state.present;
  const presentation = sidebarSpringPresentation(changed ? 0 : state.progress, side);
  return { present, duration: mode === 'elegant' ? 1400 : 1000, props: {
    'data-motion-phase': changed ? show ? 'enter' : 'exit' : state.phase,
    'data-sidebar-spring': enabled ? 'true' : undefined,
    style: { '--motion-duration': `${mode === 'elegant' ? 1400 : 1000}ms`, '--sidebar-spring-x': `${presentation.x}px`, '--sidebar-spring-scale-x': presentation.scaleX, '--sidebar-spring-scale-y': presentation.scaleY, '--sidebar-spring-alpha': presentation.alpha } as CSSProperties,
    inert: !show || undefined, 'aria-hidden': !show || undefined,
  } };
}
