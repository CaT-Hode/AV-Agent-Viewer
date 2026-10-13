import { z } from 'zod';

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
  ]), idempotencyKey: z.string().min(1).max(160),
}).strict();
