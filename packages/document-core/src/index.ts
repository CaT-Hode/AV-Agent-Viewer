import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import type { Actor, BrowserRequest, BrowserRuntime, DocumentInfo, EditOperation, Format, HarnessDriver, HarnessTask, PreparedPatch, ReadingContext, ReadingSnapshot, Receipt, ViewInfo, WorkspaceState } from '../../contracts/src/index';
import { PROTOCOL_VERSION, ViewerError, editOperationSchema, browserRequestSchema, normalizeWebAddress } from '../../contracts/src/index';
import { AdapterRegistry, createRegistry } from '../../format-adapters/src/index';
import type { WorkspaceRepository } from '../../persistence/src/index';
import { convertLegacy } from '../../../apps/office-gateway/src/conversion';
import { scopedReadingSnapshot, type ScopedReadingSnapshot } from '../../ai-reading-tools/src/index';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
interface InternalDocument { info: DocumentInfo; bytes: Uint8Array; sourceHash?: string }
import type { Annotation } from '../../selection-tools/src/index';
interface StoredWorkspace { annotations?: Annotation[]; schemaVersion: string; documents: { info: DocumentInfo; bytes: string; sourceHash?: string }[]; views: ViewInfo[]; activeViewId?: string; lastHumanViewId?: string; receipts?: [string, { payload: string; receipt: unknown }][]; patches?: [string, PreparedPatch][] }
interface UndoEntry { documentId: string; before: InternalDocument; afterRevision: number }

