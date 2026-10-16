export interface OwnedProcessIdentity { pid: number; startedTicks: string }
export interface OwnedProcessNode extends OwnedProcessIdentity { parentPid: number }

const validPid = (value: unknown, zero = false): value is number => Number.isSafeInteger(value) && (value as number) >= (zero ? 0 : 1) && (value as number) <= 0xffffffff;
const creationTicks = (value: unknown): bigint | undefined => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return;
  const ticks = BigInt(value);
  return ticks <= 3155378975999999999n ? ticks : undefined;
};

/** PPIDs identify numeric slots, not a parent's lifetime. A child that predates
 * the current occupant of its PPID cannot belong to that process. Roots must
 * be independently captured from the actual launched app/MCP handles and then
 * retain their creation identity; arbitrary worker PIDs are not new roots. */
export function ownedProcessTree<T extends OwnedProcessNode>(snapshot: readonly T[], roots: readonly OwnedProcessIdentity[], options: { allowMissingRoots?: boolean } = {}): T[] {
  if (!roots.length) throw new Error('OWNED_PROCESS_ROOTS_REQUIRED');
  const byPid = new Map<number, T>();
  for (const node of snapshot) {
    if (!validPid(node.pid)) continue;
    if (byPid.has(node.pid)) throw new Error('OWNED_PROCESS_SNAPSHOT_DUPLICATE_PID');
    byPid.set(node.pid, node);
  }
  const owned = new Map<number, bigint>(), pending: number[] = [], rootPids = new Set<number>();
  for (const root of roots) {
    const ticks = creationTicks(root.startedTicks);
    if (!validPid(root.pid) || ticks === undefined || rootPids.has(root.pid)) throw new Error('OWNED_PROCESS_ROOT_IDENTITY_INVALID');
    rootPids.add(root.pid);
    const node = byPid.get(root.pid);
    if (!node && options.allowMissingRoots) continue;
    if (!node) throw new Error('OWNED_PROCESS_ROOT_MISSING');
    if (!validPid(node.parentPid, true) || creationTicks(node.startedTicks) === undefined || node.startedTicks !== root.startedTicks) throw new Error('OWNED_PROCESS_ROOT_IDENTITY_CHANGED');
    owned.set(root.pid, ticks); pending.push(root.pid);
  }
  const children = new Map<number, T[]>();
  for (const node of byPid.values()) {
    if (!validPid(node.parentPid, true) || creationTicks(node.startedTicks) === undefined) continue;
    const siblings = children.get(node.parentPid) ?? []; siblings.push(node); children.set(node.parentPid, siblings);
  }
  for (let index = 0; index < pending.length; index++) {
    const parent = pending[index], parentTicks = owned.get(parent)!;
    for (const child of children.get(parent) ?? []) {
      if (owned.has(child.pid)) continue;
      const childTicks = creationTicks(child.startedTicks)!;
      if (childTicks < parentTicks) continue;
      owned.set(child.pid, childTicks); pending.push(child.pid);
    }
  }
  return [...owned.keys()].sort((a, b) => a - b).map(pid => byPid.get(pid)!);
}
