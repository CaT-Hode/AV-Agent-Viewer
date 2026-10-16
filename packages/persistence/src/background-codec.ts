import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { ViewerError } from '../../contracts/src/index';

const BACKGROUND_THRESHOLD = 256 * 1024;
type CodecRequest = { kind: 'text'; text: string; bom: boolean } | { kind: 'hash'; bytes: Uint8Array } | { kind: 'json'; value: unknown; fingerprint?: boolean };
type CodecResult = { bytes?: Uint8Array; sha256?: string; json?: string };
type Job = { request: CodecRequest; retainedBytes: number; resolve(value: CodecResult): void; reject(error: unknown): void };

// Inline source keeps the same implementation usable in tsx, the bundled main
// process and the portable asar, without a second filesystem worker entrypoint.
const workerSource = String.raw`
const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
parentPort.on('message', request => {
  try {
    if (request.kind === 'json') {
      const json = JSON.stringify(request.value);
      if (typeof json !== 'string') throw new TypeError('Workspace is not JSON serializable');
      parentPort.postMessage(request.fingerprint ? { sha256: createHash('sha256').update(json, 'utf8').digest('hex') } : { json });
    } else if (request.kind === 'hash') {
      parentPort.postMessage({ sha256: createHash('sha256').update(request.bytes).digest('hex') });
    } else {
      const size = Buffer.byteLength(request.text, 'utf8'), bytes = new Uint8Array(size + (request.bom ? 3 : 0));
      if (request.bom) bytes.set([239, 187, 191]);
      Buffer.from(bytes.buffer).write(request.text, request.bom ? 3 : 0, size, 'utf8');
      parentPort.postMessage({ bytes }, [bytes.buffer]);
    }
  } catch (error) { parentPort.postMessage({ error: String(error), name: error && error.name }); }
});`;

/** One bounded CPU lane. A full queue rejects before a caller changes document
 * state; it never leaves unbounded promises retaining copies of large bodies. */
export class BackgroundCodec {
  private worker?: Worker;
  private active?: Job;
  private readonly queue: Job[] = [];
  private retainedBytes = 0;
  private idleTimer?: NodeJS.Timeout;
  private counts = { completed: 0, rejected: 0, maximumRetainedBytes: 0 };
  constructor(readonly maxRetainedBytes = 128 * 1024 * 1024, readonly maxEntries = 8) {
    if (![maxRetainedBytes, maxEntries].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('后台编码预算必须是正整数。');
  }
  get statistics() { return { ...this.counts, retainedBytes: this.retainedBytes, pendingEntries: this.queue.length + (this.active ? 1 : 0), maxRetainedBytes: this.maxRetainedBytes }; }
  run(request: CodecRequest, retainedBytes: number): Promise<CodecResult> {
    const entries = this.queue.length + (this.active ? 1 : 0);
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) return Promise.reject(new RangeError('后台编码字节估算无效。'));
    // A single oversized document can use the lane exclusively. Every other
    // request remains subject to the byte and entry budgets until it completes.
    if (entries >= this.maxEntries || entries > 0 && this.retainedBytes + retainedBytes > this.maxRetainedBytes) {
      this.counts.rejected++;
      return Promise.reject(new ViewerError('BACKGROUND_CODEC_BUSY', '后台编码队列正忙，请稍后重试。'));
    }
    // Freeze mutable input now, including offset views and SharedArrayBuffer.
    // Queued jobs must observe the call boundary rather than a later mutation.
    const frozen: CodecRequest = request.kind === 'hash' ? { kind: 'hash', bytes: new Uint8Array(request.bytes) } : request.kind === 'json' ? { kind: 'json', value: structuredClone(request.value), fingerprint: request.fingerprint } : { kind: 'text', text: request.text, bom: request.bom };
    const result = new Promise<CodecResult>((resolve, reject) => this.queue.push({ request: frozen, retainedBytes, resolve, reject }));
    this.retainedBytes += retainedBytes; this.counts.maximumRetainedBytes = Math.max(this.counts.maximumRetainedBytes, this.retainedBytes);
    this.pump(); return result;
  }
  private pump() {
    if (this.active || !this.queue.length) return;
    clearTimeout(this.idleTimer); this.idleTimer = undefined;
    if (!this.worker) {
      let worker: Worker;
      try { worker = new Worker(workerSource, { eval: true }); }
      catch (error) { for (const job of this.queue.splice(0)) job.reject(error); this.retainedBytes = 0; return; }
      this.worker = worker;
      worker.on('message', (value: CodecResult & { error?: string; name?: string }) => {
        if (this.worker !== worker || !this.active) return;
        const job = this.active; this.active = undefined; this.retainedBytes -= job.retainedBytes;
        if (value.error) job.reject(Object.assign(new Error(value.error), { name: value.name ?? 'Error' }));
        else { this.counts.completed++; job.resolve(value); }
        if (this.queue.length) this.pump();
        else {
          worker.unref();
          this.idleTimer = setTimeout(() => { if (this.worker === worker && !this.active) { this.worker = undefined; void worker.terminate(); } }, 15000); this.idleTimer.unref();
        }
      });
      const failed = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        for (const job of [...(this.active ? [this.active] : []), ...this.queue.splice(0)]) job.reject(error);
        this.active = undefined; this.retainedBytes = 0; void worker.terminate();
      };
      worker.on('error', failed); worker.on('exit', code => failed(new Error('后台编码进程提前退出：' + code)));
    }
    const worker = this.worker; this.active = this.queue.shift()!; worker.ref();
    try {
      const request = this.active.request;
      worker.postMessage(request, request.kind === 'hash' ? [request.bytes.buffer as ArrayBuffer] : []);
    } catch (error) {
      const job = this.active; this.active = undefined; this.retainedBytes -= job.retainedBytes; job.reject(error); this.pump();
      if (!this.active) worker.unref();
    }
  }
}

export const documentCodec = new BackgroundCodec();
export async function encodeDocumentText(text: string, bom = false) {
  if (text.length < BACKGROUND_THRESHOLD) {
    const encoded = new TextEncoder().encode(text);
    if (!bom) return encoded;
    const bytes = new Uint8Array(encoded.length + 3); bytes.set([0xef, 0xbb, 0xbf]); bytes.set(encoded, 3); return bytes;
  }
  return (await documentCodec.run({ kind: 'text', text, bom }, text.length * 5 + 3)).bytes!;
}
export async function hashDocumentBytes(bytes: Uint8Array) {
  if (bytes.byteLength < BACKGROUND_THRESHOLD) return createHash('sha256').update(bytes).digest('hex');
  return (await documentCodec.run({ kind: 'hash', bytes }, bytes.byteLength * 2)).sha256!;
}
export async function stringifyDocumentValue(value: unknown, estimatedBytes: number) {
  if (estimatedBytes < BACKGROUND_THRESHOLD) return JSON.stringify(value);
  return (await documentCodec.run({ kind: 'json', value }, estimatedBytes * 2)).json!;
}
export async function fingerprintDocumentValue(value: unknown, estimatedBytes: number) {
  const digest = estimatedBytes < BACKGROUND_THRESHOLD ? createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex') : (await documentCodec.run({ kind: 'json', value, fingerprint: true }, estimatedBytes * 2)).sha256!;
  return 'sha256:' + digest;
}
