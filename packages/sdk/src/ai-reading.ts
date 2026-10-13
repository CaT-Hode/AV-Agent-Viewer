import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AI_READING_TOOLS, AI_READING_SCOPE_LABELS, aiReadingResultMarkdown, buildAIReadingPrompt, getAIReadingScopeState, getAIReadingTool, readingLocationLabel, scopedReadingSnapshot, type AIReadingSourceReference, type AIReadingToolDefinition, type ScopedReadingSnapshot } from '../../ai-reading-tools/src/index';
import { ViewerError, type Actor, type HarnessDriver, type HarnessTask } from '../../contracts/src/index';
import type { ViewerCore } from '../../document-core/src/index';

export const aiReadingRequestSchema = z.object({
  viewId: z.string().min(1), snapshotId: z.string().optional(),
  toolId: z.string().min(1).max(64), scope: z.enum(['selection', 'visible']),
  idempotencyKey: z.string().min(1).max(160),
}).strict();
export const aiReadingRetrySchema = z.object({ taskId: z.string().min(1), idempotencyKey: z.string().min(1).max(160) }).strict();
export const aiReadingResultSchema = z.object({ taskId: z.string().min(1) }).strict();
export type AIReadingResult = {
  task: HarnessTask; toolId: string; scope: 'selection' | 'visible';
  source: AIReadingSourceReference; outputKind: 'analysis' | 'draft'; retryOf?: string;
};
type FrozenReading = { snapshot: ScopedReadingSnapshot; source: AIReadingSourceReference; tool: AIReadingToolDefinition; driver: HarnessDriver; prompt: string; retryOf?: string };
type RequestEntry = { payload: string; taskId?: string; frozen?: FrozenReading; promise: Promise<AIReadingResult> };
const requests = new WeakMap<ViewerCore, Map<string, RequestEntry>>();
const records = new WeakMap<ViewerCore, Map<string, RequestEntry>>();

function currentResult(core: ViewerCore, result: AIReadingResult): AIReadingResult {
  return { ...result, task: structuredClone(core.tasks.get(result.task.id) ?? result.task), source: structuredClone(result.source) };
}
function request(core: ViewerCore, key: string, payload: string, start: (entry: RequestEntry) => Promise<AIReadingResult>): Promise<AIReadingResult> {
  let cache = requests.get(core); if (!cache) { cache = new Map(); requests.set(core, cache); }
  const cached = cache.get(key);
  if (cached) {
    if (cached.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '同一幂等键不能发起不同阅读分析。');
    return cached.promise.then(result => currentResult(core, result));
  }
  if (cache.size >= 256) {
    const expired = [...cache].find(([, entry]) => entry.taskId && core.tasks.get(entry.taskId)?.status !== 'running');
    if (!expired) throw new ViewerError('TASK_LIMIT', '已有过多阅读分析正在运行，请等待或取消部分任务。');
    cache.delete(expired[0]); if (expired[1].taskId) records.get(core)?.delete(expired[1].taskId);
  }
  // Register before any asynchronous work, including snapshot/model capture.
  let entry!: RequestEntry;
  const pending = Promise.resolve().then(() => start(entry)); entry = { payload, promise: pending };
  cache.set(key, entry);
  void pending.then(result => {
    entry.taskId = result.task.id;
    let index = records.get(core); if (!index) { index = new Map(); records.set(core, index); }
    index.set(result.task.id, entry);
  }, () => { if (cache!.get(key) === entry) cache!.delete(key); });
  return pending.then(result => currentResult(core, result));
}
function sourceReference(snapshot: ScopedReadingSnapshot, model?: string): AIReadingSourceReference {
  const source: AIReadingSourceReference = {
    snapshotId: snapshot.id, documentId: snapshot.document.id, viewId: snapshot.context.viewId,
    title: snapshot.document.title, format: snapshot.document.format,
    revision: snapshot.document.revision, viewRevision: snapshot.context.viewRevision,
    scope: snapshot.sourceScope, locator: structuredClone(snapshot.context.locator),
    createdAt: snapshot.createdAt, capturedAt: snapshot.context.capturedAt,
    textLength: snapshot.sourceText.length, locationLabel: readingLocationLabel(snapshot.context.locator),
    fingerprint: '', ...(model ? { model } : {}),
    navigationId: snapshot.context.viewport?.navigationId, layoutRevision: snapshot.context.viewport?.layoutRevision,
  };
  source.fingerprint = createHash('sha256').update(JSON.stringify({ ...source, fingerprint: undefined, model: undefined, sourceText: snapshot.sourceText })).digest('hex');
  return source;
}
function assertAgentRunning(core: ViewerCore, actor: Actor, viewId: string, documentId: string) {
  if (actor === 'agent' && ['paused', 'stopped'].includes(core.agentControl.get(viewId) ?? core.agentControl.get(documentId) ?? '')) throw new ViewerError('AGENT_PAUSED', '此页面的 Agent 已暂停或停止。');
}
async function launch(core: ViewerCore, entry: RequestEntry, frozen: FrozenReading, actor: Actor): Promise<AIReadingResult> {
  entry.frozen = frozen;
  const task = await core.submitFrozenReadingTask(frozen.driver, frozen.prompt, frozen.snapshot);
  const result: AIReadingResult = { task, toolId: frozen.tool.id, scope: frozen.snapshot.sourceScope, source: structuredClone(frozen.source), outputKind: frozen.tool.outputKind ?? 'analysis', ...(frozen.retryOf ? { retryOf: frozen.retryOf } : {}) };
  core.event('ai.reading', { viewId: frozen.source.viewId, documentId: frozen.source.documentId, actor, kind: frozen.tool.outputKind === 'draft' ? 'draft' : 'analysis', toolId: frozen.tool.id, scope: frozen.snapshot.sourceScope, taskId: task.id, retryOf: frozen.retryOf });
  return result;
}

