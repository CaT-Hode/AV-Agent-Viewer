import test from 'node:test';
import assert from 'node:assert/strict';
import type { NativeOfficeQuery } from '../packages/contracts/src/native-office';
import { officeQuerySchema, officeQueryTargetSchema } from '../packages/sdk/src/authoring-schemas';

test('native shape enumeration addresses one explicit slide without requiring a guessed object name', () => {
  for (const slideIndex of [0, 7]) {
    const target: NativeOfficeQuery = officeQueryTargetSchema.parse({ kind: 'shapes', slideIndex });
    assert.deepEqual(target, { kind: 'shapes', slideIndex });
    assert.deepEqual(officeQuerySchema.parse({ viewId: 'bound-impress-view', target }), { viewId: 'bound-impress-view', target });
  }
  assert.deepEqual(officeQueryTargetSchema.parse({ kind: 'shape', slideIndex: 0, name: '真实标题对象' }), { kind: 'shape', slideIndex: 0, name: '真实标题对象' });
});

test('native shape enumeration rejects invalid indices and object-path, script or inferred-page parameters', () => {
  for (const slideIndex of [-1, 1.5, Infinity, '0', null, undefined]) assert.equal(officeQueryTargetSchema.safeParse({ kind: 'shapes', slideIndex }).success, false);
  for (const extra of [{ path: 'Shapes/0' }, { name: 'first' }, { query: '*' }, { script: 'selectAll()' }, { nativeHwnd: '12' }, { select: true }]) assert.equal(officeQueryTargetSchema.safeParse({ kind: 'shapes', slideIndex: 0, ...extra }).success, false);
});
