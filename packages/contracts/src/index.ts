import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0';
/** Reading-area edge, in CSS pixels/DIP; shared by DOM and native web views. */
export const NAVIGATION_EDGE_REVEAL_PX = 6;
export type Format = 'markdown' | 'html' | 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'web';
export type Actor = 'human' | 'agent' | 'engine';
export type Rect = { x: number; y: number; width: number; height: number };
export type Locator = { kind: string; blockId?: string; pageIndex?: number; sheetId?: string; cell?: string; slideId?: string; shapeId?: string; from?: number; to?: number; navigationId?: string; scrollTop?: number; quote?: string };
export interface Capabilities {
  engine: string; protocolVersion: string; readText: boolean; readSelection: boolean; readViewport: boolean;
  editKinds: string[]; saveFormats: string[]; limitations: string[]; browserInput?: boolean;
}
export interface OfficeTextStyle { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; fontName?: string; fontSize?: number; color?: string; highlight?: string }
export interface TextBlock extends OfficeTextStyle { id: string; text: string; runs?: (OfficeTextStyle & { text: string })[]; style?: string; alignment?: string; spacingBefore?: number; spacingAfter?: number; lineSpacing?: number; indentLeft?: number; indentRight?: number; indentFirstLine?: number; tableId?: string; tableRow?: number; tableColumn?: number; kind?: 'text' | 'shape'; fill?: string; lineColor?: string; lineWidth?: number; rotation?: number; x?: number; y?: number; width?: number; height?: number }
export interface SheetCell extends OfficeTextStyle { address: string; value: string; valueType?: string; formula?: string; horizontal?: string; vertical?: string; wrap?: boolean; numberFormat?: string; fill?: string; border?: { top?: string; bottom?: string; left?: string; right?: string } }
export interface Sheet { id: string; name: string; rows: SheetCell[][]; rowCount?: number; columnCount?: number; rowHeights?: number[]; columnWidths?: number[]; mergedRanges?: string[]; freeze?: { rows: number; columns: number }; autoFilter?: string; state?: string }
export interface Slide { id: string; blocks: TextBlock[]; background?: string; notes?: string }
export interface WordPageLayout { width: number; height: number; orientation: 'portrait' | 'landscape'; margins: { top: number; right: number; bottom: number; left: number } }
export interface DocumentModel {
  format: Format; text?: string; blocks?: TextBlock[]; sheets?: Sheet[]; slides?: Slide[];
  pageCount?: number; url?: string; width?: number; height?: number; pageLayout?: WordPageLayout; pageLayouts?: WordPageLayout[]; pageBackground?: string; unsupportedFeatures?: string[];
}
export interface DocumentInfo {
  id: string; title: string; path?: string; format: Format; revision: number; diskRevision: number; dirty: boolean;
  capabilities: Capabilities; model: DocumentModel; warnings: string[]; nativeOffice?: import('./native-office').NativeOfficeMetadata;
}
export interface ReadingContext {
  viewId: string; documentId: string; contentRevision: number; viewRevision: number; capturedAt: string;
  quality: 'confirmed' | 'last-confirmed' | 'not-ready'; actor: Actor;
  locator: Locator; visibleText: string; selection: { kind: 'none' | 'text' | 'cells' | 'objects' | 'region'; text: string; locator?: Locator; rect?: Rect; pageRects?: (Rect & { pageIndex: number })[] };
  viewport?: { width: number; height: number; scrollX: number; scrollY: number; deviceScaleFactor: number; navigationId?: string; layoutRevision?: number };
  nativeOffice?: { sessionId: string; engineEpoch: string; engineRevision: number; selectionEpoch?: number; selectionActions?: string[]; sheetName?: string; range?: string; visibleTextReady?: boolean; visibleTextTruncated?: boolean; visibleTextSource?: 'actual-a11y' | 'actual-model-projection' | 'unavailable' };
}
/** Ephemeral collaboration metadata, never a lock on human input. */
export interface AgentViewState {
  controlId: string; viewId: string; documentId: string; agentId?: string;
  phase: 'reading' | 'editing'; acquiredAt: string; updatedAt: string;
  lastEdit?: { transactionId: string; revision: number; kind: string };
}
export interface AgentViewStatus { viewId: string; documentId: string; state: AgentViewState | null; userControl?: 'running' | 'paused' | 'stopped' }
export interface ViewInfo { id: string; documentId: string; windowId: string; mode: 'read' | 'source' | 'split'; pinned: boolean; context?: ReadingContext; zoom?: number; agentState?: AgentViewState }
export interface ReadingSnapshot { id: string; schemaVersion: string; context: ReadingContext; document: DocumentInfo; createdAt: string }
export interface TextSelectionLease { kind: 'text-selection'; revision: number; selection: Pick<ReadingContext['selection'], 'kind' | 'text' | 'locator'> }
export type SelectionContextLease = import('./native-office').NativeOfficeSelectionLease | TextSelectionLease;
/** A selected range receipt; it deliberately contains no document model
 * or file bytes. Complete snapshots are frozen separately when needed. */
