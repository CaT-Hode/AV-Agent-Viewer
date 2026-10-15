import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { NativeOfficeRuntime } from '../packages/office-runtime/src/index';
import { NativeOfficeProtocolReader, validateNativeOfficeDispatch, validateNativeOfficeLayout } from '../packages/office-runtime/src/protocol';
import type { NativeOfficeOpen } from '../packages/office-runtime/src/types';

test('native layouts accept DIP rectangles and exact uint64 HWNDs, reject forged or invalid bounds', () => {
  const valid = { ownerHwnd: '123456789', ownerViewport: { width: 1440, height: 900 }, bounds: { x: 13, y: 17, width: 1000, height: 700 }, visible: true };
  assert.deepEqual(validateNativeOfficeLayout(valid), valid);
  for (const ownerHwnd of ['0', '-1', '1e3', 'file://42', '18446744073709551616']) assert.throws(() => validateNativeOfficeLayout({ ...valid, ownerHwnd }));
  for (const bounds of [{ ...valid.bounds, x: -1 }, { ...valid.bounds, width: 0 }, { ...valid.bounds, height: Infinity }, { ...valid.bounds, y: NaN }]) assert.throws(() => validateNativeOfficeLayout({ ...valid, bounds }));
  for (const ownerViewport of [{ width: 0, height: 900 }, { width: 1440, height: NaN }, { width: 900, height: 900 }]) assert.throws(() => validateNativeOfficeLayout({ ...valid, ownerViewport }));
  assert.equal(validateNativeOfficeLayout({ ...valid, ownerViewport: { width: 900, height: 600 }, visible: false }).visible, false, 'hiding a prior larger surface after resizing must remain possible');
});
test('native generic commands require revision and cannot bypass app file or script routes', () => {
  assert.equal(validateNativeOfficeDispatch({ command: '.uno:Bold', expectedEngineRevision: 7 }).command, '.uno:Bold');
  for (const command of ['.uno:FontDialog', '.uno:HyperlinkDialog']) assert.equal(validateNativeOfficeDispatch({ command, expectedEngineRevision: 7 }).command, command);
  for (const command of ['.uno:Open', '.uno:RunMacro', '.uno:SaveAs', '.uno:SaveAll', '.uno:NewWindow', '.uno:Sidebar', 'javascript:x', '.uno:Bold?url=file']) assert.throws(() => validateNativeOfficeDispatch({ command, expectedEngineRevision: 7 }));
  assert.throws(() => validateNativeOfficeDispatch({ command: '.uno:Bold', expectedEngineRevision: NaN }));
  assert.throws(() => validateNativeOfficeDispatch({ command: '.uno:Bold', expectedEngineRevision: 0, args: { Size: Infinity } }));
});

test('public native dispatch rejects structural JSON commands without globally blacklisting the DataJson argument', () => {
  for (const command of ['.uno:Save', '.uno:RunMacro']) {
    const DataJson = JSON.stringify({ UnoCommand: { name: command } });
    assert.throws(() => validateNativeOfficeDispatch({ command: '.uno:TransformDocumentStructure', expectedEngineRevision: 7, expectedSelectionEpoch: 2, args: { DataJson } }), { code: 'INVALID_NATIVE_COMMAND' });
  }
  const value = { command: '.uno:Bold', expectedEngineRevision: 7, expectedSelectionEpoch: 2, args: { DataJson: '{"literal":"not a nested dispatcher"}' } };
  assert.deepEqual(validateNativeOfficeDispatch(value), value);
});
test('JSONL framing handles split responses, isolates boundaries and prevents unbounded buffering', () => {
  const values: unknown[] = [], reader = new NativeOfficeProtocolReader(value => values.push(value), 50);
  reader.feed('{"id":"a","ok":'); reader.feed('true}\r\n{"type":"changed"}\n');
  assert.deepEqual(values, [{ id: 'a', ok: true }, { type: 'changed' }]);
  assert.throws(() => reader.feed('x'.repeat(51)), /过大/); reader.feed('{"after":1}\n'); assert.deepEqual(values.at(-1), { after: 1 });
  assert.throws(() => reader.feed('{invalid}\n'), /无效/);
});

