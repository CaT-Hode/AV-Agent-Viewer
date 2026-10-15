import { ViewerError } from '../../../../packages/contracts/src/index';
import type { NativeOfficeState } from '../../../../packages/contracts/src/native-office';

export type OfficeDisplayTicket<Owner extends object> = Readonly<{ owner: Owner; viewId: string; leaseId: string; generation: number; active: boolean }>;
export type OfficeDisplayPresentation = Readonly<{ sessionId: string; engineEpoch: string; engineRevision: number; layoutRevision: number }>;

/** Display ownership is separate from the document's shared native writer. */
export class OfficeDisplayLeases<Owner extends object> {
  private tickets = new Map<string, OfficeDisplayTicket<Owner>>();
  private retired = new Map<string, Set<string>>();
  private writes = new Map<string, Promise<unknown>>();
  private presentations = new Map<string, { ticket: OfficeDisplayTicket<Owner>; proof: OfficeDisplayPresentation }>();
  current(viewId: string) { return this.tickets.get(viewId); }
  matches(ticket: OfficeDisplayTicket<Owner>) { return this.tickets.get(ticket.viewId) === ticket; }
  active(ticket: OfficeDisplayTicket<Owner>) { return ticket.active && this.matches(ticket); }
  presented(ticket: OfficeDisplayTicket<Owner>, source?: Pick<NativeOfficeState, 'sessionId'|'engineEpoch'>) { const receipt=this.presentations.get(ticket.viewId);return this.active(ticket)&&receipt?.ticket===ticket&&(!source||receipt.proof.sessionId===source.sessionId&&receipt.proof.engineEpoch===source.engineEpoch); }
  confirm(ticket: OfficeDisplayTicket<Owner>, proof: OfficeDisplayPresentation) { if(!this.active(ticket))throw new ViewerError('OFFICE_DISPLAY_EXPIRED','Office 显示租约已经释放，不能确认旧画面。');this.presentations.set(ticket.viewId,{ticket,proof:{...proof}}); }
  private remember(viewId: string, leaseId: string) { const ids = this.retired.get(viewId) ?? new Set<string>(); ids.add(leaseId); this.retired.set(viewId, ids); }
  acquire(owner: Owner, viewId: string, leaseId: string) {
    const current = this.current(viewId);
    if (current?.leaseId === leaseId) {
      if (current.owner !== owner || !current.active) throw new ViewerError('OFFICE_DISPLAY_EXPIRED', 'Office 显示租约已经释放，不能再次使用。');
      return current;
    }
    if (this.retired.get(viewId)?.has(leaseId)) throw new ViewerError('OFFICE_DISPLAY_EXPIRED', 'Office 显示租约已经过期。');
    if (current) this.remember(viewId, current.leaseId);
    this.presentations.delete(viewId);
    const ticket = { owner, viewId, leaseId, generation: (current?.generation ?? 0) + 1, active: true } as const;
    this.tickets.set(viewId, ticket); return ticket;
  }
  release(owner: Owner, viewId: string, leaseId: string) {
    const current = this.current(viewId);
    if (current && current.owner !== owner) return { changed: false, ticket: undefined };
    this.remember(viewId, leaseId);
    if (current && current.leaseId !== leaseId) return { changed: false, ticket: undefined };
    if (current && !current.active) return { changed: false, ticket: current };
    this.presentations.delete(viewId);
    const ticket = { owner, viewId, leaseId, generation: (current?.generation ?? 0) + 1, active: false } as const;
    this.tickets.set(viewId, ticket); return { changed: true, ticket };
  }
  require(owner: Owner, viewId: string, leaseId: unknown) {
    const ticket = this.current(viewId);
    if (!ticket?.active || ticket.owner !== owner || ticket.leaseId !== leaseId) throw new ViewerError('OFFICE_DISPLAY_EXPIRED', 'Office 页面显示目标已变化；操作不会自动重试。');
    return ticket;
  }
  remove(viewId: string) { this.tickets.delete(viewId); this.retired.delete(viewId); this.presentations.delete(viewId); }
  releaseOwner(owner: Owner) {
    const released: OfficeDisplayTicket<Owner>[] = [];
    for (const ticket of this.tickets.values()) if (ticket.owner === owner && ticket.active) { const next = this.release(owner, ticket.viewId, ticket.leaseId).ticket; if (next) released.push(next); }
    return released;
  }
  /** Layout and hide writes share one queue; obsolete writes check their ticket on arrival. */
  serialize<T>(viewId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(viewId) ?? Promise.resolve(), next = previous.catch(() => {}).then(run);
    this.writes.set(viewId, next);
    void next.finally(() => { if (this.writes.get(viewId) === next) this.writes.delete(viewId); }).catch(() => {});
    return next;
  }
}

/** DOM display withdrawal immediately invalidates viewport claims, never model contents. */
export function withdrawnOfficeDisplayState<T extends NativeOfficeState>(state: T): T {
  return { ...state, visible: false, focused: false, nativeGeometry: false, visibleText: '', visibleTextReady: false, visibleTextSource: 'unavailable', selection: state.selection ? { ...state.selection, rect: undefined } : undefined };
}
