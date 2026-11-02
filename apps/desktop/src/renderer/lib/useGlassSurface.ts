import { useEffect, useRef, type RefObject } from 'react';
import type { NavigationBounds } from './navigation-optics';

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

/** Share the source-only contrast probe between navigation, selection and translation. */
export function useGlassSurface(root: RefObject<HTMLElement | null>, { backdropImage, capsuleBounds, onSurface }: { backdropImage?: string; capsuleBounds?: NavigationBounds; onSurface?(surface: 'light' | 'dark'): void }) {
  const resample = useRef<(() => void) | undefined>(undefined);
  const inferred = useRef<'light' | 'dark'>('light');

  useEffect(() => {
    if (!onSurface) return;
    const brightness = (value: number) => {
      // Mid-grey and tinted paper retain dark ink. Switch to white ink only
      // over a genuinely dark source; a small dead band avoids flicker.
      const next = value < (inferred.current === 'dark' ? 112 : 92) ? 'dark' : 'light';
      if (next !== inferred.current) inferred.current = next;
      onSurface(next);
    };
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
        if (weight) brightness(light / weight);
      };
      image.src = backdropImage;
      return () => { active = false; image.onload = null; };
    }
    // Live documents need no screenshots: inspect their actual opaque page
    // surface, never navigation descendants. PDF and HTML retain page colors.
    let frame = 0;
    const measure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const element = root.current, capsule = element?.classList.contains('liquid-glass-surface') ? element.parentElement : element; if (!capsule) return;
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
              brightness(light / (pixels.length / 4)); return;
            }
          } catch { /* Read-only surface inference can fall back to page style. */ }
        }
        if (underneath instanceof HTMLIFrameElement && underneath.dataset.surfaceBackground) {
          const color = colorChannels(underneath.dataset.surfaceBackground);
          if (color && color[3] > 204) { brightness(.2126 * color[0] + .7152 * color[1] + .0722 * color[2]); return; }
        }
        let node: Element | null = underneath;
        while (node) {
          const color = colorChannels(getComputedStyle(node).backgroundColor);
          if (color && color[3] > 204) {
            brightness(.2126 * color[0] + .7152 * color[1] + .0722 * color[2]); return;
          }
          node = node.parentElement;
        }
      });
    };
    resample.current = measure;
    const appearance = new MutationObserver(measure);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-document-background', 'data-document-tone', 'data-document-paper'] });
    const content = new MutationObserver(measure);
    const documentHost = root.current?.closest('.reader-panel')?.querySelector('.document-content') ?? document.querySelector('.reader-panel .document-content');
    if (documentHost) content.observe(documentHost, { childList: true, subtree: true, characterData: true });
    document.addEventListener('scroll', measure, true); window.addEventListener('resize', measure); window.addEventListener('agentviewer:html-surface', measure); window.addEventListener('agentviewer:selection-material-position',measure); window.addEventListener('agentviewer:translation-geometry',measure); measure();
    return () => { resample.current = undefined; cancelAnimationFrame(frame); appearance.disconnect(); content.disconnect(); document.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); window.removeEventListener('agentviewer:html-surface', measure); window.removeEventListener('agentviewer:selection-material-position',measure); window.removeEventListener('agentviewer:translation-geometry',measure); };
  }, [backdropImage, onSurface]);
  useEffect(() => resample.current?.(),[capsuleBounds?.x,capsuleBounds?.y,capsuleBounds?.width,capsuleBounds?.height]);
}
