/** Shared CSS-pixel geometry for App, native-view capture and both toolbars. */
export const NAVIGATION_METRICS = {
  height: 60, radius: 30, bezelWidth: 29, glassThickness: 70,
  refractiveIndex: 1.5, blur: 1, refraction: .82,
  specularOpacity: .24, specularSaturation: 4,
  overscan: 30, captureOverscan: 30, shadowGutter: 16, top: 12, horizontalInset: 12, contentInset: 20,
  buttonSize: 34, hideShift: 20,
} as const;
/** Bottom operation geometry shared by DOM, native slot and its exact crop. */
export const AGENT_OPERATION_METRICS = {
  height: 42, radius: 21, bezelWidth: 20, glassThickness: 70,
  refractiveIndex: 1.5, blur: 1, refraction: .82,
  specularOpacity: .24, specularSaturation: 4,
  captureOverscan: 29, shadowGutter: 16, bottom: 18, maxSlotWidth: 560, buttonSize: 30,
} as const;

export type BezelProfile = 'convex' | 'circle' | 'concave' | 'lip' | 'lens';
const unit = (value: number) => Math.max(0, Math.min(1, value));
/** Cross-section equations from the source article; no authored UI code is copied. */
export function glassSurfaceHeight(position: number, profile: BezelProfile): number {
  const u = unit(position), circle = (x: number) => Math.sqrt(Math.max(0, 1 - (1 - x) ** 2));
  const squircle = (x: number) => Math.pow(Math.max(0, 1 - (1 - x) ** 4), .25);
  if (profile === 'circle') return circle(u);
  if (profile === 'concave') return 1 - circle(u);
  if (profile === 'lip') {
    const blend = u ** 3 * (u * (6 * u - 15) + 10);
    return squircle(2 * u) * (1 - blend) + (1.1 - circle(u)) * blend;
  }
  return squircle(u);
}
/** Vertical ray, one air->glass boundary. The author's derivative step is 1e-4
 * in normalized bezel coordinates; travel terminates at thickness+height*bezel. */
export function traceGlassRay(position: number, bezelWidth: number, thickness: number, refractiveIndex: number, profile: BezelProfile): number {
  if (!(bezelWidth > 0) || position < 0 || position >= 1 || !(refractiveIndex > 1)) return 0;
  const h = glassSurfaceHeight(position, profile), slope = (glassSurfaceHeight(position + .0001, profile) - h) / .0001;
  const normalLength = Math.hypot(slope, 1), nx = -slope / normalLength, ny = -1 / normalLength;
  const eta = 1 / refractiveIndex, transmission = Math.sqrt(Math.max(0, 1 - eta * eta * (1 - ny * ny)));
  const x = -(eta * ny + transmission) * nx, y = eta - (eta * ny + transmission) * ny;
  return y ? x / y * (thickness + h * bezelWidth) : 0;
}
const radialCache = new Map<string, readonly number[]>();
export function glassRadialDisplacements(bezelWidth: number, thickness: number, index: number, profile: BezelProfile): readonly number[] {
  const key = `${bezelWidth}:${thickness}:${index}:${profile}`, cached = radialCache.get(key);
  if (cached) { radialCache.delete(key); radialCache.set(key, cached); return cached; }
  const rays = Object.freeze(Array.from({ length: 128 }, (_, sample) => traceGlassRay(sample / 128, bezelWidth, thickness, index, profile)));
  radialCache.set(key, rays); if (radialCache.size > 64) radialCache.delete(radialCache.keys().next().value!);
  return rays;
}
/** Fixed-100/RG8 source encoding plus the actual SVG half-range. Three blur
 * sigmas and one pixel of AA prevent a sample's image boundary entering view. */
export function glassCaptureOverscan(bezelWidth: number, thickness: number, index: number, profile: BezelProfile, refraction: number, blur: number) {
  const maximum = Math.max(0, ...glassRadialDisplacements(bezelWidth, thickness, index, profile).map(Math.abs));
  const shift = maximum * Math.min(1, maximum / 100) * 127 / 255 * refraction;
  return Math.ceil(shift + 3 * blur + 1);
}
export type NavigationBounds = { x: number; y: number; width: number; height: number };
export type NavigationBackdropSample = {
  sequence: number; capturedAt: number; sourceContentsId: number;
  navigationId: string; layoutRevision: number; geometryRevision: number;
  scrollX: number; scrollY: number; capsuleBounds: NavigationBounds;
  origin: { x: number; y: number }; cssSize: { width: number; height: number };
  pixelSize: { width: number; height: number }; density: { x: number; y: number };
};
