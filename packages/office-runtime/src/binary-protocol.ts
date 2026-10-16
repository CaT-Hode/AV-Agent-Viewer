import { TextDecoder } from 'node:util';
import { NativeOfficeError } from './types';

export const OFFICE_BINARY_HEADER_BYTES = 24;
export const OFFICE_BINARY_JSON_CODE_UNITS = 160 * 1024 * 1024;
export const OFFICE_BINARY_RAW_BYTES = 64 * 1024 * 1024;
export const OFFICE_BINARY_ATTACHMENT_COUNT = 96;
const magic = new Uint8Array([65, 86, 75, 73, 84, 48, 50, 0]); // AVKIT02\0
type ObjectValue = Record<string, any>;
type Request = { method: string; retired?: boolean };
type Slot = { tile: ObjectValue; byteLength: number; bytes?: Uint8Array<ArrayBuffer> };
export interface NativeOfficeBinaryProtocolOptions {
  resolveRequest(id: string): Request | undefined;
  receive(message: unknown): void;
  /** Smaller limits permit boundary tests without allocating production-size buffers. */
  limits?: { jsonCodeUnits?: number; rawBytes?: number; attachments?: number };
}
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
const tileMethod = (method: string) => ['surfaceTiles', 'office-surface-tiles'].includes(method) ? 'tiles'
  : ['surfaceWindowPaint', 'office-surface-window-paint'].includes(method) ? 'window' : undefined;
const invalid = () => new NativeOfficeError('NATIVE_PROTOCOL_ERROR', 'Office 私有二进制响应无效。');
const excessive = () => new NativeOfficeError('NATIVE_PROTOCOL_LIMIT', 'Office 私有二进制响应过大。');

/** One ordered private socket stream. No input chunk or whole raw frame is retained.
 * Protocol/receiver errors clear buffered references and must terminate the connection.
 * Request retirement is supplied by the owner's bounded identity registry, not cached here. */
export class NativeOfficeBinaryProtocolReader {
  private readonly jsonLimit: number;
  private readonly rawLimit: number;
  private readonly countLimit: number;
  private header = new Uint8Array(OFFICE_BINARY_HEADER_BYTES);
  private headerLength = 0;
  private jsonRemaining = 0;
  private jsonUnits = 0;
  private jsonParts: string[] = [];
  private jsonTail = '';
  private decoder?: TextDecoder;
  private count = 0;
  private rawTotal = 0;
  private message?: ObjectValue;
  private requestId?: string;
  private requestMethod?: string;
  private discarded = false;
  private slots: Slot[] = [];
  private slotIndex = 0;
  private slotOffset = 0;
  private stage: 'header' | 'json' | 'raw' = 'header';
  private epoch = 0;
  private feeding = false;
  private queue: Uint8Array[] = [];
  private finished = false;

  constructor(private readonly options: NativeOfficeBinaryProtocolOptions) {
    this.jsonLimit = options.limits?.jsonCodeUnits ?? OFFICE_BINARY_JSON_CODE_UNITS;
    this.rawLimit = options.limits?.rawBytes ?? OFFICE_BINARY_RAW_BYTES;
    this.countLimit = options.limits?.attachments ?? OFFICE_BINARY_ATTACHMENT_COUNT;
    for (const [value, ceiling, minimum] of [[this.jsonLimit, OFFICE_BINARY_JSON_CODE_UNITS, 1], [this.rawLimit, OFFICE_BINARY_RAW_BYTES, 0], [this.countLimit, OFFICE_BINARY_ATTACHMENT_COUNT, 0]]) {
      if (!Number.isSafeInteger(value) || value < minimum || value > ceiling) throw new RangeError('Invalid Office private protocol limit.');
    }
  }

  /** Allocated, not-yet-delivered pixel stores only; excludes caller-owned input chunks. */
  get bufferedRawBytes() { return this.slots.reduce((sum, slot) => sum + (slot.bytes?.byteLength ?? 0), 0); }

  /** Drop an already-known in-progress read's pixels, then drain its remaining frame. */
  retire(id: string) { if (this.requestId === id) this.discard(); }

