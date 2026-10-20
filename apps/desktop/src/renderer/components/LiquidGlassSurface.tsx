import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { requestGlassOptics, glassGeometryStyleSignature, glassOpticsKey, readGlassRadii, type GlassOpticsLease, type GlassProfile } from '../lib/liquid-glass-optics';
import { KUBE_GLASS_PRESETS, REFRACTIVE_BLUR_LIMIT_PX } from '../lib/glass-presets';
import { glassCaptureOverscan, NAVIGATION_METRICS } from '../lib/navigation-optics';
import { scheduleLayoutRead } from '../lib/layout-frame';

export type LiquidGlassVariant = 'panel' | 'search' | 'switch' | 'slider' | 'capsule' | 'button' | 'tooltip' | 'lens';
export type LiquidGlassEffect = 'frosted' | 'refractive';
type SurfaceBounds = { x: number; y: number; width: number; height: number };
type BackdropSample = { origin: { x: number; y: number }; cssSize: { width: number; height: number } };
type MaterialStyle = CSSProperties & Record<`--${string}`, string | number | undefined>;

export type LiquidGlassSurfaceProps = {
  variant?: LiquidGlassVariant;
  /** Ordinary UI is single-layer frost. Full optics are opt-in; navigation is
   * the sole default exception. Agent operation capsules opt in explicitly. */
  effect?: LiquidGlassEffect;
  profile?: GlassProfile;
  bezelWidth?: number;
  blur?: number;
  /** Explicit per-surface exception; ordinary optics retain the global crisp policy. */
  blurLimit?: number;
  /** True once the requested optics are decoded, or an explicit fallback is active. */
  onReady?(ready: boolean): void;
  strength?: number;
  glassThickness?: number;
  refractiveIndex?: number;
  specularOpacity?: number;
  specularSaturation?: number;
  concave?: boolean;
  lensZoom?: number;
  /** Independent native views have no sibling backdrop. Keep a readable tint. */
  fallback?: boolean;
  backdropImage?: string;
  backdropSample?: BackdropSample;
  bounds?: SurfaceBounds;
  surfaceRef?: Ref<HTMLSpanElement>;
  className?: string;
  /** Tooltip/explicit gesture hosts can keep passive material presentation. */
  interaction?: 'auto' | 'none';
  /** Only NavigationGlass uses the historical names and navigation tokens. */
  navigation?: boolean;
};

const finite = (value: number | undefined, fallback: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value! : fallback));

/** Optical background only. Original controls, labels and inputs stay siblings;
 * neither their pixels nor an ancestor are filtered or faded by this surface. */
