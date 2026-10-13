import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLASS_RANGE_REFERENCE } from '../apps/desktop/src/renderer/lib/glass-range-reference';
import { KUBE_GLASS_PRESETS } from '../apps/desktop/src/renderer/lib/glass-presets';
import { clearGlassOpticsCache, createGlassOptics } from '../apps/desktop/src/renderer/lib/liquid-glass-optics';
import { glassCaptureOverscan } from '../apps/desktop/src/renderer/lib/navigation-optics';

test('reference range rests inside the compact hit area and grows about the same native-input center', () => {
  const g = GLASS_RANGE_REFERENCE;
  assert.equal(g.width, 90); assert.equal(g.height, 60); assert.equal(g.restingWidth, 54); assert.equal(g.restingHeight, 36); assert.equal(g.opticalScale, 1);
  for (const width of [130, 186, 330]) for (const progress of [0, .2, .5, 1]) {
    const nativeCenter: number = g.restingWidth / 2 + (width - g.restingWidth) * progress;
    const visualCenter: number = (width - g.restingWidth) * progress - g.inset + g.width / 2;
    assert.equal(nativeCenter, visualCenter, 'source thumb scale does not multiply its positioned center');
    assert.ok(nativeCenter - g.restingWidth / 2 >= 0 && nativeCenter + g.restingWidth / 2 <= width, 'resting pill fits both ends of the input');
    assert.equal((40 - g.height) / 2 + g.height / 2, 20, 'active and resting thumb remain vertically centered');
  }
});

test('production reference field has stronger encoded edge displacement than the former compact field without increasing refraction', () => {
  // Records production field bytes on the CPU. Actual Chromium pixels are
  // separately compared in ui-glass-switch; this is not a PNG/GPU claim.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document'), images: Uint8ClampedArray[] = [];
  let encoded = 0;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() {
    let latest: ImageData;
    return { width: 0, height: 0, getContext: () => ({ createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }), putImageData: (value: ImageData) => { latest = value; } }), toDataURL: () => { images.push(latest.data.slice()); return `data:image/png;base64,cpu-field-${++encoded}`; } };
  } } });
  clearGlassOpticsCache();
  try {
    const preset = KUBE_GLASS_PRESETS.slider;
    const make = (scale: number) => {
      const radius = { x: preset.radius * scale, y: preset.radius * scale };
      const result = createGlassOptics({ width: preset.width * scale, height: preset.height * scale, radii: { topLeft: radius, topRight: radius, bottomRight: radius, bottomLeft: radius }, density: 2, bezelWidth: preset.bezelWidth * scale, glassThickness: preset.glassThickness * scale, refractiveIndex: preset.refractiveIndex, strength: preset.refraction, profile: preset.profile, concave: false, overscan: glassCaptureOverscan(preset.bezelWidth * scale, preset.glassThickness * scale, preset.refractiveIndex, preset.profile, preset.refraction, 0) });
      const map = images.at(-2)!; let encodedPeak = 0;
      for (let i = 0; i < map.length; i += 4) encodedPeak = Math.max(encodedPeak, Math.abs(map[i] / 255 - .5), Math.abs(map[i + 1] / 255 - .5));
      return { maximum: result.maximumDisplacement, shift: encodedPeak * result.maximumDisplacement * .9 };
    };
    const old = make(.6), reference = make(GLASS_RANGE_REFERENCE.opticalScale);
    assert.equal(preset.refraction, 1); assert.equal(preset.blur, 0); assert.equal(preset.refractiveIndex, 1.45);
    assert.ok(Math.abs(reference.maximum / old.maximum - 1 / .6) < .00001, 'the source trace only recovers its original geometry');
    assert.ok(reference.shift > old.shift * 2.5, 'fixed-100 production encoding no longer attenuates both map and SVG scale a second time');
  } finally { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); clearGlassOpticsCache(); }
});
