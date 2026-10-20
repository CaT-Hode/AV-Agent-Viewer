/** A velocity-carrying scroll spring. Logical positions are real scroll
 * offsets; only the separate edge effect moves painted content. */
export class WheelScrollAxis {
  target = 0;
  value = 0;
  private lastWritten = 0;
  private direction = 0;
  private velocity = 0;
  private maximum = Infinity;
  get moving() { return Math.abs(this.target - this.value) > .25 || Math.abs(this.velocity) > 3; }
  reset(position: number) { this.target = this.value = this.lastWritten = position; this.direction = 0; this.velocity = 0; }
  push(delta: number, position: number, maximum: number) {
    if (Math.abs(position - this.lastWritten) > 1 || this.direction && Math.sign(delta) !== this.direction) this.reset(position);
    if (!this.moving) this.reset(position);
    this.direction = Math.sign(delta);
    this.maximum = maximum;
    this.target = Math.max(0, Math.min(maximum, this.target + delta));
    // Immediate feedback, followed by acceleration and a smooth deceleration.
    this.value = position + (this.target - position) * .12;
    this.velocity += delta * 2;
    this.lastWritten = this.value;
    return this.value;
  }
  step(seconds: number, actual: number) {
    if (Math.abs(actual - this.lastWritten) > 1) { this.reset(actual); return actual; }
    const dt = Math.min(.05, Math.max(0, seconds)), omega = 22;
    const error = this.value - this.target, impulse = this.velocity + omega * error, decay = Math.exp(-omega * dt);
    this.value = this.target + (error + impulse * dt) * decay;
    this.velocity = (this.velocity - omega * impulse * dt) * decay;
    if (this.value < 0 || this.value > this.maximum) { this.value = Math.max(0, Math.min(this.maximum, this.value)); this.velocity = 0; }
    if (!this.moving) this.value = this.target;
    this.lastWritten = this.value;
    return this.value;
  }
}

/** Progressive resistance at the edge, then a velocity-preserving return. */
class ScrollElasticity {
  value = 0; private velocity = 0; private pull = 0; private releaseAt = 0; private limit = 90;
  get moving() { return Math.abs(this.value) > .1 || Math.abs(this.velocity) > 1 || this.pull !== 0; }
  push(delta: number, dimension: number, now: number) {
    if (now > this.releaseAt || this.pull * delta < 0) this.pull = 0;
    this.limit = Math.min(96, dimension * .16);
    this.pull = Math.max(-dimension * 3, Math.min(dimension * 3, this.pull + delta));
    this.releaseAt = now + 70;
  }
  step(seconds: number, now: number) {
    if (now >= this.releaseAt) this.pull = 0;
    const target = -this.pull * this.limit * .38 / (this.limit + .38 * Math.abs(this.pull));
    const dt = Math.min(.05, Math.max(0, seconds)), steps = Math.max(1, Math.ceil(dt * 180)), h = dt / steps;
    for (let n = 0; n < steps; n++) { this.velocity += ((target - this.value) * 360 - this.velocity * 30) * h; this.value += this.velocity * h; }
    if (!this.moving) { this.value = 0; this.velocity = 0; }
    return this.value;
  }
}

export const READING_MOTION_EVENT = 'agentviewer:reading-motion';

/** One coordinator for the application's nested panes. Fine/pixel trackpad
 * streams keep Chromium's native momentum; zoom and engine gestures pass through. */
