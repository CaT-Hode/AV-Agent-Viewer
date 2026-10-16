/** Conservative resident-size estimate without constructing a second full JSON
 * body. Shared children within one graph are charged once; strings are UTF-16. */
export function retainedValueBytes(root: unknown) {
  const pending: unknown[] = [root], seen = new WeakSet<object>(); let bytes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') { bytes += value.length * 2 + 16; continue; }
    if (!value || typeof value !== 'object') { bytes += 8; continue; }
    if (seen.has(value)) continue; seen.add(value); bytes += 32;
    if (ArrayBuffer.isView(value)) { bytes += value.byteLength; continue; }
    if (value instanceof ArrayBuffer || typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) { bytes += value.byteLength; continue; }
    if (value instanceof Map) { for (const [key, child] of value) pending.push(key, child); continue; }
    if (value instanceof Set) { for (const child of value) pending.push(child); continue; }
    for (const key of Object.keys(value)) {
      bytes += key.length * 2 + 16;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property && Object.hasOwn(property, 'value')) pending.push(property.value);
    }
  }
  return bytes;
}
