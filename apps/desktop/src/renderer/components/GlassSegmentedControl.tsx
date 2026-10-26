import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GlassControlIndicator } from './GlassControlIndicator';
import { useGlassElasticity, useGlassSpringValue } from '../lib/glass-elasticity';
import { KUBE_GLASS_SPRINGS } from '../lib/glass-presets';
import { createGlassControlDrag, clampGlassControl, glassPointerCoordinate, nearestGlassOption, type GlassOptionBounds } from '../lib/glass-control-drag';
import { SETTINGS_CONTROL_SCALE } from './GlassControls';
import { animatedMotion, resolveMotionMode, useMotionSnapshot } from '../lib/motion';

export function GlassSegmentedControl({ label, value, options, onChange, disabled = false }: {
  label: string; value: string; options: { value: string; label: string; disabled?: boolean; reason?: string }[]; onChange(value: string): void; disabled?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ x: 3, width: 90, scroll: 0 });
  const [dragging, setDragging] = useState<{ x: number; width: number; distance: number }>();
  const [pressed, setPressed] = useState(false);
  const motion = resolveMotionMode(useMotionSnapshot().split(':')[0]);
  const unavailable = disabled || !options.some(option => !option.disabled);
  const elastic = useGlassElasticity<HTMLSpanElement>({ preset: 'slider', deform: false, disabled: unavailable });
  const gesture = useRef(createGlassControlDrag()), grip = useRef<{ grab: number; width: number; origin: number; clientX: number; owner: HTMLDivElement; id: number } | undefined>(undefined);
  const suppress = useRef(false), callbacks = useRef({ value, options, onChange, disabled }); callbacks.current = { value, options, onChange, disabled };
  const lensX = useGlassSpringValue(dragging?.x ?? geometry.x, KUBE_GLASS_SPRINGS.switchPosition, dragging !== undefined);
  const expansion = useGlassSpringValue(pressed && animatedMotion(motion) ? 1.45 : 1, KUBE_GLASS_SPRINGS.thumbScale);
  const lensWidth = useGlassSpringValue(dragging?.width ?? geometry.width, KUBE_GLASS_SPRINGS.thumbScale);
  const optionKey = options.map(option => [option.value, option.label, !!option.disabled].join(':')).join('|');
  const getOptions = (): GlassOptionBounds[] => [...(viewport.current?.querySelectorAll<HTMLButtonElement>('[role=radio]') ?? [])].map(button => ({ value: button.dataset.value!, x: button.offsetLeft, width: button.offsetWidth, disabled: button.disabled }));
  const coordinate = (clientX: number) => { const root = viewport.current!; const box = root.getBoundingClientRect(); return glassPointerCoordinate(clientX, { left: box.left, width: box.width, clientWidth: root.clientWidth, scrollLeft: root.scrollLeft }); };
  const cancel = () => {
    const active = grip.current; grip.current = undefined; gesture.current.cancel(); suppress.current = false;
    setDragging(undefined); setPressed(false); elastic.bindings.onBlur();
    if (active?.owner.hasPointerCapture(active.id)) active.owner.releasePointerCapture(active.id);
  };
  useEffect(() => { window.addEventListener('blur', cancel); return () => window.removeEventListener('blur', cancel); }, []);
  // A remote value/options change invalidates the original gesture lease.
  useEffect(() => { cancel(); }, [value, optionKey, disabled]);
  useLayoutEffect(() => {
    const root = viewport.current; if (!root) return;
    const measure = () => {
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('[role=radio]')], selected = buttons.find(button => button.dataset.value === value) ?? buttons.find(button => !button.disabled) ?? buttons[0];
      if (!selected || selected.offsetWidth <= 0) return;
      if (!grip.current) {
        if (selected.offsetLeft < root.scrollLeft + 3) root.scrollLeft = Math.max(0, selected.offsetLeft - 3);
        else if (selected.offsetLeft + selected.offsetWidth > root.scrollLeft + root.clientWidth - 3) root.scrollLeft = selected.offsetLeft + selected.offsetWidth - root.clientWidth + 3;
      }
      setGeometry(old => old.x === selected.offsetLeft && old.width === selected.offsetWidth && old.scroll === root.scrollLeft ? old : { x: selected.offsetLeft, width: selected.offsetWidth, scroll: root.scrollLeft });
    };
    const observer = new ResizeObserver(measure); observer.observe(root); for (const button of root.querySelectorAll('[role=radio]')) observer.observe(button);
    measure(); return () => observer.disconnect();
  }, [value, optionKey]);
  const updateDrag = (clientX: number, pointerId: number) => {
    const active = grip.current; if (!active || active.id !== pointerId || !viewport.current) return;
    active.clientX = clientX;
    const sample = gesture.current.update({ pointerId, clientX, contentX: coordinate(clientX) });
    if (!sample?.moved) return;
    const bounds = getOptions(), end = Math.max(3, viewport.current.scrollWidth - active.width - 3);
    const x = clampGlassControl(sample.contentX - active.grab, 3, end), closest = nearestGlassOption(bounds, x + active.width / 2);
    setDragging({ x, width: closest?.width ?? active.width, distance: x - active.origin });
  };
  const choose = (next: string) => { const current = callbacks.current, option = current.options.find(item => item.value === next); if (!current.disabled && option && !option.disabled && next !== current.value) current.onChange(next); };
  const focusValue = options.some(option => option.value === value && !option.disabled) ? value : options.find(option => !option.disabled)?.value;
  return <div ref={track} className="glass-segmented" role="radiogroup" aria-label={label} aria-disabled={unavailable || undefined} data-glass-control-owner="segmented"
    onPointerDown={event => {
      if (unavailable || event.button !== 0 || event.isPrimary === false || !viewport.current || (event.target instanceof Element && event.target.closest('[role="radio"]:disabled'))) return;
      const contentX = coordinate(event.clientX);
      if (!gesture.current.begin({ pointerId: event.pointerId, clientX: event.clientX, contentX })) return;
      suppress.current = false; setPressed(true); elastic.bindings.onPointerDown(event);
      grip.current = { grab: clampGlassControl(contentX - lensX, 0, geometry.width), width: geometry.width, origin: lensX, clientX: event.clientX, owner: event.currentTarget, id: event.pointerId };
      setDragging({ x: lensX, width: geometry.width, distance: 0 });
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => { elastic.bindings.onPointerMove(event); updateDrag(event.clientX, event.pointerId); }}
    onPointerUp={event => {
      elastic.bindings.onPointerUp(event);
      const active = grip.current; if (!active || active.id !== event.pointerId || !viewport.current) return;
      const sample = gesture.current.finish({ pointerId: event.pointerId, clientX: event.clientX, contentX: coordinate(event.clientX) });
      grip.current = undefined; suppress.current = true; setPressed(false); setDragging(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (!sample) return;
      const center = sample.moved ? clampGlassControl(sample.contentX - active.grab, 3, Math.max(3, viewport.current.scrollWidth - active.width - 3)) + active.width / 2 : sample.contentX;
      const nearest = nearestGlassOption(getOptions(), center);
      if (nearest) { choose(nearest.value); const button = [...viewport.current.querySelectorAll<HTMLButtonElement>('[role=radio]')].find(item => item.dataset.value === nearest.value); button?.focus({ preventScroll: true }); }
    }}
    onPointerCancel={event => { elastic.bindings.onPointerCancel(event); cancel(); }}
    onLostPointerCapture={event => { elastic.bindings.onLostPointerCapture(event); if (grip.current?.id === event.pointerId) cancel(); }}
    onClickCapture={event => { if (suppress.current) { suppress.current = false; event.preventDefault(); event.stopPropagation(); } }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) cancel(); }}>
    <div ref={viewport} className="glass-segmented-viewport" onScroll={() => { const root = viewport.current!; setGeometry(old => old.scroll === root.scrollLeft ? old : { ...old, scroll: root.scrollLeft }); if (grip.current) updateDrag(grip.current.clientX, grip.current.id); }}>
      {/* One colored layer follows the same interruptible pose as the clear lens. */}
      <span className="glass-segmented-fill" style={{ width: lensWidth, transform: `translateX(${lensX}px)` }} aria-hidden="true" />
      {options.map((option, index) => <button role="radio" type="button" disabled={disabled || option.disabled} data-value={option.value} key={option.value} aria-checked={value === option.value} tabIndex={focusValue === option.value ? 0 : -1} title={option.reason ?? option.label}
        onClick={() => choose(option.value)} onKeyDown={event => {
        elastic.bindings.onKeyDown(event);
        const enabled = options.map((item, itemIndex) => item.disabled ? -1 : itemIndex).filter(itemIndex => itemIndex >= 0), position = enabled.indexOf(index);
        const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? enabled[Math.min(enabled.length - 1, position + 1)] : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? enabled[Math.max(0, position - 1)] : event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : undefined;
        if (next === undefined) return; event.preventDefault(); choose(options[next].value); track.current?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus({ preventScroll: true });
      }} onKeyUp={elastic.bindings.onKeyUp}>{option.label}</button>)}
    </div>
    {/* Width scaling shares the fill's anchor; press expansion keeps its grab origin. */}
    <GlassControlIndicator materialRef={elastic.ref} className="glass-segmented-thumb" variant="slider" opticalScale={SETTINGS_CONTROL_SCALE} quietLighting={!pressed}
      style={{ width: geometry.width, translate: `calc(${lensX - geometry.scroll}px + (${lensWidth / geometry.width} - 1) * var(--glass-elastic-origin-x, 50%)) 0px`, transform: 'none', scale: `${expansion * lensWidth / geometry.width} ${expansion}` }} />
  </div>;
}
