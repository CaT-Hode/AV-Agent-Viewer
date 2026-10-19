import { z } from 'zod';
import type { NativeOfficeState } from '../../contracts/src/native-office';
import type { Actor } from '../../contracts/src/index';
import { nativeOfficeStylePatchSchema } from '../../contracts/src/native-office';

const index = z.number().int().min(0).max(1_000_000);
const name = z.string().min(1).max(256);
const range = z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$/);
const objectPath = z.array(index).min(1).max(16);
const wordRange = { paragraphIndex: index, from: index, to: index, expectedText: z.string().max(100_000) };
const shape = { slideIndex: index, objectPath };
const textStyle = nativeOfficeStylePatchSchema.options[0].shape.values;
const shapeStyle = nativeOfficeStylePatchSchema.options[3].shape.values;
const cellStyle = nativeOfficeStylePatchSchema.options[2].shape.values;
const paragraphStyle = nativeOfficeStylePatchSchema.options[1].shape.values;

/** These targets bind to the engine revision, never to the human selection. */
export const officeAuthoringQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('capabilities') }).strict(),
  z.object({ kind: z.literal('selection-target') }).strict(),
  z.object({ kind: z.literal('search'), query: z.string().min(1).max(1000), start: index.default(0), offset: index.default(0), limit: z.number().int().min(1).max(100).default(30) }).strict(),
  z.object({ kind: z.literal('word.paragraphs'), start: index.default(0), limit: z.number().int().min(1).max(100).default(30) }).strict(),
  z.object({ kind: z.literal('word.range'), paragraphIndex: index, from: index, to: index }).strict(),
  z.object({ kind: z.literal('word.nativeRange'), anchor: name }).strict(),
  z.object({ kind: z.literal('word.pageStyles') }).strict(),
  z.object({ kind: z.literal('word.comments') }).strict(),
  z.object({ kind: z.literal('word.revisions') }).strict(),
  z.object({ kind: z.literal('word.tables') }).strict(),
  z.object({ kind: z.literal('word.table'), tableName: name, start: index.default(0), limit: z.number().int().min(1).max(100).default(30), cellName: z.string().regex(/^[A-Z]+[1-9][0-9]*$/).optional() }).strict(),
  z.object({ kind: z.literal('sheets.validation'), sheetName: name, range }).strict(),
  z.object({ kind: z.literal('sheets.range'), sheetName: name, range }).strict(),
  z.object({ kind: z.literal('sheets.charts'), sheetName: name }).strict(),
  z.object({ kind: z.literal('sheets.pivots'), sheetName: name }).strict(),
  z.object({ kind: z.literal('slides.objects'), slideIndex: index }).strict(),
  z.object({ kind: z.literal('slides.objectText'), ...shape }).strict(),
  z.object({ kind: z.literal('slides.pages') }).strict(),
  z.object({ kind: z.literal('slides.notes'), slideIndex: index }).strict(),
  z.object({ kind: z.literal('slides.masters') }).strict(),
  z.object({ kind: z.literal('slides.animations'), slideIndex: index }).strict(),
]);
export type OfficeAuthoringQuery = z.input<typeof officeAuthoringQuerySchema>;

