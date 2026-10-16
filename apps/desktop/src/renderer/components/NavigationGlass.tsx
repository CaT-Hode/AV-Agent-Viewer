import { useEffect, useRef } from 'react';
import { NAVIGATION_METRICS, type NavigationBackdropSample, type NavigationBounds } from '../lib/navigation-optics';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { SELECTION_GLASS_BLUR_PX } from '../lib/glass-presets';

const colorCache = new Map<string, number[] | undefined>();

function colorChannels(color: string) {
  if (colorCache.has(color)) return colorCache.get(color);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return;
  // Let the browser normalize rgb(), color(srgb ...), lab() and alpha into
  // sRGB bytes; parsing numeric substrings assumes the wrong channel range.
  context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
  const channels = [...context.getImageData(0, 0, 1, 1).data];
  colorCache.set(color, channels);
  if (colorCache.size > 32) colorCache.delete(colorCache.keys().next().value!);
  return channels;
}

/** Background optics only; navigation labels and inputs remain sibling layers. */
export function NavigationGlass({ backdropImage, backdropSample, capsuleBounds, onSurface, softness = 'navigation', onReady }: { backdropImage?: string; backdropSample?: NavigationBackdropSample; capsuleBounds?: NavigationBounds; onSurface?(surface: 'light' | 'dark'): void; softness?: 'navigation' | 'selection'; onReady?(ready:boolean):void }) {
  const root = useRef<HTMLSpanElement>(null);
  const resample = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!onSurface) return;
    if (backdropImage) {
      let active = true;
      const image = new Image();
      image.onload = () => {
        if (!active) return;
        const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 4;
        const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return;
        context.drawImage(image, 0, 0, 24, 4);
        const pixels = context.getImageData(0, 0, 24, 4).data;
        let light = 0, weight = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3] / 255;
          light += (.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]) * alpha;
          weight += alpha;
        }
        if (weight) onSurface(light / weight > 145 ? 'light' : 'dark');
      };
      image.src = backdropImage;
      return () => { active = false; image.onload = null; };
    }
    // Live documents need no screenshots: inspect their actual opaque page
    // surface, never navigation descendants. PDF and HTML retain page colors.
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      // Movement and document mutation can fire once per animation/input
      // frame. Infer contrast once they settle instead of rescanning the DOM
      // and reattaching listeners for every reported capsule coordinate.
      timer = setTimeout(() => { frame = requestAnimationFrame(() => {
        const capsule = root.current?.parentElement; if (!capsule) return;
        const box = capsule.getBoundingClientRect();
        const underneath = document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2).find(node => !capsule.contains(node) && !node.contains(capsule) && !node.closest('.reader-toolbar'));
        if (!underneath) return;
        const pdf = underneath.closest('.pdf-page')?.querySelector('canvas');
        if (pdf) {
          const rect = pdf.getBoundingClientRect();
          const x = Math.round((box.x + box.width / 2 - rect.x) * pdf.width / rect.width);
          const y = Math.round((box.y + box.height / 2 - rect.y) * pdf.height / rect.height);
          try {
            const pixels = pdf.getContext('2d')?.getImageData(Math.max(0, Math.min(pdf.width - 24, x - 12)), Math.max(0, Math.min(pdf.height - 1, y)), Math.min(24, pdf.width), 1).data;
            if (pixels) {
              let light = 0;
              for (let i = 0; i < pixels.length; i += 4) light += .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
              onSurface(light / (pixels.length / 4) > 145 ? 'light' : 'dark'); return;
            }
          } catch { /* Read-only surface inference can fall back to page style. */ }
        }
        if (underneath instanceof HTMLIFrameElement && underneath.dataset.surfaceBackground) {
          const color = colorChannels(underneath.dataset.surfaceBackground);
          if (color && color[3] > 204) { onSurface(.2126 * color[0] + .7152 * color[1] + .0722 * color[2] > 145 ? 'light' : 'dark'); return; }
        }
        let node: Element | null = underneath;
        while (node) {
          const color = colorChannels(getComputedStyle(node).backgroundColor);
          if (color && color[3] > 204) {
            onSurface(.2126 * color[0] + .7152 * color[1] + .0722 * color[2] > 145 ? 'light' : 'dark'); return;
          }
          node = node.parentElement;
        }
      }); }, 80);
    };
    resample.current = measure;
    const appearance = new MutationObserver(measure);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-document-background', 'data-document-tone', 'data-document-paper'] });
    const content = new MutationObserver(measure);
    const documentHost = root.current?.closest('.reader-panel')?.querySelector('.document-content');
    if (documentHost) content.observe(documentHost, { childList: true, subtree: true, characterData: true });
    document.addEventListener('scroll', measure, true); window.addEventListener('resize', measure); window.addEventListener('agentviewer:html-surface', measure); window.addEventListener('agentviewer:selection-material-position',measure); measure();
    return () => { resample.current = undefined; clearTimeout(timer); cancelAnimationFrame(frame); appearance.disconnect(); content.disconnect(); document.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); window.removeEventListener('agentviewer:html-surface', measure); window.removeEventListener('agentviewer:selection-material-position',measure); };
  }, [backdropImage, onSurface]);
  useEffect(() => resample.current?.(),[capsuleBounds?.x,capsuleBounds?.y,capsuleBounds?.width,capsuleBounds?.height]);

  return <LiquidGlassSurface navigation variant="search" bezelWidth={NAVIGATION_METRICS.bezelWidth} glassThickness={NAVIGATION_METRICS.glassThickness} refractiveIndex={NAVIGATION_METRICS.refractiveIndex} blur={softness === 'selection' ? SELECTION_GLASS_BLUR_PX : NAVIGATION_METRICS.blur} blurLimit={softness === 'selection' ? SELECTION_GLASS_BLUR_PX : undefined} onReady={onReady} strength={NAVIGATION_METRICS.refraction} specularOpacity={NAVIGATION_METRICS.specularOpacity} specularSaturation={NAVIGATION_METRICS.specularSaturation} backdropImage={backdropImage} backdropSample={backdropSample} bounds={capsuleBounds} surfaceRef={root} />;
}
