import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { useGlassElasticity, useGlassSpringValue } from '../lib/glass-elasticity';
import { GLASS_CONTROL_METRICS, KUBE_GLASS_SPRINGS } from '../lib/glass-presets';
import { KUBE_GLASS_PRESETS } from '../lib/glass-presets';
export { GLASS_CONTROL_METRICS } from '../lib/glass-presets';
export const SETTINGS_CONTROL_SCALE = .6;
// Preserve the reference proportions, but lay out the compact control in real
// CSS pixels. CSS zoom would also scale the filter and pointer coordinate space.
export const SETTINGS_SWITCH_SCALE = .425;
export const COMPACT_SWITCH_METRICS = Object.fromEntries(Object.entries(GLASS_CONTROL_METRICS.switch).map(([key, value]) => [key, value * SETTINGS_SWITCH_SCALE])) as Record<keyof typeof GLASS_CONTROL_METRICS.switch, number>;

export function GlassSwitch({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  const elastic = useGlassElasticity<HTMLSpanElement>({ preset: 'switch', disabled });
  const geometry = COMPACT_SWITCH_METRICS;
  const pointer = useRef<{ id: number; owner: HTMLButtonElement; x: number; origin: number; moved: boolean; scale: number } | undefined>(undefined);
  const suppressClick = useRef(false);
  const [offset, setOffset] = useState<number>();
  const position = useGlassSpringValue(offset ?? (checked ? geometry.travel : 0), KUBE_GLASS_SPRINGS.switchPosition, offset !== undefined);
  const colorRatio = useGlassSpringValue(offset === undefined ? checked ? 1 : 0 : offset > geometry.travel / 2 ? 1 : 0, KUBE_GLASS_SPRINGS.switchPosition);
  const cancel = () => {
    const active = pointer.current; pointer.current = undefined; suppressClick.current = false; setOffset(undefined);
    if (active?.owner.hasPointerCapture(active.id)) active.owner.releasePointerCapture(active.id);
  };
  useEffect(() => { const blur = () => cancel(); window.addEventListener('blur', blur); return () => window.removeEventListener('blur', blur); }, []);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  return <button role="switch" aria-label={label} aria-checked={checked} disabled={disabled} className={'setting-switch glass-switch' + (checked ? ' on' : '')}
    style={{ '--switch-track-width': `${geometry.trackWidth}px`, '--switch-track-height': `${geometry.trackHeight}px`, '--switch-thumb-width': `${geometry.thumbWidth}px`, '--switch-thumb-height': `${geometry.thumbHeight}px`, '--switch-thumb-radius': `${geometry.thumbRadius}px`, '--switch-thumb-left': `${geometry.thumbLeft}px`, backgroundColor: `rgba(${Math.round(148 + (59 - 148) * colorRatio)},${Math.round(148 + (191 - 148) * colorRatio)},${Math.round(159 + (78 - 159) * colorRatio)},${(119 + (238 - 119) * colorRatio) / 255})`, transition: 'none' } as CSSProperties}
    onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onChange(!checked); }}
    onPointerDown={event => {
      if (disabled || event.isPrimary === false || event.button !== 0) return;
      elastic.bindings.onPointerDown(event);
      pointer.current = { id: event.pointerId, owner: event.currentTarget, x: event.clientX, origin: position, moved: false, scale: event.currentTarget.getBoundingClientRect().width / geometry.trackWidth }; event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      elastic.bindings.onPointerMove(event);
      if (!pointer.current || pointer.current.id !== event.pointerId) return;
      const delta = (event.clientX - pointer.current.x) / pointer.current.scale;
      if (Math.abs(delta) > 4) pointer.current.moved = true;
      if (pointer.current.moved) {
        const raw = pointer.current.origin + delta, clipped = Math.max(0, Math.min(geometry.travel, raw));
        setOffset(clipped + (raw - clipped) / 22);
      }
    }}
    onPointerUp={event => {
      elastic.bindings.onPointerUp(event);
      const active = pointer.current; if (!active || active.id !== event.pointerId) return; pointer.current = undefined;
      if (active?.moved) {
        const next = active.origin + (event.clientX - active.x) / active.scale > geometry.travel / 2;
        suppressClick.current = true; if (next !== checked) onChange(next);
      }
      setOffset(undefined);
    }} onPointerCancel={event => { elastic.bindings.onPointerCancel(event); cancel(); }}
    onLostPointerCapture={event => { elastic.bindings.onLostPointerCapture(event); if (pointer.current?.id === event.pointerId) cancel(); }}
    onKeyDown={elastic.bindings.onKeyDown} onKeyUp={elastic.bindings.onKeyUp} onBlur={() => { elastic.bindings.onBlur(); cancel(); }}>
    <span ref={elastic.ref} className={'glass-switch-thumb material-host ' + elastic.className} style={{ translate: `${position}px -50%`, transform: 'none', transition: 'none' }}><LiquidGlassSurface variant="switch" effect="refractive" bezelWidth={KUBE_GLASS_PRESETS.switch.bezelWidth * SETTINGS_SWITCH_SCALE} glassThickness={KUBE_GLASS_PRESETS.switch.glassThickness * SETTINGS_SWITCH_SCALE} blur={KUBE_GLASS_PRESETS.switch.blur * SETTINGS_SWITCH_SCALE} /></span>
  </button>;
}

