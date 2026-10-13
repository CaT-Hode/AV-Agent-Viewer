import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { SheetAdapter } from '../packages/format-adapters/src/sheet-editing';
import type { EditOperation } from '../packages/contracts/src/index';

const adapter = new SheetAdapter();
// ExcelJS writes and reads these OOXML fields although Color's declaration
// omits them; use the actual nested metadata in the preservation regression.
type XMLColor = Partial<ExcelJS.Color> & { tint?: number; indexed?: number };
const themeColor: XMLColor = { theme: 4, tint: .25 };
const indexedColor: XMLColor = { indexed: 10 };
const baseStyle: Partial<ExcelJS.Style> = {
  font: { name: 'Arial', size: 11, bold: false, color: { argb: 'FF334155' }, family: 2, charset: 134, scheme: 'minor' },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F8FB' } },
  alignment: { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1, readingOrder: 'ltr' },
  border: {
    top: { style: 'thin', color: themeColor },
    bottom: { style: 'dashed', color: { argb: 'FF445566' } },
    diagonal: { style: 'hair', color: indexedColor, up: true, down: false },
  },
  numFmt: '0.00;[Red]-0.00',
  protection: { locked: false, hidden: true },
};

async function load(bytes: Uint8Array) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  return workbook;
}

async function apply(bytes: Uint8Array, operation: EditOperation) {
  const model = await adapter.open(bytes, 'xlsx');
  adapter.preview(model, operation);
  return (await adapter.apply(bytes, model, operation)).bytes;
}

async function sharedStyleFixture(merged = false) {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('同款单元格');
  for (let row = 1; row <= 5; row++) {
    for (let column = 1; column <= 5; column++) {
      const cell = sheet.getCell(row, column);
      cell.value = row * 10 + column;
      cell.style = baseStyle;
    }
  }
  if (merged) {
    sheet.getCell('B1').value = null;
    sheet.getCell('C1').value = null;
    sheet.mergeCells('A1:C1');
  }
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  const reloaded = await load(bytes), cells = reloaded.worksheets[0];
  assert.equal(cells.getCell('D4').style, cells.getCell('E5').style,
    'the real XLSX loader must reconstruct the shared style object that triggered the MCP failure');
  const zip = await JSZip.loadAsync(bytes);
  zip.file('customXml/isolation-proof.xml', '<proof>unrelated metadata</proof>');
  return zip.generateAsync({ type: 'uint8array' });
}

test('serialized same-style cells isolate local font, fill, alignment and number-format edits', async () => {
  let bytes = await sharedStyleFixture();
  const operations: EditOperation[] = [
    { kind: 'sheets.setCellFormat', sheetId: '1', address: 'A1', fontSize: 18, bold: true, color: 'FFFFFF' },
    { kind: 'sheets.setCellFormat', sheetId: '1', address: 'A2', fill: '173B5E' },
    { kind: 'sheets.setCellFormat', sheetId: '1', address: 'A3', horizontal: 'center', wrap: false },
    { kind: 'sheets.setCellFormat', sheetId: '1', address: 'A4', numberFormat: '0%' },
  ];
  for (const operation of operations) {
    assert.equal(operation.kind, 'sheets.setCellFormat');
    const target = (operation as Extract<EditOperation, { kind: 'sheets.setCellFormat' }>).address;
    const before = (await load(bytes)).worksheets[0];
    const prior = structuredClone(before.getCell(target).style);
    bytes = await apply(bytes, operation);
    const after = (await load(bytes)).worksheets[0];
    for (let row = 1; row <= 5; row++) {
      for (let column = 1; column <= 5; column++) {
        const old = before.getCell(row, column), next = after.getCell(row, column);
        assert.deepEqual(next.value, old.value);
        if (old.address !== target) assert.deepEqual(next.style, old.style, `${target} must not change ${old.address}`);
      }
    }
    const changed = after.getCell(target);
    assert.deepEqual(changed.border, prior.border, 'nested border colors and diagonal fields survive');
    assert.deepEqual(changed.protection, prior.protection, 'unmodified style fields survive');
    assert.equal(changed.font.charset, prior.font?.charset);
    assert.equal(changed.font.family, prior.font?.family);
    assert.equal(changed.font.scheme, prior.font?.scheme);
  }
  const sheet = (await load(bytes)).worksheets[0];
  assert.equal(sheet.getCell('A1').font.size, 18);
  assert.equal(sheet.getCell('A2').fill.type, 'pattern');
  assert.equal((sheet.getCell('A2').fill as ExcelJS.FillPattern).fgColor?.argb, 'FF173B5E');
  assert.equal(sheet.getCell('A3').alignment.horizontal, 'center');
  assert.equal(sheet.getCell('A4').numFmt, '0%');
  const zip = await JSZip.loadAsync(bytes);
  assert.equal(await zip.file('customXml/isolation-proof.xml')!.async('string'), '<proof>unrelated metadata</proof>');
});

