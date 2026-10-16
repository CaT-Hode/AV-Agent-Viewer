import { retainedValueBytes } from '../../persistence/src/retained-value';
import { ViewerError } from '../../contracts/src/index';
export { retainedValueBytes } from '../../persistence/src/retained-value';

/** Each document has one ordered mutation lane. A failed command releases its
 * lane; unrelated documents never wait for it. */
export class DocumentSessions {
  private readonly lanes = new Map<string, Promise<unknown>>();
  run<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(documentId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation); this.lanes.set(documentId, next);
    void next.finally(() => { if (this.lanes.get(documentId) === next) this.lanes.delete(documentId); }).catch(() => {});
    return next;
  }
  async drain(documentId?: string) {
    if (documentId) { await this.lanes.get(documentId); return; }
    await Promise.all([...this.lanes.values()]);
  }
  get pendingDocuments() { return this.lanes.size; }
}

/** Evict complete oldest undo entries, never half of a transaction. Receipts
 * live separately so eviction cannot make a completed mutation execute twice. */
export class DocumentHistory<T extends { documentId: string }> extends Map<string, T> {
  private readonly sizes = new Map<string, number>();
  private readonly documentBytes = new Map<string, number>();
  private totalBytes = 0;
  constructor(private readonly estimate: (entry: T) => number, readonly perDocumentBudget = 64 * 1024 * 1024, readonly totalBudget = 256 * 1024 * 1024) {
    super();
    if (![perDocumentBudget, totalBudget].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('撤销历史字节预算必须是正整数。');
  }
  override set(key: string, entry: T): this {
    const estimated = this.estimate(entry), size = Math.max(1, Math.ceil(estimated));
    if (!Number.isFinite(estimated) || estimated < 0 || !Number.isSafeInteger(size)) throw new RangeError('撤销历史字节估算必须是有限非负安全整数。');
    this.delete(key);
    if (size > this.perDocumentBudget || size > this.totalBudget) return this;
    super.set(key, entry); this.sizes.set(key, size); this.totalBytes += size;
    this.documentBytes.set(entry.documentId, (this.documentBytes.get(entry.documentId) ?? 0) + size);
    for (const [id, candidate] of this) {
      if (this.totalBytes <= this.totalBudget && (this.documentBytes.get(entry.documentId) ?? 0) <= this.perDocumentBudget) break;
      if (this.totalBytes > this.totalBudget || candidate.documentId === entry.documentId) this.delete(id);
    }
    return this;
  }
  override delete(key: string) {
    const entry = this.get(key); if (!entry) return false;
    const size = this.sizes.get(key) ?? 0;
    this.totalBytes -= size; this.sizes.delete(key);
    const remaining = (this.documentBytes.get(entry.documentId) ?? 0) - size;
    if (remaining > 0) this.documentBytes.set(entry.documentId, remaining); else this.documentBytes.delete(entry.documentId);
    return super.delete(key);
  }
  override clear() { super.clear(); this.sizes.clear(); this.documentBytes.clear(); this.totalBytes = 0; }
  get retainedBytes() { return this.totalBytes; }
}

/** Complete reading snapshots have their own bounded retention. Running tasks
 * pin their exact sources; pressure fails a new read instead of evicting them. */
export class DocumentSnapshots<T extends { document: { id: string } }> extends Map<string, T> {
  private readonly sizes = new Map<string, number>();
  private readonly documentBytes = new Map<string, number>();
  private totalBytes = 0;
  constructor(private readonly pinned: () => ReadonlySet<string>, readonly perDocumentBudget = 64 * 1024 * 1024, readonly totalBudget = 256 * 1024 * 1024, readonly maximumEntries = 100) {
    super();
    if (![perDocumentBudget, totalBudget, maximumEntries].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('完整快照预算必须是正整数。');
  }
  override set(key: string, snapshot: T): this {
    const size = retainedValueBytes(snapshot), previous = this.get(key), pinned = this.pinned();
    let total = this.totalBytes - (this.sizes.get(key) ?? 0) + size;
    let document = (this.documentBytes.get(snapshot.document.id) ?? 0) - (previous?.document.id === snapshot.document.id ? this.sizes.get(key) ?? 0 : 0) + size;
    let count = this.size + (previous ? 0 : 1); const evicted: string[] = [];
    const overBudget = () => total > this.totalBudget || document > this.perDocumentBudget || count > this.maximumEntries;
    for (const [id, candidate] of this) {
      if (!overBudget()) break;
      if (id === key || pinned.has(id)) continue;
      if (total > this.totalBudget || count > this.maximumEntries || candidate.document.id === snapshot.document.id) {
        const bytes = this.sizes.get(id)!; evicted.push(id); total -= bytes; count--;
        if (candidate.document.id === snapshot.document.id) document -= bytes;
      }
    }
    if (overBudget()) throw new ViewerError('SNAPSHOT_BUDGET_EXCEEDED', '完整阅读快照超过保留预算，请等待正在运行的任务结束或缩小读取范围。');
    // Select every victim before mutating the cache. A refused capture preserves
    // all previously issued sources, including old unpinned snapshot IDs.
    for (const id of evicted) this.delete(id);
    this.delete(key); super.set(key, snapshot); this.sizes.set(key, size); this.totalBytes += size;
    this.documentBytes.set(snapshot.document.id, (this.documentBytes.get(snapshot.document.id) ?? 0) + size); return this;
  }
  override delete(key: string) {
    const snapshot = this.get(key); if (!snapshot) return false;
    const size = this.sizes.get(key) ?? 0, documentId = snapshot.document.id;
    this.totalBytes -= size; this.sizes.delete(key);
    const remaining = (this.documentBytes.get(documentId) ?? 0) - size;
    if (remaining > 0) this.documentBytes.set(documentId, remaining); else this.documentBytes.delete(documentId);
    return super.delete(key);
  }
  override clear() { super.clear(); this.sizes.clear(); this.documentBytes.clear(); this.totalBytes = 0; }
  get retainedBytes() { return this.totalBytes; }
}
