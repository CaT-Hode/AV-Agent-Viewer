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
  /** Reuse the decoded field while the host's existing size spring is moving. */
  stretch?: boolean;
};

const finite = (value: number | undefined, fallback: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value! : fallback));

/** Optical background only. Original controls, labels and inputs stay siblings;
 * neither their pixels nor an ancestor are filtered or faded by this surface. */
export function LiquidGlassSurface({ variant = 'panel', effect: requestedEffect, profile: requestedProfile, bezelWidth, blur, blurLimit, onReady, strength, glassThickness, refractiveIndex, specularOpacity, specularSaturation, concave = false, lensZoom, fallback = false, backdropImage, backdropSample, bounds, surfaceRef, className, interaction = 'auto', navigation = false, stretch = false }: LiquidGlassSurfaceProps) {
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
    let cancelMeasure: (() => void) | undefined;
    let request: AbortController | undefined, disposed = false, measuredKey = '';
    const resizing = () => navigation && host.dataset.navigationResizing === 'true' || stretch && host.dataset.glassResizing === 'true' && !!host.dataset.glassOpticsWidth;
    const media = ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'].map(query => matchMedia(query));
    const measure = () => {
      // Navigation reports its real hit geometry independently. Reuse and
      // scale the decoded field during its spring instead of forcing style
      // and layout reads for every intermediate optical texture size.
      if (resizing()) {
        cancelMeasure?.(); cancelMeasure = undefined;
        request?.abort(); request = undefined; measuredKey = '';
        return;
      }
      // Keep the queued frame: requeuing on every observer notification can
      // postpone measurement indefinitely during continuous resize.
      if (cancelMeasure) return;
      cancelMeasure = scheduleLayoutRead(() => {
        cancelMeasure = undefined;
        if (resizing()) return;
        const appearance = document.documentElement.dataset;
        // Desktop preferences arrive asynchronously. Do not generate default
        // optical assets for one startup frame before learning glass is off.
        // The observed data-glass update schedules the real requested material.
        if (window.agentViewer && !appearance.glass) return;
        if (appearance.glass === 'off' || appearance.contrast === 'high' || appearance.reduceTransparency === 'true' || media.some(query => query.matches)) return () => {
          request?.abort(); measuredKey = '';
          setAutomaticFallback(true); setAsset(previous => previous ? undefined : previous);
        };
        const rect = host.getBoundingClientRect();
        // Settings pages can contain many controls below the fold. Their
        // textures must not occupy the worker queue before visible controls.
        if (rect.bottom < -80 || rect.top > innerHeight + 80 || rect.right < -80 || rect.left > innerWidth + 80) return () => {
          request?.abort(); request = undefined; measuredKey = '';
        };
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
          if (disposed) return;
          // The shared layout frame coalesces geometry changes. Query the
          // cache in this frame; misses share worker jobs and replace the old
          // decoded field only after completion. New geometry cancels stale work.
          if (measuredKey !== key) {
            measuredKey = key; request?.abort();
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
          }
          // Absolute positioning covers the border box. All reads for sibling
          // surfaces have finished before these shared-frame writes occur.
          const values = navigation || stretch
            ? { left, top, right: `${-Number.parseFloat(hostStyle.borderRightWidth || '0')}px`, bottom: `${-Number.parseFloat(hostStyle.borderBottomWidth || '0')}px` }
            : { left, top, width: `${width}px`, height: `${height}px` };
          for (const [property, value] of Object.entries(values)) if (surface.style.getPropertyValue(property) !== value) surface.style.setProperty(property, value);
        };
      });
    };
    const size = new ResizeObserver(measure); size.observe(host);
    const visible = new IntersectionObserver(measure, { rootMargin: '80px' }); visible.observe(host);
    let inlineGeometry = glassGeometryStyleSignature(host.style);
    const appearance = new MutationObserver(records => {
      if (resizing()) { measure(); return; }
      let changed = false;
      for (const record of records) {
        if (record.target !== host || record.attributeName !== 'style') { changed = true; continue; }
        const next = glassGeometryStyleSignature(host.style);
        if (inlineGeometry !== next) { inlineGeometry = next; changed = true; }
      }
      if (changed) measure();
    });
    appearance.observe(host, { attributes: true, attributeFilter: ['class', 'style', 'data-state', 'aria-checked', 'data-material-fallback', 'data-navigation-resizing', 'data-glass-resizing'] });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-glass', 'data-contrast', 'data-reduce-transparency'] });
    const transition = (event: TransitionEvent) => { if (event.target === host && !['opacity', 'scale', 'translate', 'transform', 'background-color', 'box-shadow'].includes(event.propertyName)) measure(); };
    window.addEventListener('resize', measure); host.addEventListener('transitionend', transition); media.forEach(query => query.addEventListener('change', measure)); measure();
    return () => { disposed = true; cancelMeasure?.(); request?.abort(); size.disconnect(); visible.disconnect(); appearance.disconnect(); window.removeEventListener('resize', measure); host.removeEventListener('transitionend', transition); media.forEach(query => query.removeEventListener('change', measure)); };
  }, [refractive, bezelWidth, opticalBlur, strength, glassThickness, refractiveIndex, profile, concave, lensZoom, fallback, navigation, stretch, variant]);

  const activeOptics = refractive && !fallback && !automaticFallback ? optics : undefined;
  useLayoutEffect(() => {
    const surface = root.current, host = surface?.parentElement;
    if (navigation && host) {
      if (activeOptics) {
        host.dataset.navigationOpticsWidth = String(activeOptics.width);
        host.dataset.navigationOpticsHeight = String(activeOptics.height);
      } else {
        delete host.dataset.navigationOpticsWidth;
        delete host.dataset.navigationOpticsHeight;
      }
    }
    if(stretch&&host){if(activeOptics){host.dataset.glassOpticsWidth=String(activeOptics.width);host.dataset.glassOpticsHeight=String(activeOptics.height);}else{delete host.dataset.glassOpticsWidth;delete host.dataset.glassOpticsHeight;}}
    surface?.dispatchEvent(new Event('agentviewer:glass-optics', { bubbles: true }));
  },[activeOptics,navigation,stretch]);
  useLayoutEffect(()=>{
    onReady?.(!refractive || !!activeOptics || fallback || automaticFallback);
  },[onReady,refractive,activeOptics,fallback,automaticFallback]);
  const sampled = !!backdropImage, overscan = !refractive ? 0 : activeOptics?.overscan ?? (navigation ? NAVIGATION_METRICS.captureOverscan : glassCaptureOverscan(bezelWidth ?? preset.bezelWidth, glassThickness ?? preset.glassThickness, refractiveIndex ?? preset.refractiveIndex, concave ? 'concave' : profile, strength ?? preset.refraction, opticalBlur));
  const totalWidth = activeOptics ? activeOptics.width + overscan * 2 : undefined, totalHeight = activeOptics ? activeOptics.height + overscan * 2 : undefined;
  const scaled = navigation || stretch, scaleX = navigation ? '--navigation-optics-scale-x' : '--liquid-glass-optics-scale-x', scaleY = navigation ? '--navigation-optics-scale-y' : '--liquid-glass-optics-scale-y', capsuleX = navigation ? '--navigation-capsule-x' : '--liquid-glass-capsule-x', capsuleY = navigation ? '--navigation-capsule-y' : '--liquid-glass-capsule-y';
  const sourceStyle: CSSProperties = {
    width: totalWidth, height: totalHeight,
    left: scaled ? `calc(-1 * var(--liquid-glass-overscan) * var(${scaleX}, 1))` : undefined,
    top: scaled ? `calc(-1 * var(--liquid-glass-overscan) * var(${scaleY}, 1))` : undefined,
    transform: scaled && activeOptics ? `scale(var(${scaleX}, 1), var(${scaleY}, 1))` : undefined,
    transformOrigin: scaled ? '0 0' : undefined,
    backgroundImage: sampled ? `var(--liquid-glass-sampled-image, url("${backdropImage}"))` : undefined,
    backgroundSize: backdropSample ? scaled ? `calc(var(--liquid-glass-source-width,${backdropSample.cssSize.width}px) / var(${scaleX}, 1)) calc(var(--liquid-glass-source-height,${backdropSample.cssSize.height}px) / var(${scaleY}, 1))` : `${backdropSample.cssSize.width}px ${backdropSample.cssSize.height}px` : totalWidth ? `${totalWidth}px ${totalHeight}px` : undefined,
    // A sample remains in source/window coordinates while its host moves.
    backgroundPosition: backdropSample && scaled ? `calc((var(--liquid-glass-source-x,${backdropSample.origin.x}px) - var(${capsuleX}, ${bounds?.x ?? 0}px)) / var(${scaleX}, 1) + ${overscan}px) calc((var(--liquid-glass-source-y,${backdropSample.origin.y}px) - var(${capsuleY}, ${bounds?.y ?? 0}px)) / var(${scaleY}, 1) + ${overscan}px)` : backdropSample && bounds ? `${backdropSample.origin.x - bounds.x + overscan}px ${backdropSample.origin.y - bounds.y + overscan}px` : '0 0',
  };
  const style: MaterialStyle = {
    '--liquid-glass-refraction-filter': activeOptics ? `url("#${id}-edge")` : 'none',
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
  const filter = () => <filter id={`${id}-edge`} x="0" y="0" width={totalWidth} height={totalHeight} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
    {optics?.centerMap && <>
      <feImage href={optics.centerMap} x="0" y="0" width={totalWidth} height={totalHeight} preserveAspectRatio="none" result="magnifying-map" />
      <feDisplacementMap data-glass-magnification="true" in="SourceGraphic" in2="magnifying-map" scale={24} xChannelSelector="R" yChannelSelector="G" result="magnified-source" />
    </>}
    <feGaussianBlur in={optics?.centerMap ? 'magnified-source' : 'SourceGraphic'} stdDeviation={opticalBlur} result="blurred-source" />
    {optics && <>
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
  const definitions = useMemo(() => activeOptics ? <svg className={names('definitions')} width="0" height="0" aria-hidden="true" focusable="false"><defs>{filter()}</defs></svg> : undefined, [activeOptics, id, opticalBlur, refraction, defaultMultiplier, specularSaturation, preset.specularSaturation, specularOpacity, preset.specularOpacity, navigation]);

  return <span ref={assignRef} className={`liquid-glass-surface${navigation ? ' navigation-glass' : ''}${className ? ` ${className}` : ''}`} data-glass-effect={effect} data-glass-variant={variant} data-glass-interaction={variant === 'tooltip' ? 'none' : interaction} data-glass-profile={profile} data-glass-concave={concave || undefined} data-glass-fallback={fallback || automaticFallback || undefined} data-glass-pending={refractive && !activeOptics || undefined} data-source={sampled ? 'sampled' : 'live'} aria-hidden="true" style={style}>
    {definitions}
    {activeOptics
      ? <span className={names('edge') + (navigation && sampled ? ' native-glass-backdrop' : '')} aria-hidden="true" style={sourceStyle}/>
      : <span className={names('center')} aria-hidden="true"/>}
    <span className={names('tint')} aria-hidden="true" />
    {!refractive && variant !== 'tooltip' && <span className={names('highlight')} aria-hidden="true" />}
  </span>;
}
