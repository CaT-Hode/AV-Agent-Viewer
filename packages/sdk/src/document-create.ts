import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { ViewerError, type Actor, type ViewInfo } from '../../contracts/src/index';
import type { ViewerCore } from '../../document-core/src/index';
import { emptyDocumentBytes } from '../../document-core/src/empty-document';

import { documentCreateSchema } from './authoring-schemas';
export { documentCreateSchema } from './authoring-schemas';
type Entry = { payload: string; promise: Promise<ViewInfo>; complete: boolean };
const requests = new WeakMap<ViewerCore, Map<string, Entry>>();

export async function createDocument(core: ViewerCore, args: Record<string, unknown>, actor: Actor) {
  const input = documentCreateSchema.parse({ ...args, idempotencyKey: args.idempotencyKey ?? (actor === 'human' ? randomUUID() : undefined) });
  if (input.text !== undefined && !['markdown', 'html'].includes(input.format)) throw new ViewerError('INVALID_ARGUMENT', 'Office/PDF 内容请通过格式编辑操作写入。');
  const suffix = '.' + (input.format === 'markdown' ? 'md' : input.format);
  const supplied = input.title ?? '未命名' + suffix, extension = extname(supplied).toLowerCase();
  if (extension && extension !== suffix && !(input.format === 'markdown' && extension === '.markdown') && !(input.format === 'html' && extension === '.htm')) throw new ViewerError('FORMAT_MISMATCH', '标题扩展名与新建格式不一致。');
  const title = extension ? supplied : supplied + suffix;
  const payload = JSON.stringify({ ...input, title, idempotencyKey: undefined, actor });
  let cache = requests.get(core); if (!cache) { cache = new Map(); requests.set(core, cache); }
  const previous = cache.get(input.idempotencyKey);
  if (previous) { if (previous.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同的新建文档。'); const view = await previous.promise; core.getView(view.id); return structuredClone(view); }
  const entry: Entry = { payload, complete: false, promise: Promise.resolve(undefined as never) };
  cache.set(input.idempotencyKey, entry);
  entry.promise = (async () => {
    const bytes = input.text === undefined ? await emptyDocumentBytes(input.format) : new TextEncoder().encode(input.text);
    const view = await core.openBytes(title, bytes, input.format, undefined, input.windowId, input.activate);
    if (actor === 'human' && input.activate) core.activate(view.id, actor);
    return view;
  })();
  try { return structuredClone(await entry.promise); }
  finally { entry.complete = true; while (cache.size > 256) { const oldest = [...cache].find(([key, candidate]) => key !== input.idempotencyKey && candidate.complete); if (!oldest) break; cache.delete(oldest[0]); } }
}
