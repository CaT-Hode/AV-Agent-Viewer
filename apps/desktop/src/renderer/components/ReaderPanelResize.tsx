import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { clampReaderPanelWidth, createReaderPanelLayoutStore, readerPanelDragWidth, readerPanelKeyWidth, readerPanelLimits, READER_PANEL_LAYOUT_KEY, type PanelResizeGesture, type ReaderPanelSide } from '../lib/reader-panel-layout';

let layoutStore: ReturnType<typeof createReaderPanelLayoutStore> | undefined;
function readerPanelStore() {
  if (!layoutStore) {
    let storage: Storage | undefined; try { storage = window.localStorage; } catch { /* An in-memory layout remains usable. */ }
    layoutStore = createReaderPanelLayoutStore(storage);
  }
  return layoutStore;
}
export function useReaderPanelLayout() {
  const store = readerPanelStore();
  const layout = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    const receive = (event: StorageEvent) => { if (event.key === READER_PANEL_LAYOUT_KEY || event.key === null) store.receive(event.newValue); };
    window.addEventListener('storage', receive); return () => window.removeEventListener('storage', receive);
  }, [store]);
  return { layout, commitWidth: store.setWidth };
}

export function ReaderPanelResizeHandle({ side, width, workbench, onCommit }: { side: ReaderPanelSide; width: number; workbench: RefObject<HTMLDivElement | null>; onCommit(side: ReaderPanelSide, width: number): void }) {
  const handle = useRef<HTMLDivElement>(null), gesture = useRef<PanelResizeGesture | undefined>(undefined);
  const previewWidth = useRef<number | undefined>(undefined);
  const latest = useRef({ width, onCommit }); latest.current = { width, onCommit };
  const [limits, setLimits] = useState(() => readerPanelLimits(side));
  const measure = () => readerPanelLimits(side, workbench.current?.querySelector('.reader-panel')?.getBoundingClientRect().width);
  const preview = (next: number) => {
    const property = `--reader-${side}-width`, value = `${next}px`;
    workbench.current?.style.setProperty(property, value);
    const pane = handle.current?.closest<HTMLElement>('.floating-side-panel'), owner = handle.current?.ownerDocument;
    if (owner && owner !== workbench.current?.ownerDocument) { owner.documentElement.style.setProperty(property, value); pane?.style.setProperty(property, value); }
    const actual = clampReaderPanelWidth(side, next, measure()); previewWidth.current = actual;
    handle.current?.setAttribute('aria-valuenow', String(actual));
    handle.current?.setAttribute('aria-valuetext', `${actual} 像素`);
  };
  const retire = (commit: boolean) => {
    const active = gesture.current; if (!active) return;
    // Owned native windows can acknowledge geometry after pointerup. Persist
    // the latest pointer-derived target, rather than their lagging old bounds.
    const actual = previewWidth.current ?? handle.current?.closest('.floating-side-panel')?.getBoundingClientRect().width ?? latest.current.width;
    gesture.current = undefined; if (workbench.current) delete workbench.current.dataset.panelResizing;
    if (handle.current) { delete handle.current.dataset.dragging; try { if (handle.current.hasPointerCapture(active.pointerId)) handle.current.releasePointerCapture(active.pointerId); } catch { /* A native portal may already have closed. */ } }
    if (commit) latest.current.onCommit(side, clampReaderPanelWidth(side, actual, measure()));
    else preview(latest.current.width);
    previewWidth.current = undefined;
  };
  const finish = useRef(retire); finish.current = retire;
  useLayoutEffect(() => { if (!gesture.current) preview(width); }, [width]);
  useLayoutEffect(() => {
    const refresh = () => setLimits(previous => { const next = measure(); return previous.min === next.min && previous.max === next.max ? previous : next; });
    refresh(); const observer = new ResizeObserver(refresh); if (workbench.current) observer.observe(workbench.current);
    return () => observer.disconnect();
  }, [side, workbench]);
  useEffect(() => { const cancel = () => finish.current(false), owner = handle.current?.ownerDocument.defaultView ?? window; owner.addEventListener('blur', cancel); return () => { owner.removeEventListener('blur', cancel); finish.current(false); }; }, []);
  useEffect(() => { if (gesture.current) finish.current(false); }, [width]);
  const effective = clampReaderPanelWidth(side, width, limits);
  return <div ref={handle} className="reader-panel-resize" data-side={side} role="separator" aria-orientation="vertical" aria-label={side === 'left' ? '调整左侧工具栏宽度' : '调整右侧 AI 面板宽度'} aria-controls={side === 'left' ? 'format-tools' : 'ai-tools'} aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={effective} aria-valuetext={`${effective} 像素`} tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0 || gesture.current) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; }
      // Native owned windows can quantize their painted bounds by one DIP.
      // Keep the canonical logical width as the gesture origin so clicking or
      // repeating a drag cannot feed that rounding back into saved layout.
      gesture.current = { side, pointerId: event.pointerId, startX: event.screenX, startWidth: clampReaderPanelWidth(side, latest.current.width, measure()) };
      previewWidth.current = gesture.current.startWidth;
      event.currentTarget.dataset.dragging = 'true'; if (workbench.current) workbench.current.dataset.panelResizing = side;
    }}
    onPointerMove={event => { if (gesture.current?.pointerId !== event.pointerId) return; event.preventDefault(); preview(readerPanelDragWidth(gesture.current, event.screenX, measure())); }}
    onPointerUp={event => { if (gesture.current?.pointerId === event.pointerId) { preview(readerPanelDragWidth(gesture.current, event.screenX, measure())); retire(true); } }}
    onPointerCancel={() => retire(false)} onLostPointerCapture={() => retire(false)}
    onKeyDown={event => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); retire(false); return; }
      if (gesture.current) return;
      const next = readerPanelKeyWidth(side, effective, event.key, event.shiftKey, measure()); if (next === undefined) return;
      event.preventDefault(); event.stopPropagation(); preview(next); onCommit(side, next);
    }}><span aria-hidden="true" /></div>;
}
