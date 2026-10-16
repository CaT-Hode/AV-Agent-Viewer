import { ChevronLeft } from 'lucide-react';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { scrollEdges } from '../lib/scroll-edges';

/** Decorative sibling of the scroller: no gutter, flow height or focus target.
 * Attributes update only when an edge changes, never on every wheel pixel. */
export function PanelScrollHints({ viewport, content }: { viewport: RefObject<HTMLElement | null>; content?: RefObject<HTMLElement | null> }) {
  const overlay = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroll = viewport.current, host = overlay.current; if (!scroll || !host) return;
    const owner = scroll.ownerDocument.defaultView; if (!owner) return;
    let frame = 0,disposed=false;
    const update = () => {
      frame = 0;if(disposed)return;
      const edges = scrollEdges(scroll);
      for (const [edge, visible] of Object.entries(edges)) {
        const value = String(visible); if (host.dataset[edge] !== value) host.dataset[edge] = value;
      }
      for (const [name, value] of Object.entries({ top: scroll.offsetTop, left: scroll.offsetLeft, width: scroll.clientWidth, height: scroll.clientHeight })) {
        const next = value + 'px'; if (host.style.getPropertyValue('--scroll-hint-' + name) !== next) host.style.setProperty('--scroll-hint-' + name, next);
      }
    };
    const schedule = () => { if (!disposed&&!frame) frame = owner.requestAnimationFrame(update); };
    const observer = new owner.ResizeObserver(schedule); observer.observe(scroll); if (content?.current) observer.observe(content.current);
    const changes = new owner.MutationObserver(schedule); changes.observe(scroll, { childList: true, subtree: true, characterData: true });
    scroll.addEventListener('scroll', schedule, { passive: true }); update();
    return () => { disposed=true;observer.disconnect(); changes.disconnect(); scroll.removeEventListener('scroll', schedule); owner.cancelAnimationFrame(frame); };
  }, [viewport, content]);
  return <div className="panel-scroll-hints" ref={overlay} aria-hidden="true">{(['top', 'bottom', 'left', 'right'] as const).map(edge => <span className={'panel-scroll-hint panel-scroll-hint-' + edge} key={edge}><ChevronLeft size={13} strokeWidth={1.6} /></span>)}</div>;
}
