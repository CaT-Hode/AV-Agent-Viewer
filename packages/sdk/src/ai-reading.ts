import { z } from 'zod';
import { AI_READING_TOOLS, buildAIReadingPrompt, getAIReadingScopeState, getAIReadingTool } from '../../ai-reading-tools/src/index';
import { ViewerError, type Actor, type HarnessTask } from '../../contracts/src/index';
import type { ViewerCore } from '../../document-core/src/index';

export const aiReadingRequestSchema = z.object({
  viewId: z.string().min(1), snapshotId: z.string().optional(),
  toolId: z.string().min(1).max(64), scope: z.enum(['selection', 'visible']),
  idempotencyKey: z.string().min(1).max(160),
}).strict();
type RequestEntry = { payload: string; taskId?: string; promise: Promise<{ task: HarnessTask; toolId: string; scope: string }> };
const requests = new WeakMap<ViewerCore, Map<string, RequestEntry>>();

export async function aiReadingTools(core: ViewerCore, args: Record<string, unknown>) {
  if (typeof args.viewId !== 'string') throw new ViewerError('INVALID_ARGUMENT', '需要具体 viewId。');
  const snapshot = typeof args.snapshotId === 'string' ? core.readSnapshot(args.snapshotId) : undefined;
  if (snapshot && snapshot.context.viewId !== args.viewId) throw new ViewerError('SNAPSHOT_TARGET_MISMATCH', '固定来源属于其他视图。');
  const context = snapshot?.context ?? await core.context(args.viewId);
  return { tools: AI_READING_TOOLS, scopes: ['selection', 'visible'],
    availability: { selection: getAIReadingScopeState(context, snapshot, 'selection'), visible: getAIReadingScopeState(context, snapshot, 'visible') },
    viewId: args.viewId, contentRevision: context.contentRevision };
}

/** One request path for the GUI and MCP. A retry reuses its frozen job, even
 * when the human has since changed selection or switched to another tab. */
export function runAIReading(core: ViewerCore, value: unknown, actor: Actor) {
  const args = aiReadingRequestSchema.parse(value), tool = getAIReadingTool(args.toolId);
  if (!tool) throw new ViewerError('INVALID_ARGUMENT', '未知 AI 阅读工具。');
  let cache = requests.get(core); if (!cache) { cache = new Map(); requests.set(core, cache); }
  const payload = JSON.stringify(args), cached = cache.get(args.idempotencyKey);
  if (cached) {
    if (cached.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '同一幂等键不能发起不同阅读分析。');
    return cached.promise;
  }
  if (cache.size >= 256) {
    const expired = [...cache].find(([, entry]) => entry.taskId && core.tasks.get(entry.taskId)?.status !== 'running');
    if (!expired) throw new ViewerError('TASK_LIMIT', '已有过多阅读分析正在运行，请等待或取消部分任务。');
    cache.delete(expired[0]);
  }
  const pending = (async () => {
    const snapshot = args.snapshotId ? core.readSnapshot(args.snapshotId) : await core.snapshot(args.viewId);
    if (snapshot.context.viewId !== args.viewId) throw new ViewerError('SNAPSHOT_TARGET_MISMATCH', '固定来源属于其他视图。');
    if (actor === 'agent' && ['paused', 'stopped'].includes(core.agentControl.get(args.viewId) ?? core.agentControl.get(snapshot.document.id) ?? '')) throw new ViewerError('AGENT_PAUSED', '此页面的 Agent 已暂停或停止。');
    const available = getAIReadingScopeState(undefined, snapshot, args.scope);
    if (!available.available) throw new ViewerError('INVALID_TARGET', available.reason);
    const driver = await core.extensions.get('ai-reading-driver')?.({}, actor) as { driverId?: string } | undefined;
    if (!driver?.driverId) throw new ViewerError('HARNESS_UNAVAILABLE', '请先配置问答模型或 Harness。');
    const task = await core.submitTask(driver.driverId, buildAIReadingPrompt(tool, args.scope), args.viewId, snapshot.id, args.scope);
    core.event('ai.reading', { viewId: args.viewId, documentId: snapshot.document.id, actor, kind: 'analysis', toolId: tool.id, scope: args.scope, taskId: task.id });
    return { task, toolId: tool.id, scope: args.scope };
  })();
  const entry: RequestEntry = { payload, promise: pending }; cache.set(args.idempotencyKey, entry);
  void pending.then(result => { entry.taskId = result.task.id; }, () => {});
  void pending.catch(() => { if (cache!.get(args.idempotencyKey)?.promise === pending) cache!.delete(args.idempotencyKey); });
  return pending;
}
