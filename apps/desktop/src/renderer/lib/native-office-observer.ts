import type { NativeOfficeCommand, NativeOfficeState } from '../../../../../packages/contracts/src/native-office';
import type { NativeOfficeRequest } from './native-office-tools';
import { sharePolledValue } from './polled-state';

type Listener = { state(value: NativeOfficeState): void; healthy?(): void; error?(cause: unknown): void };
export type NativeOfficeObserverEnvironment = {
  now(): number; visible(): boolean;
  setTimer(callback: () => void, delay: number): unknown; clearTimer(timer: unknown): void;
  watchVisibility?(callback: () => void): () => void;
  watchMessages?(callback: (message: Record<string, unknown>) => void): () => void;
};
type Subscription = { documentId: string; interval: number; listener: Listener };
type Entry = { viewId: string; subscriptions: Set<Subscription>; value?: NativeOfficeState; pending?: Promise<void>; timer?: unknown; heartbeat?: number; generation: number; live: boolean };

/** Compare every state field, while rejecting a late response within the same engine. */
export function shareNativeOfficeState(previous: NativeOfficeState | undefined, next: NativeOfficeState): NativeOfficeState {
  if (previous?.documentId === next.documentId && previous.viewId === next.viewId && previous.sessionId === next.sessionId && previous.engineEpoch === next.engineEpoch) {
    if (next.engineRevision < previous.engineRevision || next.engineRevision === previous.engineRevision && ((next.selectionEpoch ?? 0) < (previous.selectionEpoch ?? 0) || (next.viewport?.layoutRevision ?? 0) < (previous.viewport?.layoutRevision ?? 0))) return previous;
  }
  return sharePolledValue(previous, next) ?? next;
}

/** One read flight per visible view. Heartbeats prove that the trusted host still polls. */
export function createNativeOfficeStateObserver(request: NativeOfficeRequest, environment: NativeOfficeObserverEnvironment) {
  const entries = new Map<string, Entry>();
  let offVisibility: (() => void) | undefined, offMessages: (() => void) | undefined;
  const active = (entry: Entry) => entry.live && entries.get(entry.viewId) === entry && entry.subscriptions.size > 0;
  const owns = (entry: Entry, value: NativeOfficeState) => value?.viewId === entry.viewId && typeof value.engineEpoch === 'string' && !!value.engineEpoch && Number.isSafeInteger(value.engineRevision) && value.engineRevision >= 0 && [...entry.subscriptions].every(item => item.documentId === value.documentId);
  const clear = (entry: Entry) => { if (entry.timer !== undefined) environment.clearTimer(entry.timer); entry.timer = undefined; };
  const deliver = (entry: Entry) => { if (active(entry) && environment.visible() && entry.value) for (const item of entry.subscriptions) item.listener.state(entry.value); };
  const accept = (entry: Entry, value: NativeOfficeState) => { if (!active(entry) || !owns(entry, value)) return; entry.value = shareNativeOfficeState(entry.value, value); deliver(entry); };
  const interval = (entry: Entry) => Math.min(...[...entry.subscriptions].map(item => item.interval));
  const schedule = (entry: Entry) => {
    clear(entry); if (!active(entry) || !environment.visible()) return;
    entry.timer = environment.setTimer(() => { entry.timer = undefined; void pull(entry); }, interval(entry));
  };
  const pull = async (entry: Entry, force = false) => {
    if (!active(entry) || !environment.visible()) return;
    if (entry.pending) return entry.pending;
    if (!force && entry.value && entry.heartbeat !== undefined && environment.now() - entry.heartbeat < 2500) { schedule(entry); return; }
    clear(entry); const generation = entry.generation;
    entry.pending = (async () => {
      try {
        const value = await Promise.resolve().then(() => request<NativeOfficeState>('office-status', { viewId: entry.viewId }));
        if (active(entry) && entry.generation === generation) {
          if (!owns(entry, value)) throw new Error('引擎状态不属于当前 Office 页面。');
          accept(entry, value);
        }
      } catch (cause) { if (active(entry) && entry.generation === generation && environment.visible()) for (const item of entry.subscriptions) item.listener.error?.(cause); }
      finally { entry.pending = undefined; schedule(entry); }
    })();
    return entry.pending;
  };
  const receive = (message: Record<string, unknown>) => {
    if (message.action === 'office-state') {
      const value = message.state as NativeOfficeState | undefined, entry = value?.viewId ? entries.get(value.viewId) : undefined;
      if (entry && value && owns(entry, value)) { entry.generation++; accept(entry, value); }
    } else if (message.action === 'office-state-heartbeat' && typeof message.viewId === 'string') {
      const entry = entries.get(message.viewId);
      if (entry) {
        entry.heartbeat = environment.now();
        if (entry.value && active(entry) && environment.visible()) for (const item of entry.subscriptions) item.listener.healthy?.();
      }
    }
  };
  return {
    subscribe(viewId: string, documentId: string, listener: Listener, milliseconds = 800) {
      let entry = entries.get(viewId);
      if (entry && [...entry.subscriptions].some(item => item.documentId !== documentId)) throw new Error('同一 Office 页面不能订阅不同文档。');
      if (!entry) { entry = { viewId, subscriptions: new Set(), generation: 0, live: true }; entries.set(viewId, entry); }
      const subscription = { documentId, listener, interval: Math.max(100, milliseconds) }; entry.subscriptions.add(subscription);
      if (!offVisibility) offVisibility = environment.watchVisibility?.(() => { for (const item of entries.values()) { if (environment.visible()) { deliver(item); void pull(item, true); } else clear(item); } });
      if (!offMessages) offMessages = environment.watchMessages?.(receive);
      if (entry.value && environment.visible()) listener.state(entry.value);
      void pull(entry);
      return () => {
        entry!.subscriptions.delete(subscription);
        if (!entry!.subscriptions.size) { entry!.live = false; entry!.generation++; clear(entry!); entries.delete(viewId); }
        if (!entries.size) { offVisibility?.(); offMessages?.(); offVisibility = offMessages = undefined; }
      };
    },
    receive,
  };
}

