import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { KUBE_GLASS_SPRINGS } from './glass-presets';
import { animatedMotion, resolveMotionMode, useMotionSnapshot, type MotionMode } from './motion';

export type GlassElasticPreset = 'button' | 'thumb' | 'switch' | 'slider' | 'search' | 'lens';
export type SpringAxis = { value: number; velocity: number };
export type SpringParameters = { stiffness: number; damping: number; mass?: number };
export type ElasticTarget = { scaleX: number; scaleY: number; x: number; y: number };
export type ElasticMotion = MotionMode;
export type GlassElasticOptions = { preset?: GlassElasticPreset; disabled?: boolean | (() => boolean); motion?: () => ElasticMotion; deform?: boolean };
type PointerLike = { pointerId: number; clientX: number; clientY: number; timeStamp: number; button?: number; isPrimary?: boolean; currentTarget?: EventTarget | null };
type KeyLike = { key: string; repeat?: boolean; isComposing?: boolean };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Exact damped oscillator step. Retargeting preserves velocity, so a quick
 * press/release/reversal never starts a separate, uninterruptible animation. */
export function stepGlassSpring(axis: SpringAxis, target: number, seconds: number, parameters: SpringParameters): SpringAxis {
  const dt = clamp(Number.isFinite(seconds) ? seconds : 0, 0, .064);
  if (!dt) return axis;
  const mass = Math.max(.01, parameters.mass ?? 1), stiffness = Math.max(.01, parameters.stiffness), damping = Math.max(0, parameters.damping);
  const a = damping / (2 * mass), frequency = stiffness / mass, delta = frequency - a * a;
  const y = axis.value - target, v = axis.velocity;
  let displacement: number, velocity: number;
  if (Math.abs(delta) < .0001) {
    const c = v + a * y, decay = Math.exp(-a * dt);
    displacement = decay * (y + c * dt); velocity = decay * (c - a * (y + c * dt));
  } else if (delta > 0) {
    const w = Math.sqrt(delta), c = (v + a * y) / w, cosine = Math.cos(w * dt), sine = Math.sin(w * dt), decay = Math.exp(-a * dt);
    displacement = decay * (y * cosine + c * sine);
    velocity = decay * ((-a * y + w * c) * cosine + (-a * c - w * y) * sine);
  } else {
    const root = Math.sqrt(-delta), r1 = -a + root, r2 = -a - root;
    const c1 = (v - r2 * y) / (r1 - r2), c2 = y - c1;
    displacement = c1 * Math.exp(r1 * dt) + c2 * Math.exp(r2 * dt);
    velocity = r1 * c1 * Math.exp(r1 * dt) + r2 * c2 * Math.exp(r2 * dt);
  }
  return { value: target + displacement, velocity };
}

/** Standard preserves the source targets. Elegant adds a restrained button
 * press while keeping thumb geometry and direct pointer tracking unchanged. */
export function glassElasticTarget(preset: GlassElasticPreset, active: boolean, velocity = { x: 0, y: 0 }, focused = false, mode: MotionMode = 'standard'): ElasticTarget {
  let scale = preset === 'switch' ? active ? .9 : .65 : preset === 'slider' || preset === 'thumb' ? active ? 1 : .6 : preset === 'search' ? (focused ? 1 : .8) * (active ? .99 : 1) : active ? .99 : 1;
  if (active && mode === 'elegant' && (preset === 'button' || preset === 'search')) scale *= .975 / .99;
  if (preset === 'lens') {
    scale = active ? 1 : .8;
    const scaleY = scale * Math.max(.7, 1 - Math.abs(velocity.x) / 5000);
    return { scaleX: scale + (1 - scaleY), scaleY, x: 0, y: 0 };
  }
  return { scaleX: scale, scaleY: scale, x: 0, y: 0 };
}

export function glassMaterialTarget(preset: GlassElasticPreset, active: boolean, focused = false) {
  if (preset === 'switch' || preset === 'slider' || preset === 'thumb') return { fill: active ? .1 : 1, refraction: active ? .9 : .4, magnification: 24 };
  if (preset === 'lens') return { fill: 0, refraction: active ? 1 : .8, magnification: active ? 48 : 24 };
  return { fill: active ? .3 : focused ? .2 : .05, refraction: 1, magnification: 24 };
}

