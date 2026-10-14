import type { OfficeSurfaceTile } from '../../../../../packages/contracts/src/office-surface';
/** The only pixel conversion used for document tiles and LOK window painting. */
export function officeTileRgba(tile: OfficeSurfaceTile): Uint8ClampedArray<ArrayBuffer> {
  if (!['rgba', 'bgra'].includes(tile.pixelFormat) || tile.alphaMode !== undefined && !['straight', 'premultiplied'].includes(tile.alphaMode)) throw new Error('Office tile 像素格式无效。');
  if (!Number.isSafeInteger(tile.width) || !Number.isSafeInteger(tile.height) || tile.width <= 0 || tile.height <= 0 || tile.width > 8192 || tile.height > 8192 || tile.width * tile.height * 4 > 64 * 1024 * 1024) throw new Error('Office tile 尺寸无效。');
  const source = tile.data instanceof Uint8Array ? tile.data : new Uint8Array(tile.data), expected = tile.width * tile.height * 4;
  if (source.byteLength !== expected) throw new Error('Office tile 像素长度与真实尺寸不匹配。');
  const rgba = new Uint8ClampedArray(expected);
  for (let i = 0; i < expected; i += 4) {
    const alpha = source[i + 3], multiplier = tile.alphaMode === 'premultiplied' ? alpha ? 255 / alpha : 0 : 1;
    rgba[i] = source[i + (tile.pixelFormat === 'bgra' ? 2 : 0)] * multiplier; rgba[i + 1] = source[i + 1] * multiplier; rgba[i + 2] = source[i + (tile.pixelFormat === 'bgra' ? 0 : 2)] * multiplier; rgba[i + 3] = alpha;
  }
  return rgba;
}
