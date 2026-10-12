export type BackdropFrameRect = { x: number; y: number; width: number; height: number };
export type BackdropFrameViewport = { width: number; height: number };

const MAX_DENOMINATOR = 16;
const DENSITY_TOLERANCE = 1e-7;
const PIXEL_TOLERANCE = 1e-4;

/** Smallest integer DIP step whose products with the display density are
 * integer physical pixels. Display density is independent of page/tool zoom. */
function densityStep(density: number): number | undefined {
  if (!Number.isFinite(density) || density <= 0) return;
  for (let denominator = 1; denominator <= MAX_DENOMINATOR; denominator++) {
    const numerator = Math.round(density * denominator);
    if (numerator > 0 && Number.isSafeInteger(numerator) && Math.abs(numerator / denominator - density) <= DENSITY_TOLERANCE * Math.max(1, density)) return denominator;
  }
}

function positiveRect(rect: BackdropFrameRect): boolean {
  return [rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

/** Convert an already aligned integer-DIP rectangle into physical pixels.
 * Reject non-aligned input rather than silently flooring its origin. */
export function physicalFrameCrop(rect: BackdropFrameRect, density: number): BackdropFrameRect | undefined {
  const step = densityStep(density);
  if (!step || !positiveRect(rect) || rect.x < 0 || rect.y < 0) return;
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every(value => Number.isSafeInteger(value) && value % step === 0)) return;
  const products = values.map(value => value * density), pixels = products.map(Math.round);
  if (!pixels.every((value, index) => Number.isSafeInteger(value) && Math.abs(value - products[index]) <= PIXEL_TOLERANCE)) return;
  return { x: pixels[0], y: pixels[1], width: pixels[2], height: pixels[3] };
}

/** Outward-expand a page-relative DIP ROI onto an integer-DIP/pixel grid, then
 * clamp to the viewport's aligned interior. At 150% the step is 2 DIP; at
 * 125%/175% it is 4 DIP. An unaligned final viewport edge is intentionally
 * excluded. The returned rectangle is the actual capturePage/crop rectangle,
 * and must replace the original ROI in metadata and cache identity.
 * Undefined means no safe aligned region/density; use capturePage fallback. */
export function alignFrameCapture(rect: BackdropFrameRect, viewport: BackdropFrameViewport, density: number): BackdropFrameRect | undefined {
  const step = densityStep(density);
  if (!step || !positiveRect(rect) || ![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) return;
  const availableRight = Math.floor(viewport.width / step) * step, availableBottom = Math.floor(viewport.height / step) * step;
  const left = Math.max(0, Math.floor(rect.x / step) * step), top = Math.max(0, Math.floor(rect.y / step) * step);
  const right = Math.min(availableRight, Math.ceil((rect.x + rect.width) / step) * step), bottom = Math.min(availableBottom, Math.ceil((rect.y + rect.height) / step) * step);
  const aligned = { x: left, y: top, width: right - left, height: bottom - top };
  return physicalFrameCrop(aligned, density) ? aligned : undefined;
}
