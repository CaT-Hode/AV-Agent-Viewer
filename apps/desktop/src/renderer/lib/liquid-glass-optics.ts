import { glassRadialDisplacements, traceGlassRay } from './navigation-optics';

export type GlassProfile = 'convex' | 'lip' | 'lens';
export type GlassRadius = { x: number; y: number };
export type GlassRadii = { topLeft: GlassRadius; topRight: GlassRadius; bottomRight: GlassRadius; bottomLeft: GlassRadius };
export type GlassGeometry = { width: number; height: number; radii: GlassRadii };
export type GlassOpticsOptions = GlassGeometry & { density: number; bezelWidth: number; glassThickness?: number; refractiveIndex?: number; strength: number; profile: GlassProfile; concave: boolean; overscan: number };
export type GlassOptics = { width: number; height: number; overscan: number; edgeScale: number; centerScale: number; maximumDisplacement: number; map: string; centerMap?: string; ring: string; highlight: string; centerClip: string };

export const GLASS_OPTICS_CACHE_LIMITS = { entries: 64, decodedBytes: 64 * 1024 * 1024, encodedBytes: 8 * 1024 * 1024 } as const;
type CachedOptics = { optics: GlassOptics; decodedBytes: number; encodedBytes: number };
const cache = new Map<string, CachedOptics>();
const cacheCounters = { hits: 0, builds: 0, evictions: 0, encodedBytes: 0, decodedBytes: 0, generatedPixels: 0, pngEncodes: 0 };
/** Estimates retained asset/decode cost, not Chromium's total GPU memory. */
export function glassOpticsCacheStats() { return { ...cacheCounters, entries: cache.size }; }
export function clearGlassOpticsCache() { cache.clear(); for (const key of Object.keys(cacheCounters) as (keyof typeof cacheCounters)[]) cacheCounters[key] = 0; }
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const radiusValue = (value: string, dimension: number) => Math.max(0, value.endsWith('%') ? Number.parseFloat(value) * dimension / 100 : Number.parseFloat(value) || 0);

/** Canonical used geometry; property insertion order and explicit defaults do
 * not create another PNG. Backdrop pixels and animated SVG scale are not keys. */
export function glassOpticsKey(options: GlassOpticsOptions) {
  const { width, height, radii, density, bezelWidth, strength, profile, concave, overscan } = options;
  return JSON.stringify([width, height, radii.topLeft.x, radii.topLeft.y, radii.topRight.x, radii.topRight.y, radii.bottomRight.x, radii.bottomRight.y, radii.bottomLeft.x, radii.bottomLeft.y, density, bezelWidth, options.glassThickness ?? 70, options.refractiveIndex ?? 1.5, strength, profile, concave, overscan]);
}
/** Paint/transform spring writes do not alter the local border-box geometry.
 * Keep unknown custom properties because CSS may use them in size/radius. */
export function glassGeometryStyleSignature(style: CSSStyleDeclaration) {
  const cosmetic = new Set(['transform', 'scale', 'translate', 'rotate', 'opacity', 'will-change', 'box-shadow', 'background-color', 'transition']);
  return Array.from(style).filter(name => !cosmetic.has(name) && !name.startsWith('--glass-elastic-') && !name.startsWith('--glass-material-')).sort().map(name => `${name}:${style.getPropertyValue(name)}!${style.getPropertyPriority(name)}`).join(';');
}

/** Match the host's used corner geometry, including percentages and ellipses. */
export function readGlassRadii(style: CSSStyleDeclaration, width: number, height: number): GlassRadii {
  const read = (value: string): GlassRadius => {
    const parts = value.trim().split(/\s+/);
    return { x: radiusValue(parts[0], width), y: radiusValue(parts[1] ?? parts[0], height) };
  };
  return normalizeGlassRadii({ topLeft: read(style.borderTopLeftRadius), topRight: read(style.borderTopRightRadius), bottomRight: read(style.borderBottomRightRadius), bottomLeft: read(style.borderBottomLeftRadius) }, width, height);
}
export function normalizeGlassRadii(radii: GlassRadii, width: number, height: number): GlassRadii {
  const { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl } = radii;
  const factor = Math.min(1, width / Math.max(1, tl.x + tr.x), width / Math.max(1, bl.x + br.x), height / Math.max(1, tl.y + bl.y), height / Math.max(1, tr.y + br.y));
  return Object.fromEntries(Object.entries(radii).map(([key, radius]) => [key, { x: radius.x * factor, y: radius.y * factor }])) as GlassRadii;
}
function insetRadii(radii: GlassRadii, inset: number, width: number, height: number): GlassRadii {
  return normalizeGlassRadii(Object.fromEntries(Object.entries(radii).map(([key, radius]) => [key, { x: Math.max(0, radius.x - inset), y: Math.max(0, radius.y - inset) }])) as GlassRadii, width, height);
}
export function glassRoundedPath(x: number, y: number, width: number, height: number, radii: GlassRadii): string {
  const { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl } = radii;
  const arc = (radius: GlassRadius, endX: number, endY: number) => radius.x && radius.y ? `A${radius.x},${radius.y} 0 0 1 ${endX},${endY}` : `L${endX},${endY}`;
  return `M${x + tl.x},${y}H${x + width - tr.x}${arc(tr, x + width, y + tr.y)}V${y + height - br.y}${arc(br, x + width - br.x, y + height)}H${x + bl.x}${arc(bl, x, y + height - bl.y)}V${y + tl.y}${arc(tl, x + tl.x, y)}Z`;
}

