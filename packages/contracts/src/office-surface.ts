import type { Rect } from './index';
import type { NativeOfficeState } from './native-office';

/** This is an internal renderer protocol. Public MCP continues to use versioned office tools. */
export type OfficeSurfaceIdentity = { sessionId: string; documentId: string; viewId: string; engineEpoch: string };
export type OfficeSurfacePart = { index: number; name: string; hash?: string; visible?: boolean; sizeTwips?: { width: number; height: number } };
export type OfficeSurfaceWindow = { id: number; instanceId: string; kind: 'dialog' | 'child' | 'deck' | 'tooltip'; title?: string; width: number; height: number; visible: boolean; generation: number; /** Actual engine modality when known; absence never asserts a native modal lock. */ modal?: boolean; parentId?: number; positionCss?: { x: number; y: number }; cursor?: Rect; cursorVisible?: boolean };
/** All document coordinates are twips; DOM geometry and viewport are CSS pixels. */
export interface OfficeSurfaceState extends NativeOfficeState {
  surfaceKind: 'tiled';
  viewId: string;
  sizeTwips: { width: number; height: number };
  pages?: Rect[];
  parts: OfficeSurfacePart[];
  partIndex: number;
  layoutRevision: number;
  renderGeneration: number;
  /** Monotonic engine event order within this session/epoch. */
  eventSequence: number;
  caret?: Rect;
  caretVisible?: boolean;
  selectionRects: Rect[];
  selectionStart?: Rect;
  selectionEnd?: Rect;
  graphicSelection?: { rect: Rect; rotation?: number; draggable?: boolean; resizable?: boolean; rotatable?: boolean };
  cellCursor?: Rect;
  cellSelection?: Rect;
  cellAutoFill?: Rect;
  mousePointer?: string;
  focusedParagraph?: string;
  formula?: string;
  windows?: OfficeSurfaceWindow[];
  /** Acknowledgements are scoped to this renderer input stream, never a global key count. */
  inputAck?: { streamId: string; sequence: number; composing: boolean };
}
export type OfficeSurfaceLayoutRequest = {
  viewId: string;
  layoutRevision: number;
  partIndex: number;
  visibleTwips: Rect;
  viewportCss: { width: number; height: number };
  /** Document (0,0) inside the viewport, including centered paper and real scroll offsets. */
  documentOriginCss: { x: number; y: number };
  /** The real DOM scroll viewport, in the owning renderer's CSS coordinates. */
  boundsCss: Rect;
  zoom: number;
  deviceScaleFactor: number;
  visible: boolean;
  focused: boolean;
};
export type OfficeSurfaceTileSpec = { key: string; rectTwips: Rect; pixelWidth: number; pixelHeight: number };
export type OfficeSurfaceTilesRequest = { viewId: string; layoutRevision: number; renderGeneration: number; partIndex: number; tiles: OfficeSurfaceTileSpec[] };
/** Raw engine pixels; no desktop capture, mirror document or file-export fallback. */
export type OfficeSurfaceTile = { key: string; rectTwips: Rect; width: number; height: number; pixelFormat: 'rgba' | 'bgra'; alphaMode?: 'straight' | 'premultiplied'; data: Uint8Array };
export type OfficeSurfaceTilesReply = { state: OfficeSurfaceState; partIndex: number; renderGeneration: number; layoutRevision: number; tiles: OfficeSurfaceTile[] };
export type OfficeInputModifiers = { shift: boolean; control: boolean; alt: boolean; meta: boolean };
export type OfficeSurfaceInputEvent =
  | { kind: 'pointer'; phase: 'down' | 'move' | 'up' | 'cancel'; pointTwips: { x: number; y: number }; /** DOM event.button; release must retain this even when event.buttons is zero. */ button?: number; buttons: number; clickCount: number; modifiers: OfficeInputModifiers }
  | { kind: 'key'; phase: 'down' | 'up'; key: string; code: string; repeat: boolean; modifiers: OfficeInputModifiers }
  | { kind: 'text'; text: string }
  | { kind: 'composition'; compositionId: string; phase: 'start' | 'update' | 'end' | 'cancel'; text: string }
  | { kind: 'paste'; items: { mimeType: string; data: Uint8Array }[] }
  | { kind: 'selection-handle'; edge: 'start' | 'end'; pointTwips: { x: number; y: number } }
  | { kind: 'barrier' };