  /** Also abandons the current feed's queued tail, including when called by receive(). */
  clear() { this.epoch++; this.resetFrame(); this.queue = []; this.finished = false; }

  finish() {
    if (this.stage !== 'header' || this.headerLength || this.queue.length) { this.clear(); throw invalid(); }
    this.finished = true;
  }

  feed(chunk: Uint8Array) {
    if (!(chunk instanceof Uint8Array)) { this.clear(); throw invalid(); }
    if (!chunk.byteLength) return;
    if (this.finished) { this.clear(); throw invalid(); }
    // A receiver may synchronously feed a new chunk. Consume the current chunk
    // first; own only the deferred bytes so a pooled caller Buffer is not retained.
    if (this.feeding) { this.queue.push(new Uint8Array(chunk)); return; }
    this.feeding = true;
    try {
      let next: Uint8Array | undefined = chunk;
      while (next) { this.consume(next); next = this.queue.shift(); }
    } catch (error) { this.clear(); throw error; }
    finally { this.feeding = false; }
  }

  private consume(chunk: Uint8Array) {
    const epoch = this.epoch;
    let offset = 0;
    while (offset < chunk.byteLength && epoch === this.epoch) {
      if (this.finished) throw invalid();
      if (this.stage === 'header') {
        const take = Math.min(OFFICE_BINARY_HEADER_BYTES - this.headerLength, chunk.byteLength - offset);
        this.header.set(chunk.subarray(offset, offset + take), this.headerLength); this.headerLength += take; offset += take;
        if (this.headerLength === OFFICE_BINARY_HEADER_BYTES) this.readHeader();
      } else if (this.stage === 'json') {
        const take = Math.min(this.jsonRemaining, chunk.byteLength - offset);
        this.decodeJson(chunk.subarray(offset, offset + take), true);
        this.jsonRemaining -= take; offset += take;
        if (!this.jsonRemaining) {
          this.decodeJson(); this.decoder = undefined;
          if (this.jsonTail) this.jsonParts.push(this.jsonTail);
          const text = this.jsonParts.join(''); this.jsonParts = []; this.jsonTail = '';
          let envelope: unknown;
          try { envelope = JSON.parse(text); } catch { throw invalid(); }
          this.readEnvelope(envelope);
          if (epoch !== this.epoch) break;
          if (!this.slots.length) this.deliver();
        }
      } else {
        this.checkRequest();
        if (epoch !== this.epoch) break;
        const slot = this.slots[this.slotIndex];
        const take = Math.min(slot.byteLength - this.slotOffset, chunk.byteLength - offset);
        if (!this.discarded) {
          slot.bytes ??= new Uint8Array(slot.byteLength);
          slot.bytes.set(chunk.subarray(offset, offset + take), this.slotOffset);
        }
        offset += take; this.slotOffset += take;
        if (this.slotOffset === slot.byteLength) { this.slotIndex++; this.slotOffset = 0; }
        if (this.slotIndex === this.slots.length) this.deliver();
      }
    }
  }

  private readHeader() {
    if (!magic.every((byte, index) => this.header[index] === byte)) throw invalid();
    const header = new DataView(this.header.buffer);
    if (header.getUint16(8) !== 2 || header.getUint16(10) !== 0) throw invalid();
    this.jsonRemaining = header.getUint32(12); this.count = header.getUint32(16); this.rawTotal = header.getUint32(20);
    if (this.jsonRemaining > this.jsonLimit * 3 || this.count > this.countLimit || this.rawTotal > this.rawLimit) throw excessive();
    if (!this.jsonRemaining || (this.count === 0) !== (this.rawTotal === 0)) throw invalid();
    this.stage = 'json';
    // Preserve JSON.parse's BOM behavior, reject malformed/incomplete UTF-8,
    // and count decoded UTF-16 units independently from header UTF-8 bytes.
    this.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  }

  private appendJson(text: string) {
    this.jsonUnits += text.length;
    if (this.jsonUnits > this.jsonLimit) throw excessive();
    this.jsonTail += text;
    // Tiny network fragments must not grow one array entry per received byte.
    if (this.jsonTail.length >= 64 * 1024) { this.jsonParts.push(this.jsonTail); this.jsonTail = ''; }
  }

