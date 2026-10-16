import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import type { Writable } from 'node:stream';
import { libreOfficeExecutable } from '../../engines/src/index';
import type { Rect, Actor, NativeOfficeQuery, NativeOfficeExecuteRequest, NativeOfficeExecution, UNOProperty, NativeOfficeNavigateTarget, NativeOfficeExportFormat, NativeOfficeInputRequest, NativeOfficeSnapshotReuse } from '../../contracts/src/index';
import { browserActionSchema } from '../../contracts/src/index';
import { nativeOfficeCommandPolicy } from '../../contracts/src/native-office-policy';
import { nativeOfficeWorkerSource } from './worker-source';
import { officeKitWorkerSource } from './kit-worker-source';
import type { OfficeSurfaceState, OfficeSurfaceLayoutRequest, OfficeSurfaceTilesRequest, OfficeSurfaceTilesReply, OfficeSurfaceInputRequest, OfficeSurfaceInputReply, OfficeSurfaceWindowPaintRequest, OfficeSurfaceWindowPaintReply, OfficeSurfaceWindowInputRequest, OfficeSurfaceWindowCloseRequest, OfficeSurfaceWindowIdentity, OfficeSurfaceWindowControlsReply, OfficeSurfaceWindowActionRequest, OfficeSurfaceWindowActionReply } from '../../contracts/src/office-surface';
import { NativeOfficeProtocolReader, validateNativeOfficeDispatch, validateNativeOfficeLayout } from './protocol';
import { decodeNativeOfficeBytes } from './byte-decoding';
import { NativeOfficeBinaryProtocolReader } from './binary-protocol';
import { immutableOfficeObservation } from './immutable-observation';
import { validateNativeOfficeAppearance, type NativeOfficeAppearance } from './appearance';
import { NativeOfficeError, type NativeOfficeState, type NativeOfficeOpen, type NativeOfficeRuntimeOptions, type NativeOfficeLayout, type NativeOfficeSnapshot, type NativeOfficeCapture, type NativeOfficeDispatch, type NativeOfficeCommandStatus } from './types';
export * from './types';