export interface SelectionContext { kind: 'selection-context'; id: string; context: ReadingContext; document: Omit<DocumentInfo, 'model'>; createdAt: string }
export interface WorkspaceState { protocolVersion: string; documents: DocumentInfo[]; views: ViewInfo[]; activeViewId?: string; eventsSeq: number; tasks: HarnessTask[]; agentStates?: AgentViewState[] }
export interface HarnessTask { id: string; snapshotId: string; viewId?: string; sourceScope?: 'selection' | 'visible'; prompt: string; text: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; error?: string }

const color = z.string().regex(/^[0-9A-Fa-f]{6}$/);
const richTextStyle = { bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(), strike: z.boolean().optional(), fontName: z.string().trim().min(1).max(100).optional(), fontSize: z.number().min(1).max(400).optional(), color: color.optional(), highlight: color.optional() };
const cellFormat = { ...richTextStyle, horizontal: z.enum(['left','center','right']).optional(), vertical: z.enum(['top','middle','bottom']).optional(), wrap: z.boolean().optional(), numberFormat: z.string().max(120).optional(), fill: color.optional(), borders: z.enum(['none','all','outline','bottom']).optional(), borderColor: color.optional(), borderStyle: z.enum(['thin','medium','dashed']).optional() };
const range = z.string().regex(/^[A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*$/);
const sheetPosition = { sheetId: z.string(), index: z.number().int().positive(), count: z.number().int().min(1).max(100).default(1) };
export const editOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('office.formatText'), blockId: z.string(), slideId: z.string().optional(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), expectedText: z.string(), style: z.enum(['bold', 'italic', 'underline','strike']), enabled: z.boolean().default(true) }),
  z.object({ kind: z.literal('office.setTextStyle'), blockId: z.string(), slideId: z.string().optional(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), expectedText: z.string(), ...richTextStyle }),
  z.object({ kind: z.literal('pdf.markup'), style: z.enum(['highlight', 'underline', 'strike']), rects: z.array(z.object({ pageIndex: z.number().int().nonnegative(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) })).min(1).max(500) }),
  z.object({ kind: z.literal('text.replace'), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), expectedText: z.string(), text: z.string() }),
  z.object({ kind: z.literal('word.setBlock'), blockId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('word.setParagraphFormat'), blockId: z.string(), style: z.enum(['Normal', 'Heading1', 'Heading2', 'Heading3']).optional(), alignment: z.enum(['left', 'center', 'right', 'both']).optional(), spacingBefore: z.number().min(0).max(720).optional(), spacingAfter: z.number().min(0).max(720).optional(), lineSpacing: z.number().min(.5).max(5).optional(), indentLeft: z.number().min(0).max(720).optional(), indentRight: z.number().min(0).max(720).optional(), indentFirstLine: z.number().min(-720).max(720).optional() }),
  z.object({ kind: z.literal('word.insertParagraph'), afterBlockId: z.string(), text: z.string(), style: z.enum(['Normal', 'Heading1', 'Heading2', 'Heading3']).default('Normal') }),
  z.object({ kind: z.literal('word.deleteParagraph'), blockId: z.string() }),
  z.object({ kind: z.literal('word.insertTable'), afterBlockId: z.string(), rows: z.array(z.array(z.string().max(10000)).min(1).max(20)).min(1).max(100) }),
  z.object({ kind: z.literal('word.setPageLayout'), sectionIndex: z.number().int().nonnegative().default(0), orientation: z.enum(['portrait','landscape']).optional(), margins: z.object({ top: z.number().min(0).max(720).optional(), right: z.number().min(0).max(720).optional(), bottom: z.number().min(0).max(720).optional(), left: z.number().min(0).max(720).optional() }).optional() }),
  z.object({ kind: z.literal('slides.setText'), slideId: z.string(), shapeId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('slides.setShapeBounds'), slideId: z.string(), shapeId: z.string(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }),
  z.object({ kind: z.literal('slides.addSlide'), afterSlideId: z.string().optional(), title: z.string().max(10000).optional() }),
  z.object({ kind: z.literal('slides.deleteSlide'), slideId: z.string() }),
  z.object({ kind: z.literal('slides.duplicateSlide'), slideId: z.string() }),
  z.object({ kind: z.literal('slides.moveSlide'), slideId: z.string(), index: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('slides.addTextShape'), slideId: z.string(), text: z.string().max(100000), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }),
  z.object({ kind: z.literal('slides.deleteShape'), slideId: z.string(), shapeId: z.string() }),
  z.object({ kind: z.literal('slides.setShapeStyle'), slideId: z.string(), shapeId: z.string(), ...richTextStyle, alignment: z.enum(['left','center','right']).optional(), fill: color.optional(), lineColor: color.optional(), lineWidth: z.number().min(0).max(30).optional(), rotation: z.number().min(-360).max(360).optional() }),
  z.object({ kind: z.literal('slides.setBackground'), slideId: z.string(), color }),
  z.object({ kind: z.literal('slides.setNotes'), slideId: z.string(), text: z.string().max(100000) }),
  z.object({ kind: z.literal('sheets.setCell'), sheetId: z.string(), address: z.string().regex(/^[A-Z]+[1-9]\d*$/), value: z.string(), formula: z.string().optional(), valueType: z.enum(['text', 'number', 'boolean']).optional() }),
  z.object({ kind: z.literal('sheets.setRangeValues'), sheetId: z.string(), start: z.string().regex(/^[A-Z]+[1-9]\d*$/), rows: z.array(z.array(z.string().max(10000)).min(1).max(50)).min(1).max(1000) }),
  z.object({ kind: z.literal('sheets.setCellFormat'), sheetId: z.string(), address: z.string().regex(/^[A-Z]+[1-9]\d*$/), ...cellFormat }),
  z.object({ kind: z.literal('sheets.setRangeFormat'), sheetId: z.string(), range, ...cellFormat }),
  z.object({ kind: z.literal('sheets.mergeCells'), sheetId: z.string(), range }),
  z.object({ kind: z.literal('sheets.unmergeCells'), sheetId: z.string(), range }),
  z.object({ kind: z.literal('sheets.insertRows'), ...sheetPosition }),
  z.object({ kind: z.literal('sheets.deleteRows'), ...sheetPosition }),
  z.object({ kind: z.literal('sheets.insertColumns'), ...sheetPosition }),
  z.object({ kind: z.literal('sheets.deleteColumns'), ...sheetPosition }),
  z.object({ kind: z.literal('sheets.setColumnWidth'), sheetId: z.string(), index: z.number().int().min(1).max(16384), width: z.number().min(1).max(255) }),
  z.object({ kind: z.literal('sheets.setRowHeight'), sheetId: z.string(), index: z.number().int().min(1).max(1048576), height: z.number().min(1).max(409) }),
  z.object({ kind: z.literal('sheets.deleteWorksheet'), sheetId: z.string() }),
  z.object({ kind: z.literal('sheets.setFreeze'), sheetId: z.string(), rows: z.number().int().min(0).max(1000), columns: z.number().int().min(0).max(50) }),
  z.object({ kind: z.literal('sheets.setAutoFilter'), sheetId: z.string(), range: range.optional(), enabled: z.boolean() }),
  z.object({ kind: z.literal('sheets.sortRange'), sheetId: z.string(), range, column: z.number().int().min(1).max(16384), direction: z.enum(['asc','desc']), header: z.boolean() }),
  z.object({ kind: z.literal('sheets.addWorksheet'), name: z.string().trim().min(1).max(31).regex(/^[^*?:\[\]\\/]+$/) }),
  z.object({ kind: z.literal('sheets.renameWorksheet'), sheetId: z.string(), name: z.string().trim().min(1).max(31).regex(/^[^*?:\[\]\\/]+$/) }),
  z.object({ kind: z.literal('pdf.addText'), pageIndex: z.number().int().nonnegative(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), text: z.string().min(1), size: z.number().min(6).max(144).default(16) }),
  z.object({ kind: z.literal('pdf.highlight'), pageIndex: z.number().int().nonnegative(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.001).max(1), height: z.number().min(0.001).max(1) }),
  z.object({ kind: z.literal('pdf.rotate'), pageIndex: z.number().int().nonnegative(), degrees: z.number().int().refine(v => v % 90 === 0) }),
  z.object({ kind: z.literal('pdf.addPage') }),
]);
export type EditOperation = z.infer<typeof editOperationSchema>;
export interface PreparedPatch { id: string; documentId: string; viewId?: string; agentControlId?: string; agentStateEpoch?: number; nativeSessionId?: string; nativeWriterEpoch?: string; nativeEngineEpoch?: string; nativeEngineRevision?: number; expectedRevision: number; operation: EditOperation; preview: { before: string; after: string; warnings: string[] }; createdAt: string }
export interface Receipt { transactionId: string; documentId: string; revision: number; status: 'applied' | 'saved' | 'undone' | 'dispatched' | 'no-change'; idempotencyKey?: string; path?: string; warnings?: string[]; nativeSessionId?: string; controlReleased?: boolean }

