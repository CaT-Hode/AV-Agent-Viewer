export type ReaderPanelSide = 'left' | 'right';
export type ReaderPanelLayout = { schemaVersion: 1; leftWidth: number; rightWidth: number };
export type PanelWidthLimits = { min: number; max: number };
export const READER_PANEL_LAYOUT_KEY = 'agentviewer.reader-panels.v1';
export const DEFAULT_READER_PANEL_LAYOUT: ReaderPanelLayout = { schemaVersion: 1, leftWidth: 248, rightWidth: 380 };
const bounds: Record<ReaderPanelSide, PanelWidthLimits> = { left: { min: 180, max: 620 }, right: { min: 280, max: 720 } };

/** Both panels overlay the unchanged canvas; leave room between their inner edges. */
export function readerPanelLimits(side: ReaderPanelSide, readingWidth?: number): PanelWidthLimits {
  const limits = bounds[side];
  return { min: limits.min, max: typeof readingWidth === 'number' && Number.isFinite(readingWidth) && readingWidth > 0 ? Math.max(limits.min, Math.min(limits.max, Math.floor((readingWidth - 32) / 2))) : limits.max };
}
/** The two chrome panes share the space left by the core navigation controls.
 * These responsive limits never alter the canvas or overwrite a saved width. */
export function sharedReaderPanelLimits(side: ReaderPanelSide, readingWidth: number | undefined, bothOpen: boolean): PanelWidthLimits {
  const limits = bounds[side];
  if (typeof readingWidth !== 'number' || !Number.isFinite(readingWidth) || readingWidth <= 0) return { ...limits };
  const budget = Math.floor(Math.max(0,readingWidth - 148) / (bothOpen ? 2 : 1));
  return { min:limits.min,max:Math.max(limits.min,Math.min(limits.max,budget)) };
}
export function clampReaderPanelWidth(side: ReaderPanelSide, width: number, limits = readerPanelLimits(side)) {
  const fallback = side === 'left' ? DEFAULT_READER_PANEL_LAYOUT.leftWidth : DEFAULT_READER_PANEL_LAYOUT.rightWidth;
  return Math.round(Math.min(limits.max, Math.max(limits.min, Number.isFinite(width) ? width : fallback)));
}
export type PanelResizeGesture = { side: ReaderPanelSide; pointerId: number; startX: number; startWidth: number };
export function readerPanelDragWidth(gesture: PanelResizeGesture, clientX: number, limits: PanelWidthLimits) {
  const delta = Number.isFinite(clientX) ? clientX - gesture.startX : 0;
  return clampReaderPanelWidth(gesture.side, gesture.startWidth + (gesture.side === 'left' ? delta : -delta), limits);
}
export function readerPanelKeyWidth(side: ReaderPanelSide, width: number, key: string, shift: boolean, limits: PanelWidthLimits): number | undefined {
  if (key === 'Home') return limits.min;
  if (key === 'End') return limits.max;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined;
  const direction = (key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1);
  return clampReaderPanelWidth(side, width + direction * (shift ? 32 : 8), limits);
}
export function parseReaderPanelLayout(raw: string | null): ReaderPanelLayout {
  try {
    const value: unknown = raw === null ? undefined : JSON.parse(raw);
    if (!value || typeof value !== 'object' || (value as Record<string, unknown>).schemaVersion !== 1) return { ...DEFAULT_READER_PANEL_LAYOUT };
    const fields = value as Record<string, unknown>;
    return { schemaVersion: 1, leftWidth: clampReaderPanelWidth('left', typeof fields.leftWidth === 'number' ? fields.leftWidth : NaN), rightWidth: clampReaderPanelWidth('right', typeof fields.rightWidth === 'number' ? fields.rightWidth : NaN) };
  } catch { return { ...DEFAULT_READER_PANEL_LAYOUT }; }
}
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
/** Layout persistence is separate from preferences and their global undo history. */
export function createReaderPanelLayoutStore(storage?: Storage) {
  let current: ReaderPanelLayout;
  try { current = parseReaderPanelLayout(storage?.getItem(READER_PANEL_LAYOUT_KEY) ?? null); } catch { current = { ...DEFAULT_READER_PANEL_LAYOUT }; }
  const listeners = new Set<() => void>();
  const publish = (next: ReaderPanelLayout) => {
    if (next.leftWidth === current.leftWidth && next.rightWidth === current.rightWidth) return false;
    current = next; for (const listener of listeners) listener(); return true;
  };
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    receive(raw: string | null) { publish(parseReaderPanelLayout(raw)); },
    setWidth(side: ReaderPanelSide, width: number) {
      const next = { ...current, [side === 'left' ? 'leftWidth' : 'rightWidth']: clampReaderPanelWidth(side, width) };
      if (!publish(next)) return;
      try { storage?.setItem(READER_PANEL_LAYOUT_KEY, JSON.stringify(next)); } catch { /* The current window stays usable when storage is unavailable. */ }
    },
  };
}
