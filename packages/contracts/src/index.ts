import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0';
export type Format = 'markdown' | 'html' | 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'web';
export type Actor = 'human' | 'agent' | 'engine';
export type Rect = { x: number; y: number; width: number; height: number };
export type Locator = { kind: string; blockId?: string; pageIndex?: number; sheetId?: string; cell?: string; slideId?: string; shapeId?: string; from?: number; to?: number; navigationId?: string; scrollTop?: number; quote?: string };
export interface Capabilities {
  engine: string; protocolVersion: string; readText: boolean; readSelection: boolean; readViewport: boolean;
  editKinds: string[]; saveFormats: string[]; limitations: string[]; browserInput?: boolean;
}
export interface TextBlock { id: string; text: string; runs?: { text: string; bold?: boolean; italic?: boolean; underline?: boolean }[]; style?: string; alignment?: string; x?: number; y?: number; width?: number; height?: number }
export interface Sheet { id: string; name: string; rows: { address: string; value: string; formula?: string; bold?: boolean; italic?: boolean; horizontal?: string; numberFormat?: string; fill?: string }[][] }
export interface Slide { id: string; blocks: TextBlock[] }
export interface DocumentModel {
  format: Format; text?: string; blocks?: TextBlock[]; sheets?: Sheet[]; slides?: Slide[];
  pageCount?: number; url?: string; width?: number; height?: number;
}
export interface DocumentInfo {
  id: string; title: string; path?: string; format: Format; revision: number; diskRevision: number; dirty: boolean;
  capabilities: Capabilities; model: DocumentModel; warnings: string[];
}
export interface ReadingContext {
  viewId: string; documentId: string; contentRevision: number; viewRevision: number; capturedAt: string;
  quality: 'confirmed' | 'last-confirmed' | 'not-ready'; actor: Actor;
  locator: Locator; visibleText: string; selection: { kind: 'none' | 'text' | 'cells' | 'objects' | 'region'; text: string; locator?: Locator; rect?: Rect; pageRects?: (Rect & { pageIndex: number })[] };
  viewport?: { width: number; height: number; scrollX: number; scrollY: number; deviceScaleFactor: number; navigationId?: string; layoutRevision?: number };
}
export interface ViewInfo { id: string; documentId: string; windowId: string; mode: 'read' | 'source' | 'split'; pinned: boolean; context?: ReadingContext }
export interface ReadingSnapshot { id: string; schemaVersion: string; context: ReadingContext; document: DocumentInfo; createdAt: string }
export interface WorkspaceState { protocolVersion: string; documents: DocumentInfo[]; views: ViewInfo[]; activeViewId?: string; eventsSeq: number; tasks: HarnessTask[] }
export interface HarnessTask { id: string; snapshotId: string; prompt: string; text: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; error?: string }

export const editOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('office.formatText'), blockId: z.string(), slideId: z.string().optional(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), expectedText: z.string(), style: z.enum(['bold', 'italic', 'underline']), enabled: z.boolean().default(true) }),
  z.object({ kind: z.literal('pdf.markup'), style: z.enum(['highlight', 'underline', 'strike']), rects: z.array(z.object({ pageIndex: z.number().int().nonnegative(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) })).min(1).max(500) }),
  z.object({ kind: z.literal('text.replace'), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), expectedText: z.string(), text: z.string() }),
  z.object({ kind: z.literal('word.setBlock'), blockId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('word.setParagraphFormat'), blockId: z.string(), style: z.enum(['Normal', 'Heading1', 'Heading2', 'Heading3']).optional(), alignment: z.enum(['left', 'center', 'right', 'both']).optional() }),
  z.object({ kind: z.literal('word.insertParagraph'), afterBlockId: z.string(), text: z.string(), style: z.enum(['Normal', 'Heading1', 'Heading2', 'Heading3']).default('Normal') }),
  z.object({ kind: z.literal('slides.setText'), slideId: z.string(), shapeId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('slides.setShapeBounds'), slideId: z.string(), shapeId: z.string(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }),
  z.object({ kind: z.literal('sheets.setCell'), sheetId: z.string(), address: z.string().regex(/^[A-Z]+[1-9]\d*$/), value: z.string(), formula: z.string().optional(), valueType: z.enum(['text', 'number', 'boolean']).optional() }),
  z.object({ kind: z.literal('sheets.setCellFormat'), sheetId: z.string(), address: z.string().regex(/^[A-Z]+[1-9]\d*$/), bold: z.boolean().optional(), italic: z.boolean().optional(), horizontal: z.enum(['left', 'center', 'right']).optional(), numberFormat: z.string().max(120).optional(), fill: z.string().regex(/^[0-9A-Fa-f]{6}$/).optional() }),
  z.object({ kind: z.literal('sheets.addWorksheet'), name: z.string().trim().min(1).max(31).regex(/^[^*?:\[\]\\/]+$/) }),
  z.object({ kind: z.literal('sheets.renameWorksheet'), sheetId: z.string(), name: z.string().trim().min(1).max(31).regex(/^[^*?:\[\]\\/]+$/) }),
  z.object({ kind: z.literal('pdf.addText'), pageIndex: z.number().int().nonnegative(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), text: z.string().min(1), size: z.number().min(6).max(144).default(16) }),
  z.object({ kind: z.literal('pdf.highlight'), pageIndex: z.number().int().nonnegative(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.001).max(1), height: z.number().min(0.001).max(1) }),
  z.object({ kind: z.literal('pdf.rotate'), pageIndex: z.number().int().nonnegative(), degrees: z.number().int().refine(v => v % 90 === 0) }),
  z.object({ kind: z.literal('pdf.addPage') }),
]);
export type EditOperation = z.infer<typeof editOperationSchema>;
export interface PreparedPatch { id: string; documentId: string; expectedRevision: number; operation: EditOperation; preview: { before: string; after: string; warnings: string[] }; createdAt: string }
export interface Receipt { transactionId: string; documentId: string; revision: number; status: 'applied' | 'saved' | 'undone'; idempotencyKey?: string; path?: string; warnings?: string[] }

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
  open(viewId: string, url: string): Promise<void>;
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