const modifiers = z.array(z.enum(['shift', 'control', 'alt', 'meta'])).max(4).default([]);
const point = { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() };
export const browserActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), ...point, button: z.enum(['left', 'right', 'middle']).default('left'), clickCount: z.number().int().min(1).max(3).default(1), modifiers }),
  z.object({ kind: z.literal('move'), ...point, modifiers }),
  z.object({ kind: z.literal('drag'), from: z.object(point), to: z.object(point), steps: z.number().int().min(2).max(60).default(12), modifiers }),
  z.object({ kind: z.literal('scroll'), ...point, deltaX: z.number().int().default(0), deltaY: z.number().int(), modifiers }),
  z.object({ kind: z.literal('press'), key: z.string().min(1).max(40), modifiers }),
  z.object({ kind: z.literal('type'), text: z.string().max(100_000) }),
]);
export const browserRequestSchema = z.object({
  schemaVersion: z.literal('1.0').default('1.0'),
  viewId: z.string(),
  expectedNavigationId: z.string(),
  expectedLayoutRevision: z.number().int().nonnegative().optional(),
  expectedViewport: z.object({ width: z.number().positive(), height: z.number().positive(), scrollX: z.number().finite(), scrollY: z.number().finite() }).optional(),
  action: browserActionSchema,
  idempotencyKey: z.string().min(1),
});
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type BrowserRequest = z.infer<typeof browserRequestSchema>;

