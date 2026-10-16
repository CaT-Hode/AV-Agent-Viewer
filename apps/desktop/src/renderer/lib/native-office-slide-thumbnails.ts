import type { NativeOfficeState, NativeOfficeThumbnailSource } from '../../../../../packages/contracts/src/native-office';
import type { NativeOfficeRequest } from './native-office-tools';

export type OfficeSlideItem = { index: number; name: string; text?: string; width: number; height: number; thumbnail?: string };
export type OfficeSlideNavigation = { items: OfficeSlideItem[]; activeIndex?: number; source?: NativeOfficeThumbnailSource; legacy: boolean };
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const staleThumbnailError = (message: string) => /STALE_NATIVE_THUMBNAIL|STALE_NATIVE_QUERY|NATIVE_SESSION_EXPIRED|NATIVE_QUERY_UNSUPPORTED/.test(message);
const pendingThumbnailError = (message: string) => /NATIVE_PENDING_INPUT/.test(message);
export const validOfficeThumbnail = (value: unknown): value is string => typeof value === 'string' && value.length <= 2_800_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
export function officeThumbnailSourceKey(value: NativeOfficeThumbnailSource) {
  return JSON.stringify([value.documentId, value.sessionId, value.engineEpoch, value.engineRevision, value.partGeometryGeneration, value.appearanceKey, value.geometryKey, value.renderKey]);
}
export function parseOfficeThumbnailSource(value: unknown): NativeOfficeThumbnailSource {
  const source = value as NativeOfficeThumbnailSource | undefined;
  if (!source || Array.isArray(source) || Object.keys(source).length !== 8 || ['documentId', 'sessionId', 'engineEpoch'].some(key => typeof source[key as keyof typeof source] !== 'string' || !(source[key as keyof typeof source] as string).length || (source[key as keyof typeof source] as string).length > 160)
    || !counter(source.engineRevision) || !counter(source.partGeometryGeneration) || !/^[a-f0-9]{64}$/.test(source.appearanceKey) || !/^[a-f0-9]{64}$/.test(source.geometryKey) || !/^[a-f0-9]{64}$/.test(source.renderKey)) throw new Error('Office 缩略图来源回执无效。');
  return { documentId: source.documentId, sessionId: source.sessionId, engineEpoch: source.engineEpoch, engineRevision: source.engineRevision, partGeometryGeneration: source.partGeometryGeneration, appearanceKey: source.appearanceKey, geometryKey: source.geometryKey, renderKey: source.renderKey };
}
export function officeSlideReplyOwned(state: NativeOfficeState, expected: Pick<NativeOfficeState, 'documentId' | 'viewId' | 'sessionId' | 'engineEpoch' | 'engineRevision'>) {
  return state.documentId === expected.documentId && state.viewId === expected.viewId && state.sessionId === expected.sessionId && state.engineEpoch === expected.engineEpoch && state.engineRevision === expected.engineRevision;
}
function parseNavigation(value: unknown, state: NativeOfficeState): OfficeSlideNavigation {
  const data = value as { slides?: unknown[]; activeIndex?: unknown; thumbnailSource?: unknown } | undefined;
  if (!data || !Array.isArray(data.slides)) throw new Error('Office 没有返回实际幻灯片列表。');
  const indices = new Set<number>();
  const items = data.slides.map(raw => {
    const item = raw as OfficeSlideItem | undefined;
    if (!item || !counter(item.index) || item.index >= 10000 || indices.has(item.index) || typeof item.name !== 'string' || !Number.isFinite(item.width) || item.width <= 0 || !Number.isFinite(item.height) || item.height <= 0) throw new Error('Office 幻灯片列表回执无效。');
    indices.add(item.index);
    return { index: item.index, name: item.name, width: item.width, height: item.height, text: typeof item.text === 'string' ? item.text.slice(0, 400) : undefined, thumbnail: validOfficeThumbnail(item.thumbnail) ? item.thumbnail : undefined };
  });
  const source = data.thumbnailSource === undefined ? undefined : parseOfficeThumbnailSource(data.thumbnailSource);
  if (source && (source.documentId !== state.documentId || source.sessionId !== state.sessionId || source.engineEpoch !== state.engineEpoch || source.engineRevision !== state.engineRevision)) throw new Error('STALE_NATIVE_THUMBNAIL');
  return { items, activeIndex: counter(data.activeIndex) ? data.activeIndex : undefined, source, legacy: !source };
}
/** Only an explicitly unsupported new query falls back to the old public contract. */
export async function readOfficeSlideNavigation(request: NativeOfficeRequest, expected: NativeOfficeState): Promise<OfficeSlideNavigation> {
  let response: { state: NativeOfficeState; data: unknown };
  try { response = await request('office-query', { viewId: expected.viewId, target: { kind: 'slides', includeThumbnails: false } }); }
  catch (cause) {
    if (!/INVALID_ARGUMENT|INVALID_NATIVE_QUERY|NATIVE_QUERY_UNSUPPORTED|METHOD_UNSUPPORTED|NATIVE_METHOD_UNSUPPORTED|unrecognized_keys|Unrecognized key/i.test(String(cause))) throw cause;
    response = await request('office-query', { viewId: expected.viewId, target: { kind: 'slides' } });
  }
  if (!officeSlideReplyOwned(response.state, expected)) throw new Error('STALE_NATIVE_THUMBNAIL');
  return parseNavigation(response.data, response.state);
}

/** One visible page per native request. Changing visibility drops queued work,
 * while in-flight read-only work may finish but cannot update a retired source.
 * The bounded cache owns encoded strings only; offscreen DOM never owns images. */