class FakeWorker extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); calls: { id: string; method: string; args: any }[] = [];
  stdin = new Writable({ write: (chunk, _encoding, next) => {
    const request = JSON.parse(String(chunk)); this.calls.push(request); next();
    if (this.respond) queueMicrotask(() => this.respond!(request, value => this.stdout.write(JSON.stringify({ id: request.id, ok: true, result: value }) + '\n')));
  } });
  respond?: (request: { id: string; method: string; args: any }, respond: (value: unknown) => void) => void;
  constructor() { super(); queueMicrotask(() => this.stdout.write('{"type":"ready","engineEpoch":"epoch-1"}\n')); }
}
const input = (documentId: string, sessionId = documentId, viewId = documentId + '-view'): NativeOfficeOpen => ({ documentId, sessionId, viewId, format: 'docx', bytes: new Uint8Array([1]), revision: 0, ownerHwnd: '12', ownerViewport: { width: 1440, height: 900 }, bounds: { x: 10, y: 10, width: 500, height: 500 }, visible: true });
async function setup(respond: FakeWorker['respond'], timeout = 2000) {
  let worker!: FakeWorker; const directory = await mkdtemp(join(tmpdir(), 'agentviewer-native-runtime-unit-'));
  const runtime = new NativeOfficeRuntime({ appRoot: directory, dataDir: directory, sofficePath: join(directory, 'soffice.com'), requestTimeoutMs: timeout, createWorker: () => { worker = new FakeWorker(); worker.respond = respond; return worker as unknown as ChildProcessWithoutNullStreams; } });
  return { runtime, get worker() { return worker; } };
}

test('changing Office display preferences does not start an idle engine, and repeated values do not reconfigure it', async () => {
  const fixture = await setup((_request, respond) => respond({}));
  await fixture.runtime.setAppearance({ theme: 'dark', canvasColor: 0x262626 });
  assert.equal(Boolean(fixture.worker), false);
  await fixture.runtime.state('doc');
  await fixture.runtime.setAppearance({ theme: 'light', canvasColor: 0xf7f5f2 });
  await fixture.runtime.setAppearance({ theme: 'light', canvasColor: 0xf7f5f2 });
  assert.equal(fixture.worker.calls.filter(value => value.method === 'appearance').length, 1);
  assert.deepEqual(fixture.worker.calls.find(value => value.method === 'appearance')!.args, { theme: 'light', canvasColor: 0xf7f5f2 });
  await fixture.runtime.shutdown({ discard: true });
});

test('a failed appearance update can retry the same desired value and reapply the previous value after partial failure', async () => {
  const light = { theme: 'light', canvasColor: 0xf7f5f2 } as const, dark = { theme: 'dark', canvasColor: 0x262626 } as const;
  let rejectNext = true;
  const fixture = await setup((request, respond) => {
    if (request.method === 'appearance' && rejectNext) {
      rejectNext = false;
      fixture.worker.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'NATIVE_APPEARANCE_UNAVAILABLE', message: 'profile partially updated' } }) + '\n');
    } else respond(request.method === 'appearance' ? { ...request.args, whiteDocumentBackground: true } : {});
  });
  await fixture.runtime.state('doc');
  await assert.rejects(fixture.runtime.setAppearance(dark), { code: 'NATIVE_APPEARANCE_UNAVAILABLE' });
  await fixture.runtime.setAppearance(dark);
  assert.deepEqual(fixture.worker.calls.filter(value => value.method === 'appearance').map(value => value.args), [dark, dark]);
  await fixture.runtime.setAppearance(dark);
  assert.equal(fixture.worker.calls.filter(value => value.method === 'appearance').length, 2, 'only confirmed values may skip a duplicate update');
  rejectNext = true; await assert.rejects(fixture.runtime.setAppearance(light), { code: 'NATIVE_APPEARANCE_UNAVAILABLE' });
  await fixture.runtime.setAppearance(dark);
  assert.deepEqual(fixture.worker.calls.filter(value => value.method === 'appearance').map(value => value.args), [dark, dark, light, dark], 'failure invalidates the previous applied marker too');
  await fixture.runtime.shutdown({ discard: true });
});

