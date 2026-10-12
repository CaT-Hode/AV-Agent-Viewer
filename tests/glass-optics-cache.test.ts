import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearGlassOpticsCache, createGlassOptics, GLASS_OPTICS_CACHE_LIMITS, glassBoundary, glassGeometryStyleSignature, glassOpticsCacheStats, glassOpticsKey, type GlassOpticsOptions } from '../apps/desktop/src/renderer/lib/liquid-glass-optics';
import { glassRadialDisplacements } from '../apps/desktop/src/renderer/lib/navigation-optics';

// A CPU-only canvas double records bytes/counts without opening a browser.
// It deliberately does not claim to measure Chromium PNG/GPU timing.
function canvasHarness(recordPixels = false, payload = '') {
  const images: Uint8ClampedArray[] = []; let encodes = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(tag: string) {
    assert.equal(tag, 'canvas'); let latest: ImageData;
    return { width: 0, height: 0, getContext: () => ({ createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }), putImageData: (image: ImageData) => { latest = image; } }), toDataURL: () => { encodes++; if (recordPixels) images.push(latest.data.slice()); return `data:image/png;base64,qa-${encodes}${payload}`; } };
  } } });
  return { images, get encodes() { return encodes; }, close() { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); } };
}
const options = (width = 180, height = 92): GlassOpticsOptions => ({ width, height, radii: { topLeft: { x: 21, y: 27 }, topRight: { x: 30, y: 16 }, bottomRight: { x: 16, y: 24 }, bottomLeft: { x: 32, y: 20 } }, density: 2, bezelWidth: 19, strength: 1, profile: 'convex', concave: false, overscan: 16 });

/** The pre-optimization complete field loop, retained only as a byte oracle. */
function referenceFields(input: GlassOpticsOptions) {
  const width = Math.ceil((input.width + input.overscan * 2) * input.density), height = Math.ceil((input.height + input.overscan * 2) * input.density);
  const image = new Uint8ClampedArray(width * height * 4), highlight = image.slice(), center = input.profile === 'lens' ? image.slice() : undefined;
  const rays = glassRadialDisplacements(input.bezelWidth, input.glassThickness ?? 70, input.refractiveIndex ?? 1.5, input.concave ? 'concave' : input.profile);
  const channel = (value: number, scale: number) => Math.round(Math.max(0, Math.min(255, 128 + value / scale * 127)));
  const cx = input.overscan + input.width / 2, cy = input.overscan + input.height / 2, lensRadius = Math.max(input.width, input.height) / 2;
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const offset = (py * width + px) * 4, x = (px + .5) / input.density - cx, y = (py + .5) / input.density - cy;
    const { depth, nx, ny } = glassBoundary(x, y, input); let dx = 0, dy = 0;
    if (depth > 0 && depth < input.bezelWidth) { const magnitude = rays[Math.min(127, Math.floor(depth / input.bezelWidth * 128))]; dx = -nx * magnitude; dy = -ny * magnitude; }
    image[offset] = channel(dx, 100); image[offset + 1] = channel(dy, 100); image[offset + 3] = 255;
    if (center) { center[offset] = channel(-x, lensRadius); center[offset + 1] = channel(-y, lensRadius); center[offset + 3] = 255; }
    if (depth >= 0 && depth < 2) { const light = Math.abs(nx * .5 - ny * Math.sqrt(3) / 2) * Math.sqrt(Math.max(0, 1 - (1 - depth) ** 2)); highlight[offset] = highlight[offset + 1] = highlight[offset + 2] = Math.round(255 * light); highlight[offset + 3] = Math.round(255 * light * light); }
  }
  return center ? [image, highlight, center] : [image, highlight];
}

