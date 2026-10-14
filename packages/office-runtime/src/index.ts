import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import type { Writable } from 'node:stream';
import { libreOfficeExecutable } from '../../engines/src/index';
import type { Rect, Actor, NativeOfficeQuery, NativeOfficeExecuteRequest, NativeOfficeExecution, UNOProperty, NativeOfficeNavigateTarget, NativeOfficeExportFormat, NativeOfficeInputRequest } from '../../contracts/src/index';
import { browserActionSchema } from '../../contracts/src/index';
import { nativeOfficeCommandPolicy } from '../../contracts/src/native-office-policy';
import { nativeOfficeWorkerSource } from './worker-source';
import { officeKitWorkerSource } from './kit-worker-source';
import type { OfficeSurfaceState, OfficeSurfaceLayoutRequest, OfficeSurfaceTilesRequest, OfficeSurfaceTilesReply, OfficeSurfaceInputRequest, OfficeSurfaceInputReply, OfficeSurfaceWindowPaintRequest, OfficeSurfaceWindowPaintReply, OfficeSurfaceWindowInputRequest, OfficeSurfaceWindowCloseRequest, OfficeSurfaceWindowIdentity } from '../../contracts/src/office-surface';
import { NativeOfficeProtocolReader, validateNativeOfficeDispatch, validateNativeOfficeLayout } from './protocol';
import { validateNativeOfficeAppearance, type NativeOfficeAppearance } from './appearance';
import { NativeOfficeError, type NativeOfficeState, type NativeOfficeOpen, type NativeOfficeRuntimeOptions, type NativeOfficeLayout, type NativeOfficeSnapshot, type NativeOfficeCapture, type NativeOfficeDispatch, type NativeOfficeCommandStatus } from './types';
export * from './types';