export function glassElasticMotionEnabled(mode: ElasticMotion, prefersReducedMotion: boolean) { return animatedMotion(resolveMotionMode(mode, prefersReducedMotion)); }
/** Adapt time/response, never mutate the audited source material presets.
 * Elegant uses a gentle .78 damping ratio (about 2% free overshoot). */
export function glassSpringParameters(parameters: SpringParameters, mode: MotionMode): SpringParameters {
  const speed = mode === 'elegant' ? .62 : .9, mass = parameters.mass ?? 1;
  const stiffness = parameters.stiffness * speed * speed;
  const damping = parameters.damping * speed;
  return { stiffness, damping: mode === 'elegant' ? 2 * Math.sqrt(stiffness * mass) * .78 : damping, ...(parameters.mass === undefined ? {} : { mass }) };
}
/** Direct manipulation samples the visible position. Release keeps this
 * finite measured velocity; a suspended event never injects an extreme kick. */
export function sampleGlassDragAxis(axis: SpringAxis, value: number, elapsedMs: number): SpringAxis {
  const velocity = elapsedMs > 0 && elapsedMs <= 100 ? clamp((value - axis.value) / Math.max(.008, elapsedMs / 1000), -500, 500) : 0;
  return { value, velocity };
}
const variables = ['--glass-elastic-scale-x', '--glass-elastic-scale-y', '--glass-elastic-x', '--glass-elastic-y', '--glass-material-fill'] as const;

/** Imperative controller for delegated buttons and React controls alike. It
 * owns no permanent event listener and runs RAF only until its spring rests. */
