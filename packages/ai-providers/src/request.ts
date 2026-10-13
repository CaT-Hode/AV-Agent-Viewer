import { ViewerError } from '../../contracts/src/index';

export async function requestProviderJson(url: string, options: RequestInit, signal?: AbortSignal, timeoutMs = 120000, transport: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new ViewerError('REQUEST_TIMEOUT', '模型服务请求超时，请检查连接后重试。')), timeoutMs);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await Promise.race([transport(url, { ...options, signal: controller.signal }), aborted]);
    const text = await Promise.race([response.text(), aborted]);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) throw new ViewerError('PROVIDER_ERROR', response.status + ': ' + text.slice(0, 800));
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { throw new ViewerError('PROVIDER_ERROR', '模型服务返回了非 JSON 内容。'); }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason instanceof ViewerError ? controller.signal.reason : new ViewerError('CANCELLED', '模型请求已取消。');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', onAbort); }
}

export function assertCompleteProviderOutput(data: Record<string, unknown>, protocol: string) {
  const stopped = protocol === 'anthropic-messages' ? data.stop_reason : protocol === 'chat-completions' ? (data.choices as { finish_reason?: string }[] | undefined)?.[0]?.finish_reason : data.status;
  if (stopped === 'length' || stopped === 'max_tokens' || stopped === 'incomplete') throw new ViewerError('MODEL_OUTPUT_TRUNCATED', '模型输出达到限制，结果不完整。请缩小选区或调整模型后重试。');
  if (stopped === 'content_filter' || stopped === 'refusal' || stopped === 'failed' || stopped === 'cancelled') throw new ViewerError('PROVIDER_ERROR', '模型未能完成本次请求。');
}