export function installSmoothScrolling(doc: Document) {
  const win = doc.defaultView; if (!win) return () => {};
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  type Flight = { element: HTMLElement; axis: 'x' | 'y'; curve: WheelScrollAxis; maximum: number; elastic: ScrollElasticity; content?: HTMLElement; pendingEdge: number; lastElastic?: number; scale: number };
  const flights = new Map<HTMLElement, Flight>();
  let frame = 0, last = 0, previousWheel = -Infinity;
  const motion = (item: Flight, value: number) => {
    if (!item.content) return;
    if (value === (item.lastElastic ?? 0)) return;
    item.lastElastic = value;
    if (value) item.content.style.setProperty('--scroll-elastic-translate', `0 ${value / item.scale}px`);
    else item.content.style.removeProperty('--scroll-elastic-translate');
    item.element.dataset.scrollElastic = String(value);
    win.dispatchEvent(new CustomEvent(READING_MOTION_EVENT, { detail: { element: item.element, offset: value } }));
  };
  const offset = (item: Flight) => item.axis === 'y' ? item.element.scrollTop : item.element.scrollLeft;
  const write = (item: Flight, value: number) => item.element.scrollTo(item.axis === 'y' ? { top: value, behavior: 'instant' } : { left: value, behavior: 'instant' });
  const tick = (now: number) => {
    frame = 0;
    for (const [element, item] of flights) {
      if (!element.isConnected) { motion(item, 0); flights.delete(element); continue; }
      const dt = (now - last) / 1000;
      write(item, item.curve.step(dt, offset(item)));
      if (item.pendingEdge && Math.abs(offset(item) - item.curve.target) < 1) {
        const position = offset(item);
        if (item.pendingEdge < 0 ? position <= 1 : position >= item.maximum - 1) item.elastic.push(item.pendingEdge, element.clientHeight, now);
        item.pendingEdge = 0;
      }
      if (item.content) motion(item, item.elastic.step(dt, now));
      if (!item.curve.moving && !item.elastic.moving && !item.pendingEdge) { delete element.dataset.scrollAnimating; delete element.dataset.scrollElastic; flights.delete(element); }
    }
    last = now;
    if (flights.size) frame = win.requestAnimationFrame(tick);
  };
  const cancel = () => { win.cancelAnimationFrame(frame); frame = 0; for (const [element, item] of flights) { motion(item, 0); delete element.dataset.scrollAnimating; delete element.dataset.scrollElastic; } flights.clear(); };
  const wheel = (event: WheelEvent) => {
    const now = win.performance.now(), interval = now - previousWheel; previousWheel = now;
    const mode = doc.documentElement.dataset.motion;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || reduced.matches || mode === 'reduced' || mode === 'off') { cancel(); return; }
    const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const raw = horizontal ? event.deltaX || event.deltaY : event.deltaY;
    // Only recognize conventional 100/120px wheel notches. Variable pixel
    // deltas and high-frequency streams keep the platform's precise momentum.
    const pixels = Math.abs(raw), discrete = pixels >= 80 && (pixels % 100 === 0 || pixels % 120 === 0);
    if (!raw) return;
    const smooth = event.deltaMode !== 0 || discrete && interval >= 12;
    const axis: Flight['axis'] = horizontal ? 'x' : 'y';
    for (const target of event.composedPath()) {
      if (!(target instanceof HTMLElement)) continue;
      if (target.matches('input[type=range],select,[data-native-scroll]')) return;
      if (target.matches('input[type=number]') && target === doc.activeElement) return;
      const old = flights.get(target);
      const maximum = old?.elastic.moving ? old.maximum : axis === 'y' ? target.scrollHeight - target.clientHeight : target.scrollWidth - target.clientWidth;
      if (maximum <= 1) continue;
      const style = win.getComputedStyle(target);
      if (!/^(auto|scroll|overlay)$/.test(axis === 'y' ? style.overflowY : style.overflowX)) continue;
      const position = axis === 'y' ? target.scrollTop : target.scrollLeft;
      const content = axis === 'y' && target.matches('.document-content') ? target.querySelector<HTMLElement>(':scope > .reading-content-body,:scope > .embedded-office-stage') ?? undefined : undefined;
      const remaining = old?.axis === axis ? old.curve.target : position;
      if (raw < 0 ? remaining <= 0 : remaining >= maximum) {
        const boundary = axis === 'y' ? style.overscrollBehaviorY : style.overscrollBehaviorX;
        if (!content) { if (boundary === 'contain' || boundary === 'none') { event.preventDefault(); return; } continue; }
      }
      const delta = raw * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? (axis === 'y' ? target.clientHeight : target.clientWidth) * .85 : 1);
      const item: Flight = old?.axis === axis ? old : { element: target, axis, curve: new WheelScrollAxis(), maximum, elastic: new ScrollElasticity(), content, pendingEdge: 0, scale: Number(target.dataset.readingZoom) || 1 };
      if (item !== old) item.curve.reset(position);
      item.maximum = maximum;
      if (item.pendingEdge * delta < 0) item.pendingEdge = 0;
      const edge = raw < 0 ? position <= .5 : position >= maximum - .5;
      // Precise trackpad streams already contain OS momentum. Keep them native
      // inside the page; add only the missing edge resistance on Windows.
      if (!smooth && !edge) { if (old) { motion(old, 0); flights.delete(target); delete target.dataset.scrollAnimating; delete target.dataset.scrollElastic; } return; }
      event.preventDefault(); target.dataset.scrollAnimating = 'true';
      const overflow = remaining + delta - Math.max(0, Math.min(maximum, remaining + delta));
      if (content && edge) item.elastic.push(delta, target.clientHeight, now);
      else if (content && overflow) item.pendingEdge += overflow;
      if (smooth) write(item, item.curve.push(delta, position, maximum));
      flights.set(target, item);
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
