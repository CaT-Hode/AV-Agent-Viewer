import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeOfficeStylePatchSchema } from '../packages/contracts/src/native-office';
import { officeExecuteSchema, officeQuerySchema } from '../packages/sdk/src/authoring-schemas';

test('native selected-style schema accepts bounded primitive fields with documented mm/point/degree units', () => {
  const text = { fontFamily: 'Noto Serif CJK SC', fontSize: 18, bold: true, italic: false, underline: true, strike: false, color: '223344', highlight: 'AABBCC' };
  const patches = [
    { target: 'text', values: text },
    { target: 'paragraph', values: { alignment: 'justify', left: 12.5, right: 0, firstLine: -2, top: 3, bottom: 3, lineSpacingPercent: 150 } },
    { target: 'cells', values: { ...text, alignment: 'right', verticalAlignment: 'center', wrap: true, fill: 'F0F0F0', numberFormat: '#,##0.00' } },
    { target: 'shape', values: { x: -5, y: 10, width: 75, height: 12, rotation: -30, fill: '6699AA', lineColor: '223344', lineWidth: 1.5 } },
  ];
  const versions = { viewId: 'native-bound-view', expectedEngineEpoch: 'current-epoch', expectedEngineRevision: 7, expectedSelectionEpoch: 3, idempotencyKey: 'typed-style' };
  for (const patch of patches) {
    assert.deepEqual(nativeOfficeStylePatchSchema.parse(patch), patch);
    assert.deepEqual(officeExecuteSchema.parse({ ...versions, style: patch }), { ...versions, style: patch, args: [] });
    assert.deepEqual(officeQuerySchema.parse({ viewId: versions.viewId, target: { kind: 'style', target: patch.target } }), { viewId: versions.viewId, target: { kind: 'style', target: patch.target } });
  }
  // MCP registration reads .shape; discovery remains a lightweight ZodObject.
  assert.ok(officeExecuteSchema.shape.style);
  assert.ok(officeQuerySchema.shape.target);
});

test('native selected-style schema rejects empty/unknown fields, coercion, raw UNO properties and unbounded values', () => {
  const invalid = [
    { target: 'text', values: {} }, { target: 'text', values: { bold: undefined } },
    { target: 'text', values: { bold: 'true' } }, { target: 'text', values: { bold: 1 } },
    { target: 'text', values: { fontFamily: '  ' } }, { target: 'text', values: { fontFamily: 'x'.repeat(101) } },
    ...[0, 401, Infinity, NaN].map(fontSize => ({ target: 'text', values: { fontSize } })),
    { target: 'text', values: { color: '#112233' } }, { target: 'text', values: { highlight: 'red' } },
    { target: 'text', values: { CharHeight: 12 } }, { target: 'text', values: { path: 'CharFontName' } },
    { target: 'text', values: { script: 'print(1)' } },
    { target: 'paragraph', values: { alignment: 'block' } }, { target: 'paragraph', values: { left: -1 } },
    { target: 'paragraph', values: { firstLine: -1001 } }, { target: 'paragraph', values: { right: 1001 } },
    ...[49, 501].map(lineSpacingPercent => ({ target: 'paragraph', values: { lineSpacingPercent } })),
    { target: 'cells', values: { verticalAlignment: 'middle' } }, { target: 'cells', values: { wrap: 'false' } },
    { target: 'cells', values: { numberFormat: '' } }, { target: 'cells', values: { numberFormat: 'x'.repeat(121) } },
    { target: 'shape', values: { width: 0 } }, { target: 'shape', values: { height: -1 } },
    { target: 'shape', values: { x: -10001 } }, { target: 'shape', values: { y: 10001 } },
    { target: 'shape', values: { rotation: 361 } }, { target: 'shape', values: { lineWidth: -1 } }, { target: 'shape', values: { lineWidth: 31 } },
    { target: 'shape', values: { width: 10 }, shapeId: 'first' },
  ];
  for (const patch of invalid) assert.equal(nativeOfficeStylePatchSchema.safeParse(patch).success, false, JSON.stringify(patch));
  const valid = { viewId: 'v', expectedEngineEpoch: 'epoch', expectedEngineRevision: 0, expectedSelectionEpoch: 0, idempotencyKey: 'style', style: { target: 'text', values: { bold: true } } };
  assert.equal(officeExecuteSchema.safeParse({ ...valid, nativeHwnd: '123' }).success, false);
  assert.equal(officeQuerySchema.safeParse({ viewId: 'v', target: { kind: 'style', target: 'whole-document' } }).success, false);
});
