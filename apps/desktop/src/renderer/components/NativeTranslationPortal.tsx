import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { call } from '../lib/transport';
import type { Rect } from '../../../../../packages/contracts/src/index';
import { TRANSLATION_CAPSULE_METRICS } from '../lib/translation-popover';

export type TranslationBackdrop = { image?: string; rect?: Rect };
/** Reuse the trusted, view-bound panel host above WebContentsView. The owner
 * keeps the React state and permissions; the child only displays one material. */
export function NativeTranslationPortal({ enabled, viewId, children }: { enabled: boolean; viewId: string; children(native: boolean, backdrop: TranslationBackdrop): ReactNode }) {
  const [host, setHost] = useState<{ viewId: string; container: HTMLElement; backdrop: TranslationBackdrop }>();
  const currentHost = enabled && host?.viewId === viewId && !host.container.ownerDocument.defaultView?.closed ? host : undefined;
  useLayoutEffect(() => {
    if (!enabled) return;
    const url = new URL(location.href); url.hash = '/reader-panel?side=translation&view=' + encodeURIComponent(viewId);
    const popup = window.open(url.toString(), 'agentviewer-reader-panel-translation-' + viewId, 'popup,width=1,height=1');
    if (!popup) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>, unsubscribe: (() => void) | undefined, lastImage: string | undefined;
    let requested: TranslationBackdrop = {}, decoding = false;
    let sourceGeneration = 0;
    const sync = () => { if (disposed || popup.closed) return; for (const [key,value] of Object.entries(document.documentElement.dataset)) if(popup.document.documentElement.dataset[key]!==value)popup.document.documentElement.dataset[key] = value; };
    const observer = new MutationObserver(sync); observer.observe(document.documentElement, { attributes: true });
    const attach = () => {
      if (disposed || popup.closed) return;
      const target = popup.document.getElementById('reader-panel-content');
      if (!target) { timer = setTimeout(attach, 30); return; }
      sync(); setHost({ viewId, container: target, backdrop: {} });
      const commit = ({image, rect}: TranslationBackdrop) => {
        if (disposed) return;
        if (rect) {
          const gutter = TRANSLATION_CAPSULE_METRICS.shadowGutter;
          const geometry = {x:rect.x + gutter,y:rect.y + gutter,width:rect.width,height:rect.height};
          for (const [axis, value] of Object.entries(geometry)) {
            const name = '--liquid-glass-source-' + axis;
            if (target.style.getPropertyValue(name) !== value+'px') target.style.setProperty(name,value+'px');
          }
        }
        if (lastImage === image) return;
        lastImage = image;
        if (image) target.style.setProperty('--liquid-glass-sampled-image','url("'+image+'")');
        else target.style.removeProperty('--liquid-glass-sampled-image');
        setHost(previous => previous?.container === target ? {...previous,backdrop:{image,rect}} : previous);
      };
      const decodeLatest = async () => {
        if (decoding) return;
        decoding = true;
        try {
          while (!disposed && requested.image && requested.image !== lastImage) {
            const frame = requested, generation = sourceGeneration;
            const bitmap = popup.document.createElement('img');
            bitmap.src = frame.image!;
            try { await bitmap.decode(); } catch { if (requested === frame) break; continue; }
            if (disposed || generation !== sourceGeneration) continue;
            // An origin-only move can arrive during decode. A different ROI
            // requires its own pixels, otherwise the backdrop jumps on drag.
            if (requested.image === frame.image) commit(requested);
            else if (frame.rect && requested.rect && frame.rect.x === requested.rect.x && frame.rect.y === requested.rect.y &&
                     frame.rect.width === requested.rect.width && frame.rect.height === requested.rect.height) commit(frame);
          }
        } finally { decoding=false; }
      };
      unsubscribe = popup.agentViewer?.onToolbar(event => {
        if (event.action !== 'reader-panel-backdrop' || disposed) return;
        requested = {image:typeof event.image === 'string' ? event.image : undefined,rect:event.rect as Rect|undefined};
        if (!requested.image) sourceGeneration++;
        if (!requested.image || requested.image === lastImage) commit(requested);
        else void decodeLatest();
      });
      void popup.agentViewer?.call('reader-panel-ready');
    };
    attach();
    return () => { disposed = true; clearTimeout(timer); unsubscribe?.(); observer.disconnect(); setHost(undefined); void call('translation-popover-layout', { viewId, visible: false }).catch(() => {}); if (!popup.closed) popup.close(); };
  }, [enabled, viewId]);
  return !enabled ? children(false, {}) : currentHost ? createPortal(children(true, currentHost.backdrop), currentHost.container) : null;
}