const observers = new WeakMap<NativeOfficeRequest, ReturnType<typeof createNativeOfficeStateObserver>>();
export function subscribeNativeOfficeState(request: NativeOfficeRequest, viewId: string, documentId: string, listener: Listener, interval = 800) {
  let observer = observers.get(request);
  if (!observer) {
    observer = createNativeOfficeStateObserver(request, {
      now: Date.now, visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
      setTimer: (callback, delay) => globalThis.setTimeout(callback, delay), clearTimer: timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
      watchVisibility: callback => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
      watchMessages: callback => window.agentViewer?.onToolbar(callback) ?? (() => {}),
    }); observers.set(request, observer);
  }
  return observer.subscribe(viewId, documentId, listener, interval);
}

/** Only command identities/labels/policy metadata are cached, never enabled/state/content. */
export function createNativeOfficeCatalogReader(request: NativeOfficeRequest, now = Date.now, capacity = 8, maxAge = 30_000) {
  const entries = new Map<string, { created: number; promise: Promise<NativeOfficeCommand[]> }>();
  return async (state: NativeOfficeState, force = false) => {
    const key = JSON.stringify([state.documentId, state.viewId, state.format, state.sessionId, state.engineEpoch]);
    const old = entries.get(key);
    if (!force && old && now() - old.created < maxAge) { entries.delete(key); entries.set(key, old); return old.promise; }
    if (old) entries.delete(key);
    const entry = { created: now(), promise: Promise.resolve([] as NativeOfficeCommand[]) };
    entry.promise = (async () => {
      const commands: NativeOfficeCommand[] = []; let offset = 0;
      for (;;) {
        const result = await request<{ state: NativeOfficeState; commands: NativeOfficeCommand[]; hasMore: boolean }>('office-commands', { viewId: state.viewId, offset, limit: 200 });
        if (result.state.documentId !== state.documentId || result.state.viewId !== state.viewId || result.state.sessionId !== state.sessionId || result.state.engineEpoch !== state.engineEpoch) throw new Error('读取命令目录时原生会话已变化。');
        commands.push(...result.commands.map(({ enabled: _enabled, state: _state, ...command }) => command));
        offset += result.commands.length;
        if (!result.hasMore) return [...new Map(commands.map(command => [command.command, command])).values()];
        if (!result.commands.length || offset >= 10000) throw new Error('引擎命令目录未完整返回，请重试。');
      }
    })();
    entries.set(key, entry); while (entries.size > capacity) entries.delete(entries.keys().next().value!);
    try { return await entry.promise; } catch (cause) { if (entries.get(key) === entry) entries.delete(key); throw cause; }
  };
}
const catalogs = new WeakMap<NativeOfficeRequest, ReturnType<typeof createNativeOfficeCatalogReader>>();
export function readNativeOfficeCatalog(request: NativeOfficeRequest, state: NativeOfficeState, force = false) {
  let read = catalogs.get(request); if (!read) { read = createNativeOfficeCatalogReader(request); catalogs.set(request, read); }
  return read(state, force);
}