export function createGlassElasticController(element: HTMLElement, options: GlassElasticOptions = {}) {
  const preset = options.preset ?? 'button', resting = glassElasticTarget(preset, false);
  let axes = { scaleX: { value: resting.scaleX, velocity: 0 }, scaleY: { value: resting.scaleY, velocity: 0 }, x: { value: 0, velocity: 0 }, y: { value: 0, velocity: 0 } };
  const materialRest = glassMaterialTarget(preset, false);
  let material = { fill: { value: materialRest.fill, velocity: 0 }, refraction: { value: materialRest.refraction, velocity: 0 }, magnification: { value: materialRest.magnification, velocity: 0 } };
  let lensBase: SpringAxis = { value: .8, velocity: 0 };
  let shadow = { x: { value: 0, velocity: 0 }, y: { value: 4, velocity: 0 }, blur: { value: 9, velocity: 0 }, alpha: { value: .16, velocity: 0 }, inset: { value: .2, velocity: 0 } };
  let pointer: { id: number; x: number; y: number; at: number; vx: number; vy: number; movedAt: number } | undefined;
  let keyboard = false, focused = false, frame = 0, previousAt = 0, startedAt = 0, destroyed = false, moving = false;
  const original = variables.map(name => ({ name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) }));
  const originalWillChange = element.style.getPropertyValue('will-change'), originalWillPriority = element.style.getPropertyPriority('will-change');
  const originalShadow = element.style.getPropertyValue('box-shadow');
  const hadClass = element.classList.contains('glass-elastic'), originalState = element.getAttribute('data-glass-elastic-state');
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const disabled = () => (typeof options.disabled === 'function' ? options.disabled() : options.disabled) || !!element.closest(':disabled,[aria-disabled="true"],[inert]');
  const mode = () => resolveMotionMode(options.motion?.() ?? document.documentElement.dataset.motion, media.matches);
  const enabled = () => !destroyed && !disabled() && animatedMotion(mode());
  const restoreWillChange = () => { moving = false; if (originalWillChange) element.style.setProperty('will-change', originalWillChange, originalWillPriority); else element.style.removeProperty('will-change'); };
  const draw = () => {
    if (!element.classList.contains('glass-elastic')) element.classList.add('glass-elastic');
    if (options.deform !== false) {
      element.style.setProperty(variables[0], axes.scaleX.value.toFixed(5)); element.style.setProperty(variables[1], axes.scaleY.value.toFixed(5));
      element.style.setProperty(variables[2], `${axes.x.value.toFixed(3)}px`); element.style.setProperty(variables[3], `${axes.y.value.toFixed(3)}px`);
    }
    element.style.setProperty(variables[4], material.fill.value.toFixed(5));
    for (const map of element.querySelectorAll<SVGElement>('[data-glass-displacement]')) map.setAttribute('scale', String(Number(map.dataset.glassBaseScale) * material.refraction.value));
    for (const map of element.querySelectorAll<SVGElement>('[data-glass-magnification]')) map.setAttribute('scale', String(material.magnification.value));
    if (preset === 'lens') element.style.boxShadow = `${shadow.x.value}px ${shadow.y.value}px ${shadow.blur.value}px rgb(0 0 0 / ${shadow.alpha.value}),inset ${shadow.x.value / 2}px ${shadow.y.value / 2}px 24px rgb(0 0 0 / ${shadow.inset.value}),inset ${-shadow.x.value / 2}px ${-shadow.y.value / 2}px 24px rgb(255 255 255 / ${shadow.inset.value})`;
  };
  const target = (now: number) => {
    const decay = pointer ? Math.exp(-(now - pointer.movedAt) / 85) : 0;
    return glassElasticTarget(preset, !!pointer || keyboard, { x: (pointer?.vx ?? 0) * decay, y: (pointer?.vy ?? 0) * decay }, focused, mode());
  };
  const reset = (immediate = true) => {
    pointer = undefined; keyboard = false; focused = false; element.dataset.glassElasticState = 'rest';
    if (!immediate) { animate(); return; }
    cancelAnimationFrame(frame); frame = 0;
    axes = { scaleX: { value: resting.scaleX, velocity: 0 }, scaleY: { value: resting.scaleY, velocity: 0 }, x: { value: 0, velocity: 0 }, y: { value: 0, velocity: 0 } };
    material = { fill: { value: materialRest.fill, velocity: 0 }, refraction: { value: materialRest.refraction, velocity: 0 }, magnification: { value: materialRest.magnification, velocity: 0 } };
    lensBase = { value: .8, velocity: 0 };
    shadow = { x: { value: 0, velocity: 0 }, y: { value: 4, velocity: 0 }, blur: { value: 9, velocity: 0 }, alpha: { value: .16, velocity: 0 }, inset: { value: .2, velocity: 0 } };
    draw(); restoreWillChange();
  };
  const tick = (now: number) => {
    frame = 0;
    if (!enabled()) { reset(); return; }
    const next = target(now), seconds = (now - previousAt) / 1000; previousAt = now;
    const spring = (parameters: SpringParameters) => glassSpringParameters(parameters, mode());
    const parameters = spring(preset === 'lens' ? KUBE_GLASS_SPRINGS.lensShape : preset === 'switch' || preset === 'slider' || preset === 'thumb' ? KUBE_GLASS_SPRINGS.thumbScale : KUBE_GLASS_SPRINGS.searchScale);
    let settled = true;
    if (preset === 'lens') {
      const active = !!pointer || keyboard;
      lensBase = stepGlassSpring(lensBase, active ? 1 : .8, seconds, spring(KUBE_GLASS_SPRINGS.lensScale));
      const speed = pointer ? pointer.vx * Math.exp(-(now - pointer.movedAt) / 85) : 0;
      next.scaleY = lensBase.value * Math.max(.7, 1 - Math.abs(speed) / 5000);
      next.scaleX = lensBase.value + 1 - axes.scaleY.value;
      const shadowNext = { x: active ? 4 : 0, y: active ? 16 : 4, blur: active ? 24 : 9, alpha: active ? .22 : .16, inset: active ? .27 : .2 };
      for (const key of ['x', 'y', 'blur', 'alpha', 'inset'] as const) {
        shadow[key] = stepGlassSpring(shadow[key], shadowNext[key], seconds, spring(key === 'alpha' || key === 'inset' ? KUBE_GLASS_SPRINGS.lensShadow : KUBE_GLASS_SPRINGS.lensShape));
        if (Math.abs(shadow[key].value - shadowNext[key]) > .0004 || Math.abs(shadow[key].velocity) > .003) settled = false;
      }
    }
    for (const key of ['scaleX', 'scaleY', 'x', 'y'] as const) {
      axes[key] = stepGlassSpring(axes[key], next[key], seconds, parameters);
      const positionTolerance = key === 'x' || key === 'y' ? .015 : .0004, velocityTolerance = key === 'x' || key === 'y' ? .08 : .003;
      if (Math.abs(axes[key].value - next[key]) > positionTolerance || Math.abs(axes[key].velocity) > velocityTolerance) settled = false;
    }
    const materialNext = glassMaterialTarget(preset, !!pointer || keyboard, focused);
    for (const key of ['fill', 'refraction', 'magnification'] as const) {
      const spring = key === 'fill' ? KUBE_GLASS_SPRINGS.fill : preset === 'lens' ? KUBE_GLASS_SPRINGS.lensOptics : KUBE_GLASS_SPRINGS.thumbRefraction;
      material[key] = stepGlassSpring(material[key], materialNext[key], seconds, glassSpringParameters(spring, mode()));
      if (Math.abs(material[key].value - materialNext[key]) > .0004 || Math.abs(material[key].velocity) > .003) settled = false;
    }
    if (settled || now - startedAt > 1200) {
      for (const key of ['scaleX', 'scaleY', 'x', 'y'] as const) axes[key] = { value: next[key], velocity: 0 };
      for (const key of ['fill', 'refraction', 'magnification'] as const) material[key] = { value: materialNext[key], velocity: 0 };
      draw(); restoreWillChange(); return;
    }
    draw(); frame = requestAnimationFrame(tick);
  };
  function animate() {
    if (!enabled()) { reset(); return; }
    if (!moving) { moving = true; element.style.setProperty('will-change', 'scale, translate'); }
    // Real input may continue for minutes. Bound work after the last input,
    // rather than snapping an ongoing drag every 1.2 seconds.
    startedAt = performance.now();
    if (frame) return;
    previousAt = startedAt; frame = requestAnimationFrame(tick);
  }
  const endPointer = (event: { pointerId: number }) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    pointer = undefined; element.dataset.glassElasticState = keyboard ? 'press' : 'rest'; animate();
  };
  draw(); element.dataset.glassElasticState = 'rest';
  return {
    pointerDown(event: PointerLike) {
      if (!enabled() || event.isPrimary === false || (event.button ?? 0) !== 0 || pointer) return;
      const owner = event.currentTarget instanceof HTMLElement ? event.currentTarget : element;
      if (owner.closest(':disabled,[aria-disabled="true"],[inert]')) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, vx: 0, vy: 0, movedAt: performance.now() };
      element.dataset.glassElasticState = 'press'; animate();
    },
    pointerMove(event: PointerLike) {
      if (!pointer || pointer.id !== event.pointerId) return;
      const seconds = Math.max(8, event.timeStamp - pointer.at) / 1000;
      pointer.vx += (clamp((event.clientX - pointer.x) / seconds, -4000, 4000) - pointer.vx) * .4;
      pointer.vy += (clamp((event.clientY - pointer.y) / seconds, -4000, 4000) - pointer.vy) * .4;
      pointer.x = event.clientX; pointer.y = event.clientY; pointer.at = event.timeStamp; pointer.movedAt = performance.now();
      element.dataset.glassElasticState = 'drag'; animate();
    },
    pointerUp: endPointer,
    pointerCancel: endPointer,
    keyDown(event: KeyLike) {
      if (!enabled() || event.isComposing || ![' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      keyboard = true; element.dataset.glassElasticState = 'press'; animate();
    },
    keyUp(event: KeyLike) {
      if (!keyboard || ![' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      keyboard = false; element.dataset.glassElasticState = pointer ? 'press' : 'rest'; animate();
    },
    focus() { focused = true; animate(); },
    blur() { reset(false); }, reset,
    destroy() {
      destroyed = true; cancelAnimationFrame(frame); frame = 0; restoreWillChange();
      for (const { name, value, priority } of original) { if (value) element.style.setProperty(name, value, priority); else element.style.removeProperty(name); }
      if (!hadClass) element.classList.remove('glass-elastic');
      if (preset === 'lens') { if (originalShadow) element.style.setProperty('box-shadow', originalShadow); else element.style.removeProperty('box-shadow'); }
      if (originalState === null) element.removeAttribute('data-glass-elastic-state'); else element.setAttribute('data-glass-elastic-state', originalState);
    },
  };
}

export function useGlassElasticity<T extends HTMLElement = HTMLElement>(options: GlassElasticOptions = {}) {
  const ref = useRef<T>(null), currentOptions = useRef(options); currentOptions.current = options;
  const controller = useRef<ReturnType<typeof createGlassElasticController> | undefined>(undefined);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const elastic = createGlassElasticController(ref.current, { preset: options.preset, deform: options.deform, disabled: () => typeof currentOptions.current.disabled === 'function' ? currentOptions.current.disabled() : !!currentOptions.current.disabled, motion: () => currentOptions.current.motion?.() ?? (document.documentElement.dataset.motion as ElasticMotion || 'standard') });
    controller.current = elastic;
    const end = (event: PointerEvent) => elastic.pointerUp(event), cancel = (event: PointerEvent) => elastic.pointerCancel(event), blur = () => elastic.blur();
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let lastMotion = document.documentElement.dataset.motion, lastReduced = media.matches;
    const preference = () => {
      const next = document.documentElement.dataset.motion;
      if (next === lastMotion && media.matches === lastReduced) return;
      lastMotion = next; lastReduced = media.matches; elastic.reset();
    };
    const observer = new MutationObserver(preference); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    window.addEventListener('pointerup', end, true); window.addEventListener('pointercancel', cancel, true); window.addEventListener('blur', blur); media.addEventListener('change', preference);
    return () => { observer.disconnect(); window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('blur', blur); media.removeEventListener('change', preference); elastic.destroy(); controller.current = undefined; };
  }, [options.preset, options.deform]);
  return {
    ref, className: 'glass-elastic', bindings: {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => controller.current?.pointerDown(event),
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => controller.current?.pointerMove(event),
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => controller.current?.pointerUp(event),
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => controller.current?.pointerCancel(event),
      onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => controller.current?.pointerCancel(event),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => controller.current?.keyDown(event),
      onKeyUp: (event: ReactKeyboardEvent<HTMLElement>) => controller.current?.keyUp(event),
      onBlur: () => controller.current?.blur(),
    },
  };
}

