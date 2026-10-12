import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_OPERATION_METRICS, convexBevelDisplacement, glassCaptureOverscan, glassRadialDisplacements, glassSurfaceHeight, NAVIGATION_METRICS, traceGlassRay } from '../apps/desktop/src/renderer/lib/navigation-optics';
import { KUBE_GLASS_PRESETS, GLASS_CONTROL_METRICS } from '../apps/desktop/src/renderer/lib/glass-presets';

test('slightly enlarged navigation keeps Kube optics and a sufficient capture gutter', () => {
  const p = KUBE_GLASS_PRESETS.search;
  assert.equal(p.height, 56, 'historical author preset remains unchanged');
  assert.equal(NAVIGATION_METRICS.height, 60); assert.equal(NAVIGATION_METRICS.radius, 30);
  assert.equal(NAVIGATION_METRICS.bezelWidth, 29); assert.equal(NAVIGATION_METRICS.glassThickness, 70);
  assert.equal(NAVIGATION_METRICS.refraction, .82); assert.equal(NAVIGATION_METRICS.specularOpacity, .24);
  assert.equal(NAVIGATION_METRICS.specularSaturation, 4);
  assert.equal(NAVIGATION_METRICS.captureOverscan, glassCaptureOverscan(29, 70, 1.5, 'convex', .82, 1));
  assert.equal(NAVIGATION_METRICS.captureOverscan, 30); assert.equal(NAVIGATION_METRICS.shadowGutter, 16);
  assert.equal(NAVIGATION_METRICS.buttonSize, 34);
  assert.equal(AGENT_OPERATION_METRICS.height, 42); assert.equal(AGENT_OPERATION_METRICS.radius, 21);
  assert.equal(AGENT_OPERATION_METRICS.captureOverscan, glassCaptureOverscan(20, 70, 1.5, 'convex', .82, 1));
});

test('source squircle and lip surfaces have continuous height and distinct normals', () => {
  assert.equal(glassSurfaceHeight(0, 'convex'), 0); assert.equal(glassSurfaceHeight(1, 'convex'), 1);
  assert.ok(Math.abs(glassSurfaceHeight(.5, 'convex') - Math.pow(15 / 16, .25)) < 1e-12);
  const convex = glassRadialDisplacements(27, 70, 1.5, 'convex');
  assert.equal(convex.length, 128);
  assert.ok(Math.abs(Math.max(...convex) - 78.5329397777) < 1e-8, 'independently calculated ray reference');
  assert.ok(convex.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(convex[0] > convex[64] && convex[64] > convex[120]);
  const lip = glassRadialDisplacements(19, 47, 1.5, 'lip');
  assert.ok(lip.some(value => value > 0) && lip.some(value => value < 0));
});

test('Snell ray vanishes in identical media, scales with depth and joins the flat interior', () => {
  for (const profile of ['convex', 'circle', 'lip', 'concave'] as const) {
    assert.equal(traceGlassRay(.25, 27, 70, 1, profile), 0);
    for (let u = 0; u < 1; u += .01) assert.ok(Number.isFinite(traceGlassRay(u, 27, 70, 1.5, profile)));
  }
  assert.ok(traceGlassRay(.25, 27, 140, 1.5, 'convex') > traceGlassRay(.25, 27, 70, 1.5, 'convex'));
  assert.equal(convexBevelDisplacement(27, 27), 0);
  assert.equal(convexBevelDisplacement(-1, 27), 0);
  assert.equal(convexBevelDisplacement(1, 0), 0);
  assert.ok(convexBevelDisplacement(26.99, 27) < .0001);
});

test('sampling margin covers actual RG8 and SVG shift including slider', () => {
  assert.equal(glassCaptureOverscan(19, 47, 1.5, 'lip', .9, .2), 16);
  assert.equal(glassCaptureOverscan(16, 80, 1.45, 'convex', .9, 0), 33);
  assert.ok(GLASS_CONTROL_METRICS.switch.travel > 57 && GLASS_CONTROL_METRICS.switch.travel < 58);
  assert.equal(GLASS_CONTROL_METRICS.slider.restingThumbWidth, 54);
});
