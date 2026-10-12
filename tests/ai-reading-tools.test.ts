import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadingSnapshot } from '../packages/contracts/src/index';
import { AI_READING_TOOLS, buildAIReadingPrompt, getAIReadingScopeState, getAIReadingTool, scopedReadingSnapshot } from '../packages/ai-reading-tools/src/index';

function fixture(): ReadingSnapshot {
  return {
    id: 'snapshot-1', schemaVersion: '1.0', createdAt: '2026-10-12T12:00:00Z',
    context: {
      viewId: 'v1', documentId: 'd1', contentRevision: 4, viewRevision: 8,
      capturedAt: '2026-10-12T11:59:59Z', quality: 'confirmed', actor: 'human',
      locator: { kind: 'page', pageIndex: 3, quote: 'OUTSIDE_LOCATOR_QUOTE' },
      visibleText: 'VISIBLE_SOURCE_ONLY',
      selection: { kind: 'text', text: 'SELECTED_SOURCE_ONLY', locator: { kind: 'text-range', blockId: 'p2', from: 4, to: 24, quote: 'OUTSIDE_SELECTION_QUOTE' }, rect: { x: 30, y: 40, width: 90, height: 20 } },
      viewport: { width: 1000, height: 700, scrollX: 0, scrollY: 400, deviceScaleFactor: 1.5, layoutRevision: 2 },
    },
    document: {
      id: 'd1', title: 'source.docx', path: 'D:/PRIVATE_PATH/source.docx', format: 'docx', revision: 4, diskRevision: 3, dirty: true,
      warnings: ['OUTSIDE_WARNING'], capabilities: { engine: 'ooxml', protocolVersion: '1.0', readText: true, readSelection: true, readViewport: true, editKinds: ['word.setBlock'], saveFormats: ['docx'], limitations: ['OUTSIDE_LIMITATION'] },
      model: { format: 'docx', text: 'OUTSIDE_FULL_TEXT', blocks: [{ id: 'p1', text: 'OUTSIDE_BLOCK_TEXT' }], slides: [{ id: 's1', blocks: [{ id: 'shape1', text: 'OUTSIDE_SLIDE_TEXT' }], notes: 'OUTSIDE_NOTES' }], sheets: [{ id: 'sheet1', name: 'Private', rows: [[{ address: 'A1', value: 'OUTSIDE_CELL_TEXT', formula: 'OUTSIDE_FORMULA' }]] }] },
    },
  };
}

test('the shared catalog has unique stable IDs, labels and source-bounded prompts', () => {
  assert.equal(AI_READING_TOOLS.length, 11);
  assert.equal(new Set(AI_READING_TOOLS.map(tool => tool.id)).size, AI_READING_TOOLS.length);
  for (const tool of AI_READING_TOOLS) {
    assert.equal(getAIReadingTool(tool.id), tool);
    assert.ok(tool.label && tool.description && tool.prompt);
    assert.ok(buildAIReadingPrompt(tool.id, 'selection').includes('冻结的选中内容'));
    assert.ok(buildAIReadingPrompt(tool.id, 'visible').includes('冻结的当前可见内容'));
  }
  assert.throws(() => buildAIReadingPrompt('unknown', 'visible'), /未知/);
  assert.equal(buildAIReadingPrompt({ ...AI_READING_TOOLS[0], prompt: 'UNTRUSTED_OVERRIDE' }, 'selection'), buildAIReadingPrompt('summary', 'selection'));
});

test('selection source excludes visible text, every full model section and textual metadata', () => {
  const scoped = scopedReadingSnapshot(fixture(), 'selection'), wire = JSON.stringify(scoped);
  assert.equal(scoped.sourceText, 'SELECTED_SOURCE_ONLY');
  assert.equal(scoped.context.selection.text, scoped.sourceText);
  assert.equal(scoped.context.visibleText, '');
  assert.deepEqual(scoped.document.model, { format: 'docx', text: scoped.sourceText });
  assert.equal(scoped.context.locator.blockId, 'p2');
  assert.equal(scoped.document.id, 'd1'); assert.equal(scoped.context.contentRevision, 4);
  assert.equal(scoped.document.dirty, true); assert.equal(scoped.context.viewRevision, 8);
  assert.ok(!wire.includes('OUTSIDE_')); assert.ok(!wire.includes('VISIBLE_SOURCE_ONLY')); assert.ok(!wire.includes('PRIVATE_PATH'));
});

