import type { Rect } from '../../../../../packages/contracts/src/index';
import type { OfficeSurfaceTileSpec } from '../../../../../packages/contracts/src/office-surface';
import { intersectOfficeRect, officeVisibleTiles } from './office-surface-geometry';

type PlanSpec = Readonly<Omit<OfficeSurfaceTileSpec, 'rectTwips'>> & { readonly rectTwips: Readonly<Rect> };
export type OfficeTilePlan = Readonly<{
  specs: readonly PlanSpec[];
  visibleSpecs: readonly PlanSpec[];
  visibleBytes: number;
  budgetBytes: number;
  requestedBytes: number;
}>;
const reserveBytes = 16 * 1024 * 1024, maximumBytes = 256 * 1024 * 1024;

/** Keep the original stable visible-first ordering and sequential budget filter.
 * A skipped large tile must not prevent a later small edge tile from fitting. */
export function planOfficeTiles(visible: Readonly<Rect>, size: { readonly width: number; readonly height: number }, zoom: number, dpr: number): OfficeTilePlan {
  const visibleTiles: OfficeSurfaceTileSpec[] = [], haloTiles: OfficeSurfaceTileSpec[] = [];
  let visibleBytes = 0;
  for (const spec of officeVisibleTiles(visible, size, zoom, dpr)) {
    if (intersectOfficeRect(spec.rectTwips, visible)) {
      visibleTiles.push(spec); visibleBytes += spec.pixelWidth * spec.pixelHeight * 4;
    } else haloTiles.push(spec);
  }
  if (visibleBytes > maximumBytes) throw new Error('当前 Office 可见区域超过画布资源限制。');
  const budgetBytes = Math.max(reserveBytes, Math.min(maximumBytes, visibleBytes + reserveBytes));
  const specs: PlanSpec[] = [], visibleSpecs: PlanSpec[] = [];
  let requestedBytes = 0;
  for (const group of [visibleTiles, haloTiles]) for (const spec of group) {
    const bytes = spec.pixelWidth * spec.pixelHeight * 4;
    if (requestedBytes + bytes > budgetBytes) continue;
    requestedBytes += bytes;
    Object.freeze(spec.rectTwips); const frozen = Object.freeze(spec);
    specs.push(frozen); if (group === visibleTiles) visibleSpecs.push(frozen);
  }
  return Object.freeze({ specs: Object.freeze(specs), visibleSpecs: Object.freeze(visibleSpecs), visibleBytes, budgetBytes, requestedBytes });
}

/** One numeric geometry plan only: no state, model, bitmap, cache membership or
 * display lease survives here. Every paint must still check the live cache. */
export class OfficeTilePlanCache {
  private last?: { key: string; plan: OfficeTilePlan };
  get(visible: Readonly<Rect>, size: { readonly width: number; readonly height: number }, zoom: number, dpr: number): OfficeTilePlan {
    const values = [visible.x, visible.y, visible.width, visible.height, size.width, size.height, zoom, dpr];
    // Invalid native geometry must use the real calculation/validation path,
    // rather than letting JSON's non-finite-to-null conversion alias a key.
    const key = values.every(Number.isFinite) ? JSON.stringify(values) : undefined;
    if (key !== undefined && this.last?.key === key) return this.last.plan;
    const plan = planOfficeTiles(visible, size, zoom, dpr);
    this.last = key === undefined ? undefined : { key, plan };
    return plan;
  }
  clear() { this.last = undefined; }
}
