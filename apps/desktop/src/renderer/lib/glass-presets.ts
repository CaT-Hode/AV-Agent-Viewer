/** Parameters read from kube/kube.io @ 1df5ee3e528410c9eeef55bd08a90af9796c62dc.
 * These are data and independently implemented equations, not vendored code. */
// Application policy requested after the source study: clear refractive glass
// has no Gaussian blur. The source presets remain intact for future tuning.
export const REFRACTIVE_BLUR_LIMIT_PX = 0;
/** Selection/caret capsules keep the same optics with a slightly softer source. */
export const SELECTION_GLASS_BLUR_PX = REFRACTIVE_BLUR_LIMIT_PX + .65;
export const KUBE_GLASS_PRESETS = {
  search: { width: 420, height: 56, radius: 28, bezelWidth: 27, glassThickness: 70, refractiveIndex: 1.5, profile: 'convex' as const, blur: 1, refraction: .7, specularOpacity: .2, specularSaturation: 4, restScale: .8, activeScale: 1, restAlpha: .05, activeAlpha: .2 },
  switch: { width: 146, height: 92, radius: 46, bezelWidth: 19, glassThickness: 47, refractiveIndex: 1.5, profile: 'lip' as const, blur: .2, refraction: 1, specularOpacity: .5, specularSaturation: 6, restScale: .65, activeScale: .9, restAlpha: 1, activeAlpha: .1 },
  slider: { width: 90, height: 60, radius: 30, bezelWidth: 16, glassThickness: 80, refractiveIndex: 1.45, profile: 'convex' as const, blur: 0, refraction: 1, specularOpacity: .4, specularSaturation: 7, restScale: .6, activeScale: 1, restAlpha: 1, activeAlpha: .1 },
  lens: { width: 210, height: 150, radius: 75, bezelWidth: 25, glassThickness: 110, refractiveIndex: 1.5, profile: 'lens' as const, blur: 0, refraction: 1, specularOpacity: .5, specularSaturation: 9, restScale: .8, activeScale: 1, restAlpha: 0, activeAlpha: 0 },
  panel: { width: 640, height: 63, radius: 31, bezelWidth: 29, glassThickness: 90, refractiveIndex: 1.3, profile: 'convex' as const, blur: 1, refraction: 1, specularOpacity: .4, specularSaturation: 6, restScale: 1, activeScale: 1, restAlpha: .6, activeAlpha: .6 },
} as const;
export const KUBE_GLASS_SPRINGS = {
  searchScale: { stiffness: 800, damping: 40 },
  fill: { stiffness: 2000, damping: 80 },
  thumbScale: { stiffness: 2000, damping: 80 },
  switchPosition: { stiffness: 1000, damping: 80 },
  // useSpring without options in the author's switch/slider uses Motion's default.
  thumbRefraction: { stiffness: 100, damping: 10 },
  lensOptics: { stiffness: 250, damping: 14 },
  lensScale: { stiffness: 340, damping: 20 },
  lensShape: { stiffness: 340, damping: 30 },
  lensShadow: { stiffness: 220, damping: 24 },
} as const;
/** Audited MagnifyingGlass / MixedUI interaction data. Large reading panels
 * keep their layout at rest and use the source panel height to attenuate the
 * lens's deformation; a sidebar is not a draggable 210px demonstration lens. */
export const KUBE_GLASS_INTERACTION = {
  buttonPressScale: .9,
  panelPressScale: .99,
  panelReferenceHeight: 63,
  velocityDivisor: 5000,
  minimumVelocityScale: .7,
  insetBlur: 24,
  shadowRest: { x: 0, y: 4, blur: 9, alpha: .16, inset: .2 },
  shadowActive: { x: 4, y: 16, blur: 24, alpha: .22, inset: .27 },
} as const;
export const GLASS_CONTROL_METRICS = {
  switch: { trackWidth: 160, trackHeight: 67, thumbWidth: 146, thumbHeight: 92, thumbRadius: 46, travel: 160 - 67 - (146 - 92) * .65, thumbLeft: -(1 - .65) * 146 / 2 + (67 - 92 * .65) / 2 },
  slider: { trackWidth: 330, trackHeight: 14, thumbWidth: 90, thumbHeight: 60, thumbRadius: 30, restingThumbWidth: 90 * .6 },
} as const;
