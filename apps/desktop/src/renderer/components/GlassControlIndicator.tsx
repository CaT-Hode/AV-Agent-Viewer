import type { CSSProperties, Ref } from 'react';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { KUBE_GLASS_PRESETS } from '../lib/glass-presets';

/** One optical thumb shared by the binary switch, labeled switch and range.
 * The control owns position/gesture; its sole elastic controller owns optics.
 * Caption and committed fill stay beneath this real backdrop surface. */
export function GlassControlIndicator({ materialRef, className, style, variant, opticalScale = 1, quietLighting = false }: {
  materialRef: Ref<HTMLSpanElement>; className: string; style?: CSSProperties;
  variant: 'switch' | 'slider'; opticalScale?: number; quietLighting?: boolean;
}) {
  const preset = KUBE_GLASS_PRESETS[variant];
  return <span ref={materialRef} className={className + ' material-host glass-elastic'} style={style} aria-hidden="true" data-glass-control-owner="indicator">
    <LiquidGlassSurface variant={variant} effect="refractive" profile={preset.profile}
      bezelWidth={preset.bezelWidth * opticalScale} glassThickness={preset.glassThickness * opticalScale}
      refractiveIndex={preset.refractiveIndex} blur={0} strength={preset.refraction}
      specularOpacity={quietLighting ? 0 : preset.specularOpacity} specularSaturation={quietLighting ? 1 : preset.specularSaturation} />
  </span>;
}
