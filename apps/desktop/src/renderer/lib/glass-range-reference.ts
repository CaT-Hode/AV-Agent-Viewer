import { KUBE_GLASS_PRESETS } from './glass-presets';

/** The author's Slider already animates refraction .4 -> .9. Its 90x60
 * optical field is not reduced a second time before the .6 -> 1 shape spring.
 * Keeping that original field restores its convex edge displacement while
 * the resting 54x36 knob still fits the compact settings input. */
export const GLASS_RANGE_REFERENCE = {
  width: KUBE_GLASS_PRESETS.slider.width,
  height: KUBE_GLASS_PRESETS.slider.height,
  radius: KUBE_GLASS_PRESETS.slider.radius,
  restingWidth: KUBE_GLASS_PRESETS.slider.width * KUBE_GLASS_PRESETS.slider.restScale,
  restingHeight: KUBE_GLASS_PRESETS.slider.height * KUBE_GLASS_PRESETS.slider.restScale,
  inset: KUBE_GLASS_PRESETS.slider.width * (1 - KUBE_GLASS_PRESETS.slider.restScale) / 2,
  opticalScale: 1,
} as const;
