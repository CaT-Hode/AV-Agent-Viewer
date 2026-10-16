import { isOfficeSurfaceState, type OfficeSurfaceState } from '../../../../../packages/contracts/src/office-surface';
import { sharePolledValue } from './polled-state';

export function sameOfficeSurfaceIdentity(left: OfficeSurfaceState, right: OfficeSurfaceState) {
  return left.documentId === right.documentId && left.viewId === right.viewId && left.sessionId === right.sessionId && left.engineEpoch === right.engineEpoch;
}

/** A read must never undo a newer layout, even when its content revision differs.
 * Full-field sharing preserves future state fields and genuine non-edit changes. */
export function shareOfficeSurfaceState(previous: OfficeSurfaceState | undefined, next: OfficeSurfaceState): OfficeSurfaceState {
  if (previous && sameOfficeSurfaceIdentity(previous, next)) {
    if (next.engineRevision < previous.engineRevision || next.layoutRevision < previous.layoutRevision
      || next.engineRevision === previous.engineRevision && ((next.selectionEpoch ?? 0) < (previous.selectionEpoch ?? 0) || next.eventSequence < previous.eventSequence)) return previous;
  }
  return sharePolledValue(previous, next) ?? next;
}

export type OfficeSurfaceObserverEnvironment = {
  now(): number; active(): boolean;
  setTimer(callback: () => void, delay: number): unknown; clearTimer(timer: unknown): void;
};

/** The trusted main process keeps polling the engine. Its unchanged-state
 * heartbeat replaces duplicate renderer IPC, never the authoritative poll.
 * A missing heartbeat, explicit invalidation, or visibility resume reads fresh. */
export function createOfficeSurfaceStateObserver(target: { documentId: string; viewId: string }, options: {
  read(): Promise<OfficeSurfaceState>;
  current(): OfficeSurfaceState | undefined;
  accept(value: OfficeSurfaceState): void;
  error(cause: unknown): void;
  healthy?(): void;
}, environment: OfficeSurfaceObserverEnvironment, interval = 650, heartbeatLifetime = 2500) {
  let live = true, visible = environment.active(), generation = 0, heartbeat: number | undefined;
  let timer: unknown, pending: Promise<void> | undefined, forceQueued = false;
  const owns = (value: unknown): value is OfficeSurfaceState => isOfficeSurfaceState(value) && value.documentId === target.documentId && value.viewId === target.viewId;
  const active = () => live && environment.active();
  const clear = () => { if (timer !== undefined) environment.clearTimer(timer); timer = undefined; };
  const healthy = () => {
    const state = options.current();
    return owns(state) && state.status === 'ready' && heartbeat !== undefined && environment.now() - heartbeat < heartbeatLifetime;
  };
  const schedule = () => {
    clear(); if (!active()) return;
    // Heartbeats may extend this deadline while the timer is pending. Avoid
    // waking at the old 650ms query rate merely to do no work.
    const delay = healthy() ? Math.max(interval, heartbeatLifetime - (environment.now() - heartbeat!)) : interval;
    timer = environment.setTimer(() => { timer = undefined; void pull(); }, delay);
  };
  const pull = (force = false): Promise<void> => {
    if (!active()) return Promise.resolve();
    if (pending) { forceQueued ||= force; return pending; }
    if (!force && healthy()) { schedule(); return Promise.resolve(); }
    clear(); const capturedGeneration = generation;
    pending = Promise.resolve().then(options.read).then(value => {
      if (!active() || generation !== capturedGeneration) return;
      if (!owns(value)) throw new Error('Office 内置核心没有返回当前页面的 tiled 编辑会话。');
      options.accept(value);
    }).catch(cause => {
      if (active() && generation === capturedGeneration) { heartbeat = undefined; options.error(cause); }
    }).finally(() => {
      pending = undefined;
      const forceAgain = forceQueued; forceQueued = false;
      if (forceAgain && active()) void pull(true); else schedule();
    });
    return pending;
  };
  return {
    start() { return pull(true); },
    poll(force = false) { return pull(force); },
    receive(message: Record<string, unknown>) {
      if (!active()) return;
      if (message.action === 'office-surface-state' && owns(message.state)) {
        generation++; options.accept(message.state);
      } else if (message.action === 'office-state-heartbeat' && message.viewId === target.viewId) {
        // A heartbeat without an initial ready surface cannot hide a failed or
        // still-pending initialization. It carries no document state itself.
        const state=options.current();
        if (owns(state)) { heartbeat = environment.now(); if(state.status==='ready')options.healthy?.(); }
      }
    },
    visibilityChanged() {
      const next = environment.active(); if (next === visible || !live) return;
      visible = next; generation++; heartbeat = undefined; clear();
      if (next) void pull(true);
    },
    dispose() { live = false; generation++; forceQueued = false; clear(); },
  };
}
