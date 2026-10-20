/** Exponential settling preserves distance, accepts new wheel deltas mid-flight,
 * and reverses immediately. Values are real scroll offsets, never transforms. */
export class WheelScrollAxis {
  target = 0;
  value = 0;
  private lastWritten = 0;
  private direction = 0;
  get moving() { return Math.abs(this.target - this.value) > .35; }
  reset(position: number) { this.target = this.value = this.lastWritten = position; this.direction = 0; }
  push(delta: number, position: number, maximum: number) {
    if (Math.abs(position - this.lastWritten) > 1 || this.direction && Math.sign(delta) !== this.direction) this.reset(position);
    if (!this.moving) this.reset(position);
    this.direction = Math.sign(delta);
    this.target = Math.max(0, Math.min(maximum, this.target + delta));
    // Direct feedback in the event frame; the remaining distance decays.
    this.value = position + (this.target - position) * .22;
    this.lastWritten = this.value;
    return this.value;
  }
  step(seconds: number, actual: number) {
    if (Math.abs(actual - this.lastWritten) > 1) { this.reset(actual); return actual; }
    this.value += (this.target - this.value) * -Math.expm1(-Math.min(.05, Math.max(0, seconds)) / .055);
    if (!this.moving) this.value = this.target;
    this.lastWritten = this.value;
    return this.value;
  }
}

/** One coordinator for the application's nested panes. Fine/pixel trackpad
 * streams keep Chromium's native momentum; zoom and engine gestures pass through. */
export function installSmoothScrolling(doc: Document) {
  const win = doc.defaultView; if (!win) return () => {};
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  type Flight = { element: HTMLElement; axis: 'x' | 'y'; curve: WheelScrollAxis };
  const flights = new Map<HTMLElement, Flight>();
  let frame = 0, last = 0, previousWheel = -Infinity;
  const stop = () => { win.cancelAnimationFrame(frame); frame = 0; flights.clear(); };
  const offset = (item: Flight) => item.axis === 'y' ? item.element.scrollTop : item.element.scrollLeft;
  const write = (item: Flight, value: number) => item.element.scrollTo(item.axis === 'y' ? { top: value, behavior: 'instant' } : { left: value, behavior: 'instant' });
  const tick = (now: number) => {
    frame = 0;
    for (const [element, item] of flights) {
      if (!element.isConnected) { flights.delete(element); continue; }
      write(item, item.curve.step((now - last) / 1000, offset(item)));
      if (!item.curve.moving) { delete element.dataset.scrollAnimating; flights.delete(element); }
    }
    last = now;
    if (flights.size) frame = win.requestAnimationFrame(tick);
  };
  const cancel = () => { for (const element of flights.keys()) delete element.dataset.scrollAnimating; stop(); };
  const wheel = (event: WheelEvent) => {
    const now = win.performance.now(), interval = now - previousWheel; previousWheel = now;
    const mode = doc.documentElement.dataset.motion;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || reduced.matches || mode === 'reduced' || mode === 'off') { cancel(); return; }
    const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const raw = horizontal ? event.deltaX || event.deltaY : event.deltaY;
    // Only recognize conventional 100/120px wheel notches. Variable pixel
    // deltas and high-frequency streams keep the platform's precise momentum.
    const pixels = Math.abs(raw), discrete = pixels >= 80 && (pixels % 100 === 0 || pixels % 120 === 0);
    if (!raw || event.deltaMode === 0 && (!discrete || interval < 12)) { cancel(); return; }
    const axis: Flight['axis'] = horizontal ? 'x' : 'y';
    for (const target of event.composedPath()) {
      if (!(target instanceof HTMLElement)) continue;
      if (target.matches('input[type=range],select,[data-native-scroll]')) return;
      if (target.matches('input[type=number]') && target === doc.activeElement) return;
      const maximum = axis === 'y' ? target.scrollHeight - target.clientHeight : target.scrollWidth - target.clientWidth;
      if (maximum <= 1) continue;
      const style = win.getComputedStyle(target);
      if (!/^(auto|scroll|overlay)$/.test(axis === 'y' ? style.overflowY : style.overflowX)) continue;
      const old = flights.get(target), position = axis === 'y' ? target.scrollTop : target.scrollLeft;
      const remaining = old?.axis === axis ? old.curve.target : position;
      if (raw < 0 ? remaining <= 0 : remaining >= maximum) {
        const boundary = axis === 'y' ? style.overscrollBehaviorY : style.overscrollBehaviorX;
        if (boundary === 'contain' || boundary === 'none') { event.preventDefault(); return; }
        continue;
      }
      const delta = raw * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? (axis === 'y' ? target.clientHeight : target.clientWidth) * .85 : 1);
      const item = old?.axis === axis ? old : { element: target, axis, curve: new WheelScrollAxis() };
      if (item !== old) item.curve.reset(position);
      event.preventDefault(); target.dataset.scrollAnimating = 'true';
      write(item, item.curve.push(delta, position, maximum)); flights.set(target, item);
      if (!frame) { last = now; frame = win.requestAnimationFrame(tick); }
      return;
    }
  };
  doc.addEventListener('wheel', wheel, { passive: false });
  doc.addEventListener('pointerdown', cancel, true); doc.addEventListener('keydown', cancel, true);
  win.addEventListener('blur', cancel); reduced.addEventListener('change', cancel);
  const preferences = new MutationObserver(cancel); preferences.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  return () => { cancel(); preferences.disconnect(); doc.removeEventListener('wheel', wheel); doc.removeEventListener('pointerdown', cancel, true); doc.removeEventListener('keydown', cancel, true); win.removeEventListener('blur', cancel); reduced.removeEventListener('change', cancel); };
}