/** Continuous edge normals: straight sides meet circular/elliptical corners
 * tangentially. Ellipse distance is a near-surface SDF approximation. */
export function glassBoundary(x: number, y: number, geometry: GlassGeometry) {
  const { width, height, radii } = geometry;
  // A permitted CSS corner can extend past the host's midpoint. Select its
  // actual ellipse region rather than assuming four symmetric quadrants.
  // This function runs once per field pixel: no per-pixel arrays/objects.
  let radius: GlassRadius | undefined, sx = 0, sy = 0;
  if (-x > width / 2 - radii.topLeft.x && -y > height / 2 - radii.topLeft.y) { radius = radii.topLeft; sx = sy = -1; }
  else if (x > width / 2 - radii.topRight.x && -y > height / 2 - radii.topRight.y) { radius = radii.topRight; sx = 1; sy = -1; }
  else if (x > width / 2 - radii.bottomRight.x && y > height / 2 - radii.bottomRight.y) { radius = radii.bottomRight; sx = sy = 1; }
  else if (-x > width / 2 - radii.bottomLeft.x && y > height / 2 - radii.bottomLeft.y) { radius = radii.bottomLeft; sx = -1; sy = 1; }
  const dx = Math.abs(x) - width / 2, dy = Math.abs(y) - height / 2;
  if (radius && radius.x > 0 && radius.y > 0) {
    const qx = x * sx - (width / 2 - radius.x), qy = y * sy - (height / 2 - radius.y);
    if (Math.abs(radius.x - radius.y) < .001) {
      const length = Math.hypot(qx, qy);
      return { depth: radius.x - length, nx: qx / length * sx, ny: qy / length * sy };
    }
    const length = Math.hypot(qx / radius.x, qy / radius.y);
    const gx = qx / (radius.x * radius.x), gy = qy / (radius.y * radius.y), gradient = Math.hypot(gx, gy);
    return { depth: -length * (length - 1) / gradient, nx: gx / gradient * sx, ny: gy / gradient * sy };
  }
  return dx > dy ? { depth: -dx, nx: Math.sign(x), ny: 0 } : { depth: -dy, nx: 0, ny: Math.sign(y) };
}
export function glassBevelDisplacement(depth: number, band: number, profile: GlassProfile, strength = 1, concave = false, thickness = 70, index = 1.5) {
  return traceGlassRay(depth / band, band, thickness, index, concave ? 'concave' : profile) * strength;
}