export function LiquidGlassSurface({ variant = 'panel', effect: requestedEffect, profile: requestedProfile, bezelWidth, blur, blurLimit, onReady, strength, glassThickness, refractiveIndex, specularOpacity, specularSaturation, concave = false, lensZoom, fallback = false, backdropImage, backdropSample, bounds, surfaceRef, className, interaction = 'auto', navigation = false }: LiquidGlassSurfaceProps) {
  const effect = requestedEffect ?? (navigation ? 'refractive' : 'frosted'), refractive = effect === 'refractive';
  const preset = KUBE_GLASS_PRESETS[variant === 'capsule' || variant === 'button' || variant === 'tooltip' ? 'search' : variant];
  const opticalBlur = refractive ? Math.min(finite(blur, preset.blur, 0, 40), finite(blurLimit, REFRACTIVE_BLUR_LIMIT_PX, 0, 12)) : finite(blur, preset.blur, 0, 40);
  const profile = requestedProfile ?? preset.profile;
  const root = useRef<HTMLSpanElement>(null);
  const [asset, setAsset] = useState<GlassOpticsLease>();
  const optics = asset?.optics;
  const [automaticFallback,setAutomaticFallback]=useState(false);
  useLayoutEffect(() => () => asset?.release(), [asset]);
  const id = `liquid-glass-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const assignRef = useCallback((node: HTMLSpanElement | null) => {
    root.current = node;
    if (typeof surfaceRef === 'function') surfaceRef(node);
    else if (surfaceRef) surfaceRef.current = node;
  }, [surfaceRef]);

  useLayoutEffect(() => {
    const surface = root.current, host = surface?.parentElement;
    if (!surface || !host) return;
    // Frosted surfaces never subscribe to geometry, create canvases or retain
    // refraction fields. CSS alone handles appearance/contrast preferences.
    if (!refractive || fallback) {
      setAsset(previous => previous ? undefined : previous);
      if (!navigation) for (const property of ['left', 'top', 'width', 'height']) surface.style.removeProperty(property);
      return;
    }
    let cancelMeasure: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined, disposed = false, measuredKey = '';
    const media = ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'].map(query => matchMedia(query));
    const measure = () => {
      // Navigation reports its real hit geometry independently. Reuse and
      // scale the decoded field during its spring instead of forcing style
      // and layout reads for every intermediate optical texture size.
      if (navigation && host.dataset.navigationResizing === 'true') {
        cancelMeasure?.(); cancelMeasure = undefined;
        clearTimeout(timer); request?.abort(); request = undefined; measuredKey = '';
        return;
      }
      cancelMeasure?.();
      cancelMeasure = scheduleLayoutRead(() => {
        cancelMeasure = undefined;
        if (navigation && host.dataset.navigationResizing === 'true') return;
        const appearance = document.documentElement.dataset;
        // Desktop preferences arrive asynchronously. Do not generate default
        // optical assets for one startup frame before learning glass is off.
        // The observed data-glass update schedules the real requested material.
        if (window.agentViewer && !appearance.glass) return;
        if (appearance.glass === 'off' || appearance.contrast === 'high' || appearance.reduceTransparency === 'true' || media.some(query => query.matches)) return () => {
          clearTimeout(timer); request?.abort(); measuredKey = '';
          setAutomaticFallback(true); setAsset(previous => previous ? undefined : previous);
        };
        const rect = host.getBoundingClientRect();
        // Settings pages can contain many controls below the fold. Their
        // textures must not occupy the worker queue before visible controls.
        if (rect.bottom < -80 || rect.top > innerHeight + 80 || rect.right < -80 || rect.left > innerWidth + 80) return;
        const hostStyle = getComputedStyle(host), style = getComputedStyle(surface);
        const usedSize = (axis: 'width' | 'height') => {
          const used = Number.parseFloat(hostStyle[axis]);
          if (!Number.isFinite(used)) return rect[axis];
          // Presence/press transforms scale the host and its background
          // together. Measuring the transformed rectangle would scale the
          // optical geometry a second time, so use the local CSS border box.
          if (hostStyle.boxSizing === 'border-box') return used;
          const sides = axis === 'width' ? ['Left', 'Right'] : ['Top', 'Bottom'];
          return used + sides.reduce((sum, side) => sum + Number.parseFloat(hostStyle.getPropertyValue(`padding-${side.toLowerCase()}`) || '0') + Number.parseFloat(hostStyle.getPropertyValue(`border-${side.toLowerCase()}-width`) || '0'), 0);
        };
        const width = Math.round(usedSize('width') * 4) / 4, height = Math.round(usedSize('height') * 4) / 4;
        if (width <= 0 || height <= 0) return;
        const number = (token: string, defaultValue: number) => {
          const parsed = Number.parseFloat(style.getPropertyValue(token));
          return Number.isFinite(parsed) ? parsed : defaultValue;
        };
        const band = finite(bezelWidth, number('--liquid-glass-bezel-width', preset.bezelWidth), 0, Math.min(width, height) / 2);
        // Large panels have little high-frequency edge detail and need not
        // allocate multiple full-resolution RG fields at 200% Windows scale.
        const density = width * height > 750_000 ? 1 : 2;
        const thickness = glassThickness ?? preset.glassThickness, index = refractiveIndex ?? preset.refractiveIndex;
        const overscan = navigation ? NAVIGATION_METRICS.captureOverscan : glassCaptureOverscan(band, thickness, index, concave ? 'concave' : profile, strength ?? preset.refraction, opticalBlur);
        const options = { width, height, radii: readGlassRadii(hostStyle, width, height), density, bezelWidth: band, glassThickness: thickness, refractiveIndex: index, strength: 1, profile, concave, overscan };
        const key = glassOpticsKey(options);
        const left = `${-Number.parseFloat(hostStyle.borderLeftWidth || '0')}px`, top = `${-Number.parseFloat(hostStyle.borderTopWidth || '0')}px`;
        return () => {
          // Keep the existing decoded field while geometry is moving. Only
          // the settled size requests a new field; stale jobs stop in worker.
          if (measuredKey !== key) {
            measuredKey = key; clearTimeout(timer); request?.abort();
            const generate = () => {
              if (disposed) return;
              request = new AbortController(); const signal = request.signal;
              void requestGlassOptics(options, signal).then(async next => {
                if (!next) { if (!signal.aborted && !disposed) setAutomaticFallback(true); return; }
                if (signal.aborted || disposed) { next.release(); return; }
                try {
                  await Promise.all([next.optics.map, next.optics.highlight, next.optics.centerMap].filter((url): url is string => !!url).map(async url => { const image = new Image(); image.src = url; await image.decode(); }));
                } catch { next.release(); if (!signal.aborted && !disposed) setAutomaticFallback(true); return; }
                if (signal.aborted || disposed) { next.release(); return; }
                setAutomaticFallback(false); setAsset(next);
              });
            };
            // First presentation and cache hits have no artificial wait. Only
            // replacement geometry is coalesced while a decoded field is visible.
            if (root.current?.querySelector('svg')) timer = setTimeout(generate, 80);
            else generate();
          }
          // Absolute positioning covers the border box. All reads for sibling
          // surfaces have finished before these shared-frame writes occur.
          if (!navigation) {
            const values = { left, top, width: `${width}px`, height: `${height}px` };
            for (const [property, value] of Object.entries(values)) if (surface.style.getPropertyValue(property) !== value) surface.style.setProperty(property, value);
          }
        };
      });
    };
    const size = new ResizeObserver(measure); size.observe(host);
    const visible = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) measure(); }, { rootMargin: '80px' }); visible.observe(host);
    let inlineGeometry = glassGeometryStyleSignature(host.style);
    const appearance = new MutationObserver(records => {
      if (navigation && host.dataset.navigationResizing === 'true') { measure(); return; }
      let changed = false;
      for (const record of records) {
        if (record.target !== host || record.attributeName !== 'style') { changed = true; continue; }
        const next = glassGeometryStyleSignature(host.style);
        if (inlineGeometry !== next) { inlineGeometry = next; changed = true; }
      }
      if (changed) measure();
    });
    appearance.observe(host, { attributes: true, attributeFilter: ['class', 'style', 'data-state', 'aria-checked', 'data-material-fallback', 'data-navigation-resizing'] });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-glass', 'data-contrast', 'data-reduce-transparency'] });
    const transition = (event: TransitionEvent) => { if (event.target === host && !['opacity', 'scale', 'translate', 'transform', 'background-color', 'box-shadow'].includes(event.propertyName)) measure(); };
    window.addEventListener('resize', measure); host.addEventListener('transitionend', transition); media.forEach(query => query.addEventListener('change', measure)); measure();
    return () => { disposed = true; cancelMeasure?.(); clearTimeout(timer); request?.abort(); size.disconnect(); visible.disconnect(); appearance.disconnect(); window.removeEventListener('resize', measure); host.removeEventListener('transitionend', transition); media.forEach(query => query.removeEventListener('change', measure)); };
  }, [refractive, bezelWidth, opticalBlur, strength, glassThickness, refractiveIndex, profile, concave, lensZoom, fallback, navigation, variant]);

  const activeOptics = refractive && !fallback && !automaticFallback ? optics : undefined;
  useLayoutEffect(() => {
    const surface = root.current, host = surface?.parentElement;
    if (navigation && host) {
      if (activeOptics) {
        host.dataset.navigationOpticsWidth = String(activeOptics.width);
        host.dataset.navigationOpticsHeight = String(activeOptics.height);
        host.dataset.navigationOpticsOverscan = String(activeOptics.overscan);
      } else {
        delete host.dataset.navigationOpticsWidth;
        delete host.dataset.navigationOpticsHeight;
        delete host.dataset.navigationOpticsOverscan;
      }
    }
    surface?.dispatchEvent(new Event('agentviewer:glass-optics', { bubbles: true }));
  },[activeOptics,navigation]);
  useLayoutEffect(()=>{
    onReady?.(!refractive || !!activeOptics || fallback || automaticFallback);
  },[onReady,refractive,activeOptics,fallback,automaticFallback]);
  const sampled = !!backdropImage, overscan = !refractive ? 0 : activeOptics?.overscan ?? (navigation ? NAVIGATION_METRICS.captureOverscan : glassCaptureOverscan(bezelWidth ?? preset.bezelWidth, glassThickness ?? preset.glassThickness, refractiveIndex ?? preset.refractiveIndex, concave ? 'concave' : profile, strength ?? preset.refraction, opticalBlur));
  const totalWidth = activeOptics ? activeOptics.width + overscan * 2 : undefined, totalHeight = activeOptics ? activeOptics.height + overscan * 2 : undefined;
  const sourceStyle: CSSProperties = {
    width: totalWidth, height: totalHeight,
    transform: navigation && activeOptics ? 'scale(var(--navigation-optics-scale-x, 1), var(--navigation-optics-scale-y, 1))' : undefined,
    transformOrigin: navigation ? '0 0' : undefined,
    backgroundImage: sampled ? `url("${backdropImage}")` : undefined,
    backgroundSize: backdropSample ? navigation ? `calc(${backdropSample.cssSize.width}px / var(--navigation-optics-scale-x, 1)) calc(${backdropSample.cssSize.height}px / var(--navigation-optics-scale-y, 1))` : `${backdropSample.cssSize.width}px ${backdropSample.cssSize.height}px` : totalWidth ? `${totalWidth}px ${totalHeight}px` : undefined,
    // A sample remains in source/window coordinates while its host moves.
    backgroundPosition: backdropSample && navigation ? `calc((${backdropSample.origin.x + overscan}px - var(--navigation-capsule-x, ${bounds?.x ?? 0}px)) / var(--navigation-optics-scale-x, 1)) calc((${backdropSample.origin.y + overscan}px - var(--navigation-capsule-y, ${bounds?.y ?? 0}px)) / var(--navigation-optics-scale-y, 1))` : backdropSample && bounds ? `${backdropSample.origin.x - bounds.x + overscan}px ${backdropSample.origin.y - bounds.y + overscan}px` : '0 0',
  };
  const style: MaterialStyle = {
    '--liquid-glass-refraction-filter': activeOptics ? `url("#${id}-edge")` : 'none',
    '--liquid-glass-center-filter': activeOptics ? `url("#${id}-center")` : 'none',
    '--liquid-glass-overscan': `${overscan}px`,
    '--liquid-glass-bezel-width': `${bezelWidth ?? preset.bezelWidth}px`,
    '--liquid-glass-blur': `${opticalBlur}px`,
    '--liquid-glass-strength': strength ?? preset.refraction,
    '--liquid-glass-specular-opacity': specularOpacity ?? preset.specularOpacity,
    ...(navigation ? { '--navigation-refraction-filter': activeOptics ? `url("#${id}-edge")` : 'none', '--liquid-glass-saturation': 'var(--navigation-saturation)', '--liquid-glass-tint': 'var(--navigation-tint)', '--liquid-glass-solid': 'var(--navigation-solid)' } : {}),
  };
  const names = (name: string) => `liquid-glass-${name}${navigation ? ` navigation-glass-${name}` : ''}`;
  const refraction = strength ?? preset.refraction;
  const defaultMultiplier = variant === 'switch' || variant === 'slider' ? .4 : variant === 'lens' ? .8 : 1;
  const filter = (suffix: string, edge: boolean) => <filter id={`${id}-${suffix}`} x="0" y="0" width={totalWidth} height={totalHeight} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
    {optics?.centerMap && <>
      <feImage href={optics.centerMap} x="0" y="0" width={totalWidth} height={totalHeight} preserveAspectRatio="none" result="magnifying-map" />
      <feDisplacementMap data-glass-magnification="true" in="SourceGraphic" in2="magnifying-map" scale={24} xChannelSelector="R" yChannelSelector="G" result="magnified-source" />
    </>}
    <feGaussianBlur in={optics?.centerMap ? 'magnified-source' : 'SourceGraphic'} stdDeviation={opticalBlur} result="blurred-source" />
    {edge && optics && <>
      <feImage href={optics.map} x="0" y="0" width={totalWidth} height={totalHeight} preserveAspectRatio="none" result="glass-map" />
      <feDisplacementMap data-glass-displacement="true" data-glass-base-scale={optics.maximumDisplacement * refraction} in="blurred-source" in2="glass-map" scale={optics.maximumDisplacement * refraction * defaultMultiplier} xChannelSelector="R" yChannelSelector="G" result="displaced-source" />
      <feColorMatrix in="displaced-source" type="saturate" values={String(specularSaturation ?? preset.specularSaturation)} result="saturated-source" />
      <feImage href={optics.highlight} x="0" y="0" width={totalWidth} height={totalHeight} preserveAspectRatio="none" result="specular-map" />
      <feComposite in="saturated-source" in2="specular-map" operator="in" result="saturated-rim" />
      <feComponentTransfer in="specular-map" result="faded-specular"><feFuncA type="linear" slope={specularOpacity ?? preset.specularOpacity} /></feComponentTransfer>
      <feBlend in="saturated-rim" in2="displaced-source" mode="normal" result="lit-source" />
      <feBlend in="faded-specular" in2="lit-source" mode="normal" />
    </>}
  </filter>;
  const definitions = useMemo(() => activeOptics ? <svg className={names('definitions')} width="0" height="0" aria-hidden="true" focusable="false"><defs>{filter('edge', true)}{filter('center', false)}</defs></svg> : undefined, [activeOptics, id, opticalBlur, refraction, defaultMultiplier, specularSaturation, preset.specularSaturation, specularOpacity, preset.specularOpacity, navigation]);

  return <span ref={assignRef} className={`liquid-glass-surface${navigation ? ' navigation-glass' : ''}${className ? ` ${className}` : ''}`} data-glass-effect={effect} data-glass-variant={variant} data-glass-interaction={variant === 'tooltip' ? 'none' : interaction} data-glass-profile={profile} data-glass-concave={concave || undefined} data-glass-fallback={fallback || automaticFallback || undefined} data-glass-pending={refractive && !activeOptics || undefined} data-source={sampled ? 'sampled' : 'live'} aria-hidden="true" style={style}>
    {definitions}
    <span className={`${names('center')}${navigation && sampled ? ' native-glass-backdrop' : ''}`} aria-hidden="true" style={refractive ? { ...sourceStyle, clipPath: activeOptics?.centerClip } : undefined} />
    {activeOptics && <span className={names('edge')} aria-hidden="true" style={{ ...sourceStyle, maskImage: activeOptics.ring, WebkitMaskImage: activeOptics.ring }} />}
    <span className={names('tint')} aria-hidden="true" />
    {!refractive && variant !== 'tooltip' && <span className={names('highlight')} aria-hidden="true" />}
  </span>;
}
