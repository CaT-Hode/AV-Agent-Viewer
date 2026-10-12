import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharePolledValue } from '../apps/desktop/src/renderer/lib/polled-state';
import type { WorkspaceState } from '../packages/contracts/src/index';

function fixture(): WorkspaceState {
  return {
    protocolVersion: '1.0', activeViewId: 'v1', eventsSeq: 8,
    documents: [{ id: 'd1', title: 'sample.docx', path: 'D:/sample.docx', format: 'docx', revision: 2, diskRevision: 1, dirty: true, warnings: ['limited'], capabilities: { engine: 'local', protocolVersion: '1.0', readText: true, readSelection: true, readViewport: true, saveFormats: ['docx'], editKinds: ['word.setBlock'], limitations: ['basic'] }, model: { format: 'docx', blocks: [{ id: 'p1', text: 'source', runs: [{ text: 'source', bold: true }] }], sheets: [{ id: 's1', name: 'Data', rows: [[{ address: 'A1', value: '3', formula: 'SUM(1,2)' }]] }] } }],
    views: [{ id: 'v1', documentId: 'd1', windowId: 'main', mode: 'read', pinned: false, zoom: 1, context: { viewId: 'v1', documentId: 'd1', contentRevision: 2, viewRevision: 4, capturedAt: '2026-10-12T01:00:00Z', quality: 'confirmed', actor: 'human', locator: { kind: 'paragraph', blockId: 'p1', from: 0, to: 3, quote: 'sou' }, visibleText: 'source', selection: { kind: 'text', text: 'sou', locator: { kind: 'text-range', blockId: 'p1', from: 0, to: 3 }, rect: { x: 10, y: 20, width: 30, height: 15 }, pageRects: [{ pageIndex: 0, x: .1, y: .2, width: .3, height: .1 }] }, viewport: { width: 800, height: 600, scrollX: 0, scrollY: 120, deviceScaleFactor: 1.5, navigationId: 'n1', layoutRevision: 2 } } }],
    tasks: [{ id: 't1', snapshotId: 'snap', prompt: 'read', text: 'partial', status: 'running' }],
  };
}

test('unchanged poll responses retain the complete workspace and model references', () => {
  const previous = fixture(), incoming = structuredClone(previous);
  assert.notEqual(previous, incoming);
  assert.equal(sharePolledValue(previous, incoming), previous);
  assert.deepEqual(incoming, fixture(), 'comparison does not mutate the received payload');
});

test('all workspace fields remain observable without relying on eventsSeq or document revision', () => {
  const changes: [string, (state: WorkspaceState) => void][] = [
    ['protocol', state => { state.protocolVersion = '2.0'; }],
    ['activation', state => { state.activeViewId = 'v2'; }],
    ['event', state => { state.eventsSeq++; }],
    ['document identity', state => { state.documents[0].id = 'd2'; }],
    ['title', state => { state.documents[0].title = 'renamed.docx'; }],
    ['path', state => { state.documents[0].path = 'D:/copy.docx'; }],
    ['format', state => { state.documents[0].format = 'pptx'; }],
    ['revision', state => { state.documents[0].revision++; }],
    ['disk revision', state => { state.documents[0].diskRevision++; }],
    ['dirty', state => { state.documents[0].dirty = false; }],
    ['warnings', state => { state.documents[0].warnings.push('updated'); }],
    ['capabilities', state => { state.documents[0].capabilities.readSelection = false; }],
    ['model text', state => { state.documents[0].model.blocks![0].text = 'new'; }],
    ['run formatting', state => { state.documents[0].model.blocks![0].runs![0].bold = false; }],
    ['cached formula value', state => { state.documents[0].model.sheets![0].rows[0][0].value = '4'; }],
    ['formula', state => { state.documents[0].model.sheets![0].rows[0][0].formula = 'SUM(1,3)'; }],
    ['view identity', state => { state.views[0].id = 'v2'; }],
    ['view document', state => { state.views[0].documentId = 'd2'; }],
    ['window', state => { state.views[0].windowId = 'other'; }],
    ['mode', state => { state.views[0].mode = 'split'; }],
    ['pin', state => { state.views[0].pinned = true; }],
    ['zoom', state => { state.views[0].zoom = 1.5; }],
    ['capture freshness', state => { state.views[0].context!.capturedAt = '2026-10-12T01:00:01Z'; }],
    ['view revision', state => { state.views[0].context!.viewRevision++; }],
    ['context revision', state => { state.views[0].context!.contentRevision++; }],
    ['context actor', state => { state.views[0].context!.actor = 'agent'; }],
    ['context quality', state => { state.views[0].context!.quality = 'not-ready'; }],
    ['locator', state => { state.views[0].context!.locator.from = 1; }],
    ['visible text', state => { state.views[0].context!.visibleText = 'new visible text'; }],
    ['selected text', state => { state.views[0].context!.selection.text = 'sour'; }],
    ['selection range', state => { state.views[0].context!.selection.locator!.to = 4; }],
    ['selection rectangle', state => { state.views[0].context!.selection.rect!.x++; }],
    ['PDF page rectangles', state => { state.views[0].context!.selection.pageRects![0].pageIndex = 1; }],
    ['scroll position', state => { state.views[0].context!.viewport!.scrollY++; }],
    ['navigation', state => { state.views[0].context!.viewport!.navigationId = 'n2'; }],
    ['layout version', state => { const viewport = state.views[0].context!.viewport!; viewport.layoutRevision = (viewport.layoutRevision ?? 0) + 1; }],
    ['device scale', state => { state.views[0].context!.viewport!.deviceScaleFactor = 2; }],
    ['task output', state => { state.tasks[0].text += ' streamed'; }],
    ['task status', state => { state.tasks[0].status = 'completed'; }],
    ['task error', state => { state.tasks[0].error = 'connection failed'; }],
    ['addition', state => { state.tasks.push({ ...state.tasks[0], id: 't2' }); }],
    ['removal', state => { state.documents = []; }],
  ];
  for (const [name, change] of changes) {
    const previous = fixture(), incoming = structuredClone(previous); change(incoming);
    const shared = sharePolledValue(previous, incoming);
    assert.notEqual(shared, previous, name);
    assert.deepEqual(shared, incoming, name + ' must not be omitted');
  }
});

