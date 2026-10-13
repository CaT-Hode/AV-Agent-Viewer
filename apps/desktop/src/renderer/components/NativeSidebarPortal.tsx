import { cloneElement, useLayoutEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { desktop } from '../lib/transport';

type Attributes = Record<string, unknown> & { style?: CSSProperties };
type Props = Attributes & { enabled: boolean; viewId?: string; side: 'left' | 'right'; children: ReactElement<Attributes> };

/** One React tree owns tools and editor transactions. The same-origin window
 * only hosts its DOM above a WebContentsView / native HWND; it runs no App. */
export function NativeSidebarPortal({ enabled, viewId, side, children, ...presence }: Props) {
  const [container, setContainer] = useState<HTMLElement>();
  useLayoutEffect(() => {
    if (container) container.ownerDocument.documentElement.style.setProperty('--reader-panel-presence-duration', String(presence.style?.['--motion-duration' as keyof CSSProperties] ?? '220ms'));
  }, [container, presence.style]);
  useLayoutEffect(() => {
    if (!desktop || !enabled || !viewId) { setContainer(undefined); return; }
    const url = new URL(location.href); url.hash = '/reader-panel?side=' + side + '&view=' + encodeURIComponent(viewId);
    const popup = window.open(url.toString(), 'agentviewer-reader-panel-' + side + '-' + viewId, 'popup,width=1,height=1');
    if (!popup) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const syncAppearance = () => {
      if (disposed || popup.closed) return;
      try {
        for (const [key, value] of Object.entries(document.documentElement.dataset)) popup.document.documentElement.dataset[key] = value;
      } catch { /* Navigation is denied by the trusted host. Wait for load. */ }
    };
    const observer = new MutationObserver(syncAppearance);
    observer.observe(document.documentElement, { attributes: true });
    const attach = () => {
      if (disposed || popup.closed) return;
      try {
        const target = popup.document.getElementById('reader-panel-content');
        if (target) { syncAppearance(); setContainer(target); return; }
      } catch { /* The child is still opening its exact same-origin route. */ }
      timer = setTimeout(attach, 40);
    };
    attach();
    return () => { disposed = true; clearTimeout(timer); observer.disconnect(); setContainer(undefined); if (!popup.closed) popup.close(); };
  }, [enabled, side, viewId]);

  const style = { ...children.props.style, ...presence.style };
  const element = cloneElement(children, { ...presence, style });
  if (!desktop || !enabled || !viewId) return element;
  // Static parent geometry avoids applying the presence transform twice. The
  // actual DOM in the popup keeps its animation, inert state and React events.
  return <><div className={String(children.props.className ?? '') + ' reader-panel-anchor'} data-side={side} data-panel-anchor="true" data-panel-source="native" data-panel-view={viewId} data-motion-phase={presence['data-motion-phase'] as string | undefined} aria-hidden="true" style={{ ...style, visibility: 'hidden', pointerEvents: 'none', transform: 'none', translate: 'none', scale: '1', transition: 'none' }} />{container && createPortal(cloneElement(element, { className: String(element.props.className ?? '') + ' reader-panel-ported' }), container)}</>;
}
