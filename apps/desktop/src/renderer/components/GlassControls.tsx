import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { GlassControlIndicator } from './GlassControlIndicator';
import { useGlassElasticity, useGlassSpringValue } from '../lib/glass-elasticity';
import { GLASS_CONTROL_METRICS, KUBE_GLASS_SPRINGS } from '../lib/glass-presets';
import { clampGlassControl, createGlassControlDrag, glassPointerCoordinate, rubberBandGlassControl } from '../lib/glass-control-drag';
import { GLASS_RANGE_REFERENCE } from '../lib/glass-range-reference';
export { GLASS_CONTROL_METRICS } from '../lib/glass-presets';
export const SETTINGS_CONTROL_SCALE = .6;
// Preserve the reference proportions, but lay out the compact control in real
// CSS pixels. CSS zoom would also scale the filter and pointer coordinate space.
export const SETTINGS_SWITCH_SCALE = .425;
export const COMPACT_SWITCH_METRICS = Object.fromEntries(Object.entries(GLASS_CONTROL_METRICS.switch).map(([key, value]) => [key, value * SETTINGS_SWITCH_SCALE])) as Record<keyof typeof GLASS_CONTROL_METRICS.switch, number>;

export function GlassSwitch({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  const elastic = useGlassElasticity<HTMLSpanElement>({ preset: 'switch', disabled });
  const geometry = COMPACT_SWITCH_METRICS;
  const pointer = useRef<{ id: number; owner: HTMLButtonElement; origin: number } | undefined>(undefined), gesture = useRef(createGlassControlDrag());
  const suppressClick = useRef(false);
  const [offset, setOffset] = useState<number>();
  const position = useGlassSpringValue(offset ?? (checked ? geometry.travel : 0), KUBE_GLASS_SPRINGS.switchPosition, offset !== undefined);
  const colorRatio = useGlassSpringValue(offset === undefined ? checked ? 1 : 0 : clampGlassControl(offset / geometry.travel, 0, 1), KUBE_GLASS_SPRINGS.fill, offset !== undefined);
  const coordinate = (clientX: number, owner: HTMLButtonElement) => { const box = owner.getBoundingClientRect(); return glassPointerCoordinate(clientX, { left: box.left, width: box.width, clientWidth: geometry.trackWidth }); };
  const cancel = () => {
    const active = pointer.current; pointer.current = undefined; gesture.current.cancel(); suppressClick.current = false; setOffset(undefined); elastic.bindings.onBlur();
    if (active?.owner.hasPointerCapture(active.id)) active.owner.releasePointerCapture(active.id);
  };
  useEffect(() => { const blur = () => cancel(); window.addEventListener('blur', blur); return () => window.removeEventListener('blur', blur); }, []);
  useEffect(() => { cancel(); }, [disabled, checked]);
  return <button role="switch" aria-label={label} aria-checked={checked} disabled={disabled} className={'setting-switch glass-switch' + (checked ? ' on' : '')} data-glass-control-owner="switch"
    style={{ '--switch-track-width': `${geometry.trackWidth}px`, '--switch-track-height': `${geometry.trackHeight}px`, '--switch-thumb-width': `${geometry.thumbWidth}px`, '--switch-thumb-height': `${geometry.thumbHeight}px`, '--switch-thumb-radius': `${geometry.thumbRadius}px`, '--switch-thumb-left': `${geometry.thumbLeft}px`, backgroundColor: `rgba(${Math.round(148 + (59 - 148) * colorRatio)},${Math.round(148 + (191 - 148) * colorRatio)},${Math.round(159 + (78 - 159) * colorRatio)},${(119 + (238 - 119) * colorRatio) / 255})`, transition: 'none' } as CSSProperties}
    onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onChange(!checked); }}
    onPointerDown={event => {
      if (disabled || event.isPrimary === false || event.button !== 0) return;
      if (!gesture.current.begin({ pointerId: event.pointerId, clientX: event.clientX, contentX: coordinate(event.clientX, event.currentTarget) })) return;
      elastic.bindings.onPointerDown(event);
      pointer.current = { id: event.pointerId, owner: event.currentTarget, origin: position }; event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      elastic.bindings.onPointerMove(event);
      if (!pointer.current || pointer.current.id !== event.pointerId) return;
      const sample = gesture.current.update({ pointerId: event.pointerId, clientX: event.clientX, contentX: coordinate(event.clientX, event.currentTarget) });
      if (sample?.moved) setOffset(rubberBandGlassControl(pointer.current.origin + sample.delta, 0, geometry.travel));
    }}
    onPointerUp={event => {
      elastic.bindings.onPointerUp(event);
      const active = pointer.current; if (!active || active.id !== event.pointerId) return;
      const sample = gesture.current.finish({ pointerId: event.pointerId, clientX: event.clientX, contentX: coordinate(event.clientX, event.currentTarget) }); pointer.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (sample?.moved) {
        const next = active.origin + sample.delta > geometry.travel / 2;
        suppressClick.current = true; if (next !== checked) onChange(next);
      }
      setOffset(undefined);
    }} onPointerCancel={event => { elastic.bindings.onPointerCancel(event); cancel(); }}
    onLostPointerCapture={event => { elastic.bindings.onLostPointerCapture(event); if (pointer.current?.id === event.pointerId) cancel(); }}
    onKeyDown={elastic.bindings.onKeyDown} onKeyUp={elastic.bindings.onKeyUp} onBlur={() => { elastic.bindings.onBlur(); cancel(); }}>
    <GlassControlIndicator materialRef={elastic.ref} className="glass-switch-thumb" variant="switch" opticalScale={SETTINGS_SWITCH_SCALE} style={{ translate: `${position}px -50%`, transform: 'none', transition: 'none' }} />
  </button>;
}

