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
    const painted = new Map<string, { value: string; css: string }>();
    const spring = glassSpringParameters(KUBE_GLASS_SPRINGS.lensShape, mode);
    const apply = (position: SelectionToolbarPosition | undefined) => {
      // Geometry can disappear a frame before React observes the scroll.
      // Fade the retained pose instead of making it instantly invisible.
      if (!position) { element.dataset.selectionOccluded = 'true'; element.inert = true; return; }
      delete element.dataset.selectionOccluded;
      element.inert = false;
      const styles = { left: position.x + 'px', top: position.y + 'px', maxWidth: position.width + 'px' };
      for (const [property, value] of Object.entries(styles)) {
        const key = property as keyof typeof styles, css = element.style[key], last = painted.get(property);
        // CSSOM may round a fractional pixel string. Remember its serialized
        // form so the same pose cannot keep invalidating layout at rest.
        if (css !== value && !(last?.value === value && last.css === css)) element.style[key] = value;
        painted.set(property, { value, css: element.style[key] });
      }
      const moving = String(controller.current.moving);
      if (element.dataset.selectionMoving !== moving) element.dataset.selectionMoving = moving;
      const signature = `${position.x}:${position.y}:${position.width}`;
      if (signature !== previous) { previous = signature; latest.current.changed(position); }
    };
    const update = () => {
      const measurement = latest.current.measure();
      return controller.current.retarget(measurement.target, measurement.scene, identity, animatedMotion(mode));
    };
    const tick = (now: number) => {
      frame = 0; if (!live) return;
      // Read the live scene before writing a single final pose. The old
      // retarget write followed by another step write notified every global
      // hitbox observer twice and invalidated layout between consumers.
      update(); apply(controller.current.step((now - lastAt) / 1000, spring)); lastAt = now;
      if (controller.current.moving) frame = owner.requestAnimationFrame(tick);
    };
    const wake = () => { if (!live) return; apply(update()); if (controller.current.moving && !frame) { lastAt = owner.performance.now(); frame = owner.requestAnimationFrame(tick); } };
    refresh.current = wake; wake();
    return () => { live = false; owner.cancelAnimationFrame(frame); if (refresh.current === wake) refresh.current = () => {}; };
  }, [enabled, identity, mode]);
  // Parent layout effects can update real geometry without changing identity.
  useLayoutEffect(() => { refresh.current(); });
  return refresh;
}
