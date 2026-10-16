import type ExcelJS from 'exceljs';
import type { SheetCell } from '../../contracts/src/index';

/** Preserve the preview's JSON field order without allocating undefined slots.
 * Keep an independent border for every cell: callers may edit this model. */
export function projectSheetCell(cell: ExcelJS.Cell, formulaType: ExcelJS.ValueType): SheetCell {
  const formula = cell.type === formulaType ? cell.formula : undefined;
  const result: SheetCell = {
    address: cell.address,
    value: cell.value === null || cell.value === undefined ? '' : cell.text,
  };
  if (formula !== undefined) result.formula = formula;
  result.valueType = formula ? 'formula' : cell.value instanceof Date ? 'date' : typeof cell.value;
  const bold = cell.font?.bold;
  if (bold !== undefined) result.bold = bold;
  const italic = cell.font?.italic;
  if (italic !== undefined) result.italic = italic;
  result.underline = !!cell.font?.underline;
  const strike = cell.font?.strike;
  if (strike !== undefined) result.strike = strike;
  const fontName = cell.font?.name;
  if (fontName !== undefined) result.fontName = fontName;
  const fontSize = cell.font?.size;
  if (fontSize !== undefined) result.fontSize = fontSize;
  const color = cell.font?.color?.argb?.slice(-6);
  if (color !== undefined) result.color = color;
  const horizontal = cell.alignment?.horizontal;
  if (horizontal !== undefined) result.horizontal = horizontal;
  const vertical = cell.alignment?.vertical;
  if (vertical !== undefined) result.vertical = vertical;
  const wrap = cell.alignment?.wrapText;
  if (wrap !== undefined) result.wrap = wrap;
  const numberFormat = cell.numFmt;
  if (numberFormat !== undefined) result.numberFormat = numberFormat;
  const fill = cell.fill?.type === 'pattern' ? cell.fill.fgColor?.argb?.slice(-6) : undefined;
  if (fill !== undefined) result.fill = fill;
  const border: NonNullable<SheetCell['border']> = {};
  const top = cell.border?.top?.style;
  if (top !== undefined) border.top = top;
  const bottom = cell.border?.bottom?.style;
  if (bottom !== undefined) border.bottom = bottom;
  const left = cell.border?.left?.style;
  if (left !== undefined) border.left = left;
  const right = cell.border?.right?.style;
  if (right !== undefined) border.right = right;
  result.border = border;
  return result;
}