/** Native input semantics and keyboard handling, with an independent optical
 * thumb. A drag commits one setting transaction, preserving global undo. */
export function GlassRangeControl({ label, value, min, max, step = 1, onChange, disabled = false }: {
  label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void; disabled?: boolean;
}) {
  const elastic = useGlassElasticity<HTMLSpanElement>({ preset: 'slider', disabled });
  const [draft, setDraft] = useState(value), pointerId = useRef<number | undefined>(undefined), staged = useRef(false), committed = useRef(value);
  const cancel = () => { pointerId.current = undefined; staged.current = false; setDraft(committed.current); elastic.bindings.onBlur(); };
  useEffect(() => { committed.current = value; if (pointerId.current === undefined) setDraft(value); }, [value]);
  useEffect(() => { const blur = () => cancel(); window.addEventListener('blur', blur); return () => window.removeEventListener('blur', blur); }, []);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  const commit = (next: number) => {
    pointerId.current = undefined; staged.current = false;
    if (disabled || !Number.isFinite(next) || next < min || next > max) return;
    if (next === committed.current) return;
    committed.current = next; onChange(next);
  };
  const progress = max > min ? Math.max(0, Math.min(1, (draft - min) / (max - min))) : 0;
  return <div className="glass-range-control" data-glass-control-owner="range" style={{ '--range-thumb-width': `${GLASS_RANGE_REFERENCE.width}px`, '--range-thumb-height': `${GLASS_RANGE_REFERENCE.height}px`, '--range-thumb-radius': `${GLASS_RANGE_REFERENCE.radius}px`, '--range-resting-width': `${GLASS_RANGE_REFERENCE.restingWidth}px`, '--range-thumb-inset': `${GLASS_RANGE_REFERENCE.inset}px` } as CSSProperties}>
    <div className="glass-range" style={{ '--range-progress': progress } as CSSProperties}>
      <div className="glass-range-track" aria-hidden="true" />
      <GlassControlIndicator materialRef={elastic.ref} className="glass-range-thumb" variant="slider" opticalScale={GLASS_RANGE_REFERENCE.opticalScale} />
      <input aria-label={label + '滑块'} type="range" min={min} max={max} step={step} value={draft} disabled={disabled}
        onPointerDown={event => { elastic.bindings.onPointerDown(event); if (!disabled && event.isPrimary !== false && event.button === 0) pointerId.current = event.pointerId; }}
        onPointerMove={elastic.bindings.onPointerMove}
        onChange={event => { staged.current = true; setDraft(Number(event.target.value)); }}
        onPointerUp={event => { elastic.bindings.onPointerUp(event); if (pointerId.current === event.pointerId) commit(Number(event.currentTarget.value)); }}
        onPointerCancel={event => { elastic.bindings.onPointerCancel(event); if (pointerId.current === event.pointerId) cancel(); }}
        onLostPointerCapture={event => { elastic.bindings.onLostPointerCapture(event); if (pointerId.current === event.pointerId) cancel(); }}
        onKeyDown={elastic.bindings.onKeyDown}
        onKeyUp={event => { elastic.bindings.onKeyUp(event); if (staged.current && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) commit(Number(event.currentTarget.value)); }}
        onBlur={event => { elastic.bindings.onBlur(); if (staged.current) commit(Number(event.currentTarget.value)); }} />
    </div>
    <input aria-label={label} type="number" min={min} max={max} step={step} value={draft} disabled={disabled} onChange={event => {
      if (!event.target.value) return;
      const next = Number(event.target.value); if (!Number.isFinite(next)) return;
      setDraft(next); if (next >= min && next <= max) commit(next);
    }} />
  </div>;
}