test('border shortcut preserves every source-model RG/specular/lens byte', () => {
  const canvas = canvasHarness(true); clearGlassOpticsCache();
  try {
    const cases: GlassOpticsOptions[] = [options(), { ...options(), density: 1.5 }, { ...options(), profile: 'lip' }, { ...options(), concave: true }, { ...options(), profile: 'lens' }, { ...options(), bezelWidth: 1 }, { ...options(), bezelWidth: 0 }, { ...options(72, 70), radii: { topLeft: { x: 54, y: 41 }, topRight: { x: 14, y: 11 }, bottomRight: { x: 17, y: 27 }, bottomLeft: { x: 45, y: 25 } } }];
    for (const input of cases) { const start = canvas.images.length; createGlassOptics(input); assert.deepEqual(canvas.images.slice(start), referenceFields(input), glassOpticsKey(input)); }
    assert.equal(glassOpticsCacheStats().pngEncodes, cases.reduce((sum, input) => sum + (input.profile === 'lens' ? 3 : 2), 0));
  } finally { canvas.close(); clearGlassOpticsCache(); }
});

test('same used geometry across instances/order/defaults never regenerates PNG', () => {
  const canvas = canvasHarness(); clearGlassOpticsCache();
  try {
    const first = createGlassOptics(options()); const reordered = { ...options(), radii: { bottomLeft: { x: 32, y: 20 }, bottomRight: { x: 16, y: 24 }, topRight: { x: 30, y: 16 }, topLeft: { x: 21, y: 27 } }, glassThickness: 70, refractiveIndex: 1.5 };
    for (let i = 0; i < 100; i++) assert.equal(createGlassOptics(reordered), first);
    assert.equal(canvas.encodes, 2); assert.equal(glassOpticsCacheStats().builds, 1); assert.equal(glassOpticsCacheStats().hits, 100);
    assert.equal(glassRadialDisplacements(27, 70, 1.5, 'convex'), glassRadialDisplacements(27, 70, 1.5, 'convex')); assert.ok(Object.isFrozen(glassRadialDisplacements(27, 70, 1.5, 'convex')));
  } finally { canvas.close(); clearGlassOpticsCache(); }
});

test('retained geometry cache obeys decoded/encoded/entry budgets and true LRU', () => {
  const canvas = canvasHarness(); clearGlassOpticsCache();
  try {
    const large = { ...options(2000, 1000), density: 1 };
    for (let i = 0; i < 5; i++) createGlassOptics({ ...large, width: large.width + i });
    const cost = glassOpticsCacheStats(); assert.ok(cost.decodedBytes <= GLASS_OPTICS_CACHE_LIMITS.decodedBytes); assert.ok(cost.evictions >= 1); assert.ok(cost.entries < 5);
    clearGlassOpticsCache(); const firstOptions = options(60, 40), first = createGlassOptics(firstOptions);
    for (let i = 1; i < 64; i++) createGlassOptics(options(60 + i, 40));
    assert.equal(createGlassOptics(firstOptions), first); createGlassOptics(options(150, 40)); assert.equal(createGlassOptics(firstOptions), first, 'recent hit survives oldest eviction');
    const before = glassOpticsCacheStats().builds; createGlassOptics(options(61, 40)); assert.equal(glassOpticsCacheStats().builds, before + 1, 'least recently used item was evicted'); assert.equal(glassOpticsCacheStats().entries, 64);
  } finally { canvas.close(); clearGlassOpticsCache(); }
  const oversized = canvasHarness(false, 'x'.repeat(3 * 1024 * 1024));
  try { createGlassOptics(options()); assert.equal(glassOpticsCacheStats().entries, 0, 'encoded assets exceeding budget remain only in the mounted instance'); assert.equal(glassOpticsCacheStats().encodedBytes, 0); } finally { oversized.close(); clearGlassOpticsCache(); }
});

test('paint spring updates do not invalidate geometry; actual widths/radii still do', () => {
  const values = new Map([['width', '200px'], ['border-radius', '30px'], ['--custom-size', '100px']]);
  const style = { [Symbol.iterator]: () => values.keys(), getPropertyValue: (name: string) => values.get(name)!, getPropertyPriority: () => '' } as unknown as CSSStyleDeclaration;
  const original = glassGeometryStyleSignature(style);
  for (const name of ['--glass-elastic-scale-x', '--glass-material-fill', 'transform', 'will-change', 'box-shadow', 'background-color']) values.set(name, 'animated');
  assert.equal(glassGeometryStyleSignature(style), original);
  values.set('width', '201px'); assert.notEqual(glassGeometryStyleSignature(style), original);
  values.set('width', '200px'); values.set('--custom-size', '101px'); assert.notEqual(glassGeometryStyleSignature(style), original);
});