test('concurrent display updates serialize and apply the latest desired preference without duplicate engine calls', async () => {
  let entered!: () => void, finishFirst!: (value: unknown) => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  let appearanceCalls = 0;
  const fixture = await setup((request, respond) => {
    if (request.method === 'appearance' && ++appearanceCalls === 1) { finishFirst = respond; entered(); }
    else respond(request.method === 'appearance' ? { ...request.args, whiteDocumentBackground: true } : {});
  });
  await fixture.runtime.state('doc');
  const dark = { theme: 'dark', canvasColor: 0x262626 } as const, light = { theme: 'light', canvasColor: 0xf6f8f8 } as const;
  const first = fixture.runtime.setAppearance(dark); await firstEntered;
  const second = fixture.runtime.setAppearance(light), duplicate = fixture.runtime.setAppearance(light);
  assert.equal(fixture.runtime.statistics.pending, 1, 'new desired values must not race the unacknowledged profile update');
  finishFirst({ ...dark, whiteDocumentBackground: true }); await Promise.all([first, second, duplicate]);
  assert.deepEqual(fixture.worker.calls.filter(value => value.method === 'appearance').map(value => value.args), [dark, light]);
  await fixture.runtime.setAppearance(light);
  assert.equal(fixture.worker.calls.filter(value => value.method === 'appearance').length, 2);
  await fixture.runtime.shutdown({ discard: true });
});
test('command status describes managed commands as disabled without starting or executing the engine', async () => {
  const fixture = await setup((request, respond) => respond(request.method === 'commandStatus' ? { command: request.args.command, available: true, enabled: true, state: true } : {}));
  for (const command of ['.uno:Save', '.uno:NewWindow', '.uno:Macro', '.uno:Sidebar']) {
    const status = await fixture.runtime.commandStatus('doc', 'view', command);
    assert.equal(status.command, command); assert.equal(status.available, false); assert.equal(status.enabled, false); assert.ok(status.reason);
  }
  assert.equal(Boolean(fixture.worker), false, 'blocked status must not create a worker');
  for (const command of ['javascript:x', '.uno:Bold?url=file', '.uno:123', '.uno:' + 'a'.repeat(101)]) {
    await assert.rejects(fixture.runtime.commandStatus('doc', 'view', command), { code: 'INVALID_NATIVE_COMMAND' });
  }
  assert.equal(Boolean(fixture.worker), false, 'invalid names must not reach the engine');
  assert.deepEqual(await fixture.runtime.commandStatus('doc', 'view', '.uno:Bold'), { command: '.uno:Bold', available: true, enabled: true, state: true });
  assert.equal(fixture.worker.calls.filter(value => value.method === 'commandStatus').length, 1);
  assert.throws(() => fixture.runtime.dispatch('doc', 'view', { command: '.uno:Save', expectedEngineRevision: 0 }), { code: 'INVALID_NATIVE_COMMAND' });
  assert.equal(fixture.worker.calls.filter(value => value.method === 'dispatch').length, 0);
  await fixture.runtime.shutdown({ discard: true });
});

