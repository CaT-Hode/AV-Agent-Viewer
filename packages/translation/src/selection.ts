import { randomUUID } from 'node:crypto';
import { ViewerError, type Locator, type ReadingContext } from '../../contracts/src/index';
import type { TranslationEngine } from '../../contracts/src/translation-engine';
import { abortable, assertTranslationActive, translationLanguage } from './request';

export type SelectionTranslationProfile = { fingerprint: string; model: string; engine?: TranslationEngine; translate(source: string, language: string, signal: AbortSignal): Promise<string> };
export type SelectionTranslationRequest = { requestId?: string; retryOf?: string; viewId: string; text?: string; sourceRevision?: number; targetLanguage: string; connectionId?: string; engine?: TranslationEngine };
export type SelectionTranslationResult = { requestId: string; viewId: string; sourceRevision: number; source: string; locator?: Locator; text: string; targetLanguage: string; model: string; engine: TranslationEngine; sourceUpdated: boolean };
type FrozenSource = { documentId: string; sourceRevision: number; source: string; locator?: Locator };
type RequestRecord = { ownerId: string; viewId: string; controller?: AbortController; source?: FrozenSource };
type SelectionTranslationOptions = {
  context(viewId: string): Promise<ReadingContext>;
  revision(documentId: string): number | undefined;
  capture(connectionId?: string, engine?: TranslationEngine): SelectionTranslationProfile;
  timeoutMs?: number;
  retainedSources?: number;
};

/** Request IDs and saved sources are scoped to the trusted reader window, not the active tab. */
export class SelectionTranslationService {
  private records = new Map<string, RequestRecord>();
  constructor(private readonly options: SelectionTranslationOptions) {}
  private prune() {
    const limit = this.options.retainedSources ?? 128;
    for (const [id, record] of this.records) {
      if (this.records.size <= limit) break;
      if (!record.controller) this.records.delete(id);
    }
  }
  translate(ownerId: string, input: SelectionTranslationRequest): Promise<SelectionTranslationResult> { return this.execute(ownerId, input); }
  /** Only call with a core-owned, already validated selection-action snapshot. */
  translateSnapshot(ownerId: string, input: Omit<SelectionTranslationRequest, 'retryOf' | 'text' | 'sourceRevision'>, context: ReadingContext): Promise<SelectionTranslationResult> {
    return this.execute(ownerId, { ...input, text: context.selection.text, sourceRevision: context.contentRevision }, structuredClone(context));
  }
  private async execute(ownerId: string, input: SelectionTranslationRequest, trustedContext?: ReadingContext): Promise<SelectionTranslationResult> {
    const requestId = input.requestId ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId) || !input.viewId) throw new ViewerError('INVALID_ARGUMENT', '翻译请求身份无效。');
    if (this.records.has(requestId)) throw new ViewerError('TRANSLATION_REQUEST_EXISTS', '重译请使用新的请求身份。');
    if ([...this.records.values()].filter(record => record.controller).length >= 16) throw new ViewerError('REQUEST_LIMIT', '选区翻译请求过多，请等待或取消之前的请求。');
    const language = translationLanguage(input.targetLanguage);
    let previous: FrozenSource | undefined;
    if (input.retryOf) {
      const record = this.records.get(input.retryOf);
      if (!record?.source) throw new ViewerError('TRANSLATION_SOURCE_EXPIRED', '此选区的冻结来源已过期，请重新选择原文。');
      if (record.ownerId !== ownerId || record.viewId !== input.viewId) throw new ViewerError('AUTH_SCOPE_DENIED', '不能重译其他窗口或页面的选区。');
      previous = structuredClone(record.source);
    }
    const controller = new AbortController(), record: RequestRecord = { ownerId, viewId: input.viewId, controller };
    this.records.set(requestId, record); this.prune();
    const timer = setTimeout(() => controller.abort(new ViewerError('REQUEST_TIMEOUT', '选区翻译请求超时，请重试。')), this.options.timeoutMs ?? 120000);
    try {
      if (previous) record.source = previous;
      else {
        const context = trustedContext ?? await abortable(this.options.context(input.viewId), controller.signal);
        if (context.viewId !== input.viewId || (!trustedContext && context.actor !== 'human') || context.selection.kind === 'none' || !context.selection.text.trim() || context.selection.text !== input.text || context.contentRevision !== input.sourceRevision || this.options.revision(context.documentId) !== input.sourceRevision) throw new ViewerError('STALE_SELECTION', '原文选区已变化，请重新选择。');
        if (context.selection.text.length > 100000) throw new ViewerError('INPUT_LIMIT', '选区过长，请分段翻译或生成全文译文。');
        record.source = structuredClone({ documentId: context.documentId, sourceRevision: context.contentRevision, source: context.selection.text, locator: context.selection.locator ?? context.locator });
      }
      assertTranslationActive(controller.signal);
      const profile = this.options.capture(input.connectionId,input.engine), source = record.source;
      const text = await abortable(profile.translate(source.source, language, controller.signal), controller.signal);
      assertTranslationActive(controller.signal);
      if (!text.trim()) throw new ViewerError('TRANSLATION_EMPTY', '模型没有返回译文，请重试或检查连接。');
      return { requestId, viewId: input.viewId, sourceRevision: source.sourceRevision, source: source.source, locator: structuredClone(source.locator), text: text.trim(), targetLanguage: language, model: profile.model, engine:profile.engine??'ai', sourceUpdated: this.options.revision(source.documentId) !== source.sourceRevision };
    } finally {
      clearTimeout(timer); record.controller = undefined;
      if (!record.source) this.records.delete(requestId);
      this.prune();
    }
  }
  cancel(ownerId: string, viewId: string, requestId: string) {
    const record = this.records.get(requestId);
    if (!record) return { cancelled: false };
    if (record.ownerId !== ownerId || record.viewId !== viewId) throw new ViewerError('AUTH_SCOPE_DENIED', '不能取消其他窗口或页面的翻译请求。');
    const active = !!record.controller;
    record.controller?.abort(new ViewerError('CANCELLED', '选区翻译已取消。'));
    return { cancelled: active };
  }
  cancelView(viewId: string) { for (const record of this.records.values()) if (record.viewId === viewId) record.controller?.abort(new ViewerError('CANCELLED', '阅读页面已关闭。')); }
  cancelOwner(ownerId: string) { for (const [id, record] of this.records) if (record.ownerId === ownerId) { record.controller?.abort(new ViewerError('CANCELLED', '阅读窗口已关闭。')); this.records.delete(id); } }
  dispose() { for (const record of this.records.values()) record.controller?.abort(new ViewerError('CANCELLED', '应用正在退出。')); this.records.clear(); }
}
