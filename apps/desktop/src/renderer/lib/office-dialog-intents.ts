export type OfficeDialogAction = { kind: 'click' | 'set-text' | 'toggle' | 'select'; value?: string | boolean };
type Draft = { value: string | boolean; action: OfficeDialogAction; generation: number; enqueued?: number; operation?: Promise<void> };

/** Local edit generations remain distinct from the last native acknowledgement. */
export class OfficeDialogIntents {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private drafts = new Map<string, Draft>();
  private failures = new Map<string, { generation: number; cause: unknown }>();
  private count = 0;
  constructor(private readonly execute: (nodeId: string, action: OfficeDialogAction) => Promise<void>, private readonly changed: () => void = () => {}) {}
  get pending() { return this.count; }
  get hasFailures() { return this.failures.size > 0; }
  value(nodeId: string) { const value = this.drafts.get(nodeId)?.value; return typeof value === 'string' ? value : undefined; }
  selectedOption(nodeId: string): string | undefined { const action = this.drafts.get(nodeId)?.action; return action?.kind === 'select' && typeof action.value === 'string' ? action.value : undefined; }
  checked(nodeId: string) { const value = this.drafts.get(nodeId)?.value; return typeof value === 'boolean' ? value : undefined; }
  edit(nodeId: string, value: string | boolean, action: OfficeDialogAction = { kind: typeof value === 'boolean' ? 'toggle' : 'set-text', value }) {
    this.drafts.set(nodeId, { value, action, generation: ++this.generation }); this.changed();
  }
  commit(nodeId: string): Promise<void> {
    const draft = this.drafts.get(nodeId);
    if (!draft) return Promise.resolve();
    if (draft.enqueued === draft.generation) return draft.operation ?? Promise.resolve();
    draft.enqueued = draft.generation;
    return draft.operation = this.enqueue(nodeId, draft.action, draft.generation);
  }
  action(nodeId: string, action: OfficeDialogAction) { return this.enqueue(nodeId, action, ++this.generation); }
  private enqueue(nodeId: string, action: OfficeDialogAction, generation: number) {
    this.count++; this.changed();
    const operation = this.tail.then(async () => {
      try {
        await this.execute(nodeId, action);
        if ((this.failures.get(nodeId)?.generation ?? Infinity) <= generation) this.failures.delete(nodeId);
        if (this.drafts.get(nodeId)?.generation === generation) this.drafts.delete(nodeId);
      } catch (cause) { this.failures.set(nodeId, { generation, cause }); throw cause; }
    });
    const settled = operation.finally(() => { this.count--; this.changed(); });
    // Keep the transport serial after a failure; flush separately refuses to
    // confirm a document while any failed field remains unresolved.
    this.tail = settled.catch(() => {});
    return settled;
  }
  /** Cancellation waits for already-issued work, without committing drafts or
   * replaying/rejecting failed edits. The caller separately closes its window. */
  async settle() { await this.tail; }
  async flush() {
    // Already attempted generations are never automatically retried. A new
    // user edit or explicit option selection creates a new generation.
    for (const [nodeId, draft] of this.drafts) if (draft.enqueued !== draft.generation) void this.commit(nodeId).catch(() => {});
    await this.tail;
    if (this.failures.size) throw new Error('有文档选项尚未提交，请修改失败的控件后重试。');
  }
}