export async function aiReadingTools(core: ViewerCore, args: Record<string, unknown>) {
  if (typeof args.viewId !== 'string') throw new ViewerError('INVALID_ARGUMENT', '需要具体 viewId。');
  const snapshot = typeof args.snapshotId === 'string' ? core.readSnapshot(args.snapshotId) : undefined;
  if (snapshot && snapshot.context.viewId !== args.viewId) throw new ViewerError('SNAPSHOT_TARGET_MISMATCH', '固定来源属于其他视图。');
  const context = snapshot?.context ?? await core.context(args.viewId);
  const availabilitySource = snapshot ?? { id: '', schemaVersion: '1.0', createdAt: context.capturedAt, context, document: core.getDocument(context.documentId).info };
  return { tools: AI_READING_TOOLS, scopes: ['selection', 'visible'],
    availability: { selection: getAIReadingScopeState(context, availabilitySource, 'selection'), visible: getAIReadingScopeState(context, availabilitySource, 'visible') },
    viewId: args.viewId, contentRevision: context.contentRevision };
}

/** One GUI/MCP path. Retry of the same request returns the current task; an
 * intentional new analysis has a new key and explicitly freezes a new source. */
export function runAIReading(core: ViewerCore, value: unknown, actor: Actor) {
  const args = aiReadingRequestSchema.parse(value), tool = getAIReadingTool(args.toolId);
  if (!tool) throw new ViewerError('INVALID_ARGUMENT', '未知 AI 阅读工具。');
  return request(core, args.idempotencyKey, JSON.stringify({ method: 'run', ...args }), async entry => {
    const original = args.snapshotId ? core.readSnapshot(args.snapshotId) : await core.snapshot(args.viewId);
    if (original.context.viewId !== args.viewId) throw new ViewerError('SNAPSHOT_TARGET_MISMATCH', '固定来源属于其他视图。');
    assertAgentRunning(core, actor, args.viewId, original.document.id);
    const available = getAIReadingScopeState(undefined, original, args.scope);
    if (!available.available) throw new ViewerError('INVALID_TARGET', available.reason);
    // Validate and clip before calling a provider/model-selection extension.
    const snapshot = scopedReadingSnapshot(original, args.scope);
    const captured = await core.extensions.get('ai-reading-driver')?.({ toolId: tool.id, scope: args.scope }, actor) as { driverId?: string; driver?: HarnessDriver; model?: string } | undefined;
    const driver = captured?.driver ?? (captured?.driverId ? core.drivers.get(captured.driverId) : undefined);
    if (!driver) throw new ViewerError('HARNESS_UNAVAILABLE', '请先配置问答模型或 Harness。');
    const frozen: FrozenReading = { snapshot, tool, driver, prompt: buildAIReadingPrompt(tool, args.scope), source: sourceReference(snapshot, captured?.model ?? 'harness:' + driver.id) };
    return launch(core, entry, frozen, actor);
  });
}

