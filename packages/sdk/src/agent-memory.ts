import { ViewerError } from '../../contracts/src/index';

const MiB = 1024 * 1024;
export const AGENT_SESSION_MEMORY_BYTES = 64 * MiB;
export const AGENT_CORE_MEMORY_BYTES = 256 * MiB;
type CoreBudget = { used: number; limit: number };
type Entry = { bytes: number };
const cores = new WeakMap<object, CoreBudget>();
export interface AgentMemoryLimits { sessionBytes?: number; coreBytes?: number }
export interface AgentMemoryReservation {
  readonly bytes: number;
  increment(delta: number): void;
  release(): void;
}
const validBytes = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Retained refs, evidence and job bodies share one synchronous reservation
 * ledger. Owners must release replaced/evicted entries and dispose sessions;
 * garbage collection is not a quota-release mechanism. */
export class AgentMemoryBudget {
  private readonly core: CoreBudget;
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private used = 0;
  private disposed = false;
  constructor(core: object, limits: AgentMemoryLimits = {}) {
    const sessionLimit = limits.sessionBytes ?? AGENT_SESSION_MEMORY_BYTES, coreLimit = limits.coreBytes ?? AGENT_CORE_MEMORY_BYTES;
    if (!validBytes(sessionLimit) || !validBytes(coreLimit) || sessionLimit <= 0 || coreLimit <= 0 || sessionLimit > coreLimit) throw new ViewerError('INVALID_ARGUMENT', 'Agent memory limits must be positive byte counts with session <= core.');
    const current = cores.get(core);
    if (current && current.limit !== coreLimit) throw new ViewerError('INVALID_ARGUMENT', 'Sessions sharing a core must use the same aggregate memory limit.');
    this.core = current ?? { used: 0, limit: coreLimit };
    if (!current) cores.set(core, this.core);
    this.limit = sessionLimit;
  }
  private assertOpen() { if (this.disposed) throw new ViewerError('AGENT_SESSION_CLOSED', 'The Agent memory session is closed.'); }
  private check(delta: number) {
    if (!Number.isSafeInteger(delta)) throw new ViewerError('INVALID_ARGUMENT', 'Memory increments must be integer byte counts.');
    if (delta <= 0) return;
    const session = this.used + delta, aggregate = this.core.used + delta;
    if (!Number.isSafeInteger(session) || session > this.limit) throw new ViewerError('AGENT_MEMORY_LIMIT', 'The Agent session retained-content limit was reached.', { scope: 'session', usedBytes: this.used, requestedBytes: delta, limitBytes: this.limit });
    if (!Number.isSafeInteger(aggregate) || aggregate > this.core.limit) throw new ViewerError('AGENT_MEMORY_LIMIT', 'The application retained-content limit for Agent sessions was reached.', { scope: 'core', usedBytes: this.core.used, requestedBytes: delta, limitBytes: this.core.limit });
  }
  reserve(key: string, bytes: number): AgentMemoryReservation {
    this.assertOpen();
    if (!key || !validBytes(bytes)) throw new ViewerError('INVALID_ARGUMENT', 'A resource key and nonnegative integer byte count are required.');
    if (this.entries.has(key)) throw new ViewerError('AGENT_MEMORY_KEY_CONFLICT', 'The retained resource is already reserved; increment or release its existing reservation.');
    this.check(bytes);
    const entry = { bytes }; this.entries.set(key, entry); this.used += bytes; this.core.used += bytes;
    return {
      get bytes() { return entry.bytes; },
      increment: delta => { if (this.entries.get(key) !== entry) throw new ViewerError('AGENT_MEMORY_RELEASED', 'The retained resource reservation was released.'); this.increment(key, delta); },
      release: () => { if (this.entries.get(key) === entry) this.release(key); },
    };
  }
  increment(key: string, delta: number) {
    this.assertOpen();
    const entry = this.entries.get(key);
    if (!entry) throw new ViewerError('AGENT_MEMORY_RELEASED', 'The retained resource has no active reservation.');
    if (!Number.isSafeInteger(delta) || !validBytes(entry.bytes + delta)) throw new ViewerError('INVALID_ARGUMENT', 'The retained resource byte count cannot become negative or unsafe.');
    this.check(delta); entry.bytes += delta; this.used += delta; this.core.used += delta;
  }
  release(key: string) {
    const entry = this.entries.get(key); if (!entry) return;
    this.entries.delete(key); this.used -= entry.bytes; this.core.used -= entry.bytes; entry.bytes = 0;
  }
  usage() { return { sessionBytes: this.used, sessionLimitBytes: this.limit, coreBytes: this.core.used, coreLimitBytes: this.core.limit, entries: this.entries.size }; }
  releaseAll() { for (const key of this.entries.keys()) this.release(key); }
  dispose() { this.releaseAll(); this.disposed = true; }
}

/** Conservative payload accounting without constructing another JSON copy.
 * Shared object identities count once within one retained resource. */
export function agentRetainedBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length * 2 + 32;
  if (typeof value === 'number' || typeof value === 'bigint') return 16;
  if (typeof value === 'boolean' || value === null || value === undefined) return 8;
  if (typeof value !== 'object') return 32;
  if (seen.has(value)) return 8;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer, retained = seen.has(buffer) ? 0 : buffer.byteLength;
    seen.add(buffer); return retained + 64;
  }
  if (value instanceof ArrayBuffer) return value.byteLength + 32;
  if (value instanceof Map) { let bytes = 64; for (const [key, item] of value) bytes += 32 + agentRetainedBytes(key, seen) + agentRetainedBytes(item, seen); return bytes; }
  if (value instanceof Set) { let bytes = 64; for (const item of value) bytes += 24 + agentRetainedBytes(item, seen); return bytes; }
  if (Array.isArray(value)) return 32 + value.reduce((bytes, item) => bytes + 8 + agentRetainedBytes(item, seen), 0);
  let bytes = 64;
  for (const [key, item] of Object.entries(value)) bytes += key.length * 2 + 16 + agentRetainedBytes(item, seen);
  return bytes;
}