export interface FormatAdapter {
  id: string; formats: Format[];
  open(bytes: Uint8Array, format: Format): Promise<DocumentModel>;
  capabilities(format: Format): Capabilities;
  preview(model: DocumentModel, operation: EditOperation): PreparedPatch['preview'];
  apply(bytes: Uint8Array, model: DocumentModel, operation: EditOperation): Promise<{ bytes: Uint8Array; model: DocumentModel; warnings: string[] }>;
}
export interface BrowserRuntime {
  setZoom?(viewId: string, factor: number): void;
  open(viewId: string, url: string, options?: { background?: boolean }): Promise<void>;
  layout(windowId: string, views: { viewId: string; bounds: Rect }[]): void;
  context(viewId: string, actor?: Actor): Promise<ReadingContext>;
  input(request: BrowserRequest): Promise<{ navigationId: string; context: ReadingContext }>;
  navigate(viewId: string, action: 'back' | 'forward' | 'reload' | 'url', url?: string): Promise<void>;
  capture(viewId: string): Promise<{ mimeType: string; data: string; width: number; height: number; navigationId: string; viewport?: ReadingContext['viewport'] }>;
  html(viewId: string): Promise<string>;
  close(viewId: string): void;
}
export interface HarnessDriver {
  id: string; capabilities: { streaming: boolean; cancellation: boolean; attachExistingSession: boolean };
  submit(prompt: string, snapshot: ReadingSnapshot, emit: (text: string) => void, signal: AbortSignal): Promise<void>;
}

export class ViewerError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

export { normalizeWebAddress, documentSuffixes } from './web-address';
export type { WebAddressInference } from './web-address';
export type { NativeInputState, NativeOfficeInspection, NativeOfficeSelectionLease, NativeOfficeFormat, UNOProperty, NativeOfficeQuery, NativeOfficeThumbnailSource, NativeOfficeNavigateTarget, NativeOfficeExportFormat, NativeOfficeState, NativeOfficeMetadata, NativeOfficeSnapshot, NativeOfficeSnapshotReuse, NativeOfficeCommand, NativeOfficeExecution, NativeOfficeExecuteRequest, NativeOfficeInputRequest, NativeOfficeCapture, NativeOfficeDriver, NativeOfficeStylePatch, NativeOfficeStyleTarget, NativeOfficeStyleValues, NativeOfficeStyleField, NativeOfficeStyleInspection } from './native-office';
export { nativeOfficeInteractionBlocked, nativeOfficeStylePatchSchema } from './native-office';
export { nativeOfficeCommandPolicy } from './native-office-policy';
