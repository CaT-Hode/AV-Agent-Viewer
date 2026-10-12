import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { glassSpringParameters, sampleGlassDragAxis, stepGlassSpring, useGlassElasticity, useGlassSpringValue } from '../lib/glass-elasticity';
import { animatedMotion, resolveMotionMode, useMotionSnapshot } from '../lib/motion';
import { KUBE_GLASS_PRESETS, KUBE_GLASS_SPRINGS } from '../lib/glass-presets';
import { SETTINGS_CONTROL_SCALE } from './GlassControls';

export function GlassSegmentedControl({ label, value, options, onChange, disabled = false }: {
  label: string; value: string; options: { value: string; label: string; disabled?: boolean; reason?: string }[]; onChange(value: string): void; disabled?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null), [geometry, setGeometry] = useState({ x: 0, width: 90 }), [dragX, setDragX] = useState<number>();
  const elastic = useGlassElasticity<HTMLDivElement>({ preset: 'slider', deform: false, disabled });
  // Keep the committed color below the labels. The independently dragged lens
  // sits above them, so its live backdrop includes the actual option text.
  const selectedX = useGlassSpringValue(geometry.x, KUBE_GLASS_SPRINGS.switchPosition);
  const drag = useRef<{ id: number; start: number; grab: number; moved: boolean; width: number } | undefined>(undefined), suppress = useRef(false), frame = useRef(0), position = useRef({ value: 0, velocity: 0 }), sampledAt = useRef(0);
  const mode = resolveMotionMode(useMotionSnapshot().split(':')[0]);
  const callbacks = useRef({ value, options, onChange }); callbacks.current = { value, options, onChange };
  useLayoutEffect(() => {
    const root = track.current; if (!root) return;
    const measure = () => { const buttons = [...root.querySelectorAll<HTMLButtonElement>('[role=radio]')], selected = buttons.find(button => button.dataset.value === value) ?? buttons[0]; if (selected) { if (selected.offsetLeft < root.scrollLeft + 3) root.scrollLeft = Math.max(0, selected.offsetLeft - 3); else if (selected.offsetLeft + selected.offsetWidth > root.scrollLeft + root.clientWidth - 3) root.scrollLeft = selected.offsetLeft + selected.offsetWidth - root.clientWidth + 3; setGeometry(old => old.x === selected.offsetLeft && old.width === selected.offsetWidth ? old : { x: selected.offsetLeft, width: selected.offsetWidth }); } };
    const observer = new ResizeObserver(measure); observer.observe(root); measure(); return () => observer.disconnect();
  }, [value, options.map(option => option.value + option.label).join('|')]);
  useLayoutEffect(() => {
    cancelAnimationFrame(frame.current); const node = elastic.ref.current; if (!node) return;
    const paint = (x: number) => { node.style.left = '0px'; node.style.transform = `translateX(${x}px)`; };
    if (dragX !== undefined) { const now = performance.now(); position.current = sampleGlassDragAxis(position.current, dragX, sampledAt.current ? now - sampledAt.current : 0); sampledAt.current = now; paint(dragX); return; }
    sampledAt.current = 0;
    if (!animatedMotion(mode)) { position.current = { value: geometry.x, velocity: 0 }; paint(geometry.x); return; }
    const parameters = glassSpringParameters({ stiffness: 1000, damping: 80 }, mode);
    let previous = performance.now(), started = previous;
    const tick = (now: number) => {
      position.current = stepGlassSpring(position.current, geometry.x, (now - previous) / 1000, parameters); previous = now;
      paint(position.current.value);
      if ((Math.abs(position.current.value - geometry.x) < .03 && Math.abs(position.current.velocity) < .1) || now - started > 1200) { position.current = { value: geometry.x, velocity: 0 }; paint(geometry.x); frame.current = 0; return; }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame.current);
  }, [geometry.x, dragX, mode]);
  const cancel = () => { drag.current = undefined; suppress.current = false; setDragX(undefined); };
  useEffect(() => { window.addEventListener('blur', cancel); return () => { window.removeEventListener('blur', cancel); cancelAnimationFrame(frame.current); }; }, []);
  const choose = (next: string) => { if (!disabled && !callbacks.current.options.find(option => option.value === next)?.disabled && next !== callbacks.current.value) callbacks.current.onChange(next); };
  const focusValue = options.some(option => option.value === value && !option.disabled) ? value : options.find(option => !option.disabled)?.value;
  return <div ref={track} className="glass-segmented" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}
    onPointerDown={event => { if (disabled || event.button !== 0 || !event.isPrimary || (event.target instanceof Element && event.target.closest('[role="radio"]:disabled'))) return; const root = event.currentTarget, box = root.getBoundingClientRect(); suppress.current = false; elastic.bindings.onPointerDown(event); drag.current = { id: event.pointerId, start: event.clientX, grab: Math.max(0, Math.min(geometry.width, event.clientX - box.left + root.scrollLeft - position.current.value)), moved: false, width: geometry.width }; root.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { elastic.bindings.onPointerMove(event); const current = drag.current; if (!current || current.id !== event.pointerId) return; if (Math.abs(event.clientX - current.start) > 5) current.moved = true; if (current.moved) { const box = event.currentTarget.getBoundingClientRect(); setDragX(Math.max(4, Math.min(event.currentTarget.scrollWidth - current.width - 4, event.clientX - box.left + event.currentTarget.scrollLeft - current.grab))); } }}
    onPointerUp={event => { elastic.bindings.onPointerUp(event); const current = drag.current; if (!current || current.id !== event.pointerId) return; drag.current = undefined; suppress.current = true; { const box = event.currentTarget.getBoundingClientRect(); const x = current.moved ? (dragX ?? geometry.x) + current.width / 2 : event.clientX - box.left + event.currentTarget.scrollLeft, buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')]; const nearest = buttons.reduce((best, button) => Math.abs(button.offsetLeft + button.offsetWidth / 2 - x) < Math.abs(best.offsetLeft + best.offsetWidth / 2 - x) ? button : best, buttons[0]); if (nearest) { choose(nearest.dataset.value!); nearest.focus({ preventScroll: true }); } } setDragX(undefined); }}
    onPointerCancel={event => { elastic.bindings.onPointerCancel(event); cancel(); }} onLostPointerCapture={event => { elastic.bindings.onLostPointerCapture(event); if (drag.current?.id === event.pointerId) cancel(); }}
    onClickCapture={event => { if (suppress.current) { suppress.current = false; event.preventDefault(); event.stopPropagation(); } }}>
    <div className="glass-segmented-fill" style={{ width: geometry.width, transform: `translateX(${selectedX}px)` }} aria-hidden="true" />
    <div ref={elastic.ref} className={'glass-segmented-thumb material-host ' + elastic.className} style={{ width: geometry.width }} aria-hidden="true"><LiquidGlassSurface variant="slider" effect="refractive" bezelWidth={KUBE_GLASS_PRESETS.slider.bezelWidth * SETTINGS_CONTROL_SCALE} glassThickness={KUBE_GLASS_PRESETS.slider.glassThickness * SETTINGS_CONTROL_SCALE} specularOpacity={0} specularSaturation={1} /></div>
    {options.map((option, index) => <button role="radio" type="button" disabled={disabled || option.disabled} data-value={option.value} key={option.value} aria-checked={value === option.value} tabIndex={focusValue === option.value ? 0 : -1} title={option.reason ?? option.label} onClick={() => choose(option.value)} onKeyDown={event => {
      const enabled = options.map((item, itemIndex) => item.disabled ? -1 : itemIndex).filter(itemIndex => itemIndex >= 0), position = enabled.indexOf(index);
      const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? enabled[Math.min(enabled.length - 1, position + 1)] : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? enabled[Math.max(0, position - 1)] : event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : undefined;
      if (next === undefined) return; event.preventDefault(); choose(options[next].value); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus({ preventScroll: true });
    }}>{option.label}</button>)}
  </div>;
}
