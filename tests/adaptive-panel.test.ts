import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePanelHeight, measurePanelHeight, panelContentPresentation, panelHeightSettled, panelHeightTarget, panelMaximumHeight, panelNaturalHeight } from '../apps/desktop/src/renderer/lib/adaptive-panel';

test('intrinsic content/chrome measurements produce a compact panel independent of presentation scale', () => {
  const natural = panelNaturalHeight(76, [{ height: 52 }, { height: 34, marginTop: 12, marginBottom: 16 }], 2);
  assert.equal(natural, 192); assert.equal(panelHeightTarget(natural, 800), 192);
  assert.equal(panelNaturalHeight(Number.NaN, [{ height: 52, marginTop: Number.NaN }], 2), 54);
});
test('actual measurement ignores transformed rectangles, clipping and absolute glass; popup maximum comes from owner', () => {
  const element = (height: number) => ({ offsetHeight: height, scrollHeight: height, getBoundingClientRect() { throw new Error('Transformed presentation must not be measured'); } }) as unknown as HTMLElement;
  const glass = element(1000), header = element(52), viewport = element(1), natural = element(76), footer = element(34), panel = element(1);
  Object.defineProperty(panel, 'children', { value: [glass, header, viewport, footer] });
  const style = (current: Element) => ({ position: current === glass ? 'absolute' : 'static', display: 'block', marginTop: current === footer ? '12px' : '0px', marginBottom: current === footer ? '16px' : '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: current === panel ? '1px' : '0px', borderBottomWidth: current === panel ? '1px' : '0px' });
  assert.deepEqual(measurePanelHeight(panel, natural, viewport, 800, style), { natural: 192, target: 192, maximum: 778 });
  Object.defineProperty(natural, 'scrollHeight', { value: 2400 });
  assert.deepEqual(measurePanelHeight(panel, natural, viewport, 800, style), { natural: 2516, target: 778, maximum: 778 });
});
test('large bodies cap at the owner viewport minus both gutters, never a popup bootstrap height', () => {
  assert.equal(panelMaximumHeight(800), 778); assert.equal(panelHeightTarget(6000, 800), 778);
  assert.equal(panelHeightTarget(192, 800), 192); assert.equal(panelHeightTarget(192, 1), 1);
  assert.equal(panelMaximumHeight(Number.NaN), 1);
});
for (const mode of ['standard', 'elegant'] as const) test(`${mode} size retarget is continuous, preserves velocity and settles after a reversal`, () => {
  let axis = { value: 180, velocity: 0 }, peak = 0;
  for (let i = 0; i < 12; i++) axis = advancePanelHeight(axis, 500, 1 / 60, mode, 778);
  const moving = axis; assert.ok(Math.abs(moving.velocity) > 1);
  assert.deepEqual(advancePanelHeight(moving, 230, 0, mode, 778), moving, 'retarget does not jump position or reset momentum');
  axis = advancePanelHeight(moving, 230, 1 / 60, mode, 778); assert.ok(Math.abs(axis.value - moving.value) < 40);
  for (let i = 0; i < 300; i++) { axis = advancePanelHeight(axis, 230, 1 / 60, mode, 778); assert.ok(Number.isFinite(axis.value) && Number.isFinite(axis.velocity)); peak = Math.max(peak, axis.value); }
  assert.ok(peak > 230); assert.ok(panelHeightSettled(axis, 230));
});
test('analytic panel integration is stable across frame cadence; viewport contraction clips only presentation', () => {
  const start = { value: 140, velocity: 30 };
  const one = advancePanelHeight(start, 330, .032, 'elegant', 778);
  const two = advancePanelHeight(advancePanelHeight(start, 330, .016, 'elegant', 778), 330, .016, 'elegant', 778);
  assert.ok(Math.abs(one.value - two.value) < 1e-8); assert.ok(Math.abs(one.velocity - two.velocity) < 1e-8);
  const confined = advancePanelHeight({ value: 700, velocity: 900 }, 278, .016, 'elegant', 278);
  assert.equal(confined.value, 278); assert.equal(confined.velocity, 0);
});
test('reduced/off immediately fit content and swap opacity never escapes its valid range', () => {
  for (const mode of ['off', 'reduced'] as const) assert.deepEqual(advancePanelHeight({ value: 400, velocity: 280 }, 192, .016, mode, 778), { value: 192, velocity: 0 });
  assert.equal(panelContentPresentation({ value: 1.04, velocity: 1 }).alpha, 1);
  assert.equal(panelContentPresentation({ value: -.02, velocity: 1 }).alpha, 0);
  assert.ok(panelContentPresentation({ value: .28, velocity: 0 }).y > 0);
});
