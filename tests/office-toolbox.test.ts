import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OfficeToolboxRail, officeToolboxRailIcons } from '../apps/desktop/src/renderer/components/OfficeToolboxRail';
import { createOfficeToolboxController, officeToolboxCategory, officeToolboxContribution, presentationToolboxSelection, type OfficeToolboxTarget } from '../apps/desktop/src/renderer/components/office/toolbox-contributions';
import { createRegistry } from '../packages/format-adapters/src/index';
import type { DocumentInfo, DocumentModel } from '../packages/contracts/src/index';

const deck = (): Pick<DocumentInfo, 'id' | 'format' | 'model'> => ({ id: 'document', format: 'pptx', model: { format: 'pptx', slides: [{ id: 'slide1', blocks: [{ id: 'shape1', text: '已存在对象' }] }, { id: 'slide2', blocks: [] }] } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('every toolbox edit contribution routes to an actual adapter capability; category restoration remains format-specific', () => {
  const registry = createRegistry();
  for (const format of ['docx', 'pptx', 'xlsx'] as const) {
    const contribution = officeToolboxContribution(format)!;
    assert.equal(contribution.categories.length, format === 'pptx' ? 9 : 7);
    for (const command of contribution.categories.flatMap(category => category.commands)) assert.ok(registry.resolve(format).capabilities(format).editKinds.includes(command), format + ': ' + command);
    assert.ok(contribution.categories.some(category => category.id === contribution.defaultCategory));
  }
  assert.equal(officeToolboxCategory('pptx'), 'slides'); assert.equal(officeToolboxCategory('docx', 'slides'), 'home');
  assert.equal(officeToolboxCategory('xlsx', 'data'), 'data'); assert.equal(officeToolboxContribution('pdf'), undefined);
});

test('task categories are complete, unique and remain bound to the current format', () => {
  const expected = {
    docx: ['home', 'insert', 'table', 'layout', 'references', 'review', 'view'],
    xlsx: ['home', 'insert', 'formulas', 'data', 'worksheet', 'view', 'print'],
    pptx: ['slides', 'home', 'insert', 'design', 'arrange', 'transitions', 'animation', 'presentation', 'notes'],
  };
  for (const format of ['docx', 'xlsx', 'pptx'] as const) {
    const categories = officeToolboxContribution(format)!.categories;
    assert.deepEqual(categories.map(item => item.id), expected[format]);
    assert.equal(new Set(categories.map(item => item.label)).size, categories.length);
    for (const category of categories) assert.equal(officeToolboxCategory(format, category.id), category.id);
  }
  assert.equal(officeToolboxCategory('docx', 'animation'), 'home');
  assert.equal(officeToolboxCategory('pptx', 'table'), 'slides');
  assert.equal(officeToolboxCategory('xlsx', 'references'), 'home');
});

test('the application rail renders each task once with distinct icons and no second category tab strip', () => {
  for (const format of ['docx', 'xlsx', 'pptx'] as const) {
    const contribution = officeToolboxContribution(format)!;
    assert.equal(new Set(contribution.categories.map(item => officeToolboxRailIcons[item.id])).size, contribution.categories.length);
    const selected = contribution.categories.at(-1)!.id;
    const html = renderToStaticMarkup(createElement(OfficeToolboxRail, { format, section: 'office:' + selected, open: true, onSelect: () => {} }));
    assert.equal((html.match(/<button\b/g) ?? []).length, contribution.categories.length);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.match(html, /class="office-toolbox-rail"/);
    assert.doesNotMatch(html, /role="tablist"/);
    assert.match(html, new RegExp('data-office-category="' + selected + '"'));
    const collapsed = renderToStaticMarkup(createElement(OfficeToolboxRail, { format, section: 'office:' + selected, open: false, onSelect: () => {} }));
    assert.doesNotMatch(collapsed, /aria-pressed="true"/);
  }
});

test('presentation properties require the exact selected object and never fall back to a first object', () => {
  const model = deck().model;
  assert.equal(presentationToolboxSelection(model, 'view').shape, undefined);
  assert.equal(presentationToolboxSelection(model, 'view', { viewId: 'another', slideId: 'slide1', shapeId: 'shape1' }).shape, undefined);
  assert.equal(presentationToolboxSelection(model, 'view', { viewId: 'view', slideId: 'missing', shapeId: 'shape1' }).shape, undefined);
  assert.equal(presentationToolboxSelection(model, 'view', { viewId: 'view', slideId: 'slide1', shapeId: 'gone' }).shape, undefined);
  assert.equal(presentationToolboxSelection(model, 'view', { viewId: 'view', slideId: 'slide1', shapeId: 'shape1' }).shape?.id, 'shape1');
});

test('toolbox navigation flushes drafts and validates the latest target before applying', async () => {
  const gate = deferred(), applied: OfficeToolboxTarget[] = [];
  let document = deck(), drafts = true, flushed = 0;
  const owner = createOfficeToolboxController({ viewId: 'view', documentId: 'document' }, () => ({ document, viewId: 'view', flush: async () => { flushed++; await gate.promise; drafts = false; }, hasDrafts: () => drafts, apply: target => applied.push(target) }));
  const pending = owner.controller.navigate({ kind: 'slide', slideId: 'slide2' });
  assert.equal(flushed, 1); assert.equal(applied.length, 0);
  document = { ...document, model: { ...document.model, slides: document.model.slides?.map(slide => ({ ...slide })) } };
  gate.resolve(); await pending;
  assert.deepEqual(applied, [{ kind: 'slide', slideId: 'slide2' }]); owner.dispose();
});

test('failed flush, new input, deleted target, and owner replacement reject without navigation', async () => {
  for (const scenario of ['failure', 'dirty', 'deleted', 'view', 'document', 'unmounted'] as const) {
    const gate = deferred(), applied: OfficeToolboxTarget[] = [];
    let document = deck(), viewId = 'view';
    const owner = createOfficeToolboxController({ viewId, documentId: document.id }, () => ({ document, viewId, flush: async () => { await gate.promise; if (scenario === 'failure') throw new Error('保存失败'); }, hasDrafts: () => scenario === 'dirty', apply: target => applied.push(target) }));
    const operation = owner.controller.navigate({ kind: 'slide', slideId: 'slide2' });
    const rejected = assert.rejects(operation, /保存失败|未提交|导航目标|阅读视图/);
    if (scenario === 'deleted') document = { ...document, model: { ...document.model, slides: document.model.slides!.slice(0, 1) } };
    if (scenario === 'view') viewId = 'replacement';
    if (scenario === 'document') document = { ...document, id: 'replacement' };
    if (scenario === 'unmounted') owner.dispose();
    gate.resolve(); await rejected; assert.equal(applied.length, 0, scenario); owner.dispose();
  }
});

test('newer rapid navigation supersedes a slow earlier one, and disposed controllers cannot focus or navigate', async () => {
  const gate = deferred(), applied: OfficeToolboxTarget[] = [];
  const document = deck();
  const owner = createOfficeToolboxController({ viewId: 'view', documentId: document.id }, () => ({ document, viewId: 'view', flush: () => gate.promise, hasDrafts: () => false, apply: target => applied.push(target) }));
  const first = owner.controller.navigate({ kind: 'slide', slideId: 'slide1' }), rejected = assert.rejects(first, /新的导航/);
  const second = owner.controller.navigate({ kind: 'slide', slideId: 'slide2' });
  gate.resolve(); await rejected; await second;
  assert.deepEqual(applied, [{ kind: 'slide', slideId: 'slide2' }]); owner.dispose();
  await assert.rejects(owner.controller.navigate({ kind: 'slide', slideId: 'slide1' }), /阅读视图/);
  assert.throws(() => owner.controller.focusFormula!(), /阅读视图/);
});

test('sheet navigation uses sheet identities and formula focus is only available in a live spreadsheet', async () => {
  const model: DocumentModel = { format: 'xlsx', sheets: [{ id: 'sheet1', name: '财务', rows: [] }, { id: 'sheet2', name: '人物', rows: [] }] };
  const applied: OfficeToolboxTarget[] = []; let focused = 0, flushes = 0;
  const owner = createOfficeToolboxController({ viewId: 'view', documentId: 'document' }, () => ({ document: { id: 'document', format: 'xlsx', model }, viewId: 'view', flush: async () => { flushes++; }, hasDrafts: () => false, apply: target => applied.push(target), focusFormula: () => focused++ }));
  owner.controller.focusFormula!(); assert.equal(focused, 1);
  await owner.controller.navigate({ kind: 'sheet', sheetId: 'sheet2' });
  assert.deepEqual(applied, [{ kind: 'sheet', sheetId: 'sheet2' }]); assert.equal(flushes, 1);
  await assert.rejects(owner.controller.navigate({ kind: 'sheet', sheetId: 'missing' }), /导航目标/);
  await assert.rejects(owner.controller.navigate({ kind: 'slide', slideId: 'slide1' }), /导航目标/);
  assert.equal(flushes, 1, 'invalid targets do not cause draft work'); owner.dispose();
});
