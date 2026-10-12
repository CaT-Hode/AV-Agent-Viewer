import { glassRadialDisplacements, NAVIGATION_METRICS } from '../apps/desktop/src/renderer/lib/navigation-optics';
export type PixelRect = { x: number; y: number; width: number; height: number };
export type InkRegion = PixelRect & { ink: number[]; opacity: number };
const rays = glassRadialDisplacements(NAVIGATION_METRICS.bezelWidth, NAVIGATION_METRICS.glassThickness, NAVIGATION_METRICS.refractiveIndex, 'convex');
export const SOURCE_NAVIGATION_SCALE = Math.max(...rays.map(Math.abs)) * NAVIGATION_METRICS.refraction;
/** Source squircle flattens toward the inner boundary. Test its visibly active
 * portion from its ray field; never demand old circular-profile inner ripples. */
export function activeSourceBezel(depth: number, width: number, scale: number) {
  if (depth <= .65 || depth >= width - .5) return false;
  const radial = rays[Math.min(127, Math.floor(depth / width * rays.length))];
  return Math.abs(radial) / 100 * 127 / 255 * scale > .5;
}
export function insidePixelRect(x: number, y: number, rect: PixelRect) { return x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height; }
/** nativeImage bitmaps are premultiplied BGRA. A fully covered foreground ink
 * pixel is g*ink+(1-g)*background, including the .65 partial-fade case. Hiding
 * foreground controls supplies the actual background for each filter state.
 * This avoids treating a changing background inside a button as warped text. */
export function opaqueInkError(index: number, ink: InkRegion, baseline: Buffer, baselineBackground: Buffer, sample: Buffer, sampleBackground: Buffer): number | undefined {
  const color = [ink.ink[2], ink.ink[1], ink.ink[0], 255], alpha = ink.opacity * ink.ink[3] / 255;
  if (alpha <= .2) return;
  const contrast = Math.max(...color.map((channel, i) => Math.abs(channel - baselineBackground[index + i])));
  if (contrast < 64) return;
  const expectedBefore = color.map((channel, i) => alpha * channel + (1 - alpha) * baselineBackground[index + i]);
  if (expectedBefore.some((channel, i) => Math.abs(channel - baseline[index + i]) > 2)) return;
  return Math.max(...color.map((channel, i) => Math.abs(alpha * channel + (1 - alpha) * sampleBackground[index + i] - sample[index + i])));
}
