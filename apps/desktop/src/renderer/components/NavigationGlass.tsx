import { useRef } from 'react';
import { useGlassSurface } from '../lib/useGlassSurface';
import { NAVIGATION_METRICS, type NavigationBackdropSample, type NavigationBounds } from '../lib/navigation-optics';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { SELECTION_GLASS_BLUR_PX } from '../lib/glass-presets';

/** Background optics only; navigation labels and inputs remain sibling layers. */
export function NavigationGlass({ backdropImage, backdropSample, capsuleBounds, onSurface, softness = 'navigation', onReady }: { backdropImage?: string; backdropSample?: NavigationBackdropSample; capsuleBounds?: NavigationBounds; onSurface?(surface: 'light' | 'dark'): void; softness?: 'navigation' | 'selection'; onReady?(ready:boolean):void }) {
  const root = useRef<HTMLSpanElement>(null);
  useGlassSurface(root, { backdropImage, capsuleBounds, onSurface });

  return <LiquidGlassSurface navigation variant="search" bezelWidth={NAVIGATION_METRICS.bezelWidth} glassThickness={NAVIGATION_METRICS.glassThickness} refractiveIndex={NAVIGATION_METRICS.refractiveIndex} blur={softness === 'selection' ? SELECTION_GLASS_BLUR_PX : NAVIGATION_METRICS.blur} blurLimit={softness === 'selection' ? SELECTION_GLASS_BLUR_PX : undefined} onReady={onReady} strength={NAVIGATION_METRICS.refraction} specularOpacity={NAVIGATION_METRICS.specularOpacity} specularSaturation={NAVIGATION_METRICS.specularSaturation} backdropImage={backdropImage} backdropSample={backdropSample} bounds={capsuleBounds} surfaceRef={root} />;
}