interface Pending { method: string; resolve: (value: any) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
interface OpenRecord { documentId: string; viewIds: Set<string>; promise?: Promise<NativeOfficeState> }
interface AppearanceResult { theme: string; canvasColor: number; whiteDocumentBackground: boolean }
const observationCounters = ['engineRevision', 'selectionEpoch', 'eventSequence', 'layoutRevision', 'renderGeneration', 'partGeometryGeneration'] as const;
type ObservationLease = { sessionId: string; documentId: string; viewId: string; engineEpoch: string } & Record<typeof observationCounters[number], number>;
interface ObservationReceipt { token: string; lease: ObservationLease; state: NativeOfficeState; host?: { state: NativeOfficeState; identity: object } }
export interface NativeOfficeObservation { state: NativeOfficeState; unchanged: boolean }
/** Private main-process optimization; neither this identity nor its state is accepted over IPC/MCP. */
export interface NativeOfficeHostObservation extends NativeOfficeObservation { receipt?: object }
interface ConfirmedObservation extends NativeOfficeObservation { confirmed?: ObservationReceipt }
export interface NativeOfficeWorkerOptions extends NativeOfficeRuntimeOptions {
  /** Test seam. Production always uses the bundled Python process. */
  createWorker?: (python: string, args: string[]) => ChildProcessWithoutNullStreams;
}

/** One dedicated LibreOffice process, one writable model per document, separate controllers per view. */
export class NativeOfficeRuntime extends EventEmitter {
  private worker?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (reason: unknown) => void;
  private pending = new Map<string, Pending>();
  private sessions = new Map<string, OpenRecord>();
  private documentSessions = new Map<string, string>();
  private closed = false;
  private uncertain = false;
  private engineEpoch?: string;
  private rpc?: Writable;
  private kitSocket?: Socket;
  private kitServer?: Server;
  private kitTransport: 'legacy' | 'authenticating' | 'binary' | 'failed' = 'legacy';
  private pendingKitReady?: { type: 'ready'; engineEpoch: string };
  private binaryReader?: NativeOfficeBinaryProtocolReader;
  private retiredPixels = new Map<string, { method: string; expires: number }>();
  private appearance: NativeOfficeAppearance;
  private appliedAppearance?: NativeOfficeAppearance;
  private appearanceUpdate?: Promise<AppearanceResult | undefined>;
  private observationReceipts = new Map<string, ObservationReceipt>();
  private observationTails = new Map<string, Promise<ConfirmedObservation>>();
  private observationGeneration = 0;
  private timings: Record<string, { count: number; completed: number; totalMs: number; maximumMs: number }> = {};
  private startupMilliseconds?: number;
  private startupStartedAt = 0;
  private readonly startupStages: { code: string; atMs: number; elapsedMs?: number }[] = [];
  private readonly commandCatalogs = new Map<string, Promise<{ command: string; label?: string; group?: number }[]>>();
  get statistics() { return { started: !!this.worker, pending: this.pending.size, transport: this.worker ? this.kitTransport : 'not-started', startupMs: this.startupMilliseconds, startupStages: structuredClone(this.startupStages), methods: structuredClone(this.timings) }; }
  /** Idle warmup shares exactly the same authenticated startup as first open. */
  warmup() { return this.start(); }
  readonly workerDirectory: string;
  constructor(readonly options: NativeOfficeWorkerOptions) {
    super(); this.workerDirectory = join(resolve(options.dataDir), 'native-office', randomUUID());
    this.appearance = validateNativeOfficeAppearance(options.appearance ?? { theme: 'light', canvasColor: 0xf7f5f2 });
  }
  private async start() {
    if (this.closed) throw new NativeOfficeError('NATIVE_RUNTIME_CLOSED', '原生编辑器运行时已经关闭。');
    if (this.starting) return this.starting;
    const startupStarted = performance.now();
    this.startupStartedAt = startupStarted;
    this.starting = (async () => {
      if (process.platform !== 'win32' && !this.options.createWorker) throw new NativeOfficeError('NATIVE_PLATFORM_UNSUPPORTED', '完整原生 Office 编辑器目前支持 Windows。');
      const executable = this.options.sofficePath ?? libreOfficeExecutable(this.options.appRoot)?.path;
      if (!executable) throw new NativeOfficeError('NATIVE_ENGINE_UNAVAILABLE', '找不到内置 Office 引擎。');
      const kit = this.options.backend === 'kit';
      const program = dirname(resolve(executable));
      const pythonCores = kit && existsSync(program) ? readdirSync(program,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^python-core(?:-\d[\d.]*)?$/.test(entry.name)).map(entry=>join(program,entry.name)) : [];
      if (kit && !this.options.pythonPath && pythonCores.length !== 1) throw new NativeOfficeError('NATIVE_UNO_UNAVAILABLE', '内置 Office Python 版本目录无法唯一确认。');
      const python = this.options.pythonPath ?? (kit ? join(pythonCores[0], 'bin', 'python.exe') : join(program, 'python.exe'));
      if (!this.options.createWorker && (!existsSync(python) || !existsSync(join(program, 'pyuno.pyd')))) throw new NativeOfficeError('NATIVE_UNO_UNAVAILABLE', '内置 Office Python/UNO 桥接不可用。');
      await mkdir(this.workerDirectory, { recursive: true });
      const workerFile = join(this.workerDirectory, 'office-worker.py'); await writeFile(workerFile, kit ? officeKitWorkerSource : nativeOfficeWorkerSource, 'utf8');
      const readiness = new Promise<void>((resolveReady, reject) => { this.readyResolve = resolveReady; this.readyReject = reject; });
      const reader = new NativeOfficeProtocolReader(value => this.receive(value));
      const startupAppearance = { ...this.appearance };
      const args = kit ? [] : ['-u', workerFile, this.workerDirectory, program, JSON.stringify(startupAppearance)];
      const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
      if (kit) {
        // Windows VCL and Python share the worker CRT descriptors. Explicit
        // JSONL flushes provide immediate replies without changing CRT mode.
        delete env.PYTHONUNBUFFERED;
        const adapterPath = this.options.adapterPath ?? join(this.options.appRoot, 'dist', 'main', 'office-kit-windows.dll');
        if (!existsSync(adapterPath)) throw new NativeOfficeError('OFFICE_KIT_ADAPTER_UNAVAILABLE', '内嵌 Office 绘制适配器缺失，请修复应用安装。');
        this.kitTransport = 'authenticating';
        const endpoint = await this.createKitEndpoint();
        Object.assign(env, { PYTHONHOME: dirname(dirname(python)), PYTHONPATH: program, PYTHONDONTWRITEBYTECODE:'1', PATH: program + ';' + (process.env.PATH ?? ''), AGENTVIEWER_OFFICE_KIT_CONFIG: JSON.stringify({ directory: this.workerDirectory, program, appearance: startupAppearance, adapterPath, bootstrapSeedPath:this.options.bootstrapSeedPath ?? join(dirname(adapterPath),'office-kit-bootstrap'), rpc: endpoint }) });
      }
      const worker = this.options.createWorker?.(python, args) ?? spawn(python, args, { windowsHide: true, stdio: 'pipe', env });
      this.worker = worker; worker.stdout.setEncoding('utf8'); worker.stdout.on('data', chunk => {
        // v2 has one ordered authority for every event/reply. A late stdout
        // line must never settle an RPC ahead of its socket attachment body.
        if (this.kitTransport === 'binary' || this.kitTransport === 'failed') return;
        try { reader.feed(String(chunk)); } catch (error) { this.readyReject?.(error); this.failPending(error); }
      });
      if (kit) worker.stdin.end(officeKitWorkerSource); else this.rpc = worker.stdin;
      // Drain errors without placing user document text or local profile paths in normal logs.
      worker.stderr.on('data', () => { this.emit('diagnostic', { code: 'NATIVE_WORKER_STDERR' }); });
      worker.once('error', () => { const error = new NativeOfficeError('NATIVE_WORKER_FAILED', '原生编辑器桥接未能启动。'); this.readyReject?.(error); this.failPending(error); });
      worker.once('exit', () => { reader.clear(); this.pendingKitReady = undefined; this.binaryReader?.clear(); this.retiredPixels.clear(); this.closed = true; this.kitServer?.close(); this.kitSocket?.destroy(); const error = new NativeOfficeError('NATIVE_WORKER_EXITED', '原生编辑器桥接已经退出。'); this.readyReject?.(error); this.failPending(error); this.emit('exit'); });
      const timer = setTimeout(() => { this.uncertain = true; this.readyReject?.(new NativeOfficeError('NATIVE_STARTUP_TIMEOUT', '原生编辑器启动超时，专用恢复目录已保留。')); }, this.options.requestTimeoutMs ?? 120000);
      try { await readiness; if (!this.rpc) throw new NativeOfficeError('OFFICE_KIT_NOT_AUTHENTICATED', '内嵌 Office 连接未能确认。'); this.appliedAppearance = startupAppearance; } finally { clearTimeout(timer); this.kitServer?.close(); this.readyResolve = undefined; this.readyReject = undefined; }
    })().finally(() => { this.startupMilliseconds = performance.now() - startupStarted; });
    return this.starting;
  }
  private async createKitEndpoint() {
    const token = randomUUID() + randomUUID();
    const server = createServer(socket => {
      let fragments: Buffer[] = [], length = 0;
      const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
      const authenticate = (chunk: Buffer) => {
        const end = chunk.indexOf(10), part = end < 0 ? chunk : chunk.subarray(0, end);
        length += part.length;
        if (length > 4096) { clearTimeout(timer); fragments = []; socket.destroy(); return; }
        fragments.push(part);
        if (end < 0) return;
        clearTimeout(timer); socket.removeListener('data', authenticate);
        let message: any; try { message = JSON.parse(Buffer.concat(fragments, length).toString('utf8')); } catch { fragments = []; socket.destroy(); return; }
        fragments = [];
        if (message?.type !== 'auth' || message.token !== token || this.kitSocket) { socket.destroy(); return; }
        const legacy = message.protocolVersion === undefined && message.capabilities === undefined;
        const binary = message.protocolVersion === 2 && Array.isArray(message.capabilities) && message.capabilities.includes('binary-tiles');
        if (!legacy && !binary) {
          socket.destroy(); this.failKitTransport(new NativeOfficeError('NATIVE_PROTOCOL_ERROR', '原生编辑器连接协议版本无效。')); return;
        }
        this.kitSocket = socket; this.rpc = socket; socket.setNoDelay(true); server.close();
        this.kitTransport = binary ? 'binary' : 'legacy';
        // Older workers use separate stdout/socket channels. Their ready line
        // may beat authentication; release it only after legacy is confirmed.
        const earlyReady = this.pendingKitReady; this.pendingKitReady = undefined;
        if (legacy && earlyReady) this.receive(earlyReady);
        if (binary) {
          const reader = new NativeOfficeBinaryProtocolReader({
            resolveRequest: id => {
              const pending = this.pending.get(id);
              if (pending) return { method: pending.method };
              const retired = this.retiredPixels.get(id);
              if (retired && retired.expires > Date.now()) return { method: retired.method, retired: true };
              this.retiredPixels.delete(id); return undefined;
            },
            receive: value => this.receive(value, 'socket'),
          });
          this.binaryReader = reader;
          const consume = (data: Buffer) => { try { reader.feed(data); } catch (error) { this.failKitTransport(error); } };
          socket.on('data', consume);
          socket.on('end', () => { try { reader.finish(); } catch (error) { this.failKitTransport(error); } });
          // The Buffer reader is installed before ACK. Preserve even a coalesced
          // auth tail rather than losing it through the old JSONL handshake.
          socket.write('{"type":"auth-ack","protocolVersion":2}\n', error => { if (error) this.failKitTransport(error); });
          if (end + 1 < chunk.length) consume(chunk.subarray(end + 1));
        } else if (end + 1 < chunk.length) {
          // Legacy worker output belongs to stdout, never this request socket.
          this.failKitTransport(new NativeOfficeError('NATIVE_PROTOCOL_ERROR', '原生编辑器连接协议无效。'));
        }
        socket.on('error', () => this.failKitTransport(new NativeOfficeError('NATIVE_CONNECTION_LOST', '内嵌 Office 连接已中断。')));
        socket.on('close', () => {
          this.binaryReader?.clear();
          if (!this.closed && this.kitTransport !== 'failed') this.failKitTransport(new NativeOfficeError('NATIVE_CONNECTION_LOST', '内嵌 Office 连接已中断。'));
        });
      };
      socket.on('data', authenticate);
      socket.on('error', () => { clearTimeout(timer); });
    });
    this.kitServer = server;
    await new Promise<void>((resolveServer, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolveServer(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('OFFICE_KIT_ENDPOINT_FAILED');
    return { host: '127.0.0.1', port: address.port, token };
  }
  private failKitTransport(error: unknown) {
    if (this.kitTransport === 'failed' || this.closed) return;
    this.kitTransport = 'failed'; this.pendingKitReady = undefined; this.binaryReader?.clear(); this.retiredPixels.clear();
    this.rpc = undefined; this.readyReject?.(error); this.failPending(error);
    this.kitSocket?.destroy();
  }
  private retirePixelRequest(id: string, method: string) {
    if (method !== 'surfaceTiles' && method !== 'surfaceWindowPaint') return;
    this.retiredPixels.set(id, { method, expires: Date.now() + 120000 });
    while (this.retiredPixels.size > 256) this.retiredPixels.delete(this.retiredPixels.keys().next().value!);
    this.binaryReader?.retire(id);
  }
  private receive(value: unknown, source: 'stdout' | 'socket' = 'stdout') {
    if (this.kitTransport === 'failed' || this.kitTransport === 'binary' && source !== 'socket') return;
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, any>;
    if (message.type === 'diagnostic' && typeof message.code === 'string' && /^OFFICE_KIT_(?:DLL|ADAPTER|BOOTSTRAP|HOOK|UI_RESOURCE|UNO)/.test(message.code) && this.startupStages.length < 64) this.startupStages.push({ code: message.code, atMs: performance.now() - this.startupStartedAt, ...(Number.isFinite(message.elapsedMs) ? { elapsedMs: message.elapsedMs } : {}) });
    if (message.type === 'ready') {
      if (this.kitTransport === 'authenticating') { this.pendingKitReady = { type: 'ready', engineEpoch: String(message.engineEpoch) }; return; }
      if (this.engineEpoch && this.engineEpoch !== String(message.engineEpoch)) this.clearObservations(); this.engineEpoch = String(message.engineEpoch); this.readyResolve?.(); return;
    }
    if (message.type === 'startup-error') { this.readyReject?.(new NativeOfficeError('NATIVE_STARTUP_FAILED', '原生编辑器启动失败。')); return; }
    if (message.type) { if (message.type === 'closed' || message.type === 'session-unavailable') this.clearObservations(); this.emit(message.type, message); return; }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new NativeOfficeError(typeof message.error?.code === 'string' ? message.error.code : 'NATIVE_ENGINE_ERROR', typeof message.error?.message === 'string' ? message.error.message : '原生编辑器操作失败。'));
  }
  private failPending(error: unknown) {
    this.uncertain = true;
    this.clearObservations();
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); }
    this.pending.clear();
  }
  private async request<T>(method: string, args: Record<string, unknown>, mutation = false): Promise<T> {
    const requested = performance.now();
    await this.start();
    if (!this.worker || this.closed) throw new NativeOfficeError('NATIVE_WORKER_EXITED', '原生编辑器桥接已经退出。');
    if (!this.rpc || this.kitTransport === 'failed') throw new NativeOfficeError('NATIVE_CONNECTION_LOST', '内嵌 Office 连接已中断。');
    if (mutation && this.uncertain) throw new NativeOfficeError('NATIVE_OUTCOME_UNKNOWN', '上一原生操作尚未确认，请保留恢复内容并重新读取。');
    const id = randomUUID();
    const metrics = this.timings[method] ??= { count: 0, completed: 0, totalMs: 0, maximumMs: 0 }, started = requested; metrics.count++;
    return new Promise<T>((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.retirePixelRequest(id, method); if (mutation) this.uncertain = true; reject(new NativeOfficeError('NATIVE_REQUEST_TIMEOUT', '原生操作超时；不会自动重复执行修改。')); }, this.options.requestTimeoutMs ?? 120000);
      this.pending.set(id, { method, resolve: resolveResult, reject, timer });
      this.rpc!.write(JSON.stringify({ id, method, args }) + '\n', error => {
        if (!error) return; const entry = this.pending.get(id); if (!entry) return; clearTimeout(entry.timer); this.pending.delete(id); this.retirePixelRequest(id, method); if (mutation) this.uncertain = true; entry.reject(new NativeOfficeError('NATIVE_CONNECTION_LOST', '原生编辑器连接已中断。'));
      });
    }).finally(() => { const elapsed=performance.now()-started;metrics.completed++;metrics.totalMs+=elapsed;metrics.maximumMs=Math.max(metrics.maximumMs,elapsed); });
  }
  async open(value: NativeOfficeOpen): Promise<NativeOfficeState> {
    const layout = validateNativeOfficeLayout(value);
    if (!['docx', 'pptx', 'xlsx'].includes(value.format) || !value.sessionId || !value.documentId || !value.viewId || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.bytes.byteLength > 100 * 1024 * 1024) throw new NativeOfficeError('INVALID_NATIVE_DOCUMENT', '原生文档身份或内容无效。');
    const existingId = this.documentSessions.get(value.documentId);
    if (existingId && existingId !== value.sessionId) throw new NativeOfficeError('NATIVE_DUPLICATE_WRITER', '同一文档只能有一个原生写入会话。');
    let record = this.sessions.get(value.sessionId);
    if (record && record.documentId !== value.documentId) throw new NativeOfficeError('NATIVE_SESSION_MISMATCH', '原生会话属于另一文档。');
    if (record?.promise) await record.promise;
    if (!record) { record = { documentId: value.documentId, viewIds: new Set() }; this.sessions.set(value.sessionId, record); this.documentSessions.set(value.documentId, value.sessionId); }
    const opening = this.request<NativeOfficeState>('open', { ...value, ...layout, bytes: Buffer.from(value.bytes).toString('base64') }, true); record.promise = opening;
    try { const state = await opening; record.viewIds.add(value.viewId); return state; }
    catch (error) { if (!record.viewIds.size) { this.sessions.delete(value.sessionId); this.documentSessions.delete(value.documentId); } throw error; }
    finally { if (record.promise === opening) record.promise = undefined; }
  }
  layout(sessionId: string, viewId: string, value: NativeOfficeLayout) { return this.request<NativeOfficeState>('layout', { sessionId, viewId, ...validateNativeOfficeLayout(value) }); }
  /** Updating preferences must not start Office when no Office document is open. */
  async setAppearance(value: NativeOfficeAppearance) {
    this.appearance = validateNativeOfficeAppearance(value);
    if (!this.starting || this.closed) return;
    const update = (this.appearanceUpdate ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.starting;
      const desired = { ...this.appearance };
      if (this.appliedAppearance?.theme === desired.theme && this.appliedAppearance.canvasColor === desired.canvasColor && this.appliedAppearance.paperColor === desired.paperColor) return;
      // The worker updates several profile nodes. A rejection can leave partial
      // changes, so even the previous configuration must be reapplied after it.
      this.appliedAppearance = undefined;
      const result = await this.request<AppearanceResult>('appearance', desired);
      this.appliedAppearance = desired;
      return result;
    });
    this.appearanceUpdate = update;
    try { return await update; } finally { if (this.appearanceUpdate === update) this.appearanceUpdate = undefined; }
  }
  state(sessionId: string, viewId?: string) { return this.request<NativeOfficeState>('state', { sessionId, viewId }); }
  private clearObservations() { this.observationGeneration++; this.observationReceipts.clear(); }
  /** Trusted host heartbeat only. Public state/query/snapshot and mutation guards always read fresh native state. */
  async observeState(sessionId: string, viewId: string): Promise<NativeOfficeObservation> {
    const result = await this.observeStateInside(sessionId, viewId);
    return { state: structuredClone(result.state), unchanged: result.unchanged };
  }
  /** Retains one independent immutable state only while the native receipt remains confirmed. */
  async observeStateForHost(sessionId: string, viewId: string): Promise<NativeOfficeHostObservation> {
    const result = await this.observeStateInside(sessionId, viewId), confirmed = result.confirmed;
    if (!confirmed || this.observationReceipts.get(JSON.stringify([sessionId, viewId])) !== confirmed) return { state: structuredClone(result.state), unchanged: result.unchanged };
    const host = confirmed.host ??= { state: immutableOfficeObservation(confirmed.state), identity: Object.freeze({}) };
    return { state: host.state, unchanged: result.unchanged, receipt: host.identity };
  }
  private observeStateInside(sessionId: string, viewId: string): Promise<ConfirmedObservation> {
    if (this.options.backend !== 'kit') return this.state(sessionId, viewId).then(state => ({ state, unchanged: false }));
    const key = JSON.stringify([sessionId, viewId]);
    // Two observers must not issue the same old receipt concurrently and then
    // replace each other's newer acknowledged state when their promises settle.
    const result = (this.observationTails.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const known = this.observationReceipts.get(key), generation = this.observationGeneration;
      const reply = await this.request<any>('observeState', { sessionId, viewId, ...(known ? { known: { token: known.token, lease: structuredClone(known.lease) } } : {}) });
      const reject = (): never => { this.observationReceipts.delete(key); throw new NativeOfficeError('INVALID_NATIVE_OBSERVATION', '原生后台观察回执的身份、版本或内容未能确认。'); };
      const lease = reply?.lease as ObservationLease | undefined;
      const documentId = this.sessions.get(sessionId)?.documentId;
      if (!reply || typeof reply.unchanged !== 'boolean' || !lease || typeof lease !== 'object' || Array.isArray(lease) || Object.keys(lease).length !== observationCounters.length + 4 || lease.sessionId !== sessionId || lease.viewId !== viewId || typeof lease.documentId !== 'string' || !lease.documentId || documentId && lease.documentId !== documentId || lease.engineEpoch !== this.engineEpoch || observationCounters.some(name => !Number.isSafeInteger(lease[name]) || lease[name] < 0) || known && observationCounters.some(name => lease[name] < known.lease[name]) || generation !== this.observationGeneration) return reject();
      const validToken = typeof reply.token === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reply.token);
      if (reply.unchanged) {
        if (!known || !validToken || reply.token !== known.token || reply.state !== undefined || Object.keys(lease).length !== Object.keys(known.lease).length || Object.keys(known.lease).some(name => lease[name as keyof ObservationLease] !== known.lease[name as keyof ObservationLease])) return reject();
        return { state: known.state, unchanged: true, confirmed: known };
      }
      const state = reply.state as NativeOfficeState & { eventSequence: number; layoutRevision: number; renderGeneration: number; surfaceKind: string; windows: unknown[] };
      if (!state || state.sessionId !== sessionId || state.viewId !== viewId || state.documentId !== lease.documentId || state.engineEpoch !== lease.engineEpoch || observationCounters.filter(name => name !== 'partGeometryGeneration').some(name => state[name] !== lease[name]) || state.status !== 'ready' || state.surfaceKind !== 'tiled' || !['docx', 'xlsx', 'pptx'].includes(state.format) || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.pendingInput !== 'boolean' || !state.selection || !['none', 'text', 'cells', 'objects'].includes(state.selection.kind) || typeof state.selection.text !== 'string' || !Array.isArray(state.windows) || reply.token !== undefined && (!validToken || state.pendingInput || state.windows.length > 0)) return reject();
      this.observationReceipts.delete(key);
      const confirmed = reply.token !== undefined ? { token: reply.token, lease: structuredClone(lease), state: structuredClone(state) } : undefined;
      if (confirmed) this.observationReceipts.set(key, confirmed);
      // Public observations clone this source; the Host receives a separate
      // frozen copy. Neither caller can mutate the private confirmed receipt.
      return { state: confirmed?.state ?? state, unchanged: false, confirmed };
    });
    this.observationTails.set(key, result);
    void result.finally(() => { if (this.observationTails.get(key) === result) this.observationTails.delete(key); }).catch(() => {});
    return result;
  }
  /** Explicit developer packaging step; never invoked by renderer/MCP or normal startup. */
  bootstrapSeed() { return this.request<{ directory:string;manifest:{schemaVersion:number;engineBuildId:string;mergedloSha256:string;registrationCatalogSha256:string;pathMode:string;files:{path:string;blob:string;bytes:number;sha256:string}[]} }>('bootstrapSeed',{}); }
  async snapshot(sessionId: string, viewId?: string, reuse?: NativeOfficeSnapshotReuse): Promise<NativeOfficeSnapshot> {
    const known = reuse && reuse.bytes instanceof Uint8Array && /^[a-f0-9]{64}$/.test(reuse.sha256) && typeof reuse.engineEpoch === 'string' && reuse.engineEpoch.length > 0 && Number.isSafeInteger(reuse.engineRevision) && reuse.engineRevision >= 0 ? { sha256: reuse.sha256, engineEpoch: reuse.engineEpoch, engineRevision: reuse.engineRevision } : undefined;
    const result = await this.request<any>('snapshot', { sessionId, viewId, ...(known ? { known } : {}) });
    if (!Number.isSafeInteger(result.engineRevisionAfter) || result.engineRevisionAfter < 0 || result.state?.sessionId !== sessionId || result.state?.engineEpoch !== this.engineEpoch || result.state?.engineRevision !== result.engineRevisionAfter || result.engineRevisionBefore !== result.engineRevisionAfter || known && result.engineRevisionAfter < known.engineRevision) throw new NativeOfficeError('SNAPSHOT_BUSY', '原生快照版本与来源未能一致确认。');
    if (result.unchanged === true && (!known || !reuse || result.bytes !== undefined || result.sha256 !== known.sha256 || result.state?.sessionId !== sessionId || result.state?.engineEpoch !== known.engineEpoch || result.state?.engineRevision !== known.engineRevision || result.state?.pendingInput !== false || result.engineRevisionAfter !== known.engineRevision)) throw new NativeOfficeError('SNAPSHOT_BUSY', '原生快照复用身份未能一致确认。');
    if (result.unchanged !== true && typeof result.bytes !== 'string') throw new NativeOfficeError('SNAPSHOT_BUSY', '原生快照缺少完整文件内容。');
    const bytes = result.unchanged === true ? reuse!.bytes : decodeNativeOfficeBytes(result.bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (result.stable !== true || result.engineRevisionBefore !== result.engineRevisionAfter || hash !== result.sha256) throw new NativeOfficeError('SNAPSHOT_BUSY', '原生快照版本未能一致确认。');
    const { unchanged: _wireOnly, ...snapshot } = result;
    return { ...snapshot, bytes, sha256: hash };
  }
  async commands(sessionId: string, viewId: string) {
    const key = sessionId + ':' + viewId;
    let pending = this.commandCatalogs.get(key);
    if (!pending) {
      pending = this.request<{ commands: { command: string; label?: string; group?: number }[] }>('commands', { sessionId, viewId }).then(result => result.commands);
      this.commandCatalogs.set(key, pending);
      void pending.catch(() => { if (this.commandCatalogs.get(key) === pending) this.commandCatalogs.delete(key); });
    }
    return structuredClone(await pending);
  }
  async commandStatus(sessionId: string, viewId: string, command: string): Promise<NativeOfficeCommandStatus> {
    if (!/^\.uno:[A-Za-z][A-Za-z0-9_]{0,99}$/.test(command)) throw new NativeOfficeError('INVALID_NATIVE_COMMAND', '原生命令名称无效。');
    // A read-only availability query describes managed commands without executing
    // them or passing through mutation authorization.
    const policy = nativeOfficeCommandPolicy(command);
    if (policy.blocked) return { command, available: false, enabled: false, reason: policy.reason };
    return this.request<NativeOfficeCommandStatus>('commandStatus', { sessionId, viewId, command });
  }
  /** One UI turn for visible command controls; never cache enabled/state values. */
  async commandStatuses(sessionId: string, viewId: string, commands: string[]): Promise<NativeOfficeCommandStatus[]> {
    if (!Array.isArray(commands) || commands.length > 50 || commands.some(command => typeof command !== 'string' || !/^\.uno:[A-Za-z][A-Za-z0-9_]{0,99}$/.test(command))) throw new NativeOfficeError('INVALID_NATIVE_COMMAND', '原生命令名称或查询数量无效。');
    const local = new Map<string, NativeOfficeCommandStatus>(), wanted: string[] = [];
    for (const command of new Set(commands)) {
      const policy = nativeOfficeCommandPolicy(command);
      if (policy.blocked) local.set(command, { command, available: false, enabled: false, reason: policy.reason });
      else wanted.push(command);
    }
    if (wanted.length) {
      if (this.options.backend !== 'kit') {
        // Older HWND workers retain their established single-command protocol.
        const results = await Promise.all(wanted.map(command => this.commandStatus(sessionId, viewId, command)));
        for (const result of results) local.set(result.command, result);
      } else {
        const result = await this.request<{ sessionId: string; viewId: string; engineEpoch: string; engineRevision: number; selectionEpoch: number; commands: NativeOfficeCommandStatus[] }>('commandStatuses', { sessionId, viewId, commands: wanted });
        if (result?.sessionId !== sessionId || result.viewId !== viewId || result.engineEpoch !== this.engineEpoch || !Number.isSafeInteger(result.engineRevision) || result.engineRevision < 0 || !Number.isSafeInteger(result.selectionEpoch) || result.selectionEpoch < 0 || !Array.isArray(result.commands) || result.commands.length !== wanted.length || result.commands.some((status, index) => status?.command !== wanted[index] || typeof status.available !== 'boolean' || typeof status.enabled !== 'boolean' || status.state != null && !['string','number','boolean'].includes(typeof status.state) || typeof status.state === 'number' && !Number.isFinite(status.state))) throw new NativeOfficeError('INVALID_NATIVE_COMMAND_STATUS', '原生命令状态回执的身份或内容无效。');
        for (const status of result.commands) local.set(status.command, status);
      }
    }
    return commands.map(command => local.get(command)!);
  }
  query(sessionId: string, viewId: string, target: NativeOfficeQuery) { return this.request<unknown>('query', { sessionId, viewId, target }); }
  async inspect(sessionId: string, viewId: string, request: { target?: import('../../contracts/src/native-office').NativeOfficeQuery; commands?: string[] }): Promise<import('../../contracts/src/native-office').NativeOfficeInspection> {
    if (request.commands && (request.commands.length > 50 || request.commands.some(command => !/^\.uno:[A-Za-z][A-Za-z0-9_]{0,99}$/.test(command)))) throw new NativeOfficeError('INVALID_NATIVE_COMMAND', '原生命令名称或查询数量无效。');
    if (this.options.backend !== 'kit') {
      const before = await this.state(sessionId, viewId), data = request.target ? await this.query(sessionId, viewId, request.target) : undefined, commands = request.commands ? await this.commandStatuses(sessionId, viewId, request.commands) : undefined, state = await this.state(sessionId, viewId);
      if (before.engineEpoch !== state.engineEpoch || before.engineRevision !== state.engineRevision || before.selectionEpoch !== state.selectionEpoch) throw new NativeOfficeError('SELECTION_CHANGED', '读取期间选区已变化，请重新读取。');
      return { state, data, commands };
    }
    const result = await this.request<import('../../contracts/src/native-office').NativeOfficeInspection>('inspect', { sessionId, viewId, ...request });
    if (!result?.state || result.state.sessionId !== sessionId || result.state.viewId !== viewId || result.state.engineEpoch !== this.engineEpoch || !Number.isSafeInteger(result.state.engineRevision) || !Number.isSafeInteger(result.state.selectionEpoch) || request.commands && (!Array.isArray(result.commands) || result.commands.length !== request.commands.length || result.commands.some((item, index) => item.command !== request.commands![index]))) throw new NativeOfficeError('INVALID_NATIVE_OBSERVATION', '原生属性回执身份与选区未能确认。');
    return result;
  }
  dispatch(sessionId: string, viewId: string, value: NativeOfficeDispatch) { return this.request<NativeOfficeExecution>('dispatch', { sessionId, viewId, ...validateNativeOfficeDispatch(value), expectedEngineEpoch: this.engineEpoch }, true); }
  execute(value: NativeOfficeExecuteRequest) {
    if (value.command) validateNativeOfficeDispatch({ command: value.command, args: Object.fromEntries((value.args ?? []).map((p: UNOProperty) => [p.name, p.value])), expectedEngineRevision: value.expectedEngineRevision, expectedSelectionEpoch: value.expectedSelectionEpoch });
    return this.request<NativeOfficeExecution>('execute', { ...value }, true);
  }
  undo(value: { sessionId: string; viewId: string; expectedEngineEpoch: string; expectedEngineRevision: number; undoToken: string; actor?: Actor }) { return this.request<NativeOfficeExecution>('undo', value, true); }
  navigate(value: { sessionId: string; viewId: string; target: NativeOfficeNavigateTarget; expectedEngineEpoch: string; expectedEngineRevision: number; expectedSelectionEpoch?: number; requestId: string; actor?: Actor }) { return this.request<{ status: 'requested' | 'rendered'; state: NativeOfficeState }>('navigate', value); }
  async exportCopy(sessionId: string, value: { format: NativeOfficeExportFormat; expectedEngineEpoch: string; expectedEngineRevision: number }) {
    const result = await this.request<any>('exportCopy', { sessionId, ...value }); const bytes = decodeNativeOfficeBytes(result.bytes); const hash = createHash('sha256').update(bytes).digest('hex');
    if (!result.stable || result.engineRevisionBefore !== result.engineRevisionAfter || hash !== result.sha256) throw new NativeOfficeError('SNAPSHOT_BUSY', '原生导出版本不一致。');
    return { ...result, bytes, format: value.format, sha256: hash } as { bytes: Uint8Array; format: NativeOfficeExportFormat; state: NativeOfficeState; engineRevisionBefore: number; engineRevisionAfter: number; stable: boolean; sha256: string };
  }
  setOverlayOwner(value: { sessionId: string; viewId?: string; hwnd: string }) {
    if (!/^[1-9]\d{0,19}$/.test(value.hwnd)) return Promise.reject(new NativeOfficeError('INVALID_NATIVE_OVERLAY', '原生浮层身份无效。'));
    return this.request<void>('overlayOwner', value);
  }
  detachView(sessionId: string, viewId: string) { this.clearObservations(); return this.request<void>('detachView', { sessionId, viewId }).finally(() => { this.clearObservations(); this.commandCatalogs.delete(sessionId + ':' + viewId); }); }
  zoom(sessionId: string, viewId: string, factor: number) {
    if (!Number.isFinite(factor) || factor < .25 || factor > 4) return Promise.reject(new NativeOfficeError('INVALID_NATIVE_ZOOM', '原生缩放比例无效。'));
    return this.request<NativeOfficeState>('zoom', { sessionId, viewId, factor });
  }
  input(value: NativeOfficeInputRequest) { return this.request<{ state: NativeOfficeState }>('input', { ...value, action: browserActionSchema.parse(value.action) }, true); }
  async ackSaved(sessionId: string, value: { engineEpoch: string; engineRevision: number; hash: string }) { const result = await this.request<{ accepted: boolean }>('ackSaved', { sessionId, ...value }); return result.accepted; }
  capture(sessionId: string, viewId: string, rect?: Rect) {
    if (rect && (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0)) return Promise.reject(new NativeOfficeError('INVALID_CAPTURE_RECT', '原生截图区域无效。'));
    return this.request<NativeOfficeCapture>('capture', { sessionId, viewId, rect });
  }
  async close(sessionId: string, options: { discard?: boolean } = {}) {
    this.clearObservations();
    await this.request('close', { sessionId, discard: options.discard === true }); const record = this.sessions.get(sessionId); this.sessions.delete(sessionId); if (record) this.documentSessions.delete(record.documentId);
    for (const key of this.commandCatalogs.keys()) if (key.startsWith(sessionId + ':')) this.commandCatalogs.delete(key);
    this.clearObservations();
  }
  surfaceLayout(sessionId: string, value: OfficeSurfaceLayoutRequest) { return this.request<OfficeSurfaceState>('surfaceLayout', { sessionId, ...value }); }
  /** The trusted display host enables semantic projection only after real pixels were presented. */
  async enableContextProjection(sessionId: string, viewId: string) {
    if (this.options.backend !== 'kit') return;
    return this.request<{ sessionId: string; viewId: string; engineEpoch: string; enabled: true }>('enableContextProjection', { sessionId, viewId });
  }
  async surfaceTiles(sessionId: string, value: OfficeSurfaceTilesRequest): Promise<OfficeSurfaceTilesReply> {
    const result = await this.request<any>('surfaceTiles', { sessionId, ...value });
    return { ...result, tiles: result.tiles.map((tile: any) => ({ ...tile, data: this.binaryReader ? tile.data : decodeNativeOfficeBytes(tile.data) })) };
  }
  surfaceInput(sessionId: string, value: OfficeSurfaceInputRequest) {
    const event = value.event.kind === 'paste' ? { ...value.event, items: value.event.items.map(item => ({ ...item, data: Buffer.from(item.data).toString('base64') })) } : value.event;
    return this.request<OfficeSurfaceInputReply>('surfaceInput', { sessionId, ...value, event }, true);
  }
  async surfaceWindowPaint(value: OfficeSurfaceWindowPaintRequest): Promise<OfficeSurfaceWindowPaintReply> {
    const result = await this.request<any>('surfaceWindowPaint', value);
    return { ...result, tile: { ...result.tile, data: this.binaryReader ? result.tile.data : decodeNativeOfficeBytes(result.tile.data) } };
  }
  surfaceWindowInput(value: OfficeSurfaceWindowInputRequest) {
    const event = value.event.kind === 'paste' ? { ...value.event, items: value.event.items.map(item => ({ ...item, data: Buffer.from(item.data).toString('base64') })) } : value.event;
    return this.request<OfficeSurfaceInputReply>('surfaceWindowInput', { ...value, event }, true);
  }
  surfaceWindowClose(value: OfficeSurfaceWindowCloseRequest) { return this.request<OfficeSurfaceState>('surfaceWindowClose', value, true); }
  surfaceWindowClipboard(value: OfficeSurfaceWindowIdentity) { return this.request<any>('surfaceWindowClipboard', value); }
  surfaceWindowControls(value: OfficeSurfaceWindowIdentity) { return this.request<OfficeSurfaceWindowControlsReply>('surfaceWindowControls', value); }
  surfaceWindowAction(value: OfficeSurfaceWindowActionRequest) { return this.request<OfficeSurfaceWindowActionReply>('surfaceWindowAction', value, true); }
  async shutdown(options: { discard?: boolean } = {}) {
    this.clearObservations();
    // A confirmed bridge exit is already terminal. Recovery bytes remain in workerDirectory;
    // asking the dead process to shut down again must not prevent the application from exiting.
    if (this.closed) return;
    if (!this.worker && !this.starting) { this.closed = true; return; }
    await this.request('shutdown', { discard: options.discard === true }); this.rpc?.end();
  }
}
