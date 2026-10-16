import { mkdir, readFile, writeFile, rename, copyFile, unlink, readdir, lstat, realpath, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { blobStorageReference, collectFrozenBlobs, freezeWorkspaceBlob, hashBytes, markWorkspaceBlob, readWorkspaceBlob, validateBlobReference, type BlobReference, type FrozenBlob, type TextModelReference } from './workspace-blobs';

export interface WorkspaceSaveOptions { mode?: 'barrier' | 'checkpoint' }
export interface WorkspaceDocumentSnapshot {
  documents: { info: { id: string; revision: number; model: unknown; format?: string }; bytes: Uint8Array; sourceHash?: string }[];
  [key: string]: unknown;
}
export interface WorkspaceRepository {
  load<T>(): Promise<T | undefined>;
  save(value: unknown, options?: WorkspaceSaveOptions): Promise<void>;
  saveDocuments?(value: WorkspaceDocumentSnapshot, options?: WorkspaceSaveOptions): Promise<void>;
  exportLegacy?(path: string): Promise<void>;
}
type Waiter = { resolve(): void; reject(error: unknown): void };
type SaveEntry = { payload: string; blobs: FrozenBlob[]; bytes: number; mode: 'barrier' | 'checkpoint'; v2: boolean; waiters: Waiter[] };
export class WorkspacePersistenceBusyError extends Error {
  readonly code = 'PERSISTENCE_BUSY';
  constructor() { super('恢复队列正忙，请等待当前检查点完成后重试。'); this.name = 'WorkspacePersistenceBusyError'; }
}
export class JsonWorkspaceRepository implements WorkspaceRepository {
  private active?: SaveEntry;
  private queue: SaveEntry[] = [];
  private retainedBytes = 0;
  private counts = { requested: 0, written: 0, coalesced: 0, rejected: 0, maximumRetainedBytes: 0 };
  private readonly maxPendingBytes: number;
  private readonly maxPendingEntries: number;
  private readonly maxWaiters: number;
  private readonly byteSnapshots = new WeakMap<Uint8Array, FrozenBlob>();
  private readonly modelSnapshots = new WeakMap<object, { revision: number; blob?: FrozenBlob; text?: TextModelReference }>();
  private readonly textSnapshots = new Map<string, { bytes: Uint8Array; blob: FrozenBlob; format: string }>();
  private readonly knownBlobs = new Set<string>();
  private blobCounts = { blobWrites: 0, blobReuses: 0, frozenSourceBytes: 0, blobBytesWritten: 0, deltaWrites: 0, removedBlobs: 0, gcFailures: 0 };
  private maintenance = false;
  private gcRequested = false;
  private gcWaiters: Waiter[] = [];
  private exports: { path: string; waiter: Waiter }[] = [];
  private lastGcAt = Date.now();
  private legacyBackupChecked = false;
  constructor(readonly path: string, limits: { maxPendingBytes?: number; maxPendingEntries?: number; maxWaiters?: number } = {}) {
    this.maxPendingBytes = limits.maxPendingBytes ?? 64 * 1024 * 1024;
    this.maxPendingEntries = limits.maxPendingEntries ?? 8;
    this.maxWaiters = limits.maxWaiters ?? 256;
    if (![this.maxPendingBytes, this.maxPendingEntries, this.maxWaiters].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('恢复队列预算必须是正整数。');
  }
  get statistics() { return { ...this.counts, ...this.blobCounts, retainedBytes: this.retainedBytes, pendingEntries: this.queue.length + (this.active ? 1 : 0), maxPendingBytes: this.maxPendingBytes }; }
  private get blobDirectory() { return join(this.path + '.data', 'blobs'); }
  private async readStoredBlob(reference: { sha256: string; byteLength: number }) {
    validateBlobReference(reference);
    const bytes = await readFile(join(this.blobDirectory, reference.sha256));
    if (bytes.byteLength !== reference.byteLength || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error('WORKSPACE_BLOB_CORRUPT');
    this.knownBlobs.add(reference.sha256); return bytes;
  }
  private readBlob(reference: BlobReference, loaded?: (blob: FrozenBlob) => void) { return readWorkspaceBlob(reference, value => this.readStoredBlob(value), loaded); }
  async load<T>() {
    let source: string;
    try { source = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const stored = JSON.parse(source);
    if (stored.storageVersion === undefined) return stored as T;
    if (stored.storageVersion !== 2 || !stored.workspace || !Array.isArray(stored.workspace.documents)) throw new Error('WORKSPACE_STORAGE_VERSION_UNSUPPORTED');
    const workspace = stored.workspace;
    // A missing/corrupt blob must fail the whole restore. Never turn it into an
    // empty document and overwrite the only recoverable manifest on next save.
    workspace.documents = await Promise.all(workspace.documents.map(async (entry: any) => {
      let contentBlob: FrozenBlob | undefined, modelBlob: FrozenBlob | undefined;
      const bytes = new Uint8Array(await this.readBlob(entry.content, blob => { contentBlob = blob; }));
      const textModel = entry.model?.kind === 'text';
      if (textModel && (!['markdown', 'html'].includes(entry.model.format) || entry.info.format !== entry.model.format)) throw new Error('WORKSPACE_TEXT_MODEL_INVALID');
      const model = textModel ? { format: entry.model.format, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } : JSON.parse((await this.readBlob(entry.model, blob => { modelBlob = blob; })).toString('utf8'));
      const blob = contentBlob!;
      this.byteSnapshots.set(bytes, blob);
      if (model && typeof model === 'object') this.modelSnapshots.set(model, { revision: entry.info.revision, ...(textModel ? { text: entry.model as TextModelReference } : { blob: modelBlob! }) });
      if (textModel) this.textSnapshots.set(entry.info.id, { bytes, blob, format: entry.model.format });
      const { content: _content, model: _storedModel, ...document } = entry;
      return { ...document, bytes, info: { ...entry.info, model } };
    }));
    return workspace as T;
  }
  private available(blob: FrozenBlob) {
    return collectFrozenBlobs([blob]).every(dependency => this.knownBlobs.has(blobStorageReference(dependency.reference).sha256) || !!dependency.data && (!!this.active?.blobs.includes(dependency) || this.queue.some(entry => entry.blobs.includes(dependency))));
  }
  private freezeBlob(bytes: Uint8Array, base?: { bytes: Uint8Array; blob: FrozenBlob }): FrozenBlob {
    const blob = freezeWorkspaceBlob(bytes, base);
    if (blob !== base?.blob) this.blobCounts.frozenSourceBytes += blob.data?.byteLength ?? 0;
    return blob;
  }
  /** Core owns/replaces document buffers and advances revision on model writes.
   * Freeze only changed bodies; metadata checkpoints never re-encode all files. */
  saveDocuments(value: WorkspaceDocumentSnapshot, options: WorkspaceSaveOptions = {}) {
    const blobs: FrozenBlob[] = [];
    try {
      const documents = value.documents.map(entry => {
        const shared = typeof SharedArrayBuffer !== 'undefined' && entry.bytes.buffer instanceof SharedArrayBuffer;
        const textFormat = entry.info.format === 'markdown' || entry.info.format === 'html';
        let content = shared ? undefined : this.byteSnapshots.get(entry.bytes);
        if (content && !this.available(content)) content = undefined;
        const previous = textFormat ? this.textSnapshots.get(entry.info.id) : undefined;
        const base = previous && previous.format === entry.info.format && this.available(previous.blob) ? previous : undefined;
        if (!content) { content = this.freezeBlob(entry.bytes, base); if (!shared) this.byteSnapshots.set(entry.bytes, content); }
        blobs.push(content);
        if (textFormat && !shared) this.textSnapshots.set(entry.info.id, { bytes: entry.bytes, blob: content, format: entry.info.format! });
        const object = entry.info.model && typeof entry.info.model === 'object' ? entry.info.model as Record<string, unknown> : undefined;
        const cached = object && this.modelSnapshots.get(object);
        let model = cached?.revision === entry.info.revision ? cached.blob : undefined;
        let text = cached?.revision === entry.info.revision ? cached.text : undefined;
        if (model && !this.available(model)) model = undefined;
        if (!model && !text && textFormat && object && object.format === entry.info.format && typeof object.text === 'string' && Object.keys(object).every(key => key === 'format' || key === 'text')) {
          // Validate that reconstructing the model from source is lossless,
          // including an optional UTF-8 BOM, without JSON-encoding it again.
          const bom = entry.bytes[0] === 0xef && entry.bytes[1] === 0xbb && entry.bytes[2] === 0xbf;
          const digest = createHash('sha256'); if (bom) digest.update(Uint8Array.from([0xef, 0xbb, 0xbf])); digest.update(object.text, 'utf8');
          if (Buffer.byteLength(object.text, 'utf8') + (bom ? 3 : 0) === content.reference.byteLength && digest.digest('hex') === content.reference.sha256) text = { kind: 'text', format: entry.info.format as 'markdown' | 'html' };
        }
        if (!model && !text) model = this.freezeBlob(Buffer.from(JSON.stringify(entry.info.model), 'utf8'));
        if (object) this.modelSnapshots.set(object, { revision: entry.info.revision, ...(text ? { text } : { blob: model! }) });
        if (model) blobs.push(model);
        const { model: _model, ...info } = entry.info;
        return { ...entry, bytes: undefined, info, content: content.reference, model: text ?? model!.reference };
      });
      const payload = JSON.stringify({ storageVersion: 2, workspace: { ...value, documents } });
      const present = new Set(value.documents.map(entry => entry.info.id));
      for (const id of this.textSnapshots.keys()) if (!present.has(id)) this.textSnapshots.delete(id);
      return this.enqueue(payload, collectFrozenBlobs(blobs), options, true);
    } catch (error) { this.releaseUnretained(collectFrozenBlobs(blobs)); throw error; }
  }
  save(value: unknown, options: WorkspaceSaveOptions = {}) {
    // Freeze mutable models at the call boundary, before any asynchronous work.
    // Checkpoint coalescing replaces only already-frozen, explicitly replaceable
    // requests; a barrier is never replaced with later application state.
    const payload = JSON.stringify(value);
    if (typeof payload !== 'string') throw new TypeError('工作区必须可以序列化为 JSON。');
    return this.enqueue(payload, [], options);
  }
  private releaseUnretained(blobs: FrozenBlob[]) {
    for (const blob of blobs) if (!this.active?.blobs.includes(blob) && !this.queue.some(entry => entry.blobs.includes(blob))) blob.data = undefined;
  }
  private enqueue(payload: string, blobs: FrozenBlob[], options: WorkspaceSaveOptions, v2 = false) {
    const mode = options.mode ?? 'barrier', bytes = payload.length * 2 + blobs.reduce((sum, blob) => sum + (blob.data?.byteLength ?? 0), 0);
    this.counts.requested++;
    const tail = this.queue.at(-1) ?? this.active;
    const replace = !!tail && tail !== this.active && tail.mode === 'checkpoint' && mode === 'checkpoint';
    const retained = this.retainedBytes + bytes - (replace ? tail!.bytes : 0);
    const entries = this.queue.length + (this.active ? 1 : 0);
    // A single legal workspace may exceed the normal queue budget. It may save
    // exclusively while idle (a large checkpoint becomes a barrier); additional
    // different snapshots must apply backpressure until its write completes.
    const oversizedBarrier = entries === 0;
    const tooManyWaiters = replace && tail!.waiters.length >= this.maxWaiters;
    const overBudget = retained > this.maxPendingBytes;
    const tooManyEntries = !replace && entries >= this.maxPendingEntries;
    if (tooManyWaiters || !oversizedBarrier && (overBudget || tooManyEntries)) {
      this.counts.rejected++; this.releaseUnretained(blobs); return Promise.reject(new WorkspacePersistenceBusyError());
    }
    const promise = new Promise<void>((resolve, reject) => {
      if (replace) {
        const previousBlobs = tail!.blobs;
        this.retainedBytes -= tail!.bytes; tail!.payload = payload; tail!.blobs = blobs; tail!.bytes = bytes; tail!.v2 = v2; tail!.waiters.push({ resolve, reject }); this.counts.coalesced++;
        this.releaseUnretained(previousBlobs);
      } else this.queue.push({ payload, blobs, bytes, v2, mode: bytes > this.maxPendingBytes ? 'barrier' : mode, waiters: [{ resolve, reject }] });
      this.retainedBytes += bytes;
      this.counts.maximumRetainedBytes = Math.max(this.counts.maximumRetainedBytes, this.retainedBytes);
    });
    void this.pump(); return promise;
  }
  protected async writePayload(payload: string) {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = this.path + '.tmp'; await writeFile(temp, payload, { mode: 0o600 }); await rename(temp, this.path);
  }
  private async backupLegacy() {
    if (!this.legacyBackupChecked) {
      try {
        const existing = JSON.parse(await readFile(this.path, 'utf8'));
        if (existing.storageVersion === undefined) await copyFile(this.path, this.path + '.v1.bak', constants.COPYFILE_EXCL);
      } catch (error) { if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      this.legacyBackupChecked = true;
    }
  }
  private async backupRollback() {
    try {
      const source = await readFile(this.path, 'utf8'), current = JSON.parse(source);
      if (current.storageVersion !== 2) return;
      const temporary = this.path + '.v2.bak.tmp';
      await writeFile(temporary, source, { mode: 0o600 }); await rename(temporary, this.path + '.v2.bak');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  /** Explicit maintenance waits for outstanding writes. New snapshots may
   * enqueue during marking, but no physical blob write races the sweep. */
  collectGarbage(): Promise<void> {
    this.gcRequested = true;
    const result = new Promise<void>((resolve, reject) => this.gcWaiters.push({ resolve, reject }));
    void this.pump(); return result;
  }
  private async pruneBlobs() {
    let dataDirectory: string, directory: string;
    try {
      const data = resolve(this.path + '.data'), blobs = resolve(this.blobDirectory);
      const [dataStat, blobStat] = await Promise.all([lstat(data), lstat(blobs)]);
      if (!dataStat.isDirectory() || dataStat.isSymbolicLink() || !blobStat.isDirectory() || blobStat.isSymbolicLink()) throw new Error('WORKSPACE_GC_DIRECTORY_UNSAFE');
      dataDirectory = await realpath(data); directory = await realpath(blobs);
      const actualParent = dirname(directory), same = process.platform === 'win32' ? actualParent.toLowerCase() === dataDirectory.toLowerCase() : actualParent === dataDirectory;
      if (!same) throw new Error('WORKSPACE_GC_DIRECTORY_UNSAFE');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const marked = new Set<string>();
    const checkRaw = async (reference: BlobReference) => {
      const file = await lstat(join(directory, reference.sha256));
      if (!file.isFile() || file.isSymbolicLink() || file.size !== reference.byteLength) throw new Error('WORKSPACE_BLOB_CORRUPT');
    };
    for (const path of [this.path, this.path + '.v2.bak', this.path + '.tmp', this.path + '.v2.bak.tmp', this.path + '.v1.bak']) {
      let source: string;
      try { source = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const manifest = JSON.parse(source);
      if (manifest.storageVersion === undefined) continue;
      if (manifest.storageVersion !== 2 || !Array.isArray(manifest.workspace?.documents)) throw new Error('WORKSPACE_STORAGE_VERSION_UNSUPPORTED');
      for (const entry of manifest.workspace.documents) {
        await markWorkspaceBlob(entry.content, value => this.readStoredBlob(value), marked, checkRaw);
        if (entry.model?.kind !== 'text') await markWorkspaceBlob(entry.model, value => this.readStoredBlob(value), marked, checkRaw);
      }
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(entry.name) || marked.has(entry.name)) continue;
      // Snapshot preparation/enqueue is synchronous. Recheck every candidate
      // after async marking so even newly queued dependency chains survive.
      if (this.queue.some(item => item.blobs.some(blob => blobStorageReference(blob.reference).sha256 === entry.name))) continue;
      this.knownBlobs.delete(entry.name);
      try { await unlink(join(directory, entry.name)); this.blobCounts.removedBlobs++; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  exportLegacy(path: string) {
    const result = new Promise<void>((resolve, reject) => this.exports.push({ path, waiter: { resolve, reject } }));
    void this.pump(); return result;
  }
  private async writeLegacyExport(path: string) {
    const target = resolve(path), source = resolve(this.path), ownData = resolve(this.path + '.data');
    const normalized = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const local = relative(normalized(ownData), normalized(target));
    if ([source, source + '.tmp', source + '.v1.bak', source + '.v2.bak', source + '.v2.bak.tmp'].some(value => normalized(value) === normalized(target)) || !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep)) throw new Error('WORKSPACE_EXPORT_TARGET_INVALID');
    const workspace = await this.load<WorkspaceDocumentSnapshot>();
    if (!workspace || !Array.isArray(workspace.documents)) throw new Error('WORKSPACE_EXPORT_SOURCE_MISSING');
    const documents = workspace.documents.map(entry => {
      const { content: _content, model: _model, ...document } = entry as typeof entry & { content?: unknown; model?: unknown };
      return { ...document, bytes: typeof document.bytes === 'string' ? document.bytes : Buffer.from(document.bytes).toString('base64') };
    });
    const { storageVersion: _storageVersion, ...legacy } = workspace;
    const temporary = target + '.' + randomUUID() + '.tmp'; await mkdir(dirname(target), { recursive: true });
    // Linking the completed sibling file publishes it atomically and fails
    // exclusively if a file appeared at the destination during serialization.
    try { await writeFile(temporary, JSON.stringify({ ...legacy, documents }), { mode: 0o600, flag: 'wx' }); await link(temporary, target); }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  private async writeBlobs(blobs: FrozenBlob[]) {
    if (!blobs.length) return;
    await mkdir(this.blobDirectory, { recursive: true });
    for (const blob of blobs) {
      const stored = blobStorageReference(blob.reference);
      if (this.knownBlobs.has(stored.sha256)) { this.blobCounts.blobReuses++; blob.data = undefined; continue; }
      if (!blob.data) throw new Error('WORKSPACE_BLOB_UNAVAILABLE');
      if (blob.data.byteLength !== stored.byteLength || hashBytes(blob.data) !== stored.sha256) throw new Error('WORKSPACE_BLOB_CORRUPT');
      const target = join(this.blobDirectory, stored.sha256), temporary = target + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, blob.data, { mode: 0o600 }); await rename(temporary, target); }
      finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      this.knownBlobs.add(stored.sha256); this.blobCounts.blobWrites++; this.blobCounts.blobBytesWritten += stored.byteLength; if (blob.reference.delta) this.blobCounts.deltaWrites++; blob.data = undefined;
    }
  }
  private async pump() {
    if (this.active || this.maintenance) return;
    while (this.queue.length) {
      const entry = this.queue.shift()!; this.active = entry;
      try {
        if (entry.v2) await this.backupLegacy(); await this.writeBlobs(entry.blobs); if (entry.v2) await this.backupRollback(); await this.writePayload(entry.payload); this.counts.written++;
        if (entry.v2 && (this.counts.written % 32 === 0 || Date.now() - this.lastGcAt >= 30000)) this.gcRequested = true;
        for (const waiter of entry.waiters) waiter.resolve();
      }
      catch (error) { for (const waiter of entry.waiters) waiter.reject(error); }
      finally { this.retainedBytes -= entry.bytes; this.active = undefined; this.releaseUnretained(entry.blobs); }
    }
    if (this.gcRequested) {
      const waiters = this.gcWaiters.splice(0); this.gcRequested = false; this.maintenance = true;
      try { await this.pruneBlobs(); this.lastGcAt = Date.now(); for (const waiter of waiters) waiter.resolve(); }
      catch (error) { this.blobCounts.gcFailures++; for (const waiter of waiters) waiter.reject(error); }
      finally { this.maintenance = false; }
      if (this.queue.length || this.gcRequested) { void this.pump(); return; }
    }
    // Export holds the same maintenance barrier as GC while reading blob
    // chains. New saves can enqueue, but cannot advance rollback/GC beneath it.
    if (this.exports.length) {
      const request = this.exports.shift()!; this.maintenance = true;
      try { await this.writeLegacyExport(request.path); request.waiter.resolve(); }
      catch (error) { request.waiter.reject(error); }
      finally { this.maintenance = false; }
      if (this.queue.length || this.gcRequested || this.exports.length) void this.pump();
    }
  }
}
