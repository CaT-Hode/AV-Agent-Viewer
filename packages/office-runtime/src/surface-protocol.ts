import { z } from 'zod';
import { OFFICE_SURFACE_METHODS } from '../../contracts/src/office-surface';
const identity = z.string().min(1).max(128);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().finite().positive();
const point = z.object({ x: z.number().finite().min(-1000000).max(100000000), y: z.number().finite().min(-1000000).max(100000000) }).strict();
const rect = point.extend({ width: z.number().finite().nonnegative().max(100000000), height: z.number().finite().nonnegative().max(100000000) }).strict();
const modifiers = z.object({ shift: z.boolean(), control: z.boolean(), alt: z.boolean(), meta: z.boolean() }).strict();
const phase = z.enum(['down','move','up','cancel']);
const pointer = z.object({ kind: z.literal('pointer'), phase, pointTwips: point, button: z.number().int().min(-1).max(4).optional(), buttons: z.number().int().min(0).max(31), clickCount: z.number().int().min(0).max(3), modifiers }).strict();
const binary = z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength <= 16 * 1024 * 1024);
const eventCommon = [
  z.object({ kind: z.literal('key'), phase: z.enum(['down','up']), key: z.string().max(100), code: z.string().max(100), repeat: z.boolean(), modifiers }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(1000000) }).strict(),
  z.object({ kind: z.literal('composition'), compositionId: identity, phase: z.enum(['start','update','end','cancel']), text: z.string().max(1000000) }).strict(),
  z.object({ kind: z.literal('paste'), items: z.array(z.object({ mimeType: z.string().min(1).max(200), data: binary }).strict()).min(1).max(8) }).strict(),
  z.object({ kind: z.literal('barrier') }).strict(),
] as const;
const event = z.discriminatedUnion('kind', [pointer, ...eventCommon, z.object({ kind: z.literal('selection-handle'), edge: z.enum(['start','end']), pointTwips: point }).strict()]);
const windowEvent = z.discriminatedUnion('kind', [pointer.omit({ pointTwips: true }).extend({ pointCss: point }).strict(), ...eventCommon]);
const view = z.object({ viewId: identity }).strict();
const windowIdentity = view.extend({ sessionId: identity, engineEpoch: identity, windowId: z.number().int().positive(), windowInstanceId: identity }).strict();
const schemas = {
  [OFFICE_SURFACE_METHODS.state]: view,
  [OFFICE_SURFACE_METHODS.layout]: view.extend({ layoutRevision: revision, partIndex: revision, visibleTwips: rect, documentOriginCss: point, viewportCss: z.object({ width: positive.max(20000), height: positive.max(20000) }).strict(), boundsCss: rect, zoom: z.number().finite().min(.25).max(4), deviceScaleFactor: positive.max(8), visible: z.boolean(), focused: z.boolean() }).strict(),
  [OFFICE_SURFACE_METHODS.tiles]: view.extend({ layoutRevision: revision, renderGeneration: revision, partIndex: revision, tiles: z.array(z.object({ key: identity, rectTwips: rect, pixelWidth: positive.int().max(4096), pixelHeight: positive.int().max(4096) }).strict()).min(1).max(12) }).strict().superRefine((value,ctx) => { if(value.tiles.reduce((n,t)=>n+t.pixelWidth*t.pixelHeight*4,0)>64*1024*1024)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Office tile batch exceeds the memory budget.'}); }),
  [OFFICE_SURFACE_METHODS.input]: view.extend({ streamId: identity, sequence: revision, layoutRevision: revision, expectedPartIndex: revision, event }).strict(),
  [OFFICE_SURFACE_METHODS.windowPaint]: windowIdentity.extend({ generation: revision, width: positive.int().max(8192), height: positive.int().max(8192), deviceScaleFactor: positive.max(8) }).strict().refine(value=>value.width*value.height*4<=64*1024*1024),
  [OFFICE_SURFACE_METHODS.windowInput]: windowIdentity.extend({ streamId: identity, sequence: revision, event: windowEvent }).strict(),
  [OFFICE_SURFACE_METHODS.windowClose]: windowIdentity,
  [OFFICE_SURFACE_METHODS.windowClipboard]: windowIdentity,
};
/** Private IPC accepts bounded data, never engine addresses or arbitrary paths. */
export function validateOfficeSurfaceRequest(method: string, value: unknown) {
  const schema = schemas[method as keyof typeof schemas];
  if (!schema) throw new Error('UNKNOWN_OFFICE_SURFACE_METHOD');
  return schema.parse(value);
}
