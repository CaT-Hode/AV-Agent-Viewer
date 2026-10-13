import type { Actor, EditOperation, Format, Rect, Locator, BrowserAction } from './index';
import { z } from 'zod';

const styleColor = z.string().regex(/^[0-9A-Fa-f]{6}$/);
const textStyleValues = { fontFamily: z.string().trim().min(1).max(100).optional(), fontSize: z.number().finite().min(1).max(400).optional(), bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(), strike: z.boolean().optional(), color: styleColor.optional(), highlight: styleColor.optional() };
const alignment = z.enum(['left', 'center', 'right', 'justify']);
const nonEmpty = (value: Record<string, unknown>) => Object.values(value).some(field => field !== undefined);
/** Public values stay primitive; only the trusted worker creates UNO enums/structs. */
export const nativeOfficeStylePatchSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('text'), values: z.object(textStyleValues).strict().refine(nonEmpty, '样式修改不能为空。') }).strict(),
  z.object({ target: z.literal('paragraph'), values: z.object({ alignment: alignment.optional(), left: z.number().finite().min(0).max(1000).optional(), right: z.number().finite().min(0).max(1000).optional(), firstLine: z.number().finite().min(-1000).max(1000).optional(), top: z.number().finite().min(0).max(1000).optional(), bottom: z.number().finite().min(0).max(1000).optional(), lineSpacingPercent: z.number().finite().min(50).max(500).optional() }).strict().refine(nonEmpty, '样式修改不能为空。') }).strict(),
  z.object({ target: z.literal('cells'), values: z.object({ ...textStyleValues, alignment: alignment.optional(), verticalAlignment: z.enum(['top', 'center', 'bottom']).optional(), wrap: z.boolean().optional(), fill: styleColor.optional(), numberFormat: z.string().min(1).max(120).optional() }).strict().refine(nonEmpty, '样式修改不能为空。') }).strict(),
  z.object({ target: z.literal('shape'), values: z.object({ x: z.number().finite().min(-10000).max(10000).optional(), y: z.number().finite().min(-10000).max(10000).optional(), width: z.number().finite().positive().max(10000).optional(), height: z.number().finite().positive().max(10000).optional(), rotation: z.number().finite().min(-360).max(360).optional(), fill: styleColor.optional(), lineColor: styleColor.optional(), lineWidth: z.number().finite().min(0).max(30).optional() }).strict().refine(nonEmpty, '样式修改不能为空。') }).strict(),
]);
/** Font size/line width use points; paragraph/shape lengths use mm; rotation uses degrees. */
export type NativeOfficeStylePatch = z.infer<typeof nativeOfficeStylePatchSchema>;
export type NativeOfficeStyleTarget = NativeOfficeStylePatch['target'];
export type NativeOfficeStyleValues<T extends NativeOfficeStyleTarget = NativeOfficeStyleTarget> = Extract<NativeOfficeStylePatch, { target: T }>['values'];
export interface NativeOfficeStyleField { value: string | number | boolean | null; state: 'direct' | 'default' | 'mixed' | 'unsupported'; available: boolean; reason?: string }
export interface NativeOfficeStyleInspection { targetKind: NativeOfficeStyleTarget; fields: Record<string, NativeOfficeStyleField> }

