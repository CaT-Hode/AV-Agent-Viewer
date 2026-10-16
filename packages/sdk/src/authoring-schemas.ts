import { z } from 'zod';
import { browserActionSchema } from '../../contracts/src/index';
import { nativeOfficeStylePatchSchema } from '../../contracts/src/native-office';

const agentViewIdentity = { viewId: z.string().min(1).max(160), documentId: z.string().min(1).max(160).optional() };
export const agentAcquireSchema = z.object({ ...agentViewIdentity, controlId: z.string().min(1).max(160).optional(), agentId: z.string().trim().min(1).max(100).optional(), phase: z.enum(['reading', 'editing']).default('reading') }).strict();
export const agentReleaseSchema = z.object({ ...agentViewIdentity, controlId: z.string().min(1).max(160) }).strict();
export const agentStatusSchema = z.object(agentViewIdentity).strict();

const officeView = { viewId: z.string().min(1).max(160) };
const nativeVersion = { expectedEngineEpoch: z.string().min(1).max(160), expectedEngineRevision: z.number().int().nonnegative(), expectedSelectionEpoch: z.number().int().nonnegative().optional() };
const requestKey = { idempotencyKey: z.string().min(1).max(160) };
export const officeSessionSchema = z.object({ ...officeView, action: z.enum(['open','close']).default('open') }).strict();
export const officeStatusSchema = z.object(officeView).strict();
export const officeCommandsSchema = z.object({ ...officeView, query: z.string().max(200).optional(), group: z.union([z.string().max(100),z.number().int()]).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(200) }).strict();
export const officeCommandStatusSchema = z.object({ ...officeView, commands: z.array(z.string().regex(/^\.uno:[A-Za-z0-9_]+$/)).min(1).max(50) }).strict();
export const officeThumbnailSourceSchema = z.object({ documentId: z.string().min(1).max(160), sessionId: z.string().min(1).max(160), engineEpoch: z.string().min(1).max(160), engineRevision: z.number().int().nonnegative(), partGeometryGeneration: z.number().int().nonnegative(), appearanceKey: z.string().regex(/^[a-f0-9]{64}$/), geometryKey: z.string().regex(/^[a-f0-9]{64}$/), renderKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const officeQueryTargetSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('document')}).strict(),z.object({kind:z.literal('selection')}).strict(),z.object({kind:z.literal('sheets')}).strict(),z.object({kind:z.literal('slides'),includeThumbnails:z.boolean().optional()}).strict(),
  z.object({kind:z.literal('slide-thumbnails'),indices:z.array(z.number().int().nonnegative().max(9999)).min(1).max(3).refine(indices=>new Set(indices).size===indices.length,'幻灯片索引不能重复。'),source:officeThumbnailSourceSchema}).strict(),
  z.object({kind:z.literal('cell-range'),sheetName:z.string().min(1).max(100),range:z.string().regex(/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/)}).strict(),
  z.object({kind:z.literal('shapes'),slideIndex:z.number().int().nonnegative()}).strict(),
  z.object({kind:z.literal('shape'),slideIndex:z.number().int().nonnegative(),name:z.string().min(1).max(200)}).strict(),
  z.object({kind:z.literal('properties'),target:z.enum(['document','selection']),names:z.array(z.string().min(1).max(100)).max(100).optional()}).strict(),
  z.object({kind:z.literal('style'),target:z.enum(['text','paragraph','cells','shape'])}).strict(),
]);
export const officeQuerySchema = z.object({ ...officeView, target: officeQueryTargetSchema }).strict();
export const officeExecuteSchema = z.object({ ...officeView, ...nativeVersion, ...requestKey, completion:z.enum(['applied','durable']).optional(), command:z.string().regex(/^\.uno:[A-Za-z0-9_]+$/).optional(), cell:z.object({sheetName:z.string().min(1).max(100),address:z.string().regex(/^[A-Z]+[1-9]\d*$/),content:z.string().max(100000)}).strict().optional(), replacement:z.object({expectedText:z.string().min(1).max(48000),text:z.string().max(100000)}).strict().optional(), style:nativeOfficeStylePatchSchema.optional(), controlId:z.string().min(1).max(160).optional(),args:z.array(z.object({name:z.string().min(1).max(120),type:z.enum(['string','boolean','short','long','hyper','double']).optional(),value:z.union([z.string().max(100000),z.number().finite(),z.boolean()])}).strict()).max(100).default([]) }).strict();
export const officeCellSetSchema = z.object({ ...officeView,...nativeVersion,...requestKey,controlId:z.string().min(1).max(160).optional(),sheetName:z.string().min(1).max(100),address:z.string().regex(/^[A-Z]+[1-9]\d*$/),content:z.string().max(100000) }).strict();
export const officeInputSchema = z.object({ ...officeView,...nativeVersion,...requestKey,controlId:z.string().min(1).max(160).optional(),expectedLayoutRevision:z.number().int().nonnegative().optional(),action:browserActionSchema }).strict();
export const officeCaptureSchema = z.object({ ...officeView,expectedEngineEpoch:nativeVersion.expectedEngineEpoch.optional(),expectedEngineRevision:nativeVersion.expectedEngineRevision.optional(),expectedLayoutRevision:z.number().int().nonnegative().optional(),rect:z.object({x:z.number().finite().nonnegative(),y:z.number().finite().nonnegative(),width:z.number().finite().positive(),height:z.number().finite().positive()}).strict().optional() }).strict();
export const officeNavigateTargetSchema = z.discriminatedUnion('kind',[z.object({kind:z.literal('page'),pageIndex:z.number().int().nonnegative()}).strict(),z.object({kind:z.literal('paragraph'),paragraphIndex:z.number().int().nonnegative(),select:z.boolean().default(false)}).strict(),z.object({kind:z.literal('sheet'),index:z.number().int().nonnegative()}).strict(),z.object({kind:z.literal('slide'),index:z.number().int().nonnegative()}).strict(),z.object({kind:z.literal('cell'),sheetName:z.string().min(1).max(100),address:z.string().regex(/^[A-Z]+[1-9]\d*$/)}).strict(),z.object({kind:z.literal('shape'),slideIndex:z.number().int().nonnegative(),name:z.string().min(1).max(200).refine(value=>value.trim().length>0,'对象名不能为空。')}).strict()]);
export const officeNavigateSchema = z.object({ ...officeView,...nativeVersion,...requestKey,target:officeNavigateTargetSchema }).strict();
export const officeUndoSchema = z.object({ ...officeView,...nativeVersion,...requestKey,undoToken:z.string().min(1).max(500) }).strict();
export const officeExportSchema = z.object({ ...officeView,...nativeVersion,...requestKey,path:z.string().min(1).max(4000),format:z.enum(['pdf','odt','ods','odp','docx','pptx','xlsx']) }).strict();

/** Discovery must not load document engines into the stand-alone MCP process. */
export const documentCreateSchema = z.object({
  format: z.enum(['markdown', 'html', 'docx', 'pptx', 'xlsx', 'pdf']),
  title: z.string().trim().min(1).max(160).regex(/^[^\\/:*?"<>|\x00-\x1f]+$/).refine(value => !value.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value), '请输入有效的文档文件名。').optional(),
  text: z.string().max(1_000_000).optional(), activate: z.boolean().default(true),
  windowId: z.string().min(1).max(100).default('main'), idempotencyKey: z.string().min(1).max(160),
}).strict();

export const readerNavigationSchema = z.object({
  viewId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('slide'), slideId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('cell'), sheetId: z.string().min(1), address: z.string().regex(/^[A-Z]+[1-9]\d*$/) }).strict(),
    z.object({ kind: z.literal('paragraph'), blockId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('html-heading'), blockId: z.string().min(1) }).strict(),
  ]), idempotencyKey: z.string().min(1).max(160),
}).strict();
