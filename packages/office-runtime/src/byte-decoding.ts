import { Buffer } from 'node:buffer';

/** Each wire reply owns a fresh decode. Large tile/file buffers already cover
 * their whole backing store; expose a plain view without copying the pixels a
 * second time. Small pooled buffers must be copied so .buffer cannot expose
 * unrelated slab bytes through desktop IPC or the public runtime API. */
export function decodeNativeOfficeBytes(encoded: string): Uint8Array {
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? new Uint8Array(bytes.buffer)
    : new Uint8Array(bytes);
}
