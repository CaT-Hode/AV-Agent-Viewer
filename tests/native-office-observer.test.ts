import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeOfficeState } from '../packages/contracts/src/native-office';
import type { NativeOfficeRequest } from '../apps/desktop/src/renderer/lib/native-office-tools';
import { createNativeOfficeCatalogReader, createNativeOfficeStateObserver, shareNativeOfficeState, type NativeOfficeObserverEnvironment } from '../apps/desktop/src/renderer/lib/native-office-observer';

const source = (overrides: Partial<NativeOfficeState> = {}): NativeOfficeState => ({ viewId: 'view', documentId: 'doc', format: 'xlsx', sessionId: 'session', engineEpoch: 'epoch', engineRevision: 1, selectionEpoch: 2, status: 'ready', dirty: false, visible: true, selection: { kind: 'cells', text: '', sheetName: '数据', range: 'A1' }, ...overrides });
const drain = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function clock() {
  let time = 0, visible = true, next = 0, visibility: (() => void) | undefined, messages: ((message: Record<string, unknown>) => void) | undefined;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const environment: NativeOfficeObserverEnvironment = {
    now: () => time, visible: () => visible,
    setTimer: (callback, delay) => { const id = ++next; timers.set(id, { at: time + delay, callback }); return id; }, clearTimer: id => { timers.delete(id as number); },
    watchVisibility: listener => { visibility = listener; return () => { visibility = undefined; }; },
    watchMessages: listener => { messages = listener; return () => { messages = undefined; }; },
  };
  return { environment, timers, receive: (message: Record<string, unknown>) => messages?.(message), watchers: () => [!!visibility, !!messages],
    async visible(value: boolean) { visible = value; visibility?.(); await drain(); },
    async advance(duration: number) { const end = time + duration; for (;;) { const due = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; time = due[1].at; timers.delete(due[0]); due[1].callback(); await drain(); } time = end; await drain(); },
  };
}

test('formula bar and toolbox share one flight and release it after their last subscriber leaves', async () => {
  const timer = clock(); let resolve!: (value: NativeOfficeState) => void, calls = 0;
  const pending = new Promise<NativeOfficeState>(done => { resolve = done; });
  const request = (() => { calls++; return pending; }) as NativeOfficeRequest;
  const observer = createNativeOfficeStateObserver(request, timer.environment), first: NativeOfficeState[] = [], second: NativeOfficeState[] = [];
  const offOne = observer.subscribe('view', 'doc', { state: value => first.push(value) }, 650);
  const offTwo = observer.subscribe('view', 'doc', { state: value => second.push(value) }, 800);
  await drain(); assert.equal(calls, 1); await timer.advance(5000); assert.equal(calls, 1, 'slow reads do not accumulate requests');
  resolve(source()); await drain(); assert.equal(first.length, 1); assert.equal(second.length, 1); assert.equal(first[0], second[0]);
  offOne(); await timer.advance(800); assert.equal(calls, 2); assert.equal(second[1], second[0], 'unchanged full states preserve their reference');
  offTwo(); assert.equal(timer.timers.size, 0); assert.deepEqual(timer.watchers(), [false, false]);
  await timer.advance(10000); assert.equal(calls, 2);
});

test('trusted state plus live heartbeats eliminate repeated status IPC, and heartbeat loss resumes it', async () => {
  const timer = clock(); let calls = 0;
  const observer = createNativeOfficeStateObserver((async () => { calls++; return source(); }) as NativeOfficeRequest, timer.environment);
  const values: NativeOfficeState[] = [], off = observer.subscribe('view', 'doc', { state: value => values.push(value) }, 650);
  await drain(); assert.equal(calls, 1);
  for (let index = 0; index < 8; index++) { timer.receive({ action: 'office-state-heartbeat', viewId: 'view' }); await timer.advance(900); }
  assert.equal(calls, 1, 'eight real host heartbeats cause no fallback IPC'); assert.equal(values.length, 1, 'heartbeats do not redraw anything');
  timer.receive({ action: 'office-state', state: source({ pendingInput: true, visibleTextReady: true, visibleText: 'actual visible text' }) });
  assert.equal(values.at(-1)?.pendingInput, true); assert.equal(values.at(-1)?.visibleTextReady, true);
  await timer.advance(3200); assert.ok(calls > 1, 'an absent heartbeat cannot leave the UI frozen indefinitely'); off();
});

test('hidden renderers stop pulling, resume immediately, and late reads cannot overwrite a pushed state', async () => {
  const timer = clock(); let resolve!: (value: NativeOfficeState) => void, calls = 0;
  const pending = new Promise<NativeOfficeState>(done => { resolve = done; });
  const observer = createNativeOfficeStateObserver((() => { calls++; return pending; }) as NativeOfficeRequest, timer.environment);
  const values: NativeOfficeState[] = [], off = observer.subscribe('view', 'doc', { state: value => values.push(value) });
  await drain(); timer.receive({ action: 'office-state', state: source({ engineRevision: 3 }) });
  resolve(source({ engineRevision: 1 })); await drain(); assert.equal(values.at(-1)?.engineRevision, 3);
  await timer.visible(false); await timer.advance(10000); assert.equal(calls, 1); assert.equal(timer.timers.size, 0);
  await timer.visible(true); assert.equal(calls, 2, 'resume checks the engine without waiting for a stale timer'); assert.equal(values.at(-1)?.engineRevision, 3); off();
});