export const officeAuthoringOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('word.replaceText'), ...wordRange, text: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('word.formatText'), ...wordRange, values: textStyle }).strict(),
  z.object({ kind: z.literal('word.replaceRangeText'), anchor: name, expectedText: z.string().max(100_000), text: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('word.formatRangeText'), anchor: name, expectedText: z.string().max(100_000), values: textStyle }).strict(),
  z.object({ kind: z.literal('word.formatParagraph'), paragraphIndex: index, values: paragraphStyle }).strict(),
  z.object({ kind: z.literal('word.insertTable'), paragraphIndex: index, rows: z.array(z.array(z.string().max(100_000)).min(1).max(100)).min(1).max(100) }).strict(),
  z.object({ kind: z.literal('word.setTableCell'), tableName: name, cellName: z.string().regex(/^[A-Z]+[1-9][0-9]*$/), expectedText: z.string().max(100_000), text: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('word.resolveRevision'), revisionIndex: index, action: z.enum(['accept', 'reject']) }).strict(),
  z.object({ kind: z.literal('word.pageLayout'), pageStyleName: name, landscape: z.boolean().optional(), left: z.number().min(0).max(500).optional(), right: z.number().min(0).max(500).optional(), top: z.number().min(0).max(500).optional(), bottom: z.number().min(0).max(500).optional() }).strict(),
  z.object({ kind: z.literal('word.setTracking'), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('word.addComment'), ...wordRange, text: z.string().min(1).max(20_000), author: z.string().max(256).default('AgentViewer') }).strict(),
  z.object({ kind: z.literal('word.deleteComment'), commentIndex: index, expectedText: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal('sheets.setRangeValues'), sheetName: name, range, rows: z.array(z.array(z.union([z.string().max(100_000), z.number().finite(), z.boolean(), z.null()])).min(1).max(1000)).min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('sheets.formatRange'), sheetName: name, range, values: cellStyle }).strict(),
  z.object({ kind: z.literal('sheets.grid'), sheetName: name, action: z.enum(['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns']), index, count: z.number().int().min(1).max(1000).default(1) }).strict(),
  z.object({ kind: z.literal('sheets.addSheet'), name, index: index.optional() }).strict(),
  z.object({ kind: z.literal('sheets.renameSheet'), sheetName: name, name }).strict(),
  z.object({ kind: z.literal('sheets.deleteSheet'), sheetName: name }).strict(),
  z.object({ kind: z.literal('sheets.merge'), sheetName: name, range, merge: z.boolean() }).strict(),
  z.object({ kind: z.literal('sheets.sort'), sheetName: name, range, column: index, descending: z.boolean().default(false), header: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal('sheets.filter'), sheetName: name, range, enabled: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal('sheets.setValidation'), sheetName: name, range, type: z.enum(['ANY', 'WHOLE', 'DECIMAL', 'DATE', 'TIME', 'TEXT_LEN', 'LIST', 'CUSTOM']), operator: z.enum(['BETWEEN', 'NOT_BETWEEN', 'EQUAL', 'NOT_EQUAL', 'GREATER', 'LESS', 'GREATER_EQUAL', 'LESS_EQUAL']).default('BETWEEN'), formula1: z.string().max(2000).default(''), formula2: z.string().max(2000).default(''), allowEmpty: z.boolean().default(true), showError: z.boolean().default(true), errorTitle: z.string().max(256).default(''), errorMessage: z.string().max(2000).default('') }).strict(),
  z.object({ kind: z.literal('sheets.addChart'), sheetName: name, name, range, type: z.enum(['column', 'bar', 'line', 'pie', 'scatter', 'area']).default('column'), x: z.number().min(0).max(10000), y: z.number().min(0).max(10000), width: z.number().positive().max(10000), height: z.number().positive().max(10000), columnHeaders: z.boolean().default(true), rowHeaders: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('sheets.deleteChart'), sheetName: name, name }).strict(),
  z.object({ kind: z.literal('sheets.addPivot'), sheetName: name, name, range, destination: range.refine(value => !value.includes(':')), rows: z.array(name).max(32), columns: z.array(name).max(32).default([]), data: z.array(z.object({ field: name, function: z.enum(['SUM', 'COUNT', 'AVERAGE', 'MIN', 'MAX']) }).strict()).min(1).max(32) }).strict(),
  z.object({ kind: z.literal('sheets.deletePivot'), sheetName: name, name }).strict(),
  z.object({ kind: z.literal('slides.formatObject'), ...shape, values: shapeStyle }).strict(),
  z.object({ kind: z.literal('slides.formatText'), ...shape, values: textStyle }).strict(),
  z.object({ kind: z.literal('slides.applyMaster'), slideIndex: index, masterIndex: index }).strict(),
  z.object({ kind: z.literal('slides.add'), index: index.optional(), title: z.string().max(20_000).default('') }).strict(),
  z.object({ kind: z.literal('slides.delete'), slideIndex: index }).strict(),
  z.object({ kind: z.literal('slides.duplicate'), slideIndex: index }).strict(),
  z.object({ kind: z.literal('slides.setNotes'), slideIndex: index, text: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('slides.setBackground'), slideIndex: index, color: z.string().regex(/^[0-9A-Fa-f]{6}$/) }).strict(),
  z.object({ kind: z.literal('slides.group'), slideIndex: index, objectPaths: z.array(z.array(index).length(1)).min(2).max(64) }).strict(),
  z.object({ kind: z.literal('slides.ungroup'), slideIndex: index, objectPath: z.array(index).length(1) }).strict(),
  z.object({ kind: z.literal('slides.setLegacyAnimation'), ...shape, effect: z.enum(['NONE', 'APPEAR', 'FADE_FROM_LEFT', 'FADE_FROM_RIGHT', 'FADE_FROM_TOP', 'FADE_FROM_BOTTOM']), speed: z.enum(['SLOW', 'MEDIUM', 'FAST']).default('MEDIUM') }).strict(),
  // Explicit rejection is part of the contract until isolated Outliner and
  // page-order transactions have passed native history/readback acceptance.
  z.object({ kind: z.literal('slides.replaceText'), ...shape, expectedText: z.string().max(100_000), text: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('slides.moveSlide'), slideIndex: index, index }).strict(),
]);
export type OfficeAuthoringOperation = z.input<typeof officeAuthoringOperationSchema>;
export const officeAuthoringFormats = ['docx', 'xlsx', 'pptx'] as const;
export type OfficeAuthoringFormat = typeof officeAuthoringFormats[number];
export interface OfficeAuthoringCapabilities {
  background: true; verifiedReadback: true; saveSeparate: true; atomic: false;
  operations: OfficeAuthoringOperation['kind'][];
  unsupported: { kind: string; code: 'BACKGROUND_EDIT_UNSUPPORTED' }[];
}
/** Schema kinds are the authoritative operation list used by both workers and
 * disclosure budgets. Only these operations depend on the Kit document bridge. */
