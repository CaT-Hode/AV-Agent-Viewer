import type ExcelJS from 'exceljs';
import packageInfo from 'exceljs/package.json' with { type: 'json' };

/** Private adapter surface, not a replacement for ExcelJS's public SDK. The
 * original Workbook still owns all XLSX/CSV readers, writers and document APIs. */
export type NormalExcelJS = Pick<typeof ExcelJS, 'Workbook' | 'ValueType'>;
let loading: Promise<NormalExcelJS> | undefined;

async function loadNormalWorkbook(): Promise<NormalExcelJS> {
  // These are private paths in the installed, lock-pinned dependency. Refuse an
  // unreviewed version rather than silently substituting a reduced workbook or
  // initializing the unrelated streaming-reader/writer dependency trees.
  if (packageInfo.version !== '4.4.0') throw new Error('EXCELJS_RUNTIME_UNSUPPORTED: the normal workbook loader requires the reviewed ExcelJS 4.4.0 module layout.');
  const [workbookModule, enumsModule] = await Promise.all([
    // ExcelJS publishes declarations for its top-level SDK only. Keep literal
    // imports so both native ESM and the CJS application bundle resolve these
    // exact modules, without a cwd/__filename-derived alternate installation.
    // @ts-expect-error The pinned internal CommonJS module has no declaration.
    import('exceljs/lib/doc/workbook.js'),
    // @ts-expect-error The pinned internal CommonJS module has no declaration.
    import('exceljs/lib/doc/enums.js'),
  ]);
  const Workbook = workbookModule.default, ValueType = enumsModule.default?.ValueType;
  const prototype = Workbook?.prototype;
  if (typeof Workbook !== 'function' || typeof prototype?.addWorksheet !== 'function' || typeof prototype?.getWorksheet !== 'function'
    || typeof Object.getOwnPropertyDescriptor(prototype, 'xlsx')?.get !== 'function' || typeof Object.getOwnPropertyDescriptor(prototype, 'csv')?.get !== 'function'
    || !ValueType || ['Null', 'Merge', 'Number', 'String', 'Date', 'Hyperlink', 'Formula', 'SharedString', 'RichText', 'Boolean', 'Error'].some((key, index) => ValueType[key] !== index)) {
    throw new Error('EXCELJS_RUNTIME_UNSUPPORTED: the installed normal Workbook or ValueType export does not match the reviewed ExcelJS implementation.');
  }
  return { Workbook, ValueType };
}

/** Share one lazy, complete normal Workbook across preview/editing/translation. */
export function loadExcelJS(): Promise<NormalExcelJS> {
  return loading ??= loadNormalWorkbook().catch(error => {
    // A failed import must not poison later, explicitly requested XLSX work.
    loading = undefined;
    throw error;
  });
}
