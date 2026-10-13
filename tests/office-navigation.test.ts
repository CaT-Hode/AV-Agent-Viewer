import test from 'node:test';
import assert from 'node:assert/strict';
import { officeNodeVisible, parseOfficeNavigationRequest, scrollOfficeCell } from '../apps/desktop/src/renderer/lib/office-navigation';
import { slidePreviewMetrics } from '../apps/desktop/src/renderer/lib/slide-preview';
const base = { requestId: 'request', viewId: 'view', documentId: 'document', expectedRevision: 3, actor: 'agent' };
test('Office navigation accepts only actual three target kinds with bounded cell addresses', () => {
  assert.deepEqual(parseOfficeNavigationRequest({ ...base, target: { kind: 'cell', sheetId: 'sheet', address: 'ax1000' } })?.target, { kind: 'cell', sheetId: 'sheet', address: 'AX1000' });
  assert.deepEqual(parseOfficeNavigationRequest({ ...base, target: { kind: 'paragraph', blockId: 'p1' } })?.target, { kind: 'paragraph', blockId: 'p1' });
  assert.deepEqual(parseOfficeNavigationRequest({ ...base, target: { kind: 'html-heading', blockId: 'html/0/1' } })?.target, { kind: 'html-heading', blockId: 'html/0/1' });
  assert.deepEqual(parseOfficeNavigationRequest({ ...base, target: { kind: 'slide', slideId: 'slide1' } })?.target, { kind: 'slide', slideId: 'slide1' });
  for (const address of ['A0','A01','AY1','B1001','A1:B2','A1" onclick="x']) assert.equal(parseOfficeNavigationRequest({ ...base, target: { kind: 'cell', sheetId: 'sheet', address } }), undefined);
});
test('Office navigation rejects incomplete, human, revision-stale-shaped and ambiguous identities', () => {
  for (const partial of [{ actor: 'human' }, { expectedRevision: -1 }, { expectedRevision: 1.1 }, { requestId: '' }, { viewId: 'view\nother' }, { target: { kind: 'page', pageIndex: 0 } }]) assert.equal(parseOfficeNavigationRequest({ ...base, target: { kind: 'slide', slideId: 'slide1' }, ...partial }), undefined);
});
test('slide thumbnails project real 16:9 EMU dimensions instead of treating them as CSS pixels', () => {
  const metrics = slidePreviewMetrics(12192000, 6858000);
  assert.equal(metrics.logicalWidth, 1280); assert.equal(metrics.logicalHeight, 720); assert.equal(metrics.width, 116); assert.equal(metrics.scale, 114 / 1280);
  assert.equal(metrics.height, 66.125);
  assert.equal(32 * 4 / 3 * metrics.scale, 3.8);
  const legacy = slidePreviewMetrics(960, 540); assert.equal(legacy.logicalWidth, 960); assert.equal(legacy.logicalHeight, 540);
  const portrait = slidePreviewMetrics(6858000, 12192000); assert.ok(portrait.height > portrait.width);
});

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, right: left + width, bottom: top + height, width, height });
/** Minimal geometry fixture, using actual CSS edges as a browser would report. */
function frozenGrid(zoom = 1, freezeRows = 3, freezeColumns = 2, fixedX = false, fixedY = false) {
  const root = { parentElement: null, getBoundingClientRect: () => box(0, 0, 1200, 900), style: {} };
  const headerBottom = 100 + 30 * zoom, headerRight = 100 + 42 * zoom;
  const rowHeights = [24, 36, 30], columnWidths = [80, 120];
  const frozenBottom = headerBottom + rowHeights.slice(0, freezeRows).reduce((a, b) => a + b, 0) * zoom;
  const frozenRight = headerRight + columnWidths.slice(0, freezeColumns).reduce((a, b) => a + b, 0) * zoom;
  const head = { getBoundingClientRect: () => box(100, 100, 42 * zoom, 30 * zoom), style: {} };
  const rowHead = { getBoundingClientRect: () => box(100, headerBottom, 42 * zoom, 24 * zoom), style: {} };
  const pinned = [
    ...rowHeights.slice(0, freezeRows).map((height, i) => ({ style: { top: '30px' }, getBoundingClientRect: () => box(100, headerBottom + rowHeights.slice(0, i).reduce((a, b) => a + b, 0) * zoom, 42 * zoom, height * zoom) })),
    ...columnWidths.slice(0, freezeColumns).map((width, i) => ({ style: { left: '42px' }, getBoundingClientRect: () => box(headerRight + columnWidths.slice(0, i).reduce((a, b) => a + b, 0) * zoom, 100, width * zoom, 30 * zoom) })),
  ];
  let geometryReads = 0;
  const scroller = { parentElement: root, style: {}, scrollTop: 600, scrollLeft: 450, offsetWidth: 800, offsetHeight: 500, clientLeft: 0, clientTop: 0, clientWidth: 786, clientHeight: 486,
    getBoundingClientRect: () => box(100, 100, 800, 500),
    querySelector: (selector: string) => selector === 'thead th' ? head : selector === 'tbody th' ? rowHead : undefined,
    querySelectorAll: () => { geometryReads++; return pinned; },
  };
  const table = { parentElement: scroller, getBoundingClientRect: () => box(100, 100, 800, 500), style: {} };
  const initial = { left: fixedX ? headerRight : headerRight + 10 * zoom, top: fixedY ? headerBottom + 24 * zoom : headerBottom + 10 * zoom };
  const node = { parentElement: table, style: { position: fixedX || fixedY ? 'sticky' : 'relative', left: fixedX ? '42px' : 'auto', top: fixedY ? '54px' : 'auto' },
    getBoundingClientRect: () => box(initial.left - (fixedX ? 0 : scroller.scrollLeft - 450), initial.top - (fixedY ? 0 : scroller.scrollTop - 600), 70 * zoom, 24 * zoom),
    closest: (selector: string) => selector === '.office-grid-scroll' ? scroller : selector === 'td[data-address]' ? node : undefined,
  };
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 1200, innerHeight: 900 } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: (target: typeof node) => ({ overflowX: target === scroller as unknown ? 'auto' : 'visible', overflowY: target === scroller as unknown ? 'auto' : 'visible', ...target.style }) });
  return { root: root as unknown as HTMLElement, node: node as unknown as HTMLElement, scroller, initial, frozenBottom, frozenRight, headerBottom, headerRight, reads: () => geometryReads,
    restore() { if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window'); if (oldStyle) Object.defineProperty(globalThis, 'getComputedStyle', oldStyle); else Reflect.deleteProperty(globalThis, 'getComputedStyle'); },
  };
}

