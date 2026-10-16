import { ViewerError } from '../../contracts/src/index';
import { retainedValueBytes } from '../../persistence/src/retained-value';

export interface ReceiptRecord { payload: string; receipt: unknown; patchId?: string; documentId?: string }
type Reservation = { token: object; documentId: string; bytes: number; payload: string };
const legacyScope = '__legacy_receipts__';
function receiptDocument(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, any>;
  return typeof record.documentId === 'string' ? record.documentId : typeof record.receipt?.documentId === 'string' ? record.receipt.documentId : typeof record.state?.documentId === 'string' ? record.state.documentId : typeof record.annotation?.documentId === 'string' ? record.annotation.documentId : typeof record.view?.documentId === 'string' ? record.view.documentId : undefined;
}

/** Idempotency keys are durable identities, never an LRU. Capacity is reserved
 * before executing an operation and released on failure. Import and completion
 * always retain real receipts, including oversized legacy/provider results;
 * those results block new work rather than making an old command run twice. */
export class ReceiptLedger extends Map<string, ReceiptRecord> {
  private readonly sizes = new Map<string, { documentId: string; bytes: number }>();
  private readonly documentBytes = new Map<string, number>();
  private readonly reservations = new Map<string, Reservation>();
  private totalBytes = 0;
  private reservedBytes = 0;
  constructor(readonly perDocumentBudget = 64 * 1024 * 1024, readonly totalBudget = 256 * 1024 * 1024) {
    super();
    if (![perDocumentBudget, totalBudget].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('幂等回执预算必须是正整数。');
  }
  get statistics() { return { retainedBytes: this.totalBytes, reservedBytes: this.reservedBytes, pendingEntries: this.reservations.size, entries: this.size, perDocumentBudget: this.perDocumentBudget, totalBudget: this.totalBudget, overBudget: this.totalBytes > this.totalBudget || [...this.documentBytes.values()].some(bytes => bytes > this.perDocumentBudget) }; }
  reserve(key: string, documentId: string, identity: { payload: string; patchId?: string }, resultBytes = 4096) {
    if (this.has(key)) return () => {};
    const pending = this.reservations.get(key);
    if (pending) throw new ViewerError(pending.payload === identity.payload ? 'IDEMPOTENCY_IN_PROGRESS' : 'IDEMPOTENCY_CONFLICT', '此幂等键已有正在执行的操作，请等待其回执后重试。');
    if (!Number.isSafeInteger(resultBytes) || resultBytes < 0) throw new RangeError('回执预留字节数无效。');
    const bytes = retainedValueBytes({ key, record: { ...identity, documentId, receipt: null } }) + Math.max(4096, resultBytes) + 512;
    let reservedDocumentBytes = 0; for (const reservation of this.reservations.values()) if (reservation.documentId === documentId) reservedDocumentBytes += reservation.bytes;
    const overLegacyQuota = this.statistics.overBudget;
    if (overLegacyQuota || this.totalBytes + this.reservedBytes + bytes > this.totalBudget || (this.documentBytes.get(documentId) ?? 0) + reservedDocumentBytes + bytes > this.perDocumentBudget) throw new ViewerError('RECEIPT_QUOTA_EXCEEDED', '幂等回执已达到保留配额，未执行新操作。已有回执仍可重放；请导出恢复包并使用独立工作区。');
    const token = {}, reservation = { token, documentId, bytes, payload: identity.payload };
    this.reservations.set(key, reservation); this.reservedBytes += bytes;
    return () => { if (this.reservations.get(key)?.token === token) { this.reservations.delete(key); this.reservedBytes -= bytes; } };
  }
  override set(key: string, record: ReceiptRecord): this {
    const reservation = this.reservations.get(key), documentId = record.documentId ?? reservation?.documentId ?? receiptDocument(record.receipt) ?? legacyScope;
    const retained = { ...record, documentId }, bytes = retainedValueBytes({ key, record: retained }) + 512;
    this.delete(key); super.set(key, retained); this.sizes.set(key, { documentId, bytes }); this.totalBytes += bytes;
    this.documentBytes.set(documentId, (this.documentBytes.get(documentId) ?? 0) + bytes);
    // Do not reject after an effect has happened. Unbounded third-party result
    // fields may exceed the conservative reservation; retain them and close
    // admission until the workspace is exported/split instead of losing identity.
    if (reservation) { this.reservations.delete(key); this.reservedBytes -= reservation.bytes; }
    return this;
  }
  override delete(key: string) {
    const size = this.sizes.get(key); if (!size) return super.delete(key);
    this.totalBytes -= size.bytes; this.sizes.delete(key);
    const remaining = (this.documentBytes.get(size.documentId) ?? 0) - size.bytes;
    if (remaining > 0) this.documentBytes.set(size.documentId, remaining); else this.documentBytes.delete(size.documentId);
    return super.delete(key);
  }
  override clear() { super.clear(); this.sizes.clear(); this.documentBytes.clear(); this.totalBytes = 0; }
}
