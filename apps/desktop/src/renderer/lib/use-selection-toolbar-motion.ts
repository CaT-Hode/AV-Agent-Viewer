import { useLayoutEffect, useRef, type RefObject } from 'react';
import { glassSpringParameters } from './glass-elasticity';
import { KUBE_GLASS_SPRINGS } from './glass-presets';
import { animatedMotion, resolveMotionMode, useMotionSnapshot } from './motion';
import type { SelectionToolbarPosition, SelectionToolbarScene } from './selection-position';
import { SelectionToolbarMotion } from './selection-toolbar-motion';

export type SelectionToolbarMeasurement = { target?: SelectionToolbarPosition; scene: SelectionToolbarScene };

/** Position only: foreground and optical fields keep their native dimensions.
 * No React render, image encode or asset decode is required for a spring tick. */
export function useSelectionToolbarMotion(node: RefObject<HTMLDivElement | null>, enabled: boolean, identity: unknown, measure: () => SelectionToolbarMeasurement, changed: (position: SelectionToolbarPosition) => void) {
  const latest = useRef({ measure, changed }); latest.current = { measure, changed };
  const controller = useRef(new SelectionToolbarMotion()), refresh = useRef<() => void>(() => {});
  const mode = resolveMotionMode(useMotionSnapshot().split(':')[0]);
  useLayoutEffect(() => {
    const element = node.current;
    if (!enabled || !element) { controller.current.reset(); refresh.current = () => {}; return; }
    const owner = element.ownerDocument.defaultView ?? window;
    let frame = 0, lastAt = owner.performance.now(), live = true, previous = '';
    const spring = glassSpringParameters(KUBE_GLASS_SPRINGS.lensShape, mode);
    const apply = (position: SelectionToolbarPosition | undefined) => {
      // Geometry can disappear a frame before React observes the scroll.
      // Fade the retained pose instead of making it instantly invisible.
      if (!position) { element.dataset.selectionOccluded = 'true'; element.inert = true; return; }
      delete element.dataset.selectionOccluded;
      element.inert = false;
      element.style.left = position.x + 'px'; element.style.top = position.y + 'px'; element.style.maxWidth = position.width + 'px';
      element.dataset.selectionMoving = String(controller.current.moving);
      const signature = `${position.x}:${position.y}:${position.width}`;
      if (signature !== previous) { previous = signature; latest.current.changed(position); }
    };
    const update = () => {
      const measurement = latest.current.measure();
      apply(controller.current.retarget(measurement.target, measurement.scene, identity, animatedMotion(mode)));
    };
    const tick = (now: number) => {
      frame = 0; if (!live) return;
      update(); apply(controller.current.step((now - lastAt) / 1000, spring)); lastAt = now;
      if (controller.current.moving) frame = owner.requestAnimationFrame(tick);
    };
    const wake = () => { if (!live) return; update(); if (controller.current.moving && !frame) { lastAt = owner.performance.now(); frame = owner.requestAnimationFrame(tick); } };
    refresh.current = wake; wake();
    return () => { live = false; owner.cancelAnimationFrame(frame); if (refresh.current === wake) refresh.current = () => {}; };
  }, [enabled, identity, mode]);
  // Parent layout effects can update real geometry without changing identity.
  useLayoutEffect(() => { refresh.current(); });
  return refresh;
}
