import type { Rect } from '../../../../../packages/contracts/src/index';
import { intersectOfficeRect } from './office-surface-geometry';

type TileEntry<T> = { key: string; value: T; bytes: number; rect: Rect; part: number; pinned: boolean; pixelVersion: number };
export type OfficeTileTicket = { id: number; key: string; part: number; rect: Rect };
/** Bounded LRU; resources are released exactly once, including replacement and failed cache admission. */
export class OfficeTileCache<T> {
  private entries = new Map<string, TileEntry<T>>();
  private resident = 0;
  private ticketId = 0;
  private revision = 0;
  private pending = new Map<number, { ticket: OfficeTileTicket; valid: boolean }>();
  constructor(private budget = 32 * 1024 * 1024, private dispose: (value: T) => void = () => {}) { if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Office tile cache budget must be positive.'); }
  get budgetBytes() { return this.budget; }
  setBudget(bytes: number) { if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Office tile cache budget must be positive.'); this.budget = bytes; this.trim(); }
  get size() { return this.entries.size; }
  get byteLength() { return this.resident; }
  /** Raster presentation changes only when actual resident pixels change. Reading LRU order is not a repaint. */
  get version(){return this.revision;}
  /** Read the exact resident pixels without changing eviction order. Missing
   * entries use zero; later admissions never reuse a retired pixel version. */
  pixelVersion(key: string) { return this.entries.get(key)?.pixelVersion ?? 0; }
  get(key: string) { const entry = this.entries.get(key); if (!entry) return; this.entries.delete(key); this.entries.set(key, entry); return entry.value; }
  has(key: string) { return this.entries.has(key); }
  begin(key: string, rect: Rect, part: number): OfficeTileTicket { const ticket = { id: ++this.ticketId, key, part, rect: { ...rect } }; this.pending.set(ticket.id, { ticket, valid: true }); return ticket; }
  cancel(ticket: OfficeTileTicket) { this.pending.delete(ticket.id); }
  /** An invalidated outstanding paint can never resurrect pixels when its late reply arrives. */
  admit(ticket: OfficeTileTicket, value: T, bytes: number): boolean {
    const pending = this.pending.get(ticket.id); this.pending.delete(ticket.id);
    if (!pending?.valid || pending.ticket !== ticket) { this.dispose(value); return false; }
    return this.put(ticket.key, value, bytes, ticket.rect, ticket.part);
  }
  put(key: string, value: T, bytes: number, rect: Rect, part: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.budgetBytes) { this.dispose(value); return false; }
    this.delete(key); const pixelVersion = ++this.revision; this.entries.set(key, { key, value, bytes, rect: { ...rect }, part, pinned: false, pixelVersion }); this.resident += bytes;
    this.trim(); return this.entries.has(key);
  }
  pin(keys: ReadonlySet<string>) { for (const entry of this.entries.values()) entry.pinned = keys.has(entry.key); this.trim(); }
  delete(key: string) { const entry = this.entries.get(key); if (!entry) return; this.entries.delete(key); this.resident -= entry.bytes; this.revision++;this.dispose(entry.value); }
  invalidate(part: number, rect?: Rect) { for (const pending of this.pending.values()) if (pending.ticket.part === part && (!rect || intersectOfficeRect(pending.ticket.rect, rect))) pending.valid = false; for (const entry of [...this.entries.values()]) if (entry.part === part && (!rect || intersectOfficeRect(entry.rect, rect))) this.delete(entry.key); }
  clear() { this.pending.clear(); for (const key of [...this.entries.keys()]) this.delete(key); }
  private trim() {
    while (this.resident > this.budgetBytes) {
      const victim = [...this.entries.values()].find(entry => !entry.pinned) ?? this.entries.values().next().value;
      if (!victim) break; this.delete(victim.key);
    }
  }
}
