import type { ViewInfo } from '../../../../packages/contracts/src/index';

export interface WorkspaceInvalidated { action: 'workspace-invalidated'; seq: number; windowId: string }
export interface WorkspaceChangeEvent { seq: number; type: string; data: unknown }
interface Options<Owner> {
  views(): Iterable<ViewInfo>;
  view(viewId: string): ViewInfo | undefined;
  owner(windowId: string): Owner | undefined;
  alive(owner: Owner): boolean;
  send(owner: Owner, message: WorkspaceInvalidated): void;
  schedule?(run: () => void): void;
}

/** Structural notifications only: no workspace copies or speculative targets.
 * Capture each real owner while the synchronous Core event still identifies it,
 * then collapse a command's open/activate burst into one latest-state request. */
export class WorkspaceInvalidations<Owner> {
  private readonly viewWindows = new Map<string, string>();
  private readonly pending = new Map<string, { owner: Owner; seq: number }>();
  private scheduled = false;
  private lastSeq = 0;

  constructor(private readonly options: Options<Owner>) {
    for (const view of options.views()) this.viewWindows.set(view.id, view.windowId);
  }

  receive(event: WorkspaceChangeEvent) {
    if (!['view.opened', 'view.activated', 'view.closed', 'window.closed'].includes(event.type) || !Number.isSafeInteger(event.seq) || event.seq <= this.lastSeq || !event.data || typeof event.data !== 'object') return;
    const data = event.data as Record<string, unknown>;
    if (event.type === 'window.closed') {
      if (typeof data.windowId !== 'string' || !data.windowId) return;
      this.lastSeq = event.seq; this.pending.delete(data.windowId);
      // The existing window-close path may reassign surviving views to main.
      // Notify their new live owner, never the destroyed window or its successor.
      const current = new Map([...this.options.views()].map(view => [view.id, view.windowId]));
      for (const [id, windowId] of current) if (this.viewWindows.get(id) === data.windowId && windowId !== data.windowId) this.queue(windowId, event.seq);
      this.viewWindows.clear(); for (const [id, windowId] of current) this.viewWindows.set(id, windowId);
      return;
    }
    // Core's view.opened payload is ViewInfo itself; other events use viewId.
    const id = event.type === 'view.opened' ? data.id : data.viewId;
    if (typeof id !== 'string' || !id) return;
    if (event.type === 'view.closed') {
      const windowId = this.viewWindows.get(id); if (!windowId) return;
      this.lastSeq = event.seq; this.viewWindows.delete(id); this.queue(windowId, event.seq); return;
    }
    const view = this.options.view(id); if (!view) return;
    const previousWindow = this.viewWindows.get(id);
    this.lastSeq = event.seq; this.viewWindows.set(id, view.windowId);
    if (previousWindow && previousWindow !== view.windowId) this.queue(previousWindow, event.seq);
    this.queue(view.windowId, event.seq);
  }

  private queue(windowId: string, seq: number) {
    const owner = this.options.owner(windowId); if (owner === undefined || !this.options.alive(owner)) return;
    const previous = this.pending.get(windowId);
    this.pending.set(windowId, { owner, seq: Math.max(seq, previous?.seq ?? 0) });
    if (this.scheduled) return;
    this.scheduled = true; (this.options.schedule ?? setImmediate)(() => {
      this.scheduled = false; const pending = [...this.pending]; this.pending.clear();
      for (const [id, message] of pending) if (this.options.owner(id) === message.owner && this.options.alive(message.owner)) this.options.send(message.owner, { action: 'workspace-invalidated', seq: message.seq, windowId: id });
    });
  }
}