test('range formatting preserves outside cells and applies outline borders to the proper edges', async () => {
  const original = await sharedStyleFixture(), before = (await load(original)).worksheets[0];
  const bytes = await apply(original, {
    kind: 'sheets.setRangeFormat', sheetId: '1', range: 'B2:D4', fontSize: 13,
    fill: 'E5F2EF', horizontal: 'center', borders: 'outline', borderColor: '236355', borderStyle: 'medium',
  });
  const after = (await load(bytes)).worksheets[0];
  for (let row = 1; row <= 5; row++) {
    for (let column = 1; column <= 5; column++) {
      const cell = after.getCell(row, column), prior = before.getCell(row, column);
      assert.deepEqual(cell.value, prior.value);
      if (row < 2 || row > 4 || column < 2 || column > 4) assert.deepEqual(cell.style, prior.style, cell.address);
      else {
        assert.equal(cell.font.size, 13);
        assert.equal(cell.numFmt, prior.numFmt);
        assert.deepEqual(cell.protection, prior.protection);
        assert.deepEqual(cell.border.diagonal, prior.border.diagonal);
      }
    }
  }
  assert.equal(after.getCell('B2').border.top?.style, 'medium');
  assert.equal(after.getCell('B2').border.left?.style, 'medium');
  assert.equal(after.getCell('D4').border.bottom?.style, 'medium');
  assert.equal(after.getCell('D4').border.right?.style, 'medium');
  assert.deepEqual(after.getCell('C3').border, before.getCell('C3').border, 'interior borders do not inherit an edge edit');
});

test('a merged title changes neither the neighbouring cell nor body cells sharing its serialized style', async () => {
  const original = await sharedStyleFixture(true), before = (await load(original)).worksheets[0];
  let bytes = await apply(original, { kind: 'sheets.setCellFormat', sheetId: '1', address: 'A1', fontSize: 18, color: 'FFFFFF', fill: '173B5E', bold: true });
  let sheet = (await load(bytes)).worksheets[0];
  assert.equal(sheet.getCell('A1').font.size, 18);
  assert.equal(sheet.getCell('A1').value, before.getCell('A1').value);
  for (const address of ['D1', 'E1', 'A2', 'D4', 'E5']) assert.deepEqual(sheet.getCell(address).style, before.getCell(address).style, address);
  bytes = await apply(bytes, { kind: 'sheets.setRangeFormat', sheetId: '1', range: 'D2:E3', fill: 'E5F2EF', fontSize: 12 });
  sheet = (await load(bytes)).worksheets[0];
  assert.equal(sheet.getCell('A1').font.size, 18, 'subsequent body edits keep the merged title intact');
  assert.deepEqual(sheet.getCell('D1').style, before.getCell('D1').style);
  assert.deepEqual(sheet.model.merges, ['A1:C1']);
});

test('the real three-sheet MCP baseline can recover independent titles, headers and body without changing data', async () => {
  const original = new Uint8Array(await readFile(new URL('../examples/moon-tide/02-编年表.xlsx', import.meta.url)));
  const before = await load(original);
  assert.deepEqual(before.worksheets.map(sheet => sheet.name), ['编年表', '人物', '记忆代价']);
  let bytes: Uint8Array = original;
  for (const [sheetId, lastColumn, lastRow] of [['1', 'H', 15], ['2', 'G', 6], ['3', 'E', 9]] as const) {
    bytes = await apply(bytes, { kind: 'sheets.setRangeFormat', sheetId, range: `A1:${lastColumn}${lastRow}`, fontSize: 11, color: '334155', fill: 'F5F8FB', bold: false, horizontal: 'left' });
    bytes = await apply(bytes, { kind: 'sheets.setRangeFormat', sheetId, range: `A3:${lastColumn}3`, fontSize: 11, color: 'FFFFFF', fill: '173B5E', bold: true, horizontal: 'center' });
    bytes = await apply(bytes, { kind: 'sheets.setCellFormat', sheetId, address: 'A1', fontSize: 18, color: 'FFFFFF', fill: '173B5E', bold: true });
  }
  const after = await load(bytes);
  for (let index = 0; index < after.worksheets.length; index++) {
    const sheet = after.worksheets[index], source = before.worksheets[index];
    assert.equal(sheet.getCell('A1').font.size, 18);
    assert.equal(sheet.getCell('A3').font.size, 11);
    assert.equal(sheet.getCell('A3').font.color?.argb, 'FFFFFFFF');
    assert.equal(sheet.getCell('D4').font.size, 11);
    assert.equal(sheet.getCell('D4').font.bold ?? false, false, 'XLSX omits the false/default bold flag');
    assert.equal(sheet.getCell('D4').font.color?.argb, 'FF334155');
    assert.equal((sheet.getCell('D4').fill as ExcelJS.FillPattern).fgColor?.argb, 'FFF5F8FB');
    for (let row = 1; row <= source.rowCount; row++) for (let column = 1; column <= source.columnCount; column++) assert.deepEqual(sheet.getCell(row, column).value, source.getCell(row, column).value);
    assert.deepEqual(sheet.views, source.views);
    assert.deepEqual(sheet.autoFilter, source.autoFilter);
    assert.deepEqual(sheet.model.merges, source.model.merges);
  }
  assert.equal(after.getWorksheet('人物')!.getCell('D4').value, 17);
  assert.equal(after.getWorksheet('人物')!.getCell('D5').value, 18);
  assert.equal(after.getWorksheet('记忆代价')!.getCell('B6').formula, 'SUM(B4:B5)');
  assert.deepEqual(await readFile(new URL('../examples/moon-tide/02-编年表.xlsx', import.meta.url)), Buffer.from(original), 'the acceptance test does not overwrite the original MCP evidence file');
});