export class OfficeSlideThumbnailController {
  private source?: NativeOfficeThumbnailSource;
  private key = '';
  private generation = 0;
  private live = true;
  private paused = false;
  private flight = false;
  private visible: number[] = [];
  private cache = new Map<number, string>();
  private bytes = 0;
  private failures = new Map<number, string>();
  private attempted = new Set<number>();
  private pendingAttempts = new Map<number, number>();
  private pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private stale = false;
  constructor(private options: { request: NativeOfficeRequest; viewId: string; changed(): void; invalidated(sourceKey: string): void }, private limits = { count: 64, bytes: 8 * 1024 * 1024 }) {}
  setSource(value: NativeOfficeThumbnailSource | undefined) {
    const next = value ? officeThumbnailSourceKey(value) : '';
    if (next === this.key) return;
    this.clearPending(); this.generation++; this.key = next; this.source = value && { ...value }; this.cache.clear(); this.bytes = 0; this.failures.clear(); this.attempted.clear(); this.stale = false;
    this.options.changed(); this.pump();
  }
  /** Only call after an owned, freshly completed metadata read. Ordinary props,
   * setSource(same), focus and redraws do not confirm a stale request's source. */
  confirmSourceReceipt(value: NativeOfficeThumbnailSource | undefined) {
    if (!this.live || !value || !this.stale || officeThumbnailSourceKey(value) !== this.key) return false;
    this.stale = false;
    for (const [index, message] of this.failures) if (staleThumbnailError(message)) { this.failures.delete(index); this.attempted.delete(index); }
    this.options.changed(); this.pump(); return true;
  }
  setVisible(indices: number[]) {
    const before = new Set(this.visible); this.visible = [...new Set(indices)].filter(index => counter(index) && index < 10000);
    for (const [index, timer] of this.pendingTimers) if (!this.visible.includes(index)) { clearTimeout(timer); this.pendingTimers.delete(index); }
    let clearedPending = false;
    for (const index of this.visible) if (!before.has(index)) {
      this.attempted.delete(index); this.pendingAttempts.delete(index);
      if (pendingThumbnailError(this.failures.get(index) ?? '')) { this.failures.delete(index); clearedPending = true; }
    }
    if (clearedPending) this.options.changed(); this.pump();
  }
  setPaused(value: boolean) { const resumed = this.paused && !value; this.paused = value; if (resumed) for (const index of this.visible) if (this.pendingAttempts.has(index)) { const timer = this.pendingTimers.get(index); if (timer) clearTimeout(timer); this.pendingTimers.delete(index); this.pendingAttempts.delete(index); this.failures.delete(index); this.attempted.delete(index); } if (!value) this.pump(); }
  get(index: number) { return this.cache.get(index); }
  error(index: number) { return this.failures.get(index); }
  get retainedBytes() { return this.bytes; }
  get retainedCount() { return this.cache.size; }
  retry() { this.clearPending(); for (const index of this.visible) { this.failures.delete(index); this.attempted.delete(index); } this.stale = false; this.options.changed(); this.pump(); }
  private clearPending() { for (const timer of this.pendingTimers.values()) clearTimeout(timer); this.pendingTimers.clear(); this.pendingAttempts.clear(); }
  private pump() {
    if (!this.live || this.paused || this.flight || this.stale || !this.source) return;
    const index = this.visible.find(index => !this.cache.has(index) && !this.failures.has(index) && !this.attempted.has(index));
    if (index === undefined) return;
    const generation = this.generation, source = { ...this.source }, key = this.key;
    this.flight = true; this.attempted.add(index);
    void (async () => {
      try {
        const response = await this.options.request<{ state: NativeOfficeState; data: { source: unknown; slides: { index: number; thumbnail: unknown }[] } }>('office-query', { viewId: this.options.viewId, target: { kind: 'slide-thumbnails', indices: [index], source } });
        if (!this.live || generation !== this.generation) return;
        if (!officeSlideReplyOwned(response.state, { ...source, viewId: this.options.viewId }) || officeThumbnailSourceKey(parseOfficeThumbnailSource(response.data?.source)) !== key || !Array.isArray(response.data?.slides) || response.data.slides.length !== 1 || response.data.slides[0].index !== index || !validOfficeThumbnail(response.data.slides[0].thumbnail)) throw new Error('Office 缩略图回执目标无效。');
        const thumbnail = response.data.slides[0].thumbnail;
        if (thumbnail.length > this.limits.bytes) throw new Error('Office 缩略图超过缓存限制。');
        this.cache.set(index, thumbnail); this.bytes += thumbnail.length;
        while (this.cache.size > this.limits.count || this.bytes > this.limits.bytes) { const oldest = [...this.cache.keys()].find(index => !this.visible.includes(index)) ?? this.cache.keys().next().value!; this.bytes -= this.cache.get(oldest)!.length; this.cache.delete(oldest); }
        this.options.changed();
      } catch (cause) {
        if (!this.live || generation !== this.generation) return;
        if (pendingThumbnailError(String(cause))) {
          const attempt = (this.pendingAttempts.get(index) ?? 0) + 1; this.pendingAttempts.set(index, attempt);
          if (attempt < 3 && this.visible.includes(index)) { const timer = setTimeout(() => { this.pendingTimers.delete(index); if (!this.live || generation !== this.generation) return; this.attempted.delete(index); this.pump(); }, attempt * 250); this.pendingTimers.set(index, timer); return; }
        }
        this.failures.set(index, String(cause)); this.options.changed();
        if (staleThumbnailError(String(cause))) { this.stale = true; this.options.invalidated(key); }
      } finally { this.flight = false; if (this.live) this.pump(); }
    })();
  }
  dispose() { this.clearPending(); this.live = false; this.generation++; this.visible = []; this.source = undefined; this.cache.clear(); this.failures.clear(); this.attempted.clear(); this.bytes = 0; }
}
