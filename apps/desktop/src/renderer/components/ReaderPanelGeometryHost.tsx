import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { call, desktop, windowId } from '../lib/transport';
import type { ReaderPanelSide } from '../lib/reader-panel-layout';

/** The trusted main process places owned portal windows above native content. */
export function ReaderPanelGeometryHost({ workbench, viewId, active, identity, reportError }: { workbench: RefObject<HTMLDivElement | null>; viewId?: string; active: boolean; identity: string; reportError(error: unknown): void }) {
  const latest = useRef({ viewId, active, reportError }); latest.current = { viewId, active, reportError };
  const scheduler = useRef<(() => void) | undefined>(undefined), pending = useRef(false), queued = useRef(false), lastSent = useRef('');
  useLayoutEffect(() => { scheduler.current?.(); }, [viewId, active, identity]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false, frame = 0, movingUntil = 0;
    const observed = new Set<Element>();
    const measure = () => {
      const current = latest.current;
      const panels = !current.active || !current.viewId ? [] : [...(workbench.current?.querySelectorAll<HTMLElement>(':scope > .floating-side-panel[data-panel-anchor="true"]') ?? [])].flatMap(element => {
        const side = element.dataset.side as ReaderPanelSide;
        if (side !== 'left' && side !== 'right') return [];
        const rect = element.getBoundingClientRect();
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return [];
        // Native anchors are invisible; owned windows render their actual React
        // elements. Keep the anchor's real transformed border-box geometry.
        return [{ side, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }];
      });
      return { windowId, viewId: current.viewId, panels };
    };
    const update = async () => {
      if (disposed) return;
      if (pending.current) { queued.current = true; return; }
      const args = measure(), signature = JSON.stringify(args); if (signature === lastSent.current) return;
      pending.current = true;
      try { await call('reader-panel-layout', args); lastSent.current = signature; }
      catch (error) { if (!disposed && latest.current.viewId === args.viewId && latest.current.active) latest.current.reportError(error); }
      finally { pending.current = false; if (queued.current) { queued.current = false; scheduler.current?.(); } }
    };
    const tick = () => { frame = 0; if (disposed) return; void update(); if (performance.now() < movingUntil) frame = requestAnimationFrame(tick); };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(tick); };
    const resize = new ResizeObserver(schedule);
    const changes = new MutationObserver(records => {
      for (const record of records) if (record.type === 'attributes' && record.attributeName === 'data-motion-phase') {
        const milliseconds = Number.parseFloat(getComputedStyle(record.target as Element).getPropertyValue('--motion-duration')) || 220;
        movingUntil = performance.now() + Math.min(1200, milliseconds + 60);
      }
      observe(); schedule();
    });
    const observe = () => {
      const host = workbench.current; if (!host) return;
      if (!observed.has(host)) { observed.add(host); resize.observe(host); changes.observe(host, { childList: true, attributes: true, attributeFilter: ['style'] }); }
      for (const element of host.querySelectorAll(':scope > .floating-side-panel')) if (!observed.has(element)) { observed.add(element); resize.observe(element); changes.observe(element, { attributes: true, attributeFilter: ['style', 'data-motion-phase', 'data-panel-anchor'] }); }
    };
    scheduler.current = schedule; observe(); schedule();
    const off = window.agentViewer?.onToolbar(event => { if (event.action === 'office-state' && (event.state as { viewId?: string } | undefined)?.viewId === latest.current.viewId) schedule(); });
    return () => { disposed = true; if (scheduler.current === schedule) scheduler.current = undefined; cancelAnimationFrame(frame); resize.disconnect(); changes.disconnect(); off?.(); };
  }, [workbench, viewId, active]);
  useEffect(() => () => { if (desktop) void call('reader-panel-layout', { windowId, panels: [] }).catch(() => {}); }, []);
  return null;
}