/** Generate only optical assets. Host markup/content is never serialized. */
export function createGlassOptics(options: GlassOpticsOptions): GlassOptics {
  const key = glassOpticsKey(options), cached = cache.get(key);
  if (cached) { cacheCounters.hits++; cache.delete(key); cache.set(key, cached); return cached.optics; }
  cacheCounters.builds++;
  const { width, height, radii, density, bezelWidth, strength, profile, concave, overscan } = options;
  const totalWidth = width + overscan * 2, totalHeight = height + overscan * 2;
  const radial = glassRadialDisplacements(bezelWidth, options.glassThickness ?? 70, options.refractiveIndex ?? 1.5, concave ? 'concave' : profile);
  const maximumDisplacement = Math.max(0, ...radial.map(Math.abs));
  // Match the published component's actual filter: its map is encoded against
  // 100 CSS px, while SVG scale is max(trace)*ratio (not a physical 2*max).
  const edgeScale = maximumDisplacement * strength;
  const centerScale = profile === 'lens' ? 24 : 0;
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(totalWidth * density); canvas.height = Math.ceil(totalHeight * density);
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(canvas.width, canvas.height), reflection = context.createImageData(canvas.width, canvas.height);
  const center = profile === 'lens' ? context.createImageData(canvas.width, canvas.height) : undefined;
  const neutral = new Uint32Array(new Uint8Array([128, 128, 0, 255]).buffer)[0];
  new Uint32Array(image.data.buffer).fill(neutral);
  const channel = (displacement: number, normalization: number) => Math.round(clamp(128 + displacement / normalization * 127, 0, 255));
  const cx = overscan + width / 2, cy = overscan + height / 2;
  const lensRadius = Math.max(width, height) / 2;
  const leftRadius = Math.max(radii.topLeft.x, radii.bottomLeft.x), rightRadius = Math.max(radii.topRight.x, radii.bottomRight.x);
  const topRadius = Math.max(radii.topLeft.y, radii.topRight.y), bottomRadius = Math.max(radii.bottomLeft.y, radii.bottomRight.y);
  const edgeWidth = Math.max(bezelWidth, 2);
  const leftEdge = Math.ceil((overscan + Math.max(edgeWidth, leftRadius)) * density), rightEdge = Math.floor((overscan + width - Math.max(edgeWidth, rightRadius)) * density);
  for (let py = 0; py < canvas.height; py++) for (let px = 0; px < canvas.width; px++) {
    // Every non-lens interior pixel is exactly the neutral RG field and an
    // empty specular pixel. Skip its SDF and object allocation; the encoded
    // image remains byte-for-byte identical to the full-pixel algorithm.
    const localY = (py + .5) / density - overscan;
    if (!center && localY >= Math.max(edgeWidth, topRadius) && localY <= height - Math.max(edgeWidth, bottomRadius) && px >= leftEdge && px < rightEdge) { px = rightEdge - 1; continue; }
    const offset = (py * canvas.width + px) * 4, x = (px + .5) / density - cx, y = (py + .5) / density - cy;
    const { depth, nx, ny } = glassBoundary(x, y, options);
    let displacementX = 0, displacementY = 0;
    if (depth > 0 && depth < bezelWidth) {
      const magnitude = radial[Math.min(127, Math.floor(depth / bezelWidth * 128))];
      displacementX = -nx * magnitude;
      displacementY = -ny * magnitude;
    }
    image.data[offset] = channel(displacementX, 100); image.data[offset + 1] = channel(displacementY, 100); image.data[offset + 2] = 0; image.data[offset + 3] = 255;
    if (center) { center.data[offset] = channel(-x, lensRadius); center.data[offset + 1] = channel(-y, lensRadius); center.data[offset + 2] = 0; center.data[offset + 3] = 255; }
    if (depth >= 0 && depth < 2) {
      // Author's fixed light angle pi/3; two opposed lobes and a 2px rim.
      const facing = Math.abs(nx * .5 - ny * Math.sqrt(3) / 2);
      const light = facing * Math.sqrt(Math.max(0, 1 - (1 - depth) ** 2));
      reflection.data[offset] = reflection.data[offset + 1] = reflection.data[offset + 2] = Math.round(255 * light);
      reflection.data[offset + 3] = Math.round(255 * light * light);
    }
  }
  cacheCounters.generatedPixels += canvas.width * canvas.height;
  cacheCounters.pngEncodes += center ? 3 : 2;
  context.putImageData(image, 0, 0); const map = canvas.toDataURL('image/png');
  context.putImageData(reflection, 0, 0); const highlight = canvas.toDataURL('image/png');
  let centerMap: string | undefined; if (center) { context.putImageData(center, 0, 0); centerMap = canvas.toDataURL('image/png'); }
  const innerWidth = Math.max(0, width - bezelWidth * 2), innerHeight = Math.max(0, height - bezelWidth * 2);
  const innerRadii = insetRadii(radii, bezelWidth, innerWidth, innerHeight);
  const outerPath = glassRoundedPath(overscan, overscan, width, height, radii);
  const innerPath = innerWidth && innerHeight ? glassRoundedPath(overscan + bezelWidth, overscan + bezelWidth, innerWidth, innerHeight, innerRadii) : '';
  const ringSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}"><path fill="white" fill-rule="evenodd" d="${outerPath}${innerPath}"/></svg>`;
  const { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl } = innerRadii;
  const optics = { width, height, overscan, edgeScale, centerScale, maximumDisplacement, map, centerMap, highlight, ring: `url("data:image/svg+xml,${encodeURIComponent(ringSvg)}")`, centerClip: `inset(${overscan + bezelWidth}px round ${tl.x}px ${tr.x}px ${br.x}px ${bl.x}px / ${tl.y}px ${tr.y}px ${br.y}px ${bl.y}px)` };
  const decodedBytes = canvas.width * canvas.height * 4 * (center ? 3 : 2);
  const encodedBytes = (map.length + highlight.length + (centerMap?.length ?? 0) + optics.ring.length + optics.centerClip.length) * 2;
  // Oversized assets stay with the mounted surface but are not retained by a
  // global cache after it closes. Both budgets account for geometry size.
  if (decodedBytes <= GLASS_OPTICS_CACHE_LIMITS.decodedBytes && encodedBytes <= GLASS_OPTICS_CACHE_LIMITS.encodedBytes) {
    cache.set(key, { optics, decodedBytes, encodedBytes }); cacheCounters.decodedBytes += decodedBytes; cacheCounters.encodedBytes += encodedBytes;
    while (cache.size > GLASS_OPTICS_CACHE_LIMITS.entries || cacheCounters.decodedBytes > GLASS_OPTICS_CACHE_LIMITS.decodedBytes || cacheCounters.encodedBytes > GLASS_OPTICS_CACHE_LIMITS.encodedBytes) {
      const oldest = cache.keys().next().value!, asset = cache.get(oldest)!; cache.delete(oldest);
      cacheCounters.decodedBytes -= asset.decodedBytes; cacheCounters.encodedBytes -= asset.encodedBytes; cacheCounters.evictions++;
    }
  }
  canvas.width = canvas.height = 0;
  return optics;
}