test('context projection has an explicit internal view-scoped request and leaves a legacy idle runtime untouched', async () => {
  const legacy = await setup((_request, respond) => respond({}));
  assert.equal(await legacy.runtime.enableContextProjection('writer', 'view'), undefined);
  assert.equal(Boolean(legacy.worker), false, 'a legacy display cannot accidentally start the tiled backend');
  await legacy.runtime.shutdown();
  const runtime = new NativeOfficeRuntime({ appRoot: '.', dataDir: '.', backend: 'kit' });
  const requests: { method: string; args: Record<string, unknown> }[] = [];
  (runtime as any).request = async (method: string, args: Record<string, unknown>) => {
    requests.push({ method, args }); return { ...args, engineEpoch: 'actual-worker-epoch', enabled: true };
  };
  assert.deepEqual(await runtime.enableContextProjection('writer', 'view'), { sessionId: 'writer', viewId: 'view', engineEpoch: 'actual-worker-epoch', enabled: true });
  assert.deepEqual(requests, [{ method: 'enableContextProjection', args: { sessionId: 'writer', viewId: 'view' } }], 'the internal call never opens another model or requests an eager state/semantic pass');
});

test('the bridge binds one writer per document and multiple views reuse the same session identity', async () => {
  const fixture = await setup((request, respond) => respond({ ...request.args, bytes: undefined, engineEpoch: 'epoch-1', engineRevision: 0 }));
  await fixture.runtime.open(input('doc')); await fixture.runtime.open(input('doc', 'doc', 'second-view'));
  await assert.rejects(fixture.runtime.open(input('doc', 'other-writer')), /一个原生/);
  await assert.rejects(fixture.runtime.open(input('another-doc', 'doc')), /另一文档/);
  assert.equal(fixture.worker.calls.filter(value => value.method === 'open').length, 2);
  assert.ok(fixture.worker.calls.filter(value => value.method === 'open').every(value => value.args.sessionId === 'doc'));
  await fixture.runtime.shutdown({ discard: true });
});
test('snapshots verify real bytes hash and export consistency before acceptance', async () => {
  const bytes = Buffer.from('native bytes'), hash = createHash('sha256').update(bytes).digest('hex'); let unstable = false;
  const fixture = await setup((request, respond) => respond(request.method === 'snapshot' ? { bytes: bytes.toString('base64'), sha256: hash, stable: !unstable, engineRevisionBefore: 2, engineRevisionAfter: unstable ? 3 : 2, state: { engineRevision: 2 } } : {}));
  const snapshot = await fixture.runtime.snapshot('doc'); assert.deepEqual(snapshot.bytes, new Uint8Array(bytes)); assert.equal(snapshot.sha256, hash);
  unstable = true; await assert.rejects(fixture.runtime.snapshot('doc'), /一致确认/); await fixture.runtime.shutdown({ discard: true });
});
test('a mutation timeout never silently retries or allows a second potentially duplicate edit', async () => {
  const fixture = await setup((request, respond) => { if (request.method !== 'dispatch') respond({}); }, 35);
  await assert.rejects(fixture.runtime.dispatch('doc', 'view', { command: '.uno:Bold', expectedEngineRevision: 0 }), /超时/);
  await assert.rejects(fixture.runtime.dispatch('doc', 'view', { command: '.uno:Bold', expectedEngineRevision: 0 }), /尚未确认/);
  assert.equal(fixture.worker.calls.filter(value => value.method === 'dispatch').length, 1);
  await fixture.runtime.state('doc'); await fixture.runtime.shutdown({ discard: true });
});
test('native shutdown asks UNO to close normally and never kills the owned process', async () => {
  const fixture = await setup((_request, respond) => respond({ closed: true })); await fixture.runtime.state('doc');
  let killed = false; (fixture.worker as any).kill = () => { killed = true; };
  await fixture.runtime.shutdown(); assert.equal(killed, false); assert.deepEqual(fixture.worker.calls.at(-1)?.args, { discard: false });
});

test('a confirmed worker exit makes shutdown idempotent without touching preserved recovery bytes', async () => {
  const fixture = await setup((_request, respond) => respond({})); await fixture.runtime.state('doc');
  const count = fixture.worker.calls.length; fixture.worker.emit('exit', 1);
  await fixture.runtime.shutdown(); await fixture.runtime.shutdown({ discard: true });
  assert.equal(fixture.worker.calls.length, count);
  await assert.rejects(fixture.runtime.state('doc'), /关闭|退出/);
});
