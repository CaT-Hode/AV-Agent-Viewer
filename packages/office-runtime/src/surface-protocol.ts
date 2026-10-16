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
const canvasPoint = z.object({x:z.number().finite().nonnegative().max(100000000),y:z.number().finite().nonnegative().max(100000000)}).strict();
const surfaceLayout = view.extend({ layoutRevision: revision, partIndex: revision, visibleTwips: rect, documentOriginCss: point, canvasOffsetCss:canvasPoint.optional(), scrollCss:canvasPoint.optional(),scrollExtentCss:canvasPoint.optional(),safeViewportCss:rect.optional(), viewportCss: z.object({ width: positive.max(20000), height: positive.max(20000) }).strict(), boundsCss: rect, zoom: z.number().finite().min(.25).max(4), deviceScaleFactor: positive.max(8), visible: z.boolean(), focused: z.boolean() }).strict().superRefine((value,ctx)=>{
  const fields=[value.canvasOffsetCss,value.scrollCss,value.scrollExtentCss,value.safeViewportCss],count=fields.filter(field=>field!==undefined).length;
  const invalid=(message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
  if(count!==0&&count!==fields.length){invalid('Actual Office geometry must be provided together.');return;}
  if(!value.canvasOffsetCss||!value.scrollCss||!value.scrollExtentCss||!value.safeViewportCss)return;
  for(const axis of ['x','y'] as const){
    if(value.scrollCss[axis]>value.scrollExtentCss[axis]+1)invalid('Office scroll exceeds its actual extent.');
    if(Math.abs(value.canvasOffsetCss[axis]-value.scrollCss[axis]-value.documentOriginCss[axis])>.5)invalid('Office origin is inconsistent with actual scroll.');
  }
  const safe=value.safeViewportCss;
  if(safe.x<0||safe.y<0||safe.width<=0||safe.height<=0||safe.x+safe.width>value.viewportCss.width+.5||safe.y+safe.height>value.viewportCss.height+.5)invalid('Office safe viewport lies outside the actual viewport.');
});
const schemas = {
  [OFFICE_SURFACE_METHODS.state]: view,
  [OFFICE_SURFACE_METHODS.layout]: surfaceLayout,
  [OFFICE_SURFACE_METHODS.tiles]: view.extend({ layoutRevision: revision, renderGeneration: revision, partIndex: revision, tiles: z.array(z.object({ key: identity, rectTwips: rect, pixelWidth: positive.int().max(4096), pixelHeight: positive.int().max(4096) }).strict()).min(1).max(12) }).strict().superRefine((value,ctx) => { if(value.tiles.reduce((n,t)=>n+t.pixelWidth*t.pixelHeight*4,0)>64*1024*1024)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Office tile batch exceeds the memory budget.'}); }),
  [OFFICE_SURFACE_METHODS.input]: view.extend({ streamId: identity, sequence: revision, layoutRevision: revision, expectedPartIndex: revision, event }).strict(),
  [OFFICE_SURFACE_METHODS.windowPaint]: windowIdentity.extend({ generation: revision, width: positive.int().max(8192), height: positive.int().max(8192), deviceScaleFactor: positive.max(8) }).strict().refine(value=>value.width*value.height*4<=64*1024*1024),
  [OFFICE_SURFACE_METHODS.windowInput]: windowIdentity.extend({ streamId: identity, sequence: revision, event: windowEvent }).strict(),
  [OFFICE_SURFACE_METHODS.windowClose]: windowIdentity,
  [OFFICE_SURFACE_METHODS.windowClipboard]: windowIdentity,
  [OFFICE_SURFACE_METHODS.windowControls]: windowIdentity,
  [OFFICE_SURFACE_METHODS.windowAction]: windowIdentity.extend({ revision, nodeId: identity, requestId: identity.regex(/^[A-Za-z0-9_-]+$/), action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('click') }).strict(),
    z.object({ kind: z.literal('set-text'), value: z.string().max(65536).refine(value => !value.includes('\0')) }).strict(),
    z.object({ kind: z.literal('toggle'), value: z.boolean() }).strict(),
    z.object({ kind: z.literal('select'), value: identity }).strict(),
  ]) }).strict(),
};
/** Private IPC accepts bounded data, never engine addresses or arbitrary paths. */
export function validateOfficeSurfaceRequest(method: string, value: unknown) {
  const schema = schemas[method as keyof typeof schemas];
  if (!schema) throw new Error('UNKNOWN_OFFICE_SURFACE_METHOD');
  return schema.parse(value);
}
