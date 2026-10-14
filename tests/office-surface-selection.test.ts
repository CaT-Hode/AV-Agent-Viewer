import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfficeSurfaceSelectionBridge, officeSelectionLease, officeSelectionSnapshotMatches, type OfficeSelectionToolState, type OfficeSelectionToolsEvent } from '../apps/desktop/src/renderer/lib/office-surface-selection';
import type { ReadingSnapshot } from '../packages/contracts/src/index';
import type { OfficeSurfaceSelectionProjection } from '../packages/contracts/src/office-surface';
const projection = (text = '原文', epoch = 3): OfficeSurfaceSelectionProjection => ({ viewId: 'view', documentId: 'document', sessionId: 'session', engineEpoch: 'engine', engineRevision: 5, selectionEpoch: epoch, layoutRevision: 7, actor: 'human', selection: { kind: 'text', text }, rects: [{ x: 100, y: 200, width: 160, height: 20 }], viewportCss: { x: 80, y: 80, width: 800, height: 600 }, visibleTwips: { x: 0, y: 0, width: 12000, height: 9000 }, partIndex: 0 });
const tools = (p: OfficeSurfaceSelectionProjection): OfficeSelectionToolState => ({ actions: [{ id: 'copy', label: '复制', input: false }], snapshot: { document: { id: p.documentId }, context: { viewId: p.viewId, documentId: p.documentId, quality: 'confirmed', selection: p.selection, nativeOffice: { sessionId: p.sessionId, engineEpoch: p.engineEpoch, engineRevision: p.engineRevision, selectionEpoch: p.selectionEpoch } } } as ReadingSnapshot });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const settled = () => new Promise(done => setTimeout(done, 0));

test('only the latest human engine selection can display a returned snapshot', async () => {
  const first = deferred<OfficeSelectionToolState>(), second = deferred<OfficeSelectionToolState>(), published: OfficeSelectionToolsEvent[] = []; let requests = 0;
  const bridge = new OfficeSurfaceSelectionBridge('view', { request: () => ++requests === 1 ? first.promise : second.promise, publish: event => published.push(event) });
  const a = projection('first', 3), b = projection('second', 4); bridge.update(a); bridge.update(b);
  first.resolve(tools(a)); await settled(); assert.equal(published.some(event => event.visible), false);
  second.resolve(tools(b)); await settled(); assert.equal(published.at(-1)?.state?.snapshot.context.selection.text, 'second');
  assert.equal(published.at(-1)?.visible, true); bridge.dispose();
});
test('scroll geometry reuses the engine snapshot and dismissal persists until the target changes', async () => {
  const p = projection(), published: OfficeSelectionToolsEvent[] = []; let requests = 0;
  const bridge = new OfficeSurfaceSelectionBridge('view', { request: async () => { requests++; return tools(p); }, publish: event => published.push(event) });
  bridge.update(p); await settled(); const scrolled = { ...p, layoutRevision: 8, rects: [{ ...p.rects[0], y: 90 }] }; bridge.update(scrolled);
  assert.equal(requests, 1); assert.equal(published.at(-1)?.rect?.y, 90); assert.equal(officeSelectionLease(p), officeSelectionLease(scrolled));
  bridge.dismiss(officeSelectionLease(p)); bridge.update({ ...scrolled, rects: [{ ...p.rects[0], y: 100 }] }); assert.equal(published.at(-1)?.visible, false); assert.equal(requests, 1);
  bridge.update({ ...p, selectionEpoch: 4 }); await settled(); assert.equal(requests, 2); assert.equal(published.at(-1)?.visible, false, 'an old snapshot selection epoch cannot re-open the new target'); bridge.dispose();
});
test('engine lease mismatch, agent selection and offscreen selection never yield actionable overlays', async () => {
  const p = projection(), published: OfficeSelectionToolsEvent[] = []; let requests = 0;
  assert.equal(officeSelectionSnapshotMatches(p, tools({ ...p, engineEpoch: 'other' }).snapshot), false);
  assert.equal(officeSelectionSnapshotMatches(p, tools({ ...p, engineRevision: 6 }).snapshot), false);
  const bridge = new OfficeSurfaceSelectionBridge('view', { request: async () => { requests++; return tools(p); }, publish: event => published.push(event) });
  bridge.update({ ...p, actor: 'agent' }); bridge.update({ ...p, rects: [] }); await settled(); assert.equal(requests, 0); assert.equal(published.some(event => event.visible), false); bridge.dispose();
});
