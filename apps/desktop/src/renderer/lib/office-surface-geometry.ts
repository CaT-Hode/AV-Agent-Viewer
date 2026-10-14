import type { Rect } from '../../../../../packages/contracts/src/index';
import type { OfficeSurfaceState, OfficeSurfaceTileSpec } from '../../../../../packages/contracts/src/office-surface';

export const OFFICE_TWIPS_PER_CSS_PIXEL = 15;
export type OfficeSurfaceGeometry = { zoom: number; scrollX: number; scrollY: number; offsetX: number; offsetY: number; viewport: Rect };
const finite = (n: number) => Number.isFinite(n);
export function officeCssScale(zoom: number) { if (!finite(zoom) || zoom <= 0) throw new Error('Office 缩放比例无效。'); return zoom / OFFICE_TWIPS_PER_CSS_PIXEL; }
export function officeDocumentPoint(clientX: number, clientY: number, geometry: OfficeSurfaceGeometry) {
  const scale = officeCssScale(geometry.zoom);
  return { x: (clientX - geometry.viewport.x + geometry.scrollX - geometry.offsetX) / scale, y: (clientY - geometry.viewport.y + geometry.scrollY - geometry.offsetY) / scale };
}
export function officeViewportRect(rect: Rect, geometry: OfficeSurfaceGeometry): Rect {
  const scale = officeCssScale(geometry.zoom);
  return { x: geometry.viewport.x + geometry.offsetX + rect.x * scale - geometry.scrollX, y: geometry.viewport.y + geometry.offsetY + rect.y * scale - geometry.scrollY, width: rect.width * scale, height: rect.height * scale };
}
export function intersectOfficeRect(left: Rect, right: Rect): Rect | undefined {
  const x = Math.max(left.x, right.x), y = Math.max(left.y, right.y), endX = Math.min(left.x + left.width, right.x + right.width), endY = Math.min(left.y + left.height, right.y + right.height);
  return endX > x && endY > y ? { x, y, width: endX - x, height: endY - y } : undefined;
}
export function officeVisibleTwips(geometry: OfficeSurfaceGeometry, size: { width: number; height: number }): Rect {
  const start = officeDocumentPoint(geometry.viewport.x, geometry.viewport.y, geometry), scale = officeCssScale(geometry.zoom);
  return intersectOfficeRect({ x: start.x, y: start.y, width: geometry.viewport.width / scale, height: geometry.viewport.height / scale }, { x: 0, y: 0, ...size }) ?? { x: Math.max(0, Math.min(size.width, start.x)), y: Math.max(0, Math.min(size.height, start.y)), width: 0, height: 0 };
}
export function officeCurrentPage(pages: readonly Rect[], visible: Rect): number | undefined {
  let chosen: number | undefined, maximum = 0;
  pages.forEach((page, index) => { const intersection = intersectOfficeRect(page, visible), area = intersection ? intersection.width * intersection.height : 0; if (area > maximum) { maximum = area; chosen = index; } });
  return chosen;
}
export function officeSurfaceSize(state: OfficeSurfaceState) { return state.parts.find(part => part.index === state.partIndex)?.sizeTwips ?? state.sizeTwips; }
/** Engine page margins are workspace pixels, never paper; preserve every pixel inside actual page/part bounds. */
export function officeSurfaceClipRects(state: OfficeSurfaceState): Rect[] {
  const size = officeSurfaceSize(state), bounds = { x: 0, y: 0, ...size };
  const actual = state.format === 'docx' && state.pages?.length ? state.pages : [bounds];
  return actual.map(rect => intersectOfficeRect(rect, bounds)).filter((rect): rect is Rect => !!rect);
}
/** Tile grid follows document coordinates; DPR changes pixels, never mouse or scroll coordinates. */
export function officeVisibleTiles(visible: Rect, size: { width: number; height: number }, zoom: number, dpr: number, prefetch = 1, tileCss = 256): OfficeSurfaceTileSpec[] {
  const scale = officeCssScale(zoom);
  if (!finite(dpr) || dpr <= 0 || !finite(tileCss) || tileCss <= 0 || !Number.isInteger(prefetch) || prefetch < 0) throw new Error('Office tile 参数无效。');
  if (visible.width <= 0 || visible.height <= 0) return [];
  const step = Math.max(1, Math.round(tileCss / scale)), maxColumn = Math.max(0, Math.ceil(size.width / step) - 1), maxRow = Math.max(0, Math.ceil(size.height / step) - 1);
  const left = Math.max(0, Math.floor(visible.x / step) - prefetch), top = Math.max(0, Math.floor(visible.y / step) - prefetch);
  const right = Math.min(maxColumn, Math.ceil((visible.x + visible.width) / step) - 1 + prefetch), bottom = Math.min(maxRow, Math.ceil((visible.y + visible.height) / step) - 1 + prefetch);
  const tiles: OfficeSurfaceTileSpec[] = [];
  for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) {
    const x = column * step, y = row * step, width = Math.min(step, size.width - x), height = Math.min(step, size.height - y);
    tiles.push({ key: `${column}:${row}:${zoom}:${dpr}`, rectTwips: { x, y, width, height }, pixelWidth: Math.max(1, Math.ceil(width * scale * dpr)), pixelHeight: Math.max(1, Math.ceil(height * scale * dpr)) });
  }
  return tiles;
}
/** High DPR must obey both IPC item count and physical bitmap memory, without dropping any tile. */
export function officeTileBatches(tiles: readonly OfficeSurfaceTileSpec[], maxItems = 12, maxBytes = 64 * 1024 * 1024): OfficeSurfaceTileSpec[][] {
  if (!Number.isSafeInteger(maxItems) || maxItems <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Office tile 请求预算无效。');
  const batches: OfficeSurfaceTileSpec[][] = []; let batch: OfficeSurfaceTileSpec[] = [], bytes = 0;
  for (const tile of tiles) {
    const size = tile.pixelWidth * tile.pixelHeight * 4; if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) throw new Error('单个 Office tile 超出请求预算。');
    if (batch.length && (batch.length >= maxItems || bytes + size > maxBytes)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(tile); bytes += size;
  }
  if (batch.length) batches.push(batch); return batches;
}
