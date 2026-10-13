import assert from 'node:assert/strict';
import test from 'node:test';
import type { NativeOfficeNavigateTarget } from '../packages/contracts/src/native-office';
import { officeNavigateSchema, officeNavigateTargetSchema } from '../packages/sdk/src/authoring-schemas';

test('native paragraph navigation selects only on an explicit boolean request and preserves version guards', () => {
  const target: NativeOfficeNavigateTarget = officeNavigateTargetSchema.parse({ kind: 'paragraph', paragraphIndex: 3 });
  assert.deepEqual(target, { kind: 'paragraph', paragraphIndex: 3, select: false });
  const versions = { viewId: 'bound-view', expectedEngineEpoch: 'current-epoch', expectedEngineRevision: 7, expectedSelectionEpoch: 2, idempotencyKey: 'select-paragraph' };
  const request = officeNavigateSchema.parse({ ...versions, target: { kind: 'paragraph', paragraphIndex: 3, select: true } });
  assert.deepEqual(request, { ...versions, target: { kind: 'paragraph', paragraphIndex: 3, select: true } });
  assert.equal(officeNavigateSchema.safeParse({ viewId: 'bound-view', idempotencyKey: 'missing-version', target: request.target }).success, false);
});

test('paragraph selection rejects coercion, invalid indices and selection flags on other navigation targets', () => {
  for (const select of ['true', 1, null]) assert.equal(officeNavigateTargetSchema.safeParse({ kind: 'paragraph', paragraphIndex: 0, select }).success, false);
  for (const paragraphIndex of [-1, .5, Infinity]) assert.equal(officeNavigateTargetSchema.safeParse({ kind: 'paragraph', paragraphIndex, select: true }).success, false);
  for (const target of [{ kind: 'page', pageIndex: 0 }, { kind: 'sheet', index: 0 }, { kind: 'slide', index: 0 }, { kind: 'cell', sheetName: '工作表', address: 'A1' }]) {
    assert.deepEqual(officeNavigateTargetSchema.parse(target), target);
    assert.equal(officeNavigateTargetSchema.safeParse({ ...target, select: true }).success, false);
  }
});

test('native shape navigation uses a bounded exact object name on a specific slide with no object-path escape', () => {
  const target: NativeOfficeNavigateTarget = officeNavigateTargetSchema.parse({ kind: 'shape', slideIndex: 2, name: '  灯塔标题  ' });
  assert.deepEqual(target, { kind: 'shape', slideIndex: 2, name: '  灯塔标题  ' }); // Keep a real name exact, including any intentional whitespace.
  const request = officeNavigateSchema.parse({ viewId: 'bound-impress-view', expectedEngineEpoch: 'current-epoch', expectedEngineRevision: 7, expectedSelectionEpoch: 2, idempotencyKey: 'select-real-shape', target });
  assert.deepEqual(request.target, target);
  for (const name of ['', '   ', 'x'.repeat(201), 1, null]) assert.equal(officeNavigateTargetSchema.safeParse({ kind: 'shape', slideIndex: 0, name }).success, false);
  for (const slideIndex of [-1, .5, Infinity, '0']) assert.equal(officeNavigateTargetSchema.safeParse({ kind: 'shape', slideIndex, name: '标题' }).success, false);
  for (const extra of [{ path: 'Shapes/0' }, { query: '*' }, { objectId: 'first' }, { select: true }]) assert.equal(officeNavigateTargetSchema.safeParse({ kind: 'shape', slideIndex: 0, name: '标题', ...extra }).success, false);
});