export type OfficeSurfaceInputRequest = { viewId: string; streamId: string; sequence: number; layoutRevision: number; /** Frozen when human input is captured; never replaced with a newer part. */ expectedPartIndex: number; event: OfficeSurfaceInputEvent };
export type OfficeSurfaceInputReply = { state: OfficeSurfaceState; streamId: string; ackSequence: number; composing: boolean; /** Acknowledged, unexecuted passive hover; never an editing event. */ discarded?: { code: 'STALE_OFFICE_SURFACE_LAYOUT'; reason: string } };
export type OfficeSurfaceWindowIdentity = { viewId: string; sessionId: string; engineEpoch: string; windowId: number; windowInstanceId: string };
/** Width/height here are physical buffer pixels; the window record's size is logical CSS pixels. */
export type OfficeSurfaceWindowPaintRequest = OfficeSurfaceWindowIdentity & { generation: number; width: number; height: number; deviceScaleFactor: number };
export type OfficeSurfaceWindowPaintReply = { state: OfficeSurfaceState; windowId: number; windowInstanceId: string; generation: number; tile: OfficeSurfaceTile };
export type OfficeSurfaceWindowInputEvent = Exclude<OfficeSurfaceInputEvent, { kind: 'pointer' | 'selection-handle' }> | { kind: 'pointer'; phase: 'down' | 'move' | 'up' | 'cancel'; pointCss: { x: number; y: number }; button?: number; buttons: number; clickCount: number; modifiers: OfficeInputModifiers };
export type OfficeSurfaceWindowInputRequest = OfficeSurfaceWindowIdentity & { streamId: string; sequence: number; event: OfficeSurfaceWindowInputEvent };
export type OfficeSurfaceWindowCloseRequest = OfficeSurfaceWindowIdentity;
export type OfficeSurfaceWindowClipboardReply = { state: OfficeSurfaceState; windowId: number; windowInstanceId: string; items: { mimeType: string; data: Uint8Array }[] };
export type OfficeSurfaceSelectionProjection = OfficeSurfaceIdentity & { engineRevision: number; selectionEpoch?: number; layoutRevision: number; actor?: NativeOfficeState['actor']; selection?: NativeOfficeState['selection']; rects: Rect[]; visibleTwips: Rect; viewportCss: Rect; pageIndex?: number; partIndex: number };
export type OfficeSurfaceEvent =
  | { action: 'office-surface-state'; state: OfficeSurfaceState }
  | { action: 'office-surface-invalidate'; viewId: string; sessionId: string; engineEpoch: string; partIndex: number; renderGeneration: number; engineRevision: number; eventSequence: number; rectTwips?: Rect }
  | { action: 'office-surface-scroll'; viewId: string; sessionId: string; engineEpoch: string; layoutRevision: number; partIndex: number; rectTwips: Rect; /** Exact DOM offsets for an actual scroll action; absent for an anchor jump. */ scrollCss?: { x: number; y: number }; requestId?: string };

export const OFFICE_SURFACE_METHODS = { state: 'office-surface-state', layout: 'office-surface-layout', tiles: 'office-surface-tiles', input: 'office-surface-input', windowPaint: 'office-surface-window-paint', windowInput: 'office-surface-window-input', windowClose: 'office-surface-window-close', windowClipboard: 'office-surface-window-clipboard' } as const;

export function isOfficeSurfaceState(value: unknown): value is OfficeSurfaceState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<OfficeSurfaceState>;
  return s.surfaceKind === 'tiled' && typeof s.sessionId === 'string' && typeof s.documentId === 'string' && typeof s.viewId === 'string' && typeof s.engineEpoch === 'string'
    && !!s.sizeTwips && [s.sizeTwips.width, s.sizeTwips.height].every(n => Number.isFinite(n) && n > 0)
    && Number.isSafeInteger(s.partIndex) && s.partIndex! >= 0 && Number.isSafeInteger(s.renderGeneration) && s.renderGeneration! >= 0
    && Number.isSafeInteger(s.layoutRevision) && s.layoutRevision! >= 0 && Number.isSafeInteger(s.eventSequence) && s.eventSequence! >= 0
    && Number.isSafeInteger(s.engineRevision) && s.engineRevision! >= 0 && Array.isArray(s.parts) && s.parts.every(part => Number.isSafeInteger(part.index) && part.index >= 0 && typeof part.name === 'string')
    && Array.isArray(s.selectionRects) && s.selectionRects.every(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0);
}