  private decodeJson(bytes?: Uint8Array, stream = false) {
    let text: string;
    try { text = this.decoder!.decode(bytes, { stream }); } catch { throw invalid(); }
    this.appendJson(text);
  }

  private readEnvelope(envelope: unknown) {
    if (!object(envelope) || !object(envelope.message) || !Array.isArray(envelope.attachments) || envelope.attachments.length !== this.count) throw invalid();
    const message = envelope.message;
    this.message = message;
    const id = typeof message.id === 'string' ? message.id : undefined;
    const epoch = this.epoch, request = id ? this.options.resolveRequest(id) : undefined;
    if (epoch !== this.epoch) return;
    const kind = request && tileMethod(request.method);
    if (kind && message.ok === true && Object.hasOwn(message, 'type')) throw invalid();
    if (this.count && (!id || !kind || message.ok !== true || message.type !== undefined)) throw invalid();
    if (kind && message.type === undefined) {
      this.requestId = id; this.requestMethod = request!.method;
      if (request!.retired) this.discard();
    }
    if (!kind || message.ok !== true || message.type !== undefined) {
      if (this.count || this.rawTotal) throw invalid();
      return;
    }
    if (!object(message.result)) throw invalid();
    const tiles = kind === 'tiles' ? message.result.tiles : [message.result.tile];
    if (!Array.isArray(tiles) || tiles.length !== this.count || tiles.length > (kind === 'tiles' ? 96 : 1) || kind === 'window' && tiles.length !== 1) throw invalid();
    const side = kind === 'tiles' ? 2048 : 4096;
    let total = 0;
    for (let index = 0; index < tiles.length; index++) {
      const tile = tiles[index], attachment = envelope.attachments[index];
      if (!object(tile) || Object.hasOwn(tile, 'data') || !validKey(tile.key) || !object(tile.rectTwips)
        || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(tile.rectTwips[key])) || tile.rectTwips.width <= 0 || tile.rectTwips.height <= 0
        || !Number.isSafeInteger(tile.width) || !Number.isSafeInteger(tile.height) || tile.width < 1 || tile.height < 1 || tile.width > side || tile.height > side
        || !['rgba', 'bgra'].includes(tile.pixelFormat) || tile.alphaMode !== undefined && !['straight', 'premultiplied'].includes(tile.alphaMode)
        || !object(attachment) || attachment.tileIndex !== index || !Number.isSafeInteger(attachment.byteLength) || attachment.byteLength !== tile.width * tile.height * 4) throw invalid();
      total += attachment.byteLength;
      if (total > this.rawLimit) throw excessive();
      this.slots.push({ tile, byteLength: attachment.byteLength });
    }
    if (total !== this.rawTotal) throw invalid();
    this.stage = 'raw';
  }

  private checkRequest() {
    if (!this.requestId || !this.requestMethod || this.discarded) return;
    const epoch = this.epoch, request = this.options.resolveRequest(this.requestId);
    if (epoch !== this.epoch) return;
    if (!request || request.retired) { this.discard(); return; }
    if (request.method !== this.requestMethod) throw invalid();
  }

  private discard() { this.discarded = true; for (const slot of this.slots) slot.bytes = undefined; }

  private deliver() {
    const epoch = this.epoch;
    this.checkRequest();
    if (epoch !== this.epoch) return;
    const message = this.message!, discarded = this.discarded;
    if (!discarded) for (const slot of this.slots) { if (!slot.bytes) throw invalid(); slot.tile.data = slot.bytes; }
    // Reset before invoking user code: clear/reentrant feed cannot revive this frame.
    this.resetFrame();
    if (!discarded) this.options.receive(message);
  }

  private resetFrame() {
    this.headerLength = this.jsonRemaining = this.jsonUnits = this.count = this.rawTotal = this.slotIndex = this.slotOffset = 0;
    this.jsonParts = []; this.jsonTail = ''; this.decoder = undefined; this.message = undefined; this.requestId = this.requestMethod = undefined;
    this.slots = []; this.discarded = false; this.stage = 'header';
  }
}