/** Native input semantics and keyboard handling, with an independent optical
 * thumb. A drag commits one setting transaction, preserving global undo. */
export function GlassRangeControl({ label, value, min, max, step = 1, onChange, disabled = false }: {
  label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void; disabled?: boolean;
}) {
  const elastic = useGlassElasticity<HTMLDivElement>({ preset: 'slider', disabled });
  const [draft, setDraft] = useState(value), dragging = useRef(false), committed = useRef(value);
  useEffect(() => { committed.current = value; if (!dragging.current) setDraft(value); }, [value]);
  useEffect(() => { const blur = () => { dragging.current = false; setDraft(committed.current); }; window.addEventListener('blur', blur); return () => window.removeEventListener('blur', blur); }, []);
  const commit = (next: number) => {
    dragging.current = false;
    if (next === committed.current) return;
    committed.current = next; onChange(next);
  };
  const progress = max > min ? Math.max(0, Math.min(1, (draft - min) / (max - min))) : 0;
  return <div className="glass-range-control">
    <div className="glass-range" style={{ '--range-progress': progress } as CSSProperties}>
      <div className="glass-range-track" aria-hidden="true" />
      <div ref={elastic.ref} className={'glass-range-thumb material-host ' + elastic.className} aria-hidden="true"><LiquidGlassSurface variant="slider" effect="refractive" bezelWidth={KUBE_GLASS_PRESETS.slider.bezelWidth * SETTINGS_CONTROL_SCALE} glassThickness={KUBE_GLASS_PRESETS.slider.glassThickness * SETTINGS_CONTROL_SCALE} /></div>
      <input aria-label={label + '滑块'} type="range" min={min} max={max} step={step} value={draft} disabled={disabled}
        onPointerDown={event => { elastic.bindings.onPointerDown(event); if (!disabled && event.isPrimary !== false && event.button === 0) dragging.current = true; }}
        onPointerMove={elastic.bindings.onPointerMove}
        onChange={event => setDraft(Number(event.target.value))}
        onPointerUp={event => { elastic.bindings.onPointerUp(event); if (dragging.current) commit(Number(event.currentTarget.value)); }}
        onPointerCancel={event => { elastic.bindings.onPointerCancel(event); dragging.current = false; setDraft(value); }}
        onLostPointerCapture={elastic.bindings.onLostPointerCapture}
        onKeyDown={elastic.bindings.onKeyDown}
        onKeyUp={event => { elastic.bindings.onKeyUp(event); commit(Number(event.currentTarget.value)); }}
        onBlur={event => { elastic.bindings.onBlur(); commit(Number(event.currentTarget.value)); }} />
    </div>
    <input aria-label={label} type="number" min={min} max={max} step={step} value={draft} disabled={disabled} onChange={event => {
      if (!event.target.value) return;
      const next = Number(event.target.value); if (!Number.isFinite(next)) return;
      setDraft(next); if (next >= min && next <= max) commit(next);
    }} />
  </div>;
}
