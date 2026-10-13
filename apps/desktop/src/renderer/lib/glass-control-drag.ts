export type GlassOptionBounds = { value: string; x: number; width: number; disabled?: boolean };
export type GlassDragPoint = { pointerId: number; clientX: number; contentX: number };
export type GlassDragSample = { contentX: number; delta: number; moved: boolean };

export const clampGlassControl = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Convert the pointer to the unscrolled CSS coordinate space. Bounding boxes
 * include ancestor zoom/transforms; scrollLeft and option offsets do not. */
export function glassPointerCoordinate(clientX: number, bounds: { left: number; width: number; clientWidth: number; scrollLeft?: number }) {
  const scale = bounds.width > 0 && bounds.clientWidth > 0 ? bounds.width / bounds.clientWidth : 1;
  return (clientX - bounds.left) / scale + (bounds.scrollLeft ?? 0);
}

/** Disabled options never become a drag destination, even if their center is
 * closest. Stable order resolves an exact tie without oscillating. */
export function nearestGlassOption(options: readonly GlassOptionBounds[], center: number) {
  return options.reduce<GlassOptionBounds | undefined>((best, option) => {
    if (option.disabled || option.width <= 0 || !Number.isFinite(option.x + option.width)) return best;
    return !best || Math.abs(option.x + option.width / 2 - center) < Math.abs(best.x + best.width / 2 - center) ? option : best;
  }, undefined);
}

/** A held lens reveals the actual captions as it leaves the committed pill.
 * Smoothstep has no binary midpoint and no abrupt slope at either endpoint. */
export function glassSelectionFillOpacity(distance: number, selectedWidth: number) {
  const amount = clampGlassControl(Math.abs(distance) / Math.max(24, selectedWidth * .55), 0, 1);
  return 1 - amount * amount * (3 - 2 * amount);
}

export function rubberBandGlassControl(value: number, min: number, max: number) {
  const clipped = clampGlassControl(value, min, max);
  return clipped + (value - clipped) / 22;
}

/** Shared switch/segmented gesture ownership. A release consumes the session
 * before callbacks run: duplicate up/lost-capture cannot commit twice. */
export function createGlassControlDrag(threshold = 4) {
  let active: (GlassDragPoint & { moved: boolean; latest: GlassDragSample }) | undefined;
  const update = (point: GlassDragPoint) => {
    if (!active || active.pointerId !== point.pointerId) return;
    active.moved ||= Math.abs(point.clientX - active.clientX) > threshold;
    active.latest = { contentX: point.contentX, delta: point.contentX - active.contentX, moved: active.moved };
    return active.latest;
  };
  return {
    begin(point: GlassDragPoint) {
      if (active) return false;
      active = { ...point, moved: false, latest: { contentX: point.contentX, delta: 0, moved: false } };
      return true;
    },
    update,
    finish(point: GlassDragPoint) { const sample = update(point); if (sample) active = undefined; return sample; },
    cancel(pointerId?: number) { if (pointerId === undefined || active?.pointerId === pointerId) active = undefined; },
    get pointerId() { return active?.pointerId; },
    get sample() { return active?.latest; },
  };
}