test('visible source cannot accidentally prefer a selected passage at the provider', () => {
  const scoped = scopedReadingSnapshot(fixture(), 'visible'), wire = JSON.stringify(scoped);
  assert.equal(scoped.sourceText, 'VISIBLE_SOURCE_ONLY');
  assert.equal(scoped.context.visibleText, scoped.sourceText);
  assert.deepEqual(scoped.context.selection, { kind: 'none', text: '' });
  assert.equal(scoped.context.locator.pageIndex, 3);
  assert.ok(!wire.includes('SELECTED_SOURCE_ONLY')); assert.ok(!wire.includes('OUTSIDE_'));
});

test('new unrecognized source fields are omitted instead of leaking via object spreads', () => {
  const snapshot = fixture();
  Object.assign(snapshot.document, { futureBody: 'OUTSIDE_FUTURE_DOCUMENT' });
  Object.assign(snapshot.context, { futureText: 'OUTSIDE_FUTURE_CONTEXT' });
  Object.assign(snapshot.context.locator, { futureQuote: 'OUTSIDE_FUTURE_LOCATOR' });
  Object.assign(snapshot.context.viewport!, { futureText: 'OUTSIDE_FUTURE_VIEWPORT' });
  Object.assign(snapshot.context.selection.locator!, { futureQuote: 'OUTSIDE_FUTURE_SELECTION_LOCATOR' });
  Object.assign(snapshot.context.selection.rect!, { futureText: 'OUTSIDE_FUTURE_RECT' });
  const wire = JSON.stringify(scopedReadingSnapshot(snapshot, 'visible'));
  assert.ok(!wire.includes('OUTSIDE_')); assert.ok(!wire.includes('futureBody')); assert.ok(!wire.includes('futureText'));
  assert.ok(!JSON.stringify(scopedReadingSnapshot(snapshot, 'selection')).includes('OUTSIDE_'));
});

test('scoping neither changes the frozen source nor shares mutable locator/viewport objects', () => {
  const snapshot = fixture(), before = structuredClone(snapshot), scoped = scopedReadingSnapshot(snapshot, 'selection');
  scoped.context.locator.blockId = 'changed'; scoped.context.viewport!.scrollY = 900;
  scoped.context.selection.rect!.x = 900;
  assert.deepEqual(snapshot, before);
});

test('empty selection never falls back to available visible content', () => {
  const snapshot = fixture(); snapshot.context.selection = { kind: 'none', text: 'stale selected text' };
  assert.equal(getAIReadingScopeState(undefined, snapshot, 'selection').available, false);
  assert.throws(() => scopedReadingSnapshot(snapshot, 'selection'), /请先选中/);
  snapshot.context.selection = { kind: 'text', text: ' \n ' };
  assert.throws(() => scopedReadingSnapshot(snapshot, 'selection'), /请先选中/);
  snapshot.context.visibleText = '';
  assert.throws(() => scopedReadingSnapshot(snapshot, 'visible'), /暂无可读文字/);
});

test('document scope remains opt-in in the UI and is unavailable to this source helper', () => {
  const snapshot = fixture();
  assert.equal(getAIReadingScopeState(undefined, snapshot, 'document').available, false);
  assert.throws(() => scopedReadingSnapshot(snapshot, 'document'), /单独确认完整读取/);
  assert.throws(() => scopedReadingSnapshot(snapshot, 'unknown' as 'visible'), /仅支持/);
});

test('not-ready and mismatched fixed sources are refused before any provider receives them', () => {
  const snapshot = fixture(); snapshot.context.quality = 'not-ready';
  assert.throws(() => scopedReadingSnapshot(snapshot, 'visible'), /正在同步/);
  snapshot.context.quality = 'confirmed'; snapshot.context.contentRevision++;
  assert.throws(() => scopedReadingSnapshot(snapshot, 'selection'), /版本不一致/);
  snapshot.context.contentRevision = 4; snapshot.context.documentId = 'another-document';
  assert.throws(() => scopedReadingSnapshot(snapshot, 'visible'), /版本不一致/);
});

test('a fixed source takes precedence over a newly selected live range', () => {
  const snapshot = fixture(), live = structuredClone(snapshot.context);
  live.selection.text = ''; live.visibleText = 'UNRELATED_LIVE_TEXT';
  assert.equal(getAIReadingScopeState(live, snapshot, 'selection').textLength, 'SELECTED_SOURCE_ONLY'.length);
  assert.equal(getAIReadingScopeState(live, undefined, 'selection').available, false);
});
