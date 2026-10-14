import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfficePendingScroll } from '../apps/desktop/src/renderer/lib/office-pending-scroll';
import { OfficeTileCache } from '../apps/desktop/src/renderer/lib/office-tile-cache';
import { officeCurrentPage, officeDocumentPoint, officeSurfaceClipRects, officeTileBatches, officeVisibleTiles, officeVisibleTwips, officeViewportRect } from '../apps/desktop/src/renderer/lib/office-surface-geometry';
import type { OfficeSurfaceState } from '../packages/contracts/src/office-surface';

test('Office document/viewport coordinates round trip across zoom, horizontal scroll and centered paper', () => {
  for (const zoom of [.25, .75, 1, 1.5, 2, 4]) for (const offsetX of [0, 137.5]) {
    const geometry = { zoom, offsetX, offsetY: 3, scrollX: 212.25, scrollY: 701.75, viewport: { x: 83, y: 109, width: 1256, height: 672 } };
    const document = { x: 3600.75, y: 12400.25, width: 400, height: 350 }, css = officeViewportRect(document, geometry), resolved = officeDocumentPoint(css.x, css.y, geometry);
    assert.ok(Math.abs(resolved.x - document.x) < 1e-8); assert.ok(Math.abs(resolved.y - document.y) < 1e-8);
    const visible = officeVisibleTwips(geometry, { width: 12474, height: 85894 });
    assert.ok(visible.x >= 0 && visible.y >= 0 && visible.x + visible.width <= 12474 + 1e-8 && visible.y + visible.height <= 85894 + 1e-8);
  }
});
test('Office DPR increases pixels while document tile bounds and page intersection stay identical', () => {
  const visible = { x: 1500, y: 20000, width: 8000, height: 7500 }, size = { width: 12474, height: 85894 };
  const one = officeVisibleTiles(visible, size, 1.5, 1), two = officeVisibleTiles(visible, size, 1.5, 2);
  assert.deepEqual(one.map(tile => tile.rectTwips), two.map(tile => tile.rectTwips));
  one.forEach((tile, index) => { assert.ok(two[index].pixelWidth >= tile.pixelWidth * 2 - 1 && two[index].pixelWidth <= tile.pixelWidth * 2); assert.ok(two[index].pixelHeight >= tile.pixelHeight * 2 - 1 && two[index].pixelHeight <= tile.pixelHeight * 2, 'clipped edge tiles only differ by ceil quantization'); });
  assert.ok(one.length < 100, 'a long document only requests visible tiles plus one ring');
  assert.equal(officeCurrentPage([{ x: 0, y: 0, width: 100, height: 150 }, { x: 0, y: 180, width: 100, height: 150 }], { x: 0, y: 130, width: 100, height: 100 }), 1);
});
test('actual paper clipping removes engine workspace margins while preserving complete empty sheet and slide extents', () => {
  const writer = { format: 'docx', partIndex: 0, parts: [], sizeTwips: { width: 12474, height: 85894 }, pages: [{ x: 284, y: 284, width: 11906, height: 16838 }, { x: 284, y: 17406, width: 11906, height: 16838 }] } as unknown as OfficeSurfaceState;
  assert.deepEqual(officeSurfaceClipRects(writer), writer.pages);
  assert.equal(officeSurfaceClipRects(writer).some(rect => rect.x === 0 || rect.y === 0), false, '284twip engine margins are transparent workspace, independent of pixel color');
  for (const format of ['xlsx', 'pptx'] as const) { const state = { ...writer, format, partIndex: 1, parts: [{ index: 1, name: 'part', sizeTwips: { width: 26000, height: 200000 } }] }; assert.deepEqual(officeSurfaceClipRects(state), [{ x: 0, y: 0, width: 26000, height: 200000 }], 'blank cells and outlying content inside the actual part remain editable'); }
});
test('high DPR paint batches preserve every tile while staying inside physical byte and IPC count limits', () => {
  const tiles = officeVisibleTiles({ x: 0, y: 0, width: 15000, height: 12000 }, { width: 15000, height: 12000 }, 1, 8), batches = officeTileBatches(tiles);
  assert.deepEqual(batches.flat().map(tile => tile.key), tiles.map(tile => tile.key));
  assert.ok(batches.length > 1); for (const batch of batches) { assert.ok(batch.length <= 12); assert.ok(batch.reduce((bytes, tile) => bytes + tile.pixelWidth * tile.pixelHeight * 4, 0) <= 64 * 1024 * 1024); }
});
test('local Office invalidation rejects an old inflight paint without dropping unrelated tiles', () => {
  const released: string[] = [], cache = new OfficeTileCache<string>(1024, value => released.push(value));
  const affected = cache.begin('a', { x: 0, y: 0, width: 100, height: 100 }, 0), untouched = cache.begin('b', { x: 100, y: 0, width: 100, height: 100 }, 0);
  cache.put('old-b', 'previous unrelated', 100, { x: 200, y: 0, width: 100, height: 100 }, 0);
  cache.invalidate(0, { x: 30, y: 30, width: 5, height: 5 });
  assert.equal(cache.admit(affected, 'stale pixels', 100), false);
  assert.equal(cache.admit(untouched, 'fresh unrelated', 100), true);
  assert.equal(cache.has('a'), false); assert.equal(cache.get('b'), 'fresh unrelated'); assert.equal(cache.get('old-b'), 'previous unrelated');
  assert.deepEqual(released, ['stale pixels']);
  assert.equal(cache.admit(untouched, 'duplicate response', 100), false, 'a ticket is consumed exactly once');
  cache.clear(); assert.equal(new Set(released).size, released.length);
});
test('Office tile cache evicts oldest unpinned resources, never exceeds budget and closes replacements once', () => {
  const released: string[] = [], cache = new OfficeTileCache<string>(300, value => released.push(value)), rect = { x: 0, y: 0, width: 1, height: 1 };
  cache.put('a', 'a', 100, rect, 0); cache.put('b', 'b', 100, rect, 0); cache.put('c', 'c', 100, rect, 0); cache.get('a'); cache.pin(new Set(['b']));
  cache.put('d', 'd', 100, rect, 0); assert.equal(cache.has('c'), false); assert.equal(cache.has('b'), true); assert.equal(cache.byteLength, 300);
  cache.put('a', 'new a', 100, rect, 0); assert.equal(released.filter(value => value === 'a').length, 1);
  const ticket = cache.begin('late', rect, 0); cache.clear(); assert.equal(cache.admit(ticket, 'late', 100), false);
  assert.equal(cache.put('too big', 'oversized', 301, rect, 0), false); assert.equal(cache.byteLength, 0);
  assert.equal(new Set(released).size, released.length);
});
test('a real sheet reveal waits for expanded DOM extent rather than losing its target to an old-stage clamp',()=>{
  const source={viewId:'view',sessionId:'session',engineEpoch:'engine'},scroll=new OfficePendingScroll();
  assert.equal(scroll.queue(source,{...source,partIndex:0,layoutRevision:5,x:1800,y:1200}),true);
  assert.equal(scroll.take(source,0,{x:965,y:1221}),undefined);assert.equal(scroll.pending,true);
  assert.deepEqual(scroll.take(source,0,{x:1900,y:1400}),{...source,partIndex:0,layoutRevision:5,x:1800,y:1200});assert.equal(scroll.pending,false);
});
test('a replaced view or engine cannot inherit a pending reveal, and the newest owned target wins',()=>{
  const source={viewId:'view',sessionId:'session',engineEpoch:'engine'},scroll=new OfficePendingScroll();
  scroll.queue(source,{...source,partIndex:0,layoutRevision:5,x:1800,y:1200});scroll.queue(source,{...source,partIndex:0,layoutRevision:6,x:30,y:40});
  assert.equal(scroll.queue(source,{...source,sessionId:'old session',partIndex:0,layoutRevision:7,x:10,y:20}),false);
  assert.equal(scroll.queue(source,{...source,partIndex:0,layoutRevision:4,x:10,y:20}),false);
  assert.equal(scroll.take(source,1,{x:100,y:100}),undefined);assert.equal(scroll.take(source,0,{x:100,y:100})?.x,30);
  scroll.queue(source,{...source,partIndex:0,layoutRevision:7,x:1800,y:1200});assert.equal(scroll.take({...source,engineEpoch:'replacement'},0,{x:1900,y:1400}),undefined);assert.equal(scroll.pending,false);
  scroll.queue(source,{...source,partIndex:0,layoutRevision:8,x:50,y:50});scroll.clear();assert.equal(scroll.take(source,0,{x:100,y:100}),undefined);
});
