import { useLayoutEffect, useRef } from 'react';

export type OfficeDraft = { isDirty(): boolean; flush(): Promise<void>; discard(): void };
export type OfficeDraftFlushOptions = { preserveSelection?: boolean };
export type OfficeDraftController = { viewId: string; hasDrafts(options?: OfficeDraftFlushOptions): boolean; flush(options?: OfficeDraftFlushOptions): Promise<void>; history?(direction: 'undo' | 'redo'): Promise<boolean>; discard(): void };

/** The registry stores live editors, not model copies; flush never forces blur. */
export class OfficeDraftRegistry implements OfficeDraftController {
  private entries = new Map<string, OfficeDraft>();
  private pending?: Promise<void>;
  private lastDirty = false;
  constructor(public readonly viewId: string, private onChange: (dirty: boolean) => void) {}
  register(id: string, draft: OfficeDraft) { this.entries.set(id, draft); if (draft.isDirty()) this.notify(); return () => { if (this.entries.get(id) !== draft) return; const changed = draft.isDirty(); this.entries.delete(id); if (changed || this.lastDirty) this.notify(); }; }
  hasDrafts() { return [...this.entries.values()].some(entry => entry.isDirty()); }
  notify() { const dirty = this.hasDrafts(); if (dirty !== this.lastDirty) { this.lastDirty = dirty; this.onChange(dirty); } }
  flush() {
    if (this.pending) return this.pending;
    // Snapshot the entries. New typing while a save is underway remains a draft
    // for the next save instead of getting cleared by an earlier transaction.
    const entries = [...this.entries.values()].filter(entry => entry.isDirty());
    const operation = (async () => { for (const entry of entries) await entry.flush(); })();
    this.pending = operation;
    void operation.finally(() => { if (this.pending === operation) this.pending = undefined; this.notify(); }).catch(() => {});
    return operation;
  }
  discard() { for (const entry of this.entries.values()) entry.discard(); this.notify(); }
}

export function useOfficeDraft(registry: OfficeDraftRegistry, id: string, draft: OfficeDraft) {
  const current = useRef(draft); current.current = draft;
  useLayoutEffect(() => registry.register(id, { isDirty: () => current.current.isDirty(), flush: () => current.current.flush(), discard: () => current.current.discard() }), [registry, id]);
}
