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