export const useGlassButtonElasticity = () => useGlassElasticity<HTMLButtonElement>({ preset: 'button' });

/** A controlled position spring, separate from the optical/scale springs. */
export function useGlassSpringValue(value: number, parameters: SpringParameters, immediate = false) {
  const axis = useRef<SpringAxis>({ value, velocity: 0 }), [display, setDisplay] = useState(value);
  const mode = resolveMotionMode(useMotionSnapshot().split(':')[0]), sampledAt = useRef(0);
  useLayoutEffect(() => {
    if (!animatedMotion(mode)) { axis.current = { value, velocity: 0 }; sampledAt.current = 0; setDisplay(value); return; }
    if (immediate) { const now = performance.now(); axis.current = sampleGlassDragAxis(axis.current, value, sampledAt.current ? now - sampledAt.current : 0); sampledAt.current = now; setDisplay(value); return; }
    sampledAt.current = 0;
    let frame = 0, previous = performance.now(), start = previous;
    const spring = glassSpringParameters(parameters, mode);
    const tick = (now: number) => {
      axis.current = stepGlassSpring(axis.current, value, (now - previous) / 1000, spring); previous = now;
      if ((Math.abs(axis.current.value - value) < .01 && Math.abs(axis.current.velocity) < .05) || now - start > 1500) { axis.current = { value, velocity: 0 }; setDisplay(value); return; }
      setDisplay(axis.current.value); frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, parameters.stiffness, parameters.damping, parameters.mass, immediate, mode]);
  return display;
}

/** Compose visual feedback with an existing behavior without suppressing
 * native defaults, focus, value changes, click or a previous handler. */
export function composeGlassHandlers<T>(behavior: ((event: T) => void) | undefined, feedback: ((event: T) => void) | undefined) {
  return (event: T) => { behavior?.(event); feedback?.(event); };
}