/** Explicit rerun: same source and captured model, a fresh task and key. It
 * does not reread a live selection or depend on the 100-snapshot UI cache. */
export function retryAIReading(core: ViewerCore, value: unknown, actor: Actor) {
  const args = aiReadingRetrySchema.parse(value);
  // Capture before inserting the new request: at the 256-record boundary the
  // original completed entry itself may be the next safe eviction candidate.
  const originalSource = records.get(core)?.get(args.taskId)?.frozen;
  return request(core, args.idempotencyKey, JSON.stringify({ method: 'retry', ...args }), async entry => {
    const task = core.tasks.get(args.taskId);
    if (!originalSource || !task) throw new ViewerError('CAPABILITY_UNSUPPORTED', '该任务没有可重试的冻结阅读来源，或来源记录已过期。请重新明确选择阅读范围。');
    if (task.status === 'running') throw new ViewerError('TASK_RUNNING', '原阅读任务仍在运行，请先取消或等待完成。');
    const frozen = originalSource;
    assertAgentRunning(core, actor, frozen.source.viewId, frozen.source.documentId);
    return launch(core, entry, { ...frozen, retryOf: task.id }, actor);
  });
}

/** Host data only: provenance is taken from our frozen record, never from model
 * output. A Markdown export is a new document, not an edit transaction. */
export function readAIReadingResult(core: ViewerCore, taskId: string) {
  const entry = records.get(core)?.get(taskId), task = core.tasks.get(taskId), frozen = entry?.frozen;
  if (!frozen || !task) throw new ViewerError('CAPABILITY_UNSUPPORTED', '该任务没有冻结阅读结果，或来源记录已过期。');
  const source = structuredClone(frozen.source), currentDocument = core.documents.get(source.documentId)?.info, currentView = core.views.get(source.viewId);
  const sourceUpdated = !!currentDocument && currentDocument.revision !== source.revision
    || !!source.navigationId && !!currentView?.context?.viewport && currentView.context.viewport.navigationId !== source.navigationId;
  const sourceLabel = source.title + ' · ' + AI_READING_SCOPE_LABELS[source.scope] + ' · ' + source.locationLabel + ' · 版本 ' + source.revision;
  return {
    task: structuredClone(task), toolId: frozen.tool.id, label: frozen.tool.label, scope: source.scope,
    source, sourceText: frozen.snapshot.sourceText, sourceRevision: source.revision,
    documentId: source.documentId, viewId: source.viewId, sourceLabel,
    outputKind: frozen.tool.outputKind ?? 'analysis', canRetry: task.status !== 'running', sourceUpdated,
    ...(task.status !== 'running' && task.text.trim() ? { markdown: aiReadingResultMarkdown(frozen.tool, source, task.text, task.status) } : {}),
  };
}

export function aiReadingResult(core: ViewerCore, value: unknown) { const args = aiReadingResultSchema.parse(value); return readAIReadingResult(core, args.taskId); }