interface Pending { resolve: (value: any) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
interface OpenRecord { documentId: string; viewIds: Set<string>; promise?: Promise<NativeOfficeState> }
interface AppearanceResult { theme: string; canvasColor: number; whiteDocumentBackground: boolean }
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
  private appearance: NativeOfficeAppearance;
  private appliedAppearance?: NativeOfficeAppearance;
  private appearanceUpdate?: Promise<AppearanceResult | undefined>;
  private timings: Record<string, { count: number; completed: number; totalMs: number; maximumMs: number }> = {};
  get statistics() { return { started: !!this.worker, pending: this.pending.size, methods: structuredClone(this.timings) }; }
  readonly workerDirectory: string;
  constructor(readonly options: NativeOfficeWorkerOptions) {
    super(); this.workerDirectory = join(resolve(options.dataDir), 'native-office', randomUUID());
    this.appearance = validateNativeOfficeAppearance(options.appearance ?? { theme: 'light', canvasColor: 0xf7f5f2 });
  }
  private async start() {
    if (this.closed) throw new NativeOfficeError('NATIVE_RUNTIME_CLOSED', '原生编辑器运行时已经关闭。');
    if (this.starting) return this.starting;
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
        const endpoint = await this.createKitEndpoint();
        Object.assign(env, { PYTHONHOME: dirname(dirname(python)), PYTHONPATH: program, PYTHONDONTWRITEBYTECODE:'1', PATH: program + ';' + (process.env.PATH ?? ''), AGENTVIEWER_OFFICE_KIT_CONFIG: JSON.stringify({ directory: this.workerDirectory, program, appearance: startupAppearance, adapterPath, bootstrapSeedPath:this.options.bootstrapSeedPath ?? join(dirname(adapterPath),'office-kit-bootstrap'), rpc: endpoint }) });
      }
      const worker = this.options.createWorker?.(python, args) ?? spawn(python, args, { windowsHide: true, stdio: 'pipe', env });
      this.worker = worker; worker.stdout.setEncoding('utf8'); worker.stdout.on('data', chunk => { try { reader.feed(String(chunk)); } catch (error) { this.failPending(error); } });
      if (kit) worker.stdin.end(officeKitWorkerSource); else this.rpc = worker.stdin;
      // Drain errors without placing user document text or local profile paths in normal logs.
      worker.stderr.on('data', () => { this.emit('diagnostic', { code: 'NATIVE_WORKER_STDERR' }); });
      worker.once('error', () => { const error = new NativeOfficeError('NATIVE_WORKER_FAILED', '原生编辑器桥接未能启动。'); this.readyReject?.(error); this.failPending(error); });
      worker.once('exit', () => { reader.clear(); this.closed = true; this.kitServer?.close(); this.kitSocket?.destroy(); const error = new NativeOfficeError('NATIVE_WORKER_EXITED', '原生编辑器桥接已经退出。'); this.readyReject?.(error); this.failPending(error); this.emit('exit'); });
      const timer = setTimeout(() => { this.uncertain = true; this.readyReject?.(new NativeOfficeError('NATIVE_STARTUP_TIMEOUT', '原生编辑器启动超时，专用恢复目录已保留。')); }, this.options.requestTimeoutMs ?? 120000);
      try { await readiness; if (!this.rpc) throw new NativeOfficeError('OFFICE_KIT_NOT_AUTHENTICATED', '内嵌 Office 连接未能确认。'); this.appliedAppearance = startupAppearance; } finally { clearTimeout(timer); this.kitServer?.close(); this.readyResolve = undefined; this.readyReject = undefined; }
    })();
    return this.starting;
  }
  private async createKitEndpoint() {
    const token = randomUUID() + randomUUID();
    const server = createServer(socket => {
      let line = ''; const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
      const authenticate = (chunk: Buffer) => {
        line += chunk.toString('utf8');
        if (line.length > 4096) { clearTimeout(timer); socket.destroy(); return; }
        const end = line.indexOf('\n'); if (end < 0) return;
        clearTimeout(timer); socket.removeListener('data', authenticate);
        let message: any; try { message = JSON.parse(line.slice(0, end)); } catch { socket.destroy(); return; }
        if (message?.type !== 'auth' || message.token !== token || this.kitSocket) { socket.destroy(); return; }
        this.kitSocket = socket; this.rpc = socket; socket.setNoDelay(true); server.close();
        socket.on('error', () => this.failPending(new NativeOfficeError('NATIVE_CONNECTION_LOST', '内嵌 Office 连接已中断。')));
        socket.on('close', () => { if (!this.closed) this.failPending(new NativeOfficeError('NATIVE_CONNECTION_LOST', '内嵌 Office 连接已中断。')); });
      };
      socket.on('data', authenticate);
      socket.on('error', () => { clearTimeout(timer); });
    });
    this.kitServer = server;
    await new Promise<void>((resolveServer, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolveServer(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('OFFICE_KIT_ENDPOINT_FAILED');
    return { host: '127.0.0.1', port: address.port, token };
  }
  private receive(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, any>;
    if (message.type === 'ready') { this.engineEpoch = String(message.engineEpoch); this.readyResolve?.(); return; }
    if (message.type === 'startup-error') { this.readyReject?.(new NativeOfficeError('NATIVE_STARTUP_FAILED', '原生编辑器启动失败。')); return; }
    if (message.type) { this.emit(message.type, message); return; }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new NativeOfficeError(typeof message.error?.code === 'string' ? message.error.code : 'NATIVE_ENGINE_ERROR', typeof message.error?.message === 'string' ? message.error.message : '原生编辑器操作失败。'));
  }
  private failPending(error: unknown) {
    this.uncertain = true;
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); }
    this.pending.clear();
  }
  private async request<T>(method: string, args: Record<string, unknown>, mutation = false): Promise<T> {
    await this.start();
    if (!this.worker || this.closed) throw new NativeOfficeError('NATIVE_WORKER_EXITED', '原生编辑器桥接已经退出。');
    if (mutation && this.uncertain) throw new NativeOfficeError('NATIVE_OUTCOME_UNKNOWN', '上一原生操作尚未确认，请保留恢复内容并重新读取。');
    const id = randomUUID();
    const metrics = this.timings[method] ??= { count: 0, completed: 0, totalMs: 0, maximumMs: 0 }, started = performance.now(); metrics.count++;
    return new Promise<T>((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); if (mutation) this.uncertain = true; reject(new NativeOfficeError('NATIVE_REQUEST_TIMEOUT', '原生操作超时；不会自动重复执行修改。')); }, this.options.requestTimeoutMs ?? 120000);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.rpc!.write(JSON.stringify({ id, method, args }) + '\n', error => {
        if (!error) return; const entry = this.pending.get(id); if (!entry) return; clearTimeout(entry.timer); this.pending.delete(id); if (mutation) this.uncertain = true; entry.reject(new NativeOfficeError('NATIVE_CONNECTION_LOST', '原生编辑器连接已中断。'));
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
  /** Explicit developer packaging step; never invoked by renderer/MCP or normal startup. */
  bootstrapSeed() { return this.request<{ directory:string;manifest:{schemaVersion:number;engineBuildId:string;mergedloSha256:string;registrationCatalogSha256:string;pathMode:string;files:{path:string;blob:string;bytes:number;sha256:string}[]} }>('bootstrapSeed',{}); }
  async snapshot(sessionId: string, viewId?: string): Promise<NativeOfficeSnapshot> {
    const result = await this.request<any>('snapshot', { sessionId, viewId }); const bytes = new Uint8Array(Buffer.from(result.bytes, 'base64'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (result.stable !== true || result.engineRevisionBefore !== result.engineRevisionAfter || hash !== result.sha256) throw new NativeOfficeError('SNAPSHOT_BUSY', '原生快照版本未能一致确认。');
    return { ...result, bytes, sha256: hash };
  }
  async commands(sessionId: string, viewId: string) { const result = await this.request<{ commands: { command: string; label?: string; group?: number }[] }>('commands', { sessionId, viewId }); return result.commands; }
  async commandStatus(sessionId: string, viewId: string, command: string): Promise<NativeOfficeCommandStatus> {
    if (!/^\.uno:[A-Za-z][A-Za-z0-9_]{0,99}$/.test(command)) throw new NativeOfficeError('INVALID_NATIVE_COMMAND', '原生命令名称无效。');
    // A read-only availability query describes managed commands without executing
    // them or passing through mutation authorization.
    const policy = nativeOfficeCommandPolicy(command);
    if (policy.blocked) return { command, available: false, enabled: false, reason: policy.reason };
    return this.request<NativeOfficeCommandStatus>('commandStatus', { sessionId, viewId, command });
  }
  query(sessionId: string, viewId: string, target: NativeOfficeQuery) { return this.request<unknown>('query', { sessionId, viewId, target }); }
  dispatch(sessionId: string, viewId: string, value: NativeOfficeDispatch) { return this.request<NativeOfficeExecution>('dispatch', { sessionId, viewId, ...validateNativeOfficeDispatch(value), expectedEngineEpoch: this.engineEpoch }, true); }
  execute(value: NativeOfficeExecuteRequest) {
    if (value.command) validateNativeOfficeDispatch({ command: value.command, args: Object.fromEntries((value.args ?? []).map((p: UNOProperty) => [p.name, p.value])), expectedEngineRevision: value.expectedEngineRevision, expectedSelectionEpoch: value.expectedSelectionEpoch });
    return this.request<NativeOfficeExecution>('execute', { ...value }, true);
  }
  undo(value: { sessionId: string; viewId: string; expectedEngineEpoch: string; expectedEngineRevision: number; undoToken: string; actor?: Actor }) { return this.request<NativeOfficeExecution>('undo', value, true); }
  navigate(value: { sessionId: string; viewId: string; target: NativeOfficeNavigateTarget; expectedEngineEpoch: string; expectedEngineRevision: number; expectedSelectionEpoch?: number; requestId: string; actor?: Actor }) { return this.request<{ status: 'requested' | 'rendered'; state: NativeOfficeState }>('navigate', value); }
  async exportCopy(sessionId: string, value: { format: NativeOfficeExportFormat; expectedEngineEpoch: string; expectedEngineRevision: number }) {
    const result = await this.request<any>('exportCopy', { sessionId, ...value }); const bytes = new Uint8Array(Buffer.from(result.bytes, 'base64')); const hash = createHash('sha256').update(bytes).digest('hex');
    if (!result.stable || result.engineRevisionBefore !== result.engineRevisionAfter || hash !== result.sha256) throw new NativeOfficeError('SNAPSHOT_BUSY', '原生导出版本不一致。');
    return { ...result, bytes, format: value.format, sha256: hash } as { bytes: Uint8Array; format: NativeOfficeExportFormat; state: NativeOfficeState; engineRevisionBefore: number; engineRevisionAfter: number; stable: boolean; sha256: string };
  }
  setOverlayOwner(value: { sessionId: string; viewId?: string; hwnd: string }) {
    if (!/^[1-9]\d{0,19}$/.test(value.hwnd)) return Promise.reject(new NativeOfficeError('INVALID_NATIVE_OVERLAY', '原生浮层身份无效。'));
    return this.request<void>('overlayOwner', value);
  }
  detachView(sessionId: string, viewId: string) { return this.request<void>('detachView', { sessionId, viewId }); }
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
    await this.request('close', { sessionId, discard: options.discard === true }); const record = this.sessions.get(sessionId); this.sessions.delete(sessionId); if (record) this.documentSessions.delete(record.documentId);
  }
  surfaceLayout(sessionId: string, value: OfficeSurfaceLayoutRequest) { return this.request<OfficeSurfaceState>('surfaceLayout', { sessionId, ...value }); }
  async surfaceTiles(sessionId: string, value: OfficeSurfaceTilesRequest): Promise<OfficeSurfaceTilesReply> {
    const result = await this.request<any>('surfaceTiles', { sessionId, ...value });
    return { ...result, tiles: result.tiles.map((tile: any) => ({ ...tile, data: new Uint8Array(Buffer.from(tile.data, 'base64')) })) };
  }
  surfaceInput(sessionId: string, value: OfficeSurfaceInputRequest) {
    const event = value.event.kind === 'paste' ? { ...value.event, items: value.event.items.map(item => ({ ...item, data: Buffer.from(item.data).toString('base64') })) } : value.event;
    return this.request<OfficeSurfaceInputReply>('surfaceInput', { sessionId, ...value, event }, true);
  }
  async surfaceWindowPaint(value: OfficeSurfaceWindowPaintRequest): Promise<OfficeSurfaceWindowPaintReply> {
    const result = await this.request<any>('surfaceWindowPaint', value);
    return { ...result, tile: { ...result.tile, data: new Uint8Array(Buffer.from(result.tile.data, 'base64')) } };
  }
  surfaceWindowInput(value: OfficeSurfaceWindowInputRequest) {
    const event = value.event.kind === 'paste' ? { ...value.event, items: value.event.items.map(item => ({ ...item, data: Buffer.from(item.data).toString('base64') })) } : value.event;
    return this.request<OfficeSurfaceInputReply>('surfaceWindowInput', { ...value, event }, true);
  }
  surfaceWindowClose(value: OfficeSurfaceWindowCloseRequest) { return this.request<OfficeSurfaceState>('surfaceWindowClose', value, true); }
  surfaceWindowClipboard(value: OfficeSurfaceWindowIdentity) { return this.request<any>('surfaceWindowClipboard', value); }
  async shutdown(options: { discard?: boolean } = {}) {
    // A confirmed bridge exit is already terminal. Recovery bytes remain in workerDirectory;
    // asking the dead process to shut down again must not prevent the application from exiting.
    if (this.closed) return;
    if (!this.worker && !this.starting) { this.closed = true; return; }
    await this.request('shutdown', { discard: options.discard === true }); this.rpc?.end();
  }
}