export type NativeOfficeFormat = Extract<Format, 'docx' | 'pptx' | 'xlsx'>;
export type UNOProperty = { name: string; type?: 'string' | 'boolean' | 'short' | 'long' | 'hyper' | 'double'; value: string | number | boolean };
export type NativeOfficeQuery = { kind: 'document' | 'selection' | 'sheets' | 'slides' } | { kind: 'cell-range'; sheetName: string; range: string } | { kind: 'shapes'; slideIndex: number } | { kind: 'shape'; slideIndex: number; name: string } | { kind: 'properties'; target: 'document' | 'selection'; names?: string[] } | { kind: 'style'; target: NativeOfficeStyleTarget };
export type NativeOfficeNavigateTarget = { kind: 'page'; pageIndex: number } | { kind: 'paragraph'; paragraphIndex: number; select?: boolean } | { kind: 'sheet' | 'slide'; index: number } | { kind: 'cell'; sheetName: string; address: string } | { kind: 'shape'; slideIndex: number; name: string };
export type NativeOfficeExportFormat = NativeOfficeFormat | 'pdf' | 'odt' | 'ods' | 'odp';
export interface NativeOfficeState {
  sessionId: string; documentId: string; viewId?: string; format: NativeOfficeFormat;
  engineEpoch: string; engineRevision: number; selectionEpoch?: number; revision?: number;
  dirty: boolean; status?: 'opening' | 'ready' | 'failed'; actor?: Actor; pendingInput?: boolean; nativeGeometry?: boolean;
  /** Content has changed since the last validated application save. A native temporary save must not clear this history. */
  unsavedContentChanges?: boolean;
  nativeHwnd?: string; nativePid?: number; visible?: boolean; focused?: boolean; zoom?: number;
  viewport?: { width: number; height: number; deviceScaleFactor: number; bounds: Rect; screenBounds: Rect; visibleRange?: string; layoutRevision?: number };
  selection?: { kind: 'none' | 'text' | 'cells' | 'objects'; text: string; rect?: Rect; locator?: Locator; pageIndex?: number; sheetIndex?: number; sheetName?: string; range?: string; slideIndex?: number; objectNames?: string[] };
  visibleText?: string; visibleTextTruncated?: boolean; visibleTextReady?: boolean; visibleTextSource?: 'actual-a11y' | 'unavailable';
  undo?: { canUndo: boolean; canRedo: boolean; title?: string; count: number; token?: string };
  nativeUi?: { menus: boolean; toolbars: boolean; statusbar: boolean; sidebar?: boolean; deckId?: string };
  supportedOperations?: string[]; selectionActions?: string[]; warnings?: string[];
}
export interface NativeOfficeMetadata { sessionId: string; writerEpoch: string; engineEpoch: string; engineRevision: number; mirrorEngineRevision: number; status: 'opening' | 'ready' | 'failed' }
export interface NativeOfficeSnapshot {
  bytes: Uint8Array; format: NativeOfficeFormat; state: NativeOfficeState;
  engineRevisionBefore: number; engineRevisionAfter: number; stable: boolean; sha256?: string; undoToken?: string;
}
export interface NativeOfficeCommand { command: string; label?: string; group?: number | string; available?: boolean; enabled?: boolean; state?: unknown; reason?: string; requiresSelection?: boolean; opensDialog?: boolean; parameters?: { name: string; type?: string; required?: boolean }[] }
export interface NativeOfficeExecution {
  status: 'dispatched' | 'applied' | 'no-change'; state: NativeOfficeState; undoToken?: string; warnings?: string[];
}
export interface NativeOfficeExecuteRequest {
  sessionId: string; viewId: string; expectedEngineEpoch: string; expectedEngineRevision: number;
  expectedSelectionEpoch?: number; requestId: string; actor?: Actor; operation?: EditOperation; command?: string; args?: UNOProperty[];
  cell?: { sheetName: string; address: string; content: string };
  replacement?: { expectedText: string; text: string };
  style?: NativeOfficeStylePatch;
}
export interface NativeOfficeInputRequest { sessionId: string; viewId: string; expectedEngineEpoch: string; expectedEngineRevision: number; expectedSelectionEpoch?: number; expectedLayoutRevision?: number; action: BrowserAction; idempotencyKey: string; actor?: Actor }
export interface NativeOfficeCapture { mimeType: 'image/png'; data: string; width: number; height: number; deviceScaleFactor: number; rect: Rect; engineEpoch: string; engineRevision: number; sessionId: string; capturedAt: string; layoutRevision?: number }
/** Trusted main-process facade; HWND/layout never originate from public MCP. */
export interface NativeOfficeDriver {
  open(request: { documentId: string; viewId: string; format: NativeOfficeFormat; bytes: Uint8Array; revision: number; sourcePath?: string }): Promise<NativeOfficeState>;
  state(sessionId: string, viewId?: string): Promise<NativeOfficeState>;
  snapshot(sessionId: string): Promise<NativeOfficeSnapshot>;
  commands(sessionId: string, viewId: string): Promise<NativeOfficeCommand[]>;
  commandStatus?(sessionId: string, viewId: string, commands: string[]): Promise<NativeOfficeCommand[]>;
  query(sessionId: string, viewId: string, target: NativeOfficeQuery): Promise<unknown>;
  input?(request: NativeOfficeInputRequest): Promise<{ state: NativeOfficeState }>;
  captureNative?(sessionId: string, viewId: string, rect?: Rect): Promise<NativeOfficeCapture>;
  zoom?(sessionId: string, viewId: string, factor: number): Promise<NativeOfficeState>;
  execute(request: NativeOfficeExecuteRequest): Promise<NativeOfficeExecution>;
  undo(request: { sessionId: string; viewId: string; expectedEngineEpoch: string; expectedEngineRevision: number; undoToken: string; actor?: Actor }): Promise<NativeOfficeExecution>;
  navigate?(request: { sessionId: string; viewId: string; target: NativeOfficeNavigateTarget; expectedEngineEpoch: string; expectedEngineRevision: number; expectedSelectionEpoch?: number; requestId: string; actor?: Actor }): Promise<{ status: 'requested' | 'rendered'; state: NativeOfficeState }>;
  exportCopy?(sessionId: string, request: { format: NativeOfficeExportFormat; expectedEngineEpoch: string; expectedEngineRevision: number }): Promise<{ bytes: Uint8Array; format: NativeOfficeExportFormat; state: NativeOfficeState; engineRevisionBefore: number; engineRevisionAfter: number; stable: boolean; sha256?: string }>;
  ackSaved?(sessionId: string, saved: { engineEpoch: string; engineRevision: number; hash: string }): Promise<boolean>;
  close(sessionId: string): Promise<void>;
  detachView?(sessionId: string, viewId: string): Promise<void>;
}
