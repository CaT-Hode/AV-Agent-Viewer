import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { ViewerError, type Actor } from '../../contracts/src/index';
import type { ViewerCore } from '../../document-core/src/index';

import { readerNavigationSchema } from './authoring-schemas';
import { outlineDocument } from './document-content';
export { readerNavigationSchema } from './authoring-schemas';
type NavigationReceipt = { requestId: string; viewId: string; documentId: string; expectedRevision: number; target: z.infer<typeof readerNavigationSchema>['target']; actor: Actor; status: 'requested' };
const requests = new WeakMap<ViewerCore, Map<string, { payload: string; receipt: NavigationReceipt }>>();

/** Publishes a UI request. A receipt is not proof that a renderer reached it. */
export function navigateReader(core: ViewerCore, args: Record<string, unknown>, actor: Actor) {
  const input = readerNavigationSchema.parse(args), view = core.getView(input.viewId), document = core.getDocument(view.documentId).info;
  const payload = JSON.stringify({ ...input, actor });
  let cache = requests.get(core); if (!cache) { cache = new Map(); requests.set(core, cache); }
  const previous = cache.get(input.idempotencyKey);
  if (previous) { if (previous.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同的阅读位置。'); return structuredClone(previous.receipt); }
  if (actor === 'agent' && ['paused','stopped'].includes(core.agentControl.get(view.id) ?? core.agentControl.get(document.id) ?? '')) throw new ViewerError('AGENT_PAUSED', 'Agent 已暂停。');
  if (document.revision !== input.expectedRevision) throw new ViewerError('VERSION_CONFLICT', '内容版本已变化，请重新读取位置。');
  const target = input.target;
  if (target.kind === 'slide' && (document.format !== 'pptx' || !document.model.slides?.some(s => s.id === target.slideId))) throw new ViewerError('INVALID_TARGET', '幻灯片不存在或文档格式不匹配。');
  if (target.kind === 'paragraph' && (document.format !== 'docx' || !document.model.blocks?.some(b => b.id === target.blockId))) throw new ViewerError('INVALID_TARGET', '段落不存在或文档格式不匹配。');
  if (target.kind === 'html-heading' && (document.format !== 'html' || outlineDocument(document).filter(item => typeof item !== 'string' && item.id === target.blockId).length !== 1)) throw new ViewerError('INVALID_TARGET', 'HTML 标题不存在、不唯一或文档格式不匹配。');
  if (target.kind === 'cell') {
    const match = /^([A-Z]+)([1-9]\d*)$/.exec(target.address)!;
    const column = [...match[1]].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
    if (document.format !== 'xlsx' || !document.model.sheets?.some(s => s.id === target.sheetId)) throw new ViewerError('INVALID_TARGET', '工作表不存在或文档格式不匹配。');
    if (column > 50 || Number(match[2]) > 1000) throw new ViewerError('CAPABILITY_UNSUPPORTED', '当前表格阅读视图支持前 1000 行、50 列。');
  }
  const receipt: NavigationReceipt = { requestId: randomUUID(), viewId: view.id, documentId: document.id, expectedRevision: document.revision, target: structuredClone(target), actor, status: 'requested' };
  cache.set(input.idempotencyKey, { payload, receipt }); if (cache.size > 256) cache.delete(cache.keys().next().value!);
  core.activate(view.id, actor); core.event('reader.navigate', receipt); return structuredClone(receipt);
}
