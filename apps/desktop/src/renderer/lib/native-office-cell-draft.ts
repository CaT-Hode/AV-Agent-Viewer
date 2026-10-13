import type { NativeOfficeState } from '../../../../../packages/contracts/src/native-office';
import type { OfficeDraftController } from '../components/office/OfficeDrafts';
import { nativeOfficeOwnedState, type NativeOfficeRequest } from './native-office-tools';

export function nativeOfficeSingleCell(state?: NativeOfficeState) {
  const selection = state?.selection;
  if (!state || state.format !== 'xlsx' || selection?.kind !== 'cells' || !selection.sheetName || !selection.range) return undefined;
  const address = selection.range.replace(/\$/g, '').toUpperCase();
  const [start, end] = address.split(':');
  if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(start) || (end !== undefined && end !== start)) return undefined;
  return { sheetName: selection.sheetName, address: start };
}
type Source = { state: NativeOfficeState; sheetName: string; address: string };
/** The formula draft owns a single real cell; native selection changes never retarget it. */
export class NativeOfficeCellDraft implements OfficeDraftController {
  private source?: Source;
  private content = '';
  private savedContent = '';
  private pending?: Promise<void>;
  private composing = false;
  private disposed = false;
  constructor(public readonly viewId: string, private documentId: string, private options: { current(): NativeOfficeState | undefined; request: NativeOfficeRequest; accept(state: NativeOfficeState): void; changed(): void; makeKey?(): string }) {}
  get value() { return this.content; }
  get target() { return this.source && { sheetName: this.source.sheetName, address: this.source.address }; }
  get isPending() { return !!this.pending; }
  hasDrafts() { return this.content !== this.savedContent; }
  load(state: NativeOfficeState, value: string) {
    if (this.disposed || this.hasDrafts() || this.pending || this.composing || !nativeOfficeOwnedState(state, { documentId: this.documentId, viewId: this.viewId })) return false;
    const target = nativeOfficeSingleCell(state); if (!target) { this.source = undefined; this.content = this.savedContent = ''; this.options.changed(); return false; }
    this.source = { state, ...target }; this.content = this.savedContent = value; this.options.changed(); return true;
  }
  setValue(value: string) { if (!this.source || this.disposed) return; this.content = value; this.options.changed(); }
  setComposing(value: boolean) { this.composing = value; }
  discard() { if (this.composing || this.pending) return; this.content = this.savedContent; this.options.changed(); }
  clear() { if (this.hasDrafts() || this.pending || this.composing) return; this.source = undefined; this.content = this.savedContent = ''; this.options.changed(); }
  flush() {
    if (this.pending) return this.pending;
    if (this.composing) return Promise.reject(new Error('请先完成输入法组合输入，再保存公式。'));
    if (!this.hasDrafts()) return Promise.resolve();
    const source = this.source, submitted = this.content, current = this.options.current(), target = nativeOfficeSingleCell(current);
    if (this.disposed || !source || !nativeOfficeOwnedState(current, { documentId: this.documentId, viewId: this.viewId }) || current.status !== 'ready' || current.pendingInput || current.sessionId !== source.state.sessionId || current.engineEpoch !== source.state.engineEpoch || current.engineRevision !== source.state.engineRevision || target?.sheetName !== source.sheetName || target.address !== source.address) return Promise.reject(new Error('公式草稿的来源或当前选区已变化，请返回原单元格或取消此草稿。'));
    const versions = { viewId: this.viewId, sheetName: source.sheetName, address: source.address, content: submitted, expectedEngineEpoch: current.engineEpoch, expectedEngineRevision: current.engineRevision, expectedSelectionEpoch: current.selectionEpoch, idempotencyKey: this.options.makeKey?.() ?? crypto.randomUUID() };
    const promise = (async () => {
      const response = await this.options.request<{ receipt: { status: string }; state: NativeOfficeState }>('office-cell-set', versions);
      const latest = this.options.current();
      if (this.disposed || !nativeOfficeOwnedState(response.state, { documentId: this.documentId, viewId: this.viewId }) || !nativeOfficeOwnedState(latest, { documentId: this.documentId, viewId: this.viewId }) || response.state.sessionId !== current.sessionId || response.state.engineEpoch !== current.engineEpoch || latest.sessionId !== current.sessionId || latest.engineEpoch !== current.engineEpoch || response.state.engineRevision < current.engineRevision) throw new Error('原生会话已变化，无法确认此次公式提交。');
      if (!response.receipt || !['applied', 'no-change'].includes(response.receipt.status)) throw new Error('公式已派发，但引擎尚未确认应用；请检查单元格结果。');
      // Retain typing that happened while the request was in flight, rebased on this receipt.
      this.savedContent = submitted; this.source = { ...source, state: response.state };
      if (response.state.engineRevision > latest.engineRevision || response.state.engineRevision === latest.engineRevision && (response.state.selectionEpoch ?? 0) >= (latest.selectionEpoch ?? 0)) this.options.accept(response.state);
      this.options.changed();
    })();
    this.pending = promise;
    this.options.changed();
    void promise.finally(() => { if (this.pending === promise) this.pending = undefined; if (!this.disposed) this.options.changed(); }).catch(() => {});
    return promise;
  }
  dispose() { this.disposed = true; }
}