test('real context updates preserve unchanged document models, selections and task arrays', () => {
  const previous = fixture(), incoming = structuredClone(previous);
  incoming.views[0].context!.capturedAt = 'later'; incoming.views[0].context!.viewRevision++;
  const shared = sharePolledValue(previous, incoming);
  assert.notEqual(shared, previous); assert.notEqual(shared.views, previous.views);
  assert.equal(shared.documents, previous.documents); assert.equal(shared.documents[0].model, previous.documents[0].model);
  assert.equal(shared.tasks, previous.tasks);
  assert.equal(shared.views[0].context!.selection, previous.views[0].context!.selection);
  assert.equal(shared.views[0].context!.viewport, previous.views[0].context!.viewport);
});

test('future keys, undefined key removal and array order are compared explicitly', () => {
  const previous = { optional: undefined, nested: { custom: ['a', 'b'] } };
  assert.equal(sharePolledValue(previous, { nested: { custom: ['a', 'b'] }, optional: undefined }), previous);
  assert.notEqual(sharePolledValue(previous, { nested: { custom: ['a', 'b'] } }), previous);
  const future = { ...previous, future: { enabled: true } }, added = sharePolledValue(previous, future);
  assert.deepEqual(added, { ...previous, future: { enabled: true } });
  assert.notEqual(added, previous);
  assert.deepEqual(sharePolledValue(previous, { ...previous, nested: { custom: ['b', 'a'] } }).nested.custom, ['b', 'a']);
  const oldDate = new Date(0), newDate = new Date(1);
  assert.equal(sharePolledValue(oldDate, newDate), newDate);
});

test('unchanged translation results retain arrays while nested job progress and artifact changes propagate', () => {
  const previous = { jobs: [{ id: 'j1', completed: 2, units: [{ source: 'first', result: '一' }] }], artifacts: [{ id: 'a1', path: 'D:/translation.docx', sourceRevision: 3 }] };
  assert.equal(sharePolledValue(previous, structuredClone(previous)), previous);
  const incoming = structuredClone(previous); incoming.jobs[0].units[0].result = '第一';
  const shared = sharePolledValue(previous, incoming);
  assert.equal(shared.artifacts, previous.artifacts); assert.notEqual(shared.jobs, previous.jobs);
  assert.equal(shared.jobs[0].units[0].result, '第一');
  const moved = structuredClone(previous); moved.artifacts[0].path = 'D:/new.docx';
  assert.equal(sharePolledValue(previous, moved).artifacts[0].path, 'D:/new.docx');
});
