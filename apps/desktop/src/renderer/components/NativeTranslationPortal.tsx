import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { call } from '../lib/transport';
import type { Rect } from '../../../../../packages/contracts/src/index';

export type TranslationBackdrop = { image?: string; rect?: Rect };
/** Reuse the trusted, view-bound panel host above WebContentsView. The owner
 * keeps the React state and permissions; the child only displays one material. */
export function NativeTranslationPortal({ enabled, viewId, children }: { enabled: boolean; viewId: string; children(native: boolean, backdrop: TranslationBackdrop): ReactNode }) {
  const [container, setContainer] = useState<HTMLElement>(), [backdrop, setBackdrop] = useState<TranslationBackdrop>({});
  useLayoutEffect(() => {
    if (!enabled) return;
    const url = new URL(location.href); url.hash = '/reader-panel?side=translation&view=' + encodeURIComponent(viewId);
    const popup = window.open(url.toString(), 'agentviewer-reader-panel-translation-' + viewId, 'popup,width=1,height=1');
    if (!popup) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>, unsubscribe: (() => void) | undefined;
    const sync = () => { if (disposed || popup.closed) return; for (const [key,value] of Object.entries(document.documentElement.dataset)) popup.document.documentElement.dataset[key] = value; };
    const observer = new MutationObserver(sync); observer.observe(document.documentElement, { attributes: true });
    const attach = () => {
      if (disposed || popup.closed) return;
      const target = popup.document.getElementById('reader-panel-content');
      if (!target) { timer = setTimeout(attach, 30); return; }
      sync(); setContainer(target);
      unsubscribe = popup.agentViewer?.onToolbar(event => { if (event.action === 'reader-panel-backdrop') setBackdrop({ image: typeof event.image === 'string' ? event.image : undefined, rect: event.rect as Rect | undefined }); });
      void popup.agentViewer?.call('reader-panel-ready');
    };
    attach();
    return () => { disposed = true; clearTimeout(timer); unsubscribe?.(); observer.disconnect(); setContainer(undefined); setBackdrop({}); void call('translation-popover-layout', { viewId, visible: false }).catch(() => {}); if (!popup.closed) popup.close(); };
  }, [enabled, viewId]);
  return !enabled ? children(false, {}) : container ? createPortal(children(true, backdrop), container) : null;
}
