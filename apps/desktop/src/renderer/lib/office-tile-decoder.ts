import type { OfficeSurfaceTile } from '../../../../../packages/contracts/src/office-surface';
import { officeTileRgba } from './office-surface-pixels';

export type OfficeDecodedTile = Pick<OfficeSurfaceTile, 'key' | 'width' | 'height'>;
type BitmapResource = { close(): void };
type TileDecodeOptions<T extends BitmapResource> = {
  current(): boolean;
  validate(tile: OfficeSurfaceTile): void;
  decode(image: ImageData): Promise<T>;
  /** Ownership transfers to the cache, including its rejected-admission disposal. */
  admit(tile: OfficeDecodedTile, bitmap: T): void;
  imageData?(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): ImageData;
};

/** Keep raw tiles out of the suspended async frame. Only the ImageData needed
 * by the browser decoder and small identity/size metadata survive this call.
 * Straight RGBA may share its buffer with ImageData: never detach or edit it. */
function beginTileDecode<T extends BitmapResource>(tiles: OfficeSurfaceTile[], index: number, options: TileDecodeOptions<T>) {
  const tile = tiles[index];
  delete tiles[index];
  if (!tile) throw new Error('Office tile 回执缺少像素。');
  options.validate(tile);
  const metadata: OfficeDecodedTile = { key: tile.key, width: tile.width, height: tile.height };
  const pixels = officeTileRgba(tile);
  const image = options.imageData ? options.imageData(pixels, tile.width, tile.height) : new ImageData(pixels, tile.width, tile.height);
  return { metadata, bitmap: options.decode(image) };
}

/** Consumes an exclusively owned renderer RPC batch. The original reply loses
 * each raw tile before decoding waits; failure/cancellation drops every unused
 * tile as well. Cache tickets and their final cancellation remain with caller. */
export async function consumeOfficeTileBatch<T extends BitmapResource>(tiles: OfficeSurfaceTile[], options: TileDecodeOptions<T>): Promise<void> {
  try {
    for (let index = 0; index < tiles.length; index++) {
      if (!options.current()) break;
      const pending = beginTileDecode(tiles, index, options);
      const bitmap = await pending.bitmap;
      if (!options.current()) { bitmap.close(); break; }
      options.admit(pending.metadata, bitmap);
    }
  } finally { tiles.length = 0; }
}
