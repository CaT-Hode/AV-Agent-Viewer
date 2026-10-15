import { cloneElement, useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { desktop } from '../lib/transport';
import { NativePanelHeightContext } from '../lib/native-panel-height';
import { sidebarPopupProjection } from '../lib/sidebar-presence';

type Attributes = Record<string, unknown> & { style?: CSSProperties };
type Props = Attributes & { enabled: boolean; viewId?: string; side: 'left' | 'right'; children: ReactElement<Attributes> };

/** One React tree owns tools and editor transactions. The same-origin window
 * only hosts its DOM above a WebContentsView / native HWND; it runs no App. */
export function NativeSidebarPortal({ enabled, viewId, side, children, ...presence }: Props) {
  const [container, setContainer] = useState<HTMLElement>();
  const anchor = useRef<HTMLDivElement>(null), height = useRef<number | undefined>(undefined);
  const syncHeight = useCallback((value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    height.current = value;
    anchor.current?.style.setProperty('--adaptive-panel-height', value.toFixed(3) + 'px');
  }, []);
  useLayoutEffect(() => {
    if (!container) return;
    container.ownerDocument.documentElement.style.setProperty('--reader-panel-presence-duration', String(presence.style?.['--motion-duration' as keyof CSSProperties] ?? '220ms'));
    // The raw bitmap is a sibling behind the portalled material. It must not
    // remain an opaque rectangle while the actual tools and rim disappear.
    for (const name of ['--sidebar-spring-alpha','--sidebar-spring-x','--sidebar-spring-scale-x','--sidebar-spring-scale-y']) {
      const value = presence.style?.[name as keyof CSSProperties];
      if (value === undefined) container.style.removeProperty(name);
      else container.style.setProperty(name, String(value));
    }
    const project = () => {
      const source=anchor.current;if(!source)return;
      const original=Number.parseFloat(String(presence.style?.['--sidebar-spring-x' as keyof CSSProperties]??0))||0;
      const paint=sidebarPopupProjection(side,source.offsetWidth,original);
      container.style.setProperty('--sidebar-window-scale-x',String(paint.scaleX));
      container.style.setProperty('--sidebar-window-x',paint.x+'px');
    };
    const size=new ResizeObserver(project);if(anchor.current)size.observe(anchor.current);project();
    return()=>size.disconnect();
  }, [container, presence.style,side]);
  useLayoutEffect(() => {
    const source = anchor.current; if (!container || !source) return;
    // The navigation lives in another trusted window. Its actual moving edge
    // constrains the hidden owner's anchor; mirror that paint-only constraint
    // into this same React tree before the child window's next frame.
    const sync = () => { const value = source.style.getPropertyValue('--sidebar-space-scale-x'); if (value) container.style.setProperty('--sidebar-space-scale-x',value); else container.style.removeProperty('--sidebar-space-scale-x'); };
    const observer = new MutationObserver(sync); observer.observe(source,{attributes:true,attributeFilter:['style']}); sync();
    return () => observer.disconnect();
  }, [container]);
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
  return <><div ref={anchor} className={String(children.props.className ?? '') + ' reader-panel-anchor'} data-side={side} data-panel-anchor="true" data-panel-adaptive="true" data-panel-source="native" data-panel-view={viewId} data-motion-phase={presence['data-motion-phase'] as string | undefined} aria-hidden="true" style={{ ...style, '--adaptive-panel-height': (height.current ?? Math.min(420, Math.max(160, window.innerHeight - 72))) + 'px', visibility: 'hidden', pointerEvents: 'none', transform: 'none', translate: 'none', scale: '1', transition: 'none' } as CSSProperties} />{container && <NativePanelHeightContext.Provider value={syncHeight}>{createPortal(cloneElement(element, { className: String(element.props.className ?? '') + ' reader-panel-ported' }), container)}</NativePanelHeightContext.Provider>}</>;
}