export class ViewerCore extends EventEmitter {
  readonly annotations = new Map<string, Annotation>();
  readonly extensions = new Map<string, (args: Record<string, any>, actor: Actor) => Promise<unknown>>();
  readonly documents = new Map<string, InternalDocument>();
  readonly views = new Map<string, ViewInfo>();
  readonly snapshots = new Map<string, ReadingSnapshot>();
  readonly patches = new Map<string, PreparedPatch>();
  readonly transactions = new Map<string, UndoEntry>();
  readonly tasks = new Map<string, HarnessTask>();
  readonly drivers = new Map<string, HarnessDriver>();
  readonly receipts = new Map<string, { payload: string; receipt: unknown }>();
  readonly agentControl = new Map<string, 'running' | 'paused' | 'stopped'>();
  readonly eventLog: { seq: number; type: string; time: string; data: unknown }[] = [];
  browser?: BrowserRuntime;
  activeViewId?: string;
  lastHumanViewId?: string;
  private taskControllers = new Map<string, AbortController>();
  private queues = new Map<string, Promise<unknown>>();
  private saveTimer?: NodeJS.Timeout;
  lastPersistenceError?: string;
  constructor(readonly repository: WorkspaceRepository, readonly registry: AdapterRegistry = createRegistry()) { super(); }
  async initialize() {
    const saved = await this.repository.load<StoredWorkspace>();
    if (!saved) return;
    if (saved.schemaVersion !== PROTOCOL_VERSION) throw new ViewerError('SCHEMA_MISMATCH', '工作区版本不兼容，原恢复文件保留。');
    for (const entry of saved.documents) this.documents.set(entry.info.id, { info: entry.info, bytes: new Uint8Array(Buffer.from(entry.bytes, 'base64')), sourceHash: entry.sourceHash });
    for (const entry of this.documents.values()) if (entry.info.format !== 'web') entry.info.capabilities = this.registry.resolve(entry.info.format).capabilities(entry.info.format);
    for (const view of saved.views) this.views.set(view.id, { ...view, windowId: 'main', context: view.context ? { ...view.context, quality: 'last-confirmed' } : undefined });
    for (const annotation of saved.annotations ?? []) this.annotations.set(annotation.id, annotation);
    this.activeViewId = saved.activeViewId;
    this.lastHumanViewId = saved.lastHumanViewId;
    for (const [id, receipt] of saved.receipts ?? []) this.receipts.set(id, receipt);
    for (const [id, patch] of saved.patches ?? []) this.patches.set(id, patch);
  }
  state(): WorkspaceState { return clone({ protocolVersion: PROTOCOL_VERSION, documents: [...this.documents.values()].map(d => d.info), views: [...this.views.values()], activeViewId: this.activeViewId, eventsSeq: this.eventLog.at(-1)?.seq ?? 0, tasks: [...this.tasks.values()] }); }
  event(type: string, data: unknown) {
    const event = { seq: (this.eventLog.at(-1)?.seq ?? 0) + 1, type, time: new Date().toISOString(), data };
    this.eventLog.push(event); if (this.eventLog.length > 1000) this.eventLog.shift(); this.emit('change', event);
    if (!type.startsWith('harness.')) { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { void this.persist().catch(e => { this.lastPersistenceError = String(e); this.emit('diagnostic', e); }); }, 300); }
  }
  async persist() {
    clearTimeout(this.saveTimer);
    const value: StoredWorkspace = { annotations: [...this.annotations.values()], schemaVersion: PROTOCOL_VERSION, documents: [...this.documents.values()].map(d => ({ info: d.info, bytes: Buffer.from(d.bytes).toString('base64'), sourceHash: d.sourceHash })), views: [...this.views.values()], activeViewId: this.activeViewId, lastHumanViewId: this.lastHumanViewId, receipts: [...this.receipts.entries()].slice(-1000), patches: [...this.patches.entries()].slice(-1000) };
    await this.repository.save(value); this.lastPersistenceError = undefined;
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn); this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
    return next;
  }
  getDocument(id: string) { const document = this.documents.get(id); if (!document) throw new ViewerError('TARGET_NOT_FOUND', '文档已关闭或不存在。'); return document; }
  getView(id?: string) {
    const target = id ?? this.lastHumanViewId ?? this.activeViewId;
    const view = target && this.views.get(target);
    if (!view) throw new ViewerError('TARGET_NOT_FOUND', '没有有效阅读视图。请打开文档或指定 viewId。');
    return view;
  }
  async openFile(path: string, windowId = 'main', activate = true) {
    const fullPath = resolve(path);
    const existing = [...this.documents.values()].find(d => d.info.path?.toLowerCase() === fullPath.toLowerCase());
    if (existing) return this.addView(existing.info.id, windowId, activate);
    const bytes = new Uint8Array(await readFile(fullPath));
    if (bytes.byteLength > 100 * 1024 * 1024) throw new ViewerError('FILE_TOO_LARGE', '首版单文件上限为 100 MB。');
    const extension = extname(fullPath).slice(1).toLowerCase();
    if (['doc', 'ppt', 'xls'].includes(extension)) {
      const converted = await convertLegacy(fullPath, extension);
      const view = await this.openBytes(basename(fullPath).replace(/\.[^.]+$/, '.' + converted.format), converted.bytes, converted.format as Format, undefined, windowId, activate);
      this.getDocument(view.documentId).info.warnings.push(...converted.warnings, `原件：${fullPath}`);
      return view;
    }
    const format = ({ md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', pdf: 'pdf' } as Record<string, Format>)[extension];
    if (!format) throw new ViewerError('CAPABILITY_UNSUPPORTED', `暂不支持 .${extension}。`);
    return this.openBytes(basename(fullPath), bytes, format, fullPath, windowId, activate);
  }
  async openBytes(title: string, bytes: Uint8Array, format: Format, path?: string, windowId = 'main', activate = true) {
    const adapter = this.registry.resolve(format), model = await adapter.open(bytes, format), id = randomUUID();
    this.documents.set(id, { bytes: bytes.slice(), sourceHash: path ? hash(bytes) : undefined, info: { id, title, path, format, revision: 0, diskRevision: path ? 0 : -1, dirty: !path, capabilities: adapter.capabilities(format), model, warnings: [] } });
    return this.addView(id, windowId, activate);
  }
  async importArtifact(path: string, bytes: Uint8Array, format: Format) {
    const fullPath = resolve(path), adapter = this.registry.resolve(format), id = randomUUID();
    const info: DocumentInfo = { id, title: basename(fullPath), path: fullPath, format, revision: 0, diskRevision: 0, dirty: false, capabilities: adapter.capabilities(format), model: await adapter.open(bytes, format), warnings: [] };
    this.documents.set(id, { info, bytes: bytes.slice(), sourceHash: hash(bytes) });
    this.event('document.imported', { documentId: id, path: fullPath });
    await this.persist(); return clone(info);
  }
  addView(documentId: string, windowId = 'main', activate = true) {
    this.getDocument(documentId);
    const view: ViewInfo = { id: randomUUID(), documentId, windowId, mode: 'read', pinned: false };
    this.views.set(view.id, view); if (activate) this.activeViewId = view.id; this.event('view.opened', view); return clone(view);
  }
  async openWeb(url: string, windowId = 'main', activate = true) {
    const normalized = normalizeWebAddress(url);
    if (!normalized) throw new ViewerError('INVALID_URL', '请输入有效的 HTTP(S) 网页地址。');
    url = normalized;
    const parsed = new URL(url);
    const id = randomUUID();
    this.documents.set(id, { bytes: new Uint8Array(), info: { id, title: parsed.hostname, format: 'web', revision: 0, diskRevision: 0, dirty: false, model: { format: 'web', url }, warnings: [], capabilities: { engine: this.browser ? 'electron-chromium' : 'preview-iframe', protocolVersion: PROTOCOL_VERSION, readText: !!this.browser, readSelection: !!this.browser, readViewport: !!this.browser, editKinds: [], saveFormats: ['html'], browserInput: !!this.browser, limitations: this.browser ? ['实时网页操作影响当前站点；持久编辑请建立阅读副本。', '正文提取当前仅顶层 frame。'] : ['原生网页输入与跨站上下文需在桌面应用使用。'] } } });
    const view = this.addView(id, windowId, activate); if (this.browser) await this.browser.open(view.id, url); return view;
  }
  activate(viewId: string, actor: Actor = 'human') { this.getView(viewId); this.activeViewId = viewId; if (actor === 'human') this.lastHumanViewId = viewId; this.event('view.activated', { viewId, actor }); }
  setAgentControl(viewId: string, status: 'running' | 'paused' | 'stopped') { const view = this.getView(viewId); this.agentControl.set(viewId, status); this.agentControl.set(view.documentId, status); this.event('agent.control', { viewId, status }); }
  setMode(viewId: string, mode: ViewInfo['mode']) { this.getView(viewId).mode = mode; this.event('view.mode', { viewId, mode }); }
  setViewZoom(viewId: string, factor: number, actor: Actor = 'human') {
    if (!Number.isFinite(factor) || factor < .25 || factor > 4) throw new ViewerError('INVALID_ARGUMENT', '缩放比例应在 25% 到 400% 之间。');
    const view = this.getView(viewId), zoom = Math.round(factor * 100) / 100;
    if (view.zoom === zoom) return clone(view);
    if (this.getDocument(view.documentId).info.format === 'web') this.browser?.setZoom?.(viewId, zoom);
    view.zoom = zoom;
    if (view.context) view.context = { ...view.context, viewRevision: view.context.viewRevision + 1, quality: 'last-confirmed', selection: { ...view.context.selection, rect: undefined, pageRects: undefined } };
    this.event('view.zoom', { viewId, zoom, actor });
    return clone(view);
  }
  closeView(viewId: string, retainRecovery = false) {
    const view = this.getView(viewId), document = this.getDocument(view.documentId);
    if (document.info.dirty && !retainRecovery && [...this.views.values()].filter(v => v.documentId === document.info.id).length === 1) throw new ViewerError('UNSAVED_CHANGES', '文档尚未保存，请先保存或保留恢复点后关闭。');
    this.views.delete(viewId); this.browser?.close(viewId);
    if (this.activeViewId === viewId) this.activeViewId = [...this.views.keys()].at(-1);
    if (this.lastHumanViewId === viewId) this.lastHumanViewId = undefined;
    this.event('view.closed', { viewId });
  }
  updateContext(viewId: string, update: Partial<ReadingContext>, actor: Actor = 'human') {
    const view = this.getView(viewId), doc = this.getDocument(view.documentId);
    if (update.contentRevision !== undefined && update.contentRevision !== doc.info.revision) return;
    const old = view.context;
    view.context = { viewId, documentId: view.documentId, contentRevision: doc.info.revision, viewRevision: (old?.viewRevision ?? 0) + 1, capturedAt: new Date().toISOString(), quality: update.quality ?? 'confirmed', actor, locator: update.locator ?? old?.locator ?? { kind: doc.info.format }, visibleText: update.visibleText ?? old?.visibleText ?? '', selection: update.selection ?? old?.selection ?? { kind: 'none', text: '' }, viewport: update.viewport ?? old?.viewport };
    const significant = (context?: ReadingContext) => context && JSON.stringify({ ...context, capturedAt: undefined, viewRevision: undefined });
    if (significant(old) !== significant(view.context)) this.event('context.changed', { viewId, viewRevision: view.context.viewRevision });
  }
  async context(viewId?: string) {
    const view = this.getView(viewId);
    if (this.getDocument(view.documentId).info.format === 'web' && this.browser) {
      const fresh = await this.browser.context(view.id); this.updateContext(view.id, fresh, fresh.actor);
    }
    return clone(view.context ?? { viewId: view.id, documentId: view.documentId, contentRevision: this.getDocument(view.documentId).info.revision, viewRevision: 0, capturedAt: new Date().toISOString(), quality: 'not-ready', actor: 'engine', locator: { kind: 'unconfirmed' }, visibleText: '', selection: { kind: 'none', text: '' } } satisfies ReadingContext);
  }
  async snapshot(viewId?: string) {
    const context = await this.context(viewId), document = clone(this.getDocument(context.documentId).info);
    const snapshot: ReadingSnapshot = { id: randomUUID(), schemaVersion: PROTOCOL_VERSION, context, document, createdAt: new Date().toISOString() };
    this.snapshots.set(snapshot.id, snapshot);
    if (this.snapshots.size > 100) { const referenced = new Set([...this.tasks.values()].filter(t => t.status === 'running').map(t => t.snapshotId)); for (const id of this.snapshots.keys()) { if (!referenced.has(id) && id !== snapshot.id) { this.snapshots.delete(id); break; } } }
    this.event('snapshot.created', { id: snapshot.id }); return clone(snapshot);
  }
  readSnapshot(id: string) { const snapshot = this.snapshots.get(id); if (!snapshot) throw new ViewerError('SNAPSHOT_EXPIRED', '快照已过期或所属应用已重启。'); return clone(snapshot); }
  prepare(documentId: string, expectedRevision: number, operation: EditOperation) {
    const doc = this.getDocument(documentId); if (doc.info.revision !== expectedRevision) throw new ViewerError('VERSION_CONFLICT', '内容版本已变化，请重新读取。', { actualRevision: doc.info.revision });
    const op = editOperationSchema.parse(operation), adapter = this.registry.resolve(doc.info.format);
    const patch: PreparedPatch = { id: randomUUID(), documentId, expectedRevision, operation: op, preview: adapter.preview(doc.info.model, op), createdAt: new Date().toISOString() };
    this.patches.set(patch.id, patch); return clone(patch);
  }
  async commit(patchId: string, idempotencyKey: string, actor: Actor = 'agent') {
    const patch = this.patches.get(patchId); if (!patch) throw new ViewerError('TARGET_NOT_FOUND', '修改计划不存在或已过期。');
    if (actor === 'agent' && this.agentControl.get(patch.documentId) && this.agentControl.get(patch.documentId) !== 'running') throw new ViewerError('AGENT_PAUSED', '此文档的 Agent 操作已暂停或停止。');
    const payload = JSON.stringify(patch), prior = this.receipts.get(idempotencyKey);
    if (prior) { if (prior.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '同一幂等键不能提交不同修改。'); return clone(prior.receipt) as Receipt; }
    if (actor === 'agent') await this.extensions.get('before-agent-edit')?.({ documentId: patch.documentId, operation: clone(patch.operation) }, actor);
    return this.serial(patch.documentId, async () => {
      const existing = this.receipts.get(idempotencyKey); if (existing) { if (existing.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '幂等键内容冲突。'); return clone(existing.receipt) as Receipt; }
      const doc = this.getDocument(patch.documentId); if (doc.info.revision !== patch.expectedRevision) throw new ViewerError('VERSION_CONFLICT', '预览之后内容已改变，请重新准备。');
      if (actor === 'agent' && this.agentControl.get(patch.documentId) && this.agentControl.get(patch.documentId) !== 'running') throw new ViewerError('AGENT_PAUSED', '此文档的 Agent 操作已暂停或停止。');
      const before = clone(doc), adapter = this.registry.resolve(doc.info.format);
      const updated = await adapter.apply(doc.bytes, doc.info.model, patch.operation);
      doc.bytes = updated.bytes; doc.info.model = updated.model; doc.info.revision++; doc.info.dirty = true; doc.info.warnings = updated.warnings;
      for (const view of this.views.values()) if (view.documentId === doc.info.id && view.context) view.context = { ...view.context, contentRevision: doc.info.revision, quality: 'not-ready', visibleText: '', selection: { kind: 'none', text: '' } };
      const receipt: Receipt = { transactionId: randomUUID(), documentId: doc.info.id, revision: doc.info.revision, status: 'applied', idempotencyKey, warnings: updated.warnings };
      this.transactions.set(receipt.transactionId, { documentId: doc.info.id, before, afterRevision: doc.info.revision }); this.receipts.set(idempotencyKey, { payload, receipt });
      const operation = patch.operation;
      const target = 'blockId' in operation ? { kind: operation.kind, blockId: operation.blockId } : 'afterBlockId' in operation ? { kind: operation.kind, blockId: operation.afterBlockId } : 'shapeId' in operation ? { kind: operation.kind, slideId: operation.slideId, shapeId: operation.shapeId } : 'address' in operation ? { kind: operation.kind, sheetId: operation.sheetId, address: operation.address } : 'sheetId' in operation ? { kind: operation.kind, sheetId: operation.sheetId } : 'pageIndex' in operation ? { kind: operation.kind, pageIndex: operation.pageIndex } : { kind: operation.kind };
      this.event('document.changed', { ...receipt, actor, target }); await this.persist(); return receipt;
    });
  }
  async undo(transactionId: string) {
    const tx = this.transactions.get(transactionId); if (!tx) throw new ViewerError('TARGET_NOT_FOUND', '撤销事务不存在。');
    return this.serial(tx.documentId, async () => {
      const current = this.getDocument(tx.documentId); if (current.info.revision !== tx.afterRevision) throw new ViewerError('VERSION_CONFLICT', '该修改之后还有其他编辑，不能整组覆盖撤销。');
      const restored = clone(tx.before); restored.info.revision = current.info.revision + 1; restored.info.diskRevision = current.info.diskRevision; restored.sourceHash = current.sourceHash; restored.info.path = current.info.path; restored.info.dirty = hash(restored.bytes) !== current.sourceHash;
      this.documents.set(tx.documentId, restored); this.transactions.delete(transactionId);
      for (const view of this.views.values()) if (view.documentId === tx.documentId && view.context) view.context = { ...view.context, contentRevision: restored.info.revision, quality: 'not-ready', visibleText: '', selection: { kind: 'none', text: '' } };
      const receipt: Receipt = { transactionId: randomUUID(), documentId: tx.documentId, revision: restored.info.revision, status: 'undone' }; this.event('document.changed', receipt); return receipt;
    });
  }
  async save(documentId: string, path?: string, allowOverwrite = false) {
    return this.serial(documentId, async () => {
      const doc = this.getDocument(documentId), target = path ? resolve(path) : doc.info.path;
      if (!target) throw new ViewerError('SAVE_PATH_REQUIRED', '新文档需要选择保存位置。');
      if (doc.info.format === 'web') throw new ViewerError('CAPABILITY_UNSUPPORTED', '请先生成网页阅读副本。');
      const expectedExtension = doc.info.format === 'markdown' ? '.md' : '.' + doc.info.format;
      if (!target.toLowerCase().endsWith(expectedExtension) && !(doc.info.format === 'html' && target.endsWith('.htm')) && !(doc.info.format === 'markdown' && target.endsWith('.markdown'))) throw new ViewerError('FORMAT_MISMATCH', `当前内容需保存为 ${expectedExtension}，不能通过改扩展名转换格式。`);
      let disk: Uint8Array | undefined;
      try { disk = new Uint8Array(await readFile(target)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (target === doc.info.path && doc.sourceHash && (!disk || hash(disk) !== doc.sourceHash)) throw new ViewerError('FILE_CONFLICT', '源文件被其他程序修改或删除，请另存副本。');
      if (target !== doc.info.path && disk && !allowOverwrite) throw new ViewerError('FILE_EXISTS', '目标文件已存在，需明确覆盖授权。');
      await mkdir(dirname(target), { recursive: true }); const temp = target + '.agentviewer-' + randomUUID() + '.tmp';
      try { await writeFile(temp, doc.bytes); if (hash(new Uint8Array(await readFile(temp))) !== hash(doc.bytes)) throw new ViewerError('SAVE_VERIFY_FAILED', '临时文件校验失败。'); await rename(temp, target); } finally { await unlink(temp).catch(() => {}); }
      doc.info.path = target; doc.info.title = basename(target); doc.sourceHash = hash(doc.bytes); doc.info.diskRevision = doc.info.revision; doc.info.dirty = false;
      const receipt: Receipt = { transactionId: randomUUID(), documentId, revision: doc.info.revision, status: 'saved', path: target }; this.event('document.saved', receipt); await this.persist(); return receipt;
    });
  }
  async reloadFromDisk(documentId: string) {
    return this.serial(documentId, async () => {
      const doc = this.getDocument(documentId);
      if (!doc.info.path) throw new ViewerError('SAVE_PATH_REQUIRED', '文档尚未保存到磁盘。');
      if (doc.info.dirty) throw new ViewerError('UNSAVED_CHANGES', '请先保存或另存当前修改，再重新载入。');
      const bytes = new Uint8Array(await readFile(doc.info.path));
      if (bytes.byteLength > 100 * 1024 * 1024) throw new ViewerError('FILE_TOO_LARGE', '文件超过 100 MB。');
      const nextHash = hash(bytes);
      if (nextHash === doc.sourceHash) return clone(doc.info);
      const model = await this.registry.resolve(doc.info.format).open(bytes, doc.info.format);
      doc.bytes = bytes; doc.sourceHash = nextHash; doc.info.model = model;
      doc.info.revision++; doc.info.diskRevision = doc.info.revision; doc.info.dirty = false; doc.info.warnings = [];
      for (const [id, tx] of this.transactions) if (tx.documentId === documentId) this.transactions.delete(id);
      for (const view of this.views.values()) if (view.documentId === documentId && view.context) view.context = { ...view.context, contentRevision: doc.info.revision, quality: 'not-ready', visibleText: '', selection: { kind: 'none', text: '' } };
      this.event('document.reloaded', { documentId, revision: doc.info.revision });
      await this.persist(); return clone(doc.info);
    });
  }
  async browserInput(raw: BrowserRequest) {
    if (!this.browser) throw new ViewerError('CAPABILITY_UNSUPPORTED', '原生鼠标键盘输入只能在桌面应用执行。');
    const request = browserRequestSchema.parse(raw); this.getView(request.viewId);
    if (this.agentControl.get(request.viewId) && this.agentControl.get(request.viewId) !== 'running') throw new ViewerError('AGENT_PAUSED', '此页面的 Agent 操作已暂停或停止。');
    const payload = JSON.stringify(request), prior = this.receipts.get(request.idempotencyKey);
    if (prior) { if (prior.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '输入幂等键冲突。'); return clone(prior.receipt); }
    return this.serial('browser:' + request.viewId, async () => {
      const existing = this.receipts.get(request.idempotencyKey); if (existing) { if (existing.payload !== payload) throw new ViewerError('IDEMPOTENCY_CONFLICT', '输入幂等键冲突。'); return clone(existing.receipt); }
      if (this.agentControl.get(request.viewId) && this.agentControl.get(request.viewId) !== 'running') throw new ViewerError('AGENT_PAUSED', '此页面的 Agent 操作已暂停或停止。');
      const result = await this.browser!.input(request); this.updateContext(request.viewId, result.context, 'agent'); this.receipts.set(request.idempotencyKey, { payload, receipt: result }); this.event('browser.input', { viewId: request.viewId, kind: request.action.kind, point: 'x' in request.action ? { x: request.action.x, y: request.action.y } : 'to' in request.action ? request.action.to : undefined, actor: 'agent' }); await this.persist(); return result;
    });
  }
  async browserCopy(viewId: string) { if (!this.browser) throw new ViewerError('CAPABILITY_UNSUPPORTED', '请在桌面应用创建网页副本。'); const view = this.getView(viewId); const source = this.getDocument(view.documentId).info; const html = await this.browser.html(viewId); const copy = await this.openBytes(source.title + '.html', new TextEncoder().encode(html), 'html', undefined, view.windowId); this.getDocument(copy.documentId).info.warnings.push('来源：' + source.model.url, '这是本地阅读副本，未修改远程站点。外部资源未归档，相对链接可能失效。', '副本移除脚本、嵌入 frame、事件属性与已知敏感表单值。'); return copy; }
  async submitTask(driverId: string, prompt: string, viewId?: string, snapshotId?: string, sourceScope?: 'selection' | 'visible') {
    const driver = this.drivers.get(driverId); if (!driver) throw new ViewerError('HARNESS_UNAVAILABLE', '尚未配置该 harness 驱动。');
    const original = snapshotId ? this.readSnapshot(snapshotId) : await this.snapshot(viewId);
    const snapshot = sourceScope ? scopedReadingSnapshot(original, sourceScope) : original;
    if (viewId && snapshot.context.viewId !== viewId) throw new ViewerError('SNAPSHOT_TARGET_MISMATCH', '固定快照属于其他阅读视图。');
    return this.startTask(driver, prompt, snapshot, sourceScope);
  }
  /** Trusted SDK path for retrying a bounded source after the ordinary snapshot
   * cache expires. The public dispatcher never accepts a caller-supplied source. */
  async submitFrozenReadingTask(driver: HarnessDriver, prompt: string, frozen: ScopedReadingSnapshot, timeoutMs = 180000) {
    const snapshot = scopedReadingSnapshot(frozen, frozen.sourceScope);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new ViewerError('INVALID_ARGUMENT', '阅读任务超时必须在 1–900000 毫秒内。');
    return this.startTask(driver, prompt, snapshot, snapshot.sourceScope, timeoutMs);
  }
  private startTask(driver: HarnessDriver, prompt: string, snapshot: ReadingSnapshot, sourceScope?: 'selection' | 'visible', timeoutMs = sourceScope ? 180000 : 0) {
    const controller = new AbortController();
    const task: HarnessTask = { id: randomUUID(), snapshotId: snapshot.id, viewId: snapshot.context.viewId, sourceScope, prompt, text: '', status: 'running' }; this.tasks.set(task.id, task); this.taskControllers.set(task.id, controller); this.event('harness.started', { taskId: task.id });
    let ended = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: HarnessTask['status'], error?: unknown) => {
      if (ended) return;
      ended = true; clearTimeout(timer); controller.signal.removeEventListener('abort', cancelled);
      task.status = status; if (error !== undefined) task.error = String(error);
      this.taskControllers.delete(task.id); this.event('harness.completed', { taskId: task.id, status: task.status });
    };
    const cancelled = () => finish('cancelled'); controller.signal.addEventListener('abort', cancelled, { once: true });
    if (timeoutMs) { timer = setTimeout(() => { finish('failed', '阅读分析超过 ' + Math.round(timeoutMs / 1000) + ' 秒，已停止等待；可基于同一冻结来源重试。'); controller.abort(); }, timeoutMs); timer.unref(); }
    void Promise.resolve().then(() => {
      if (ended || controller.signal.aborted) return;
      return driver.submit(prompt, clone(snapshot), delta => {
      // A provider may ignore cancellation or emit after its promise settles.
      // Terminal tasks must not grow or change status when that happens.
      if (ended || controller.signal.aborted) return;
      if (typeof delta !== 'string') { finish('failed', 'Harness 返回了非文本内容。'); controller.abort(); return; }
      if (sourceScope && task.text.length + delta.length > 160000) { finish('failed', '模型输出超过 160000 字符，已停止接收；未静默截断为完整结果。'); controller.abort(); return; }
      task.text += delta; if (delta) this.event('harness.delta', { taskId: task.id, text: delta });
      }, controller.signal);
    }).then(() => {
      if (sourceScope && !task.text.trim()) finish('failed', '模型未返回可读结果。'); else finish('completed');
    }).catch(error => finish(controller.signal.aborted ? 'cancelled' : 'failed', error));
    return clone(task);
  }
  cancelTask(taskId: string) { const controller = this.taskControllers.get(taskId); if (!controller) { if (this.tasks.get(taskId)?.status === 'cancelled') return; throw new ViewerError('TARGET_NOT_FOUND', '任务已结束或不存在。'); } controller.abort(); }
}