export const officeAuthoringRequiresDocCall: readonly OfficeAuthoringOperation['kind'][] = ['word.resolveRevision', 'slides.replaceText', 'slides.moveSlide'];
export const officeAuthoringCapabilityManifest = Object.fromEntries(officeAuthoringFormats.map(format => {
  const prefix = { docx: 'word.', xlsx: 'sheets.', pptx: 'slides.' }[format];
  const operations = officeAuthoringOperationSchema.options.map(value => value.shape.kind.value).filter(kind => kind.startsWith(prefix));
  const unsupported = (format === 'docx' ? ['word.compare'] : format === 'pptx' ? ['slides.setAnimation'] : []).map(kind => ({ kind, code: 'BACKGROUND_EDIT_UNSUPPORTED' as const }));
  return [format, { background: true, verifiedReadback: true, saveSeparate: true, atomic: false, operations, unsupported }];
})) as Record<OfficeAuthoringFormat, OfficeAuthoringCapabilities>;
export function officeAuthoringCapabilities(format: OfficeAuthoringFormat, docCall = true): OfficeAuthoringCapabilities {
  const capabilities = structuredClone(officeAuthoringCapabilityManifest[format]);
  if (!docCall) capabilities.operations = capabilities.operations.filter(kind => !officeAuthoringRequiresDocCall.includes(kind));
  return capabilities;
}
export interface OfficeAuthoringExecuteRequest {
  sessionId: string; viewId: string; expectedEngineEpoch: string; expectedEngineRevision: number;
  requestId: string; actor?: Actor; operation: OfficeAuthoringOperation;
}
export interface OfficeAuthoringReadback {
  status: 'applied' | 'no-change'; state: NativeOfficeState; readback: unknown; verified: true; undoToken?: string; warnings?: string[];
}
