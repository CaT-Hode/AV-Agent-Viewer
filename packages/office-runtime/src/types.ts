import type { Rect, Locator } from '../../contracts/src/index';
import type { NativeOfficeAppearance } from './appearance';

export type NativeOfficeFormat = 'docx' | 'pptx' | 'xlsx';
export interface NativeOfficeBinding {
  /** A document has exactly one writable native model; views may reuse its frame. */
  sessionId: string;
  documentId: string;
  viewId: string;
  format: NativeOfficeFormat;
  revision: number;
}
export interface NativeOfficeLayout { ownerHwnd: string; ownerViewport: { width: number; height: number }; bounds: Rect; visible: boolean }
export interface NativeOfficeOpen extends NativeOfficeBinding, NativeOfficeLayout { bytes: Uint8Array }
export interface NativeOfficeSelection {
  kind: 'none' | 'text' | 'cells' | 'objects';
  text: string;
  pageIndex?: number;
  sheetIndex?: number;
  sheetName?: string;
  range?: string;
  slideIndex?: number;
  objectNames?: string[];
  rect?: Rect;
  locator?: Locator;
}
export interface NativeOfficeState extends NativeOfficeBinding {
  engineEpoch: string;
  engineRevision: number;
  selectionEpoch: number;
  dirty: boolean;
  /** Sticky real native content dirtiness; cleared only by a validated application save. */
  unsavedContentChanges: boolean;
  status: 'ready';
  nativeGeometry: boolean;
  supportedOperations: string[];
  selectionActions?: string[];
  warnings?: string[];
  zoom?: number;
  nativeHwnd: string;
  nativePid: number;
  visible: boolean;
  focused: boolean;
  /** This is a real pending native input buffer, not a renderer draft. */
  pendingInput: boolean;
  actor?: 'human' | 'agent' | 'engine';
  viewport: { width: number; height: number; deviceScaleFactor: number; bounds: Rect; screenBounds: Rect; visibleRange?: string; layoutRevision: number; scrollX?: number; scrollY?: number };
  selection: NativeOfficeSelection;
  /** Read from the actual native accessibility tree; never filled from the full file. */
  visibleText: string;
  visibleTextReady: boolean;
  visibleTextSource: 'actual-a11y' | 'actual-model-projection' | 'unavailable';
  visibleTextTruncated: boolean;
  undo: { canUndo: boolean; canRedo: boolean; title?: string; count: number; token?: string };
  /** sidebar means expanded deck content, not a retained collapsed tab strip. */
  nativeUi: { menus: boolean; toolbars: boolean; statusbar: boolean; sidebar?: boolean; deckId?: string };
}
export interface NativeOfficeSnapshot {
  bytes: Uint8Array;
  format: NativeOfficeFormat;
  sha256: string;
  state: NativeOfficeState;
  engineRevisionBefore: number;
  engineRevisionAfter: number;
  stable: true;
  dirty: boolean;
  undoToken?: string;
}
export interface NativeOfficeCapture {
  mimeType: 'image/png'; data: string;
  width: number; height: number; deviceScaleFactor: number;
  /** Actual captured region, in surface CSS/DIP pixels. */
  rect: Rect;
  engineEpoch: string; engineRevision: number; sessionId: string; capturedAt: string; layoutRevision: number;
}
export type UnoValue = string | number | boolean;
export interface NativeOfficeDispatch {
  command: string;
  args?: Record<string, UnoValue>;
  expectedEngineRevision: number;
  expectedSelectionEpoch?: number;
}
export interface NativeOfficeCommandStatus { command: string; available: boolean; enabled: boolean; state?: UnoValue; reason?: string }
export interface NativeOfficeRuntimeOptions {
  appRoot: string;
  dataDir: string;
  sofficePath?: string;
  pythonPath?: string;
  requestTimeoutMs?: number;
  appearance?: NativeOfficeAppearance;
  /** Tiled engine owns the LibreOffice core DLL and exposes no Office window. */
  backend?: 'window' | 'kit';
  adapterPath?: string;
}
export interface NativeOfficeEvent { type: 'changed' | 'selection' | 'closed' | 'diagnostic'; sessionId?: string; engineRevision?: number; code?: string }

export class NativeOfficeError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = 'NativeOfficeError'; }
}
