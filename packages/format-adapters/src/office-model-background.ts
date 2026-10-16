import { Worker } from 'node:worker_threads';
import type { DocumentModel, Format, FormatAdapter } from '../../contracts/src/index';
import { ViewerError } from '../../contracts/src/index';

interface ModelJob { id: number; format: Format; bytes: Uint8Array<ArrayBuffer>; retainedSize: number; resolve: (model: DocumentModel) => void; reject: (cause: Error) => void }
/** One parser lane; source ownership and queued bytes remain bounded independently of UI reads. */
export class OfficeModelBackground {
  private worker?: Worker;
  private active?: ModelJob;
  private jobs: ModelJob[] = [];
  private retainedBytes = 0;
  private nextId = 0;
  private timer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  constructor(private readonly workerPath: string) {}
  open(bytes: Uint8Array, format: Format) {
    if (this.jobs.length + Number(!!this.active) >= 8 || this.retainedBytes + bytes.byteLength > 128 * 1024 * 1024) return Promise.reject(new ViewerError('OFFICE_MODEL_BUSY', 'Office 辅助解析队列已满，请等待当前文件加载完成。'));
    // Transfer only an owned copy. The document, recovery and caller retain their original bytes.
    const owned = new Uint8Array(bytes);
    this.retainedBytes += owned.byteLength;
    return new Promise<DocumentModel>((resolve, reject) => { this.jobs.push({ id: ++this.nextId, format, bytes: owned, retainedSize: owned.byteLength, resolve, reject }); this.pump(); });
  }
  private fail(cause: Error) {
    const worker = this.worker; this.worker = undefined;
    clearTimeout(this.timer); clearTimeout(this.idleTimer);
    const jobs = [...(this.active ? [this.active] : []), ...this.jobs]; this.active = undefined; this.jobs = []; this.retainedBytes = 0;
    for (const job of jobs) job.reject(cause);
    if (worker) void worker.terminate();
  }
  private pump() {
    if (this.active) return;
    clearTimeout(this.idleTimer);
    const job = this.jobs.shift();
    if (!job) {
      this.worker?.unref();
      this.idleTimer = setTimeout(() => { const worker = this.worker; this.worker = undefined; if (worker) void worker.terminate(); }, 30000); this.idleTimer.unref(); return;
    }
    this.active = job;
    if (!this.worker) {
      try {
        const worker = new Worker(this.workerPath, { resourceLimits: { maxOldGenerationSizeMb: 512 } }); this.worker = worker;
        worker.on('message', (reply: { id: number; model?: DocumentModel; error?: { code: string; message: string } }) => {
          if (this.worker !== worker || !this.active || reply.id !== this.active.id) return;
          const current = this.active; this.active = undefined; clearTimeout(this.timer); this.retainedBytes -= current.retainedSize;
          if (reply.error) current.reject(new ViewerError(reply.error.code, reply.error.message));
          else if (!reply.model || reply.model.format !== current.format) current.reject(new ViewerError('OFFICE_MODEL_INVALID', 'Office 辅助模型返回的格式身份无效。'));
          else current.resolve(reply.model);
          this.pump();
        });
        worker.on('error', () => { if (this.worker === worker) this.fail(new ViewerError('OFFICE_MODEL_WORKER_FAILED', 'Office 辅助解析进程异常，原文件保持不变。')); });
        worker.on('exit', () => { if (this.worker === worker) this.fail(new ViewerError('OFFICE_MODEL_WORKER_EXITED', 'Office 辅助解析进程提前退出。')); });
      } catch { this.fail(new ViewerError('OFFICE_MODEL_WORKER_FAILED', 'Office 辅助解析进程未能启动。')); return; }
    }
    this.worker.ref();
    this.timer = setTimeout(() => this.fail(new ViewerError('OFFICE_MODEL_TIMEOUT', 'Office 辅助解析超时，原文件保持不变。')), 120000); this.timer.unref();
    // Keep accounting separate: transfer detaches the byte buffer immediately.
    try { this.worker.postMessage({ id: job.id, format: job.format, bytes: job.bytes }, [job.bytes.buffer]); }
    catch { this.fail(new ViewerError('OFFICE_MODEL_WORKER_FAILED', 'Office 辅助解析任务未能发送。')); }
  }
}

/** Compressed byte size alone misses long, repetitive XML. Read only ZIP directory sizes. */
function requiresBackgroundModel(bytes: Uint8Array) {
  if (bytes.byteLength >= 256 * 1024) return true;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let end = bytes.byteLength - 22; end >= Math.max(0, bytes.byteLength - 65557); end--) {
    if (data.getUint32(end, true) !== 0x06054b50 || end + 22 + data.getUint16(end + 20, true) !== bytes.byteLength) continue;
    const count = data.getUint16(end + 10, true), size = data.getUint32(end + 12, true), offset = data.getUint32(end + 16, true);
    if (count > 512 || offset === 0xffffffff || size === 0xffffffff || offset + size > end) return true;
    let cursor = offset, xmlBytes = 0;
    for (let entry = 0; entry < count; entry++) {
      if (cursor + 46 > end || data.getUint32(cursor, true) !== 0x02014b50) return true;
      const expanded = data.getUint32(cursor + 24, true), nameLength = data.getUint16(cursor + 28, true), nameEnd = cursor + 46 + nameLength;
      if (nameEnd > end || expanded === 0xffffffff) return true;
      const xml = nameLength >= 4 && bytes[nameEnd - 4] === 46 && bytes[nameEnd - 3] === 120 && bytes[nameEnd - 2] === 109 && bytes[nameEnd - 1] === 108;
      if (xml) xmlBytes += expanded;
      if (xmlBytes >= 256 * 1024) return true;
      cursor = nameEnd + data.getUint16(cursor + 30, true) + data.getUint16(cursor + 32, true);
    }
    return false;
  }
  return false; // The ordinary parser still validates small invalid archives.
}

export function backgroundOfficeAdapter(adapter: FormatAdapter, parser: OfficeModelBackground): FormatAdapter {
  return {
    id: adapter.id, formats: adapter.formats,
    capabilities: format => adapter.capabilities(format), preview: (model, operation) => adapter.preview(model, operation),
    open: (bytes, format) => requiresBackgroundModel(bytes) ? parser.open(bytes, format) : adapter.open(bytes, format),
    apply: (bytes, model, operation) => adapter.apply(bytes, model, operation),
  };
}