test('return navigation from far scroll reveals C4 beyond three frozen rows and two frozen columns', () => {
  const grid = frozenGrid();
  try {
    assert.equal(officeNodeVisible(grid.node, grid.root), false, 'a cell covered by pinned headers is not visible evidence');
    scrollOfficeCell(grid.node);
    assert.equal(grid.scroller.scrollTop, 600 + grid.initial.top - grid.frozenBottom);
    assert.equal(grid.scroller.scrollLeft, 450 + grid.initial.left - grid.frozenRight);
    assert.equal(grid.node.getBoundingClientRect().top, grid.frozenBottom);
    assert.equal(grid.node.getBoundingClientRect().left, grid.frozenRight);
    assert.equal(officeNodeVisible(grid.node, grid.root), true);
  } finally { grid.restore(); }
});

test('frozen-grid navigation uses measured zoomed variable row heights and column widths', () => {
  const grid = frozenGrid(1.5);
  try {
    assert.equal(officeNodeVisible(grid.node, grid.root), false);
    scrollOfficeCell(grid.node);
    assert.equal(grid.node.getBoundingClientRect().top, 280);
    assert.equal(grid.node.getBoundingClientRect().left, 463);
    assert.equal(officeNodeVisible(grid.node, grid.root), true);
    const clips = new Map<HTMLElement, { left: number; top: number; right: number; bottom: number }>();
    const before = grid.reads(); officeNodeVisible(grid.node, grid.root, clips); officeNodeVisible(grid.node, grid.root, clips);
    assert.equal(grid.reads() - before, 1, 'pinned geometry is read once per report rather than once per visible cell');
  } finally { grid.restore(); }
});

test('pinned target axes stay put while a non-pinned axis can reveal its cell', () => {
  for (const [fixedX, fixedY] of [[true, true], [true, false], [false, true]]) {
    const grid = frozenGrid(1, 3, 2, fixedX, fixedY);
    try {
      assert.equal(officeNodeVisible(grid.node, grid.root), fixedX && fixedY, 'either pinned strip can fully hide a non-pinned target axis');
      scrollOfficeCell(grid.node);
      assert.equal(grid.scroller.scrollLeft === 450, fixedX);
      assert.equal(grid.scroller.scrollTop === 600, fixedY);
      assert.equal(officeNodeVisible(grid.node, grid.root), true, 'the frozen cell itself remains visible within its pinned region');
    } finally { grid.restore(); }
  }
});

test('a viewport fully consumed by frozen columns cannot falsely confirm a non-frozen cell', () => {
  const grid = frozenGrid(4);
  try {
    assert.equal(officeNodeVisible(grid.node, grid.root), false);
    scrollOfficeCell(grid.node);
    assert.equal(officeNodeVisible(grid.node, grid.root), false);
    assert.equal(grid.scroller.scrollLeft, 450, 'an empty scrollable viewport cannot be repaired by a fabricated scroll');
  } finally { grid.restore(); }
});

test('unfrozen navigation still excludes real headers and scrollbar space', () => {
  const grid = frozenGrid(1, 0, 0);
  try {
    assert.equal(officeNodeVisible(grid.node, grid.root), true);
    scrollOfficeCell(grid.node);
    assert.equal(grid.scroller.scrollTop, 600); assert.equal(grid.scroller.scrollLeft, 450);
    const current = grid.node.getBoundingClientRect.bind(grid.node);
    grid.node.getBoundingClientRect = () => box(870, 580, 70, 24) as DOMRect;
    assert.equal(officeNodeVisible(grid.node, grid.root), true, 'partially visible cells remain real viewport content');
    scrollOfficeCell(grid.node);
    assert.equal(grid.scroller.scrollLeft, 504); assert.equal(grid.scroller.scrollTop, 618);
    grid.node.getBoundingClientRect = current;
  } finally { grid.restore(); }
});
