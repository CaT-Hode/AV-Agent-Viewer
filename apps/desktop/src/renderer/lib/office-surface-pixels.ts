import type { OfficeSurfaceTile } from '../../../../../packages/contracts/src/office-surface';
const littleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
let unpremultipliedChannels: Uint8ClampedArray<ArrayBuffer> | undefined;
/** The same floating-point product and Uint8ClampedArray rounding as the
 * scalar path, retained once instead of repeated for each translucent pixel. */
function unpremultiplyTable() {
  if (!unpremultipliedChannels) {
    const table = new Uint8ClampedArray(256 * 256);
    for (let alpha = 1; alpha < 256; alpha++) {
      const multiplier = 255 / alpha, offset = alpha << 8;
      for (let channel = 0; channel < 256; channel++) table[offset | channel] = channel * multiplier;
    }
    unpremultipliedChannels = table;
  }
  return unpremultipliedChannels;
}
/** The only pixel conversion used for document tiles and LOK window painting. */
export function officeTileRgba(tile: OfficeSurfaceTile): Uint8ClampedArray<ArrayBuffer> {
  if (!['rgba', 'bgra'].includes(tile.pixelFormat) || tile.alphaMode !== undefined && !['straight', 'premultiplied'].includes(tile.alphaMode)) throw new Error('Office tile 像素格式无效。');
  if (!Number.isSafeInteger(tile.width) || !Number.isSafeInteger(tile.height) || tile.width <= 0 || tile.height <= 0 || tile.width > 8192 || tile.height > 8192 || tile.width * tile.height * 4 > 64 * 1024 * 1024) throw new Error('Office tile 尺寸无效。');
  const source = tile.data instanceof Uint8Array ? tile.data : new Uint8Array(tile.data), expected = tile.width * tile.height * 4;
  if (source.byteLength !== expected) throw new Error('Office tile 像素长度与真实尺寸不匹配。');
  const bgra = tile.pixelFormat === 'bgra', premultiplied = tile.alphaMode === 'premultiplied';
  // ImageData consumes this view synchronously before createImageBitmap. The
  // received IPC buffer is not edited or retained as another converted copy.
  if (!bgra && !premultiplied && source.buffer instanceof ArrayBuffer) return new Uint8ClampedArray(source.buffer, source.byteOffset, expected);
  const rgba = new Uint8ClampedArray(expected);
  if (littleEndian && source.byteOffset % 4 === 0) {
    const input = new Uint32Array(source.buffer, source.byteOffset, expected / 4), output = new Uint32Array(rgba.buffer);
    if (bgra && premultiplied) {
      // Native BGRA paper is overwhelmingly opaque. Four packed words share
      // one alpha test; mixed groups keep exact per-channel alpha semantics.
      let pixel = 0, table = unpremultipliedChannels;
      for (; pixel + 3 < input.length; pixel += 4) {
        const a = input[pixel], b = input[pixel + 1], c = input[pixel + 2], d = input[pixel + 3];
        if ((a & b & c & d) >>> 24 === 255) {
          output[pixel] = (a & 0xff00ff00) | (a & 0xff) << 16 | (a >>> 16 & 0xff);
          output[pixel + 1] = (b & 0xff00ff00) | (b & 0xff) << 16 | (b >>> 16 & 0xff);
          output[pixel + 2] = (c & 0xff00ff00) | (c & 0xff) << 16 | (c >>> 16 & 0xff);
          output[pixel + 3] = (d & 0xff00ff00) | (d & 0xff) << 16 | (d >>> 16 & 0xff);
        } else {
          const channels = table ??= unpremultiplyTable();
          for (let shift = 0; shift < 4; shift++) {
            const at = pixel + shift, packed = input[at], alpha = packed >>> 24;
            if (alpha === 255) output[at] = (packed & 0xff00ff00) | (packed & 0xff) << 16 | (packed >>> 16 & 0xff);
            else if (alpha !== 0) {
              const offset = alpha << 8;
              output[at] = (packed & 0xff000000) | channels[offset | (packed >>> 16 & 0xff)] | channels[offset | (packed >>> 8 & 0xff)] << 8 | channels[offset | (packed & 0xff)] << 16;
            }
          }
        }
      }
      for (; pixel < input.length; pixel++) {
        const packed = input[pixel], alpha = packed >>> 24;
        if (alpha === 255) output[pixel] = (packed & 0xff00ff00) | (packed & 0xff) << 16 | (packed >>> 16 & 0xff);
        else if (alpha !== 0) {
          const channels = table ??= unpremultiplyTable(), offset = alpha << 8;
          output[pixel] = (packed & 0xff000000) | channels[offset | (packed >>> 16 & 0xff)] | channels[offset | (packed >>> 8 & 0xff)] << 8 | channels[offset | (packed & 0xff)] << 16;
        }
      }
      return rgba;
    }
    for (let pixel = 0; pixel < input.length; pixel++) {
      const packed = input[pixel], alpha = packed >>> 24;
      // Native document tiles are mostly opaque paper/text. Swap one packed
      // word rather than multiplying and clamping four channels per pixel.
      if (!premultiplied || alpha === 255) output[pixel] = bgra ? (packed & 0xff00ff00) | (packed & 0xff) << 16 | (packed >>> 16 & 0xff) : packed;
      else if (alpha !== 0) {
        const i = pixel * 4, multiplier = 255 / alpha;
        rgba[i] = source[i + (bgra ? 2 : 0)] * multiplier; rgba[i + 1] = source[i + 1] * multiplier; rgba[i + 2] = source[i + (bgra ? 0 : 2)] * multiplier; rgba[i + 3] = alpha;
      }
    }
    return rgba;
  }
  for (let i = 0; i < expected; i += 4) {
    const alpha = source[i + 3], multiplier = premultiplied ? alpha ? 255 / alpha : 0 : 1;
    rgba[i] = source[i + (bgra ? 2 : 0)] * multiplier; rgba[i + 1] = source[i + 1] * multiplier; rgba[i + 2] = source[i + (bgra ? 0 : 2)] * multiplier; rgba[i + 3] = alpha;
  }
  return rgba;
}
