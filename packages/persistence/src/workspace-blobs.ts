import { createHash } from 'node:crypto';

export const MAX_TEXT_DELTA_DEPTH = 32;
export type BlobReference = { sha256: string; byteLength: number; delta?: { sha256: string; byteLength: number; depth: number } };
export type FrozenBlob = { reference: BlobReference; data?: Buffer; base?: FrozenBlob };
export type TextModelReference = { kind: 'text'; format: 'markdown' | 'html' };
type DeltaPayload = { version: 1; base: BlobReference; from: number; to: number; insert: string };
export const blobStorageReference = (reference: BlobReference) => reference.delta ?? reference;
export const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function validateBlobReference(reference: BlobReference) {
  const valid = (value: { sha256: string; byteLength: number }) => value && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0;
  if (!valid(reference) || reference.delta && (!valid(reference.delta) || !Number.isSafeInteger(reference.delta.depth) || reference.delta.depth < 1 || reference.delta.depth > MAX_TEXT_DELTA_DEPTH)) throw new Error('WORKSPACE_BLOB_REFERENCE_INVALID');
}
export function freezeWorkspaceBlob(bytes: Uint8Array, base?: { bytes: Uint8Array; blob: FrozenBlob }): FrozenBlob {
  if (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer) bytes = Uint8Array.from(bytes);
  const reference: BlobReference = { sha256: hashBytes(bytes), byteLength: bytes.byteLength };
  if (base && !(typeof SharedArrayBuffer !== 'undefined' && base.bytes.buffer instanceof SharedArrayBuffer) && base.bytes.byteLength === base.blob.reference.byteLength && hashBytes(base.bytes) === base.blob.reference.sha256) {
    if (reference.sha256 === base.blob.reference.sha256 && reference.byteLength === base.blob.reference.byteLength) return base.blob;
    if ((base.blob.reference.delta?.depth ?? 0) >= MAX_TEXT_DELTA_DEPTH) return { reference, data: Buffer.from(bytes) };
    const before = Buffer.from(base.bytes.buffer, base.bytes.byteOffset, base.bytes.byteLength), after = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let from = 0, oldEnd = before.length, newEnd = after.length;
    const block = 64 * 1024, commonLength = Math.min(oldEnd, newEnd);
    // Native comparisons skip unchanged chunks. Only the first differing
    // chunk at either end needs the byte loop, including offset buffer views.
    while (from + block <= commonLength && before.subarray(from, from + block).equals(after.subarray(from, from + block))) from += block;
    while (from < oldEnd && from < newEnd && before[from] === bytes[from]) from++;
    while (oldEnd - from >= block && newEnd - from >= block && before.subarray(oldEnd - block, oldEnd).equals(after.subarray(newEnd - block, newEnd))) { oldEnd -= block; newEnd -= block; }
    while (oldEnd > from && newEnd > from && before[oldEnd - 1] === bytes[newEnd - 1]) { oldEnd--; newEnd--; }
    const payload: DeltaPayload = { version: 1, base: base.blob.reference, from, to: oldEnd, insert: Buffer.from(bytes.buffer, bytes.byteOffset + from, newEnd - from).toString('base64') };
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    // Small/fully rewritten documents are cheaper as ordinary checkpoints.
    if (data.byteLength < bytes.byteLength / 2) return { reference: { ...reference, delta: { sha256: hashBytes(data), byteLength: data.byteLength, depth: (base.blob.reference.delta?.depth ?? 0) + 1 } }, data, base: base.blob };
  }
  return { reference, data: Buffer.from(bytes) };
}
export function collectFrozenBlobs(roots: FrozenBlob[]) {
  const result: FrozenBlob[] = [], seen = new Set<FrozenBlob>();
  const visit = (blob: FrozenBlob, depth = 0) => {
    if (depth > MAX_TEXT_DELTA_DEPTH) throw new Error('WORKSPACE_DELTA_DEPTH_INVALID');
    if (seen.has(blob)) return; seen.add(blob);
    if (blob.base) visit(blob.base, depth + 1);
    result.push(blob);
  };
  roots.forEach(blob => visit(blob)); return result;
}
function deltaPayload(bytes: Buffer, reference: BlobReference): DeltaPayload {
  let value: DeltaPayload;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('WORKSPACE_DELTA_CORRUPT'); }
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to) || value.from < 0 || value.to < value.from || typeof value.insert !== 'string') throw new Error('WORKSPACE_DELTA_CORRUPT');
  validateBlobReference(value.base);
  if (reference.delta!.depth !== (value.base.delta?.depth ?? 0) + 1 || value.to > value.base.byteLength) throw new Error('WORKSPACE_DELTA_CORRUPT');
  const insert = Buffer.from(value.insert, 'base64');
  if (insert.toString('base64') !== value.insert || value.base.byteLength - value.to + value.from + insert.byteLength !== reference.byteLength) throw new Error('WORKSPACE_DELTA_CORRUPT');
  return value;
}
type Reader = (reference: { sha256: string; byteLength: number }) => Promise<Buffer>;
export async function readWorkspaceBlob(reference: BlobReference, read: Reader, loaded?: (blob: FrozenBlob) => void) {
  validateBlobReference(reference);
  const chain: { reference: BlobReference; delta: DeltaPayload; insert: Buffer }[] = [];
  let cursor = reference;
  while (cursor.delta) {
    if (chain.length >= MAX_TEXT_DELTA_DEPTH) throw new Error('WORKSPACE_DELTA_DEPTH_INVALID');
    const delta = deltaPayload(await read(cursor.delta), cursor);
    chain.push({ reference: cursor, delta, insert: Buffer.from(delta.insert, 'base64') }); cursor = delta.base;
  }
  const checkpoint = await read(cursor);
  if (!chain.length) { loaded?.({ reference }); return checkpoint; }
  const capacity = Math.max(checkpoint.byteLength, ...chain.map(entry => entry.reference.byteLength));
  const buffer = Buffer.allocUnsafe(capacity); checkpoint.copy(buffer); let length = checkpoint.byteLength;
  // One reconstruction buffer, with overlap-safe moves, avoids retaining a
  // complete document for every link in a long editing chain.
  let dependency: FrozenBlob = { reference: cursor };
  for (const { reference: target, delta, insert } of chain.reverse()) {
    buffer.copy(buffer, delta.from + insert.byteLength, delta.to, length); insert.copy(buffer, delta.from);
    length = target.byteLength;
    if (hashBytes(buffer.subarray(0, length)) !== target.sha256) throw new Error('WORKSPACE_BLOB_CORRUPT');
    dependency = { reference: target, base: dependency };
  }
  loaded?.(dependency);
  return capacity > length * 1.5 ? Buffer.from(buffer.subarray(0, length)) : buffer.subarray(0, length);
}
/** Mark physical dependencies without materializing every historical version. */
export async function markWorkspaceBlob(reference: BlobReference, read: Reader, marked: Set<string>, checkRaw?: (reference: BlobReference) => Promise<void>) {
  validateBlobReference(reference); let cursor = reference, depth = 0;
  for (;;) {
    if (depth++ > MAX_TEXT_DELTA_DEPTH) throw new Error('WORKSPACE_DELTA_DEPTH_INVALID');
    const stored = blobStorageReference(cursor);
    if (marked.has(stored.sha256)) return;
    if (!cursor.delta && checkRaw) { await checkRaw(cursor); marked.add(stored.sha256); return; }
    const bytes = await read(stored); marked.add(stored.sha256);
    if (!cursor.delta) return;
    cursor = deltaPayload(bytes, cursor).base;
  }
}