test('mismatched identities are rejected, failures recover, and unsubscription rejects a late result', async () => {
  const timer = clock(); let result = source({ documentId: 'wrong' }), calls = 0;
  const observer = createNativeOfficeStateObserver((async () => { calls++; return result; }) as NativeOfficeRequest, timer.environment);
  const values: NativeOfficeState[] = [], errors: unknown[] = [], off = observer.subscribe('view', 'doc', { state: value => values.push(value), error: cause => errors.push(cause) });
  await drain(); assert.equal(values.length, 0); assert.equal(errors.length, 1);
  timer.receive({ action: 'office-state', state: source({ viewId: 'other' }) });
  timer.receive({ action: 'office-state', state: source({ documentId: 'wrong' }) }); assert.equal(values.length, 0);
  result = source(); await timer.advance(800); assert.equal(values.length, 1); assert.equal(calls, 2); off();
  timer.receive({ action: 'office-state', state: source({ engineRevision: 99 }) }); assert.equal(values.length, 1);
});

test('structural sharing preserves all real state changes and rejects older selection/geometry versions', () => {
  const before = source({ visibleTextReady: false, viewport: { width: 600, height: 400, deviceScaleFactor: 1, bounds: { x: 0, y: 0, width: 600, height: 400 }, screenBounds: { x: 0, y: 0, width: 600, height: 400 }, layoutRevision: 5 } });
  assert.equal(shareNativeOfficeState(before, structuredClone(before)), before);
  for (const change of [{ visibleTextReady: true }, { pendingInput: true }, { visibleText: 'updated' }, { zoom: 1.25 }, { selectionEpoch: 3 }, { dirty: true }, { actor: 'agent' as const }]) assert.notEqual(shareNativeOfficeState(before, { ...before, ...change }), before);
  assert.equal(shareNativeOfficeState(before, { ...before, selectionEpoch: 1 }), before);
  assert.equal(shareNativeOfficeState(before, { ...before, viewport: { ...before.viewport!, layoutRevision: 4 } }), before);
  assert.notEqual(shareNativeOfficeState(before, { ...before, engineEpoch: 'new', engineRevision: 0 }), before);
});

test('an old in-flight read cannot update a new subscription after the original view unmounts', async () => {
  const timer = clock(), pending: ((value: NativeOfficeState) => void)[] = [];
  const observer = createNativeOfficeStateObserver((() => new Promise<NativeOfficeState>(done => pending.push(done))) as NativeOfficeRequest, timer.environment);
  const before: NativeOfficeState[] = [], after: NativeOfficeState[] = [];
  const offBefore = observer.subscribe('view', 'doc', { state: value => before.push(value) }); await drain(); offBefore();
  const offAfter = observer.subscribe('view', 'next-doc', { state: value => after.push(value) }); await drain();
  pending[0](source()); await drain(); assert.equal(before.length, 0); assert.equal(after.length, 0);
  pending[1](source({ documentId: 'next-doc' })); await drain(); assert.equal(after.length, 1); assert.equal(after[0].documentId, 'next-doc'); offAfter();
});

test('catalog pagination is coalesced and caches only bounded manifest metadata, not live command state', async () => {
  let time = 0, calls = 0;
  const request = (async (_method: string, args: Record<string, unknown>) => {
    calls++; return { state: source({ viewId: String(args.viewId) }), commands: [{ command: args.offset === 0 ? '.uno:Bold' : '.uno:Italic', enabled: true, state: true, label: 'label' }], hasMore: args.offset === 0 };
  }) as NativeOfficeRequest;
  const read = createNativeOfficeCatalogReader(request, () => time, 1, 30000);
  const [one, two] = await Promise.all([read(source()), read(source())]); assert.equal(calls, 2); assert.equal(one, two); assert.equal(one.length, 2);
  assert.ok(one.every(command => !('enabled' in command) && !('state' in command)), 'availability is always read freshly for a specific selection');
  await read(source()); assert.equal(calls, 2); await read(source(), true); assert.equal(calls, 4, 'manual refresh bypasses the cache');
  time = 31000; await read(source()); assert.equal(calls, 6, 'manifest entries expire');
  await read(source({ viewId: 'other' })); assert.equal(calls, 8); await read(source()); assert.equal(calls, 10, 'LRU capacity is bounded');
});

test('catalogs cannot leak across sessions/epochs and a failed load is retryable', async () => {
  let calls = 0, state = source();
  const read = createNativeOfficeCatalogReader((async () => { calls++; return { state, commands: [{ command: '.uno:Bold' }], hasMore: false }; }) as NativeOfficeRequest);
  await read(state); state = source({ engineEpoch: 'new' }); await read(state); assert.equal(calls, 2);
  await assert.rejects(read(source({ sessionId: 'other' })), /会话已变化/);
  state = source({ sessionId: 'other' }); await read(state); assert.equal(calls, 4, 'failed catalog promises never poison future reads');
});

test('a recovered host heartbeat clears only read health without rebroadcasting or inventing a state', async () => {
  const timer = clock(); let fail = false, health = 0, errors = 0, states = 0;
  const request = (async () => { if (fail) throw new Error('temporary transport failure'); return source(); }) as NativeOfficeRequest;
  const observer = createNativeOfficeStateObserver(request, timer.environment);
  const off = observer.subscribe('view', 'doc', { state: () => states++, healthy: () => health++, error: () => errors++ });
  await drain(); fail = true; await timer.advance(800); assert.equal(errors, 1);
  timer.receive({ action: 'office-state-heartbeat', viewId: 'view' }); assert.equal(health, 1); assert.equal(states, 1); off();
  const cold = createNativeOfficeStateObserver(request, timer.environment);
  const offCold = cold.subscribe('view', 'doc', { state: () => states++, healthy: () => health++ });
  await drain(); timer.receive({ action: 'office-state-heartbeat', viewId: 'view' }); assert.equal(health, 1, 'a heartbeat alone never pretends that an initial missing state was read'); offCold();
});
