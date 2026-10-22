import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { openXlsxSource, xlsxSourceFeatures, type XlsxSource } from './xlsx-source';

export type XlsxPreviewLimits = { rows: number; columns: number };
export type XlsxPreviewCounts = { rowCount: number; columnCount: number };
export type BoundedXlsxPreview = { bytes: Uint8Array; sheets: Map<string, XlsxPreviewCounts> };
type Tag = { name: string; attributes: Record<string, string>; isSelfClosing: boolean };
type Sax = { position: number; on(event: string, listener: (...args: any[]) => void): void; write(value: string): Sax; close(): Sax };
type SaxConstructor = new (options: { position: true }) => Sax;
let saxConstructor: SaxConstructor | undefined;
const refused = () => { throw new Error('Use the complete XLSX reader.'); };

/** ExcelJS itself declares and pins this parser. Resolve from its installation,
 * including the packaged main process; never depend on hoisted transitive paths.
 * Missing/changed parser behavior simply retains the normal Workbook path. */
function parserConstructor(): SaxConstructor {
  if (!saxConstructor) {
    const local = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
    const excel = createRequire(local.resolve('exceljs/package.json'));
    saxConstructor = excel('saxes').SaxesParser;
  }
  if (typeof saxConstructor !== 'function') return refused();
  return saxConstructor;
}

function parse(source: string, visit: (parser: Sax) => void) {
  const Parser = parserConstructor(), parser = new Parser({ position: true });
  parser.on('error', refused); parser.on('doctype', refused); parser.on('cdata', refused);
  parser.on('xmldecl', declaration => {
    if (declaration.encoding && !/^utf-?8$/i.test(declaration.encoding)) refused();
  });
  visit(parser);
  parser.write(source).close();
}

function coordinate(value: string | undefined) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(value ?? '');
  if (!match) return refused();
  let column = 0;
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || !Number.isSafeInteger(row) || row > 1048576) return refused();
  return { row, column };
}

function integer(value: string | undefined, maximum: number) {
  if (!/^[1-9]\d*$/.test(value ?? '')) return refused();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) return refused();
  return number;
}

async function sheetPaths(source: XlsxSource) {
  const { zip } = source;
  const workbook = zip.file('xl/workbook.xml'), relationships = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships) return refused();
  const targets = new Map<string, string>(), sheets: { id: string; relationship: string }[] = [];
  parse(await source.xml('xl/_rels/workbook.xml.rels'), parser => parser.on('opentag', (tag: Tag) => {
    if (tag.name !== 'Relationship' || !tag.attributes.Type?.endsWith('/worksheet')) return;
    const { Id: id, Target: target, TargetMode: mode } = tag.attributes;
    if (!id || !target || mode === 'External' || targets.has(id) || /[\\?#]/.test(target)) return refused();
    const file = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target));
    // The unchanged ExcelJS normal loader recognises this package layout.
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(file) || !zip.file(file)) return refused();
    targets.set(id, file);
  }));
  parse(await source.xml('xl/workbook.xml'), parser => parser.on('opentag', (tag: Tag) => {
    if (tag.name !== 'sheet') return;
    const id = String(integer(tag.attributes.sheetId, 2147483647)), relationship = tag.attributes['r:id'];
    if (!relationship || sheets.some(sheet => sheet.id === id || sheet.relationship === relationship)) return refused();
    sheets.push({ id, relationship });
  }));
  if (!sheets.length || sheets.length !== targets.size) return refused();
  const paths = sheets.map(sheet => ({ id: sheet.id, path: targets.get(sheet.relationship) ?? refused() }));
  if (new Set(paths.map(sheet => sheet.path)).size !== paths.length) return refused();
  return paths;
}

async function sharedStringCount(source: XlsxSource) {
  const { zip } = source;
  const file = zip.file('xl/sharedStrings.xml');
  if (!file) return 0;
  let count = 0, depth = 0;
  parse(await source.xml('xl/sharedStrings.xml'), parser => {
    parser.on('opentag', (tag: Tag) => { depth++; if (depth === 2 && tag.name === 'si') count++; });
    parser.on('closetag', () => { depth--; });
  });
  return count;
}

type Span = { start: number; end: number };
type Row = { number: number; start: number; outside: boolean; lastColumn: number; materializedColumn: number; hasValues: boolean; cutStart?: number; cutEnd?: number };
type Cell = { column: number; type?: string; style: boolean; value: boolean; formula: boolean; rich: boolean; sharedIndex: string };
const cellElements = new Set(['f', 'v', 'is', 't', 'r', 'rPr', 'b', 'i', 'u', 'strike', 'sz', 'rFont', 'color', 'family', 'charset', 'scheme', 'vertAlign', 'outline', 'shadow', 'condense', 'extend']);
const worksheetElements = new Set(['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'dataValidations', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'hyperlinks']);

/** Scan without a cell DOM. Outside rows produce one removal span, and each
 * retained row produces at most one column-tail span. Retained XML is copied
 * verbatim, including entities, whitespace and non-BMP characters. CDATA and
 * non-UTF-8 declarations conservatively retain the complete loader. */
function trimWorksheet(source: string, limits: XlsxPreviewLimits, strings: number) {
  const stack: string[] = [], spans: Span[] = [];
  let outsideSpan: Span | undefined;
  let row: Row | undefined, cell: Cell | undefined, rowCount = 0, columnCount = 0, dataSections = 0, previousRow = 0;
  parse(source, parser => {
    parser.on('opentag', (tag: Tag) => {
      const parent = stack.at(-1), depth = stack.length;
      if (depth > 64 || tag.name.includes(':')) return refused();
      // Saxes.position is explicitly a UTF-16 string index after the tag. A
      // literal '<' cannot occur inside a well-formed XML attribute value.
      const start = source.lastIndexOf('<', parser.position - 1);
      if (start < 0 || source.slice(start, start + tag.name.length + 1) !== '<' + tag.name || source[parser.position - 1] !== '>') return refused();
      if (!depth) { if (tag.name !== 'worksheet') return refused(); }
      else if (depth === 1 && !worksheetElements.has(tag.name)) return refused();
      if (tag.name === 'sheetData') {
        if (parent !== 'worksheet' || ++dataSections !== 1) return refused();
      } else if (parent === 'sheetData') {
        if (tag.name !== 'row' || row) return refused();
        const number = integer(tag.attributes.r, 1048576);
        if (number <= previousRow) return refused();
        previousRow = number; rowCount = number;
        row = { number, start, outside: number > limits.rows, lastColumn: 0, materializedColumn: 0, hasValues: false };
      } else if (parent === 'row') {
        if (tag.name !== 'c' || !row || cell) return refused();
        const address = coordinate(tag.attributes.r);
        if (address.row !== row.number || address.column <= row.lastColumn) return refused();
        row.lastColumn = address.column;
        if (!row.outside && address.column > limits.columns) row.cutStart ??= start;
        const type = tag.attributes.t, style = tag.attributes.s;
        if (type !== undefined && !['n', 's', 'str', 'inlineStr', 'b', 'e'].includes(type) || style !== undefined && !/^\d+$/.test(style)) return refused();
        cell = { column: address.column, type, style: Number(style ?? 0) > 0, value: false, formula: false, rich: false, sharedIndex: '' };
      } else if (cell) {
        if (!cellElements.has(tag.name)) return refused();
        const validParent = tag.name === 'f' || tag.name === 'v' || tag.name === 'is' ? parent === 'c'
          : tag.name === 'r' ? parent === 'is' : tag.name === 'rPr' ? parent === 'r'
          : tag.name === 't' ? parent === 'is' || parent === 'r' : parent === 'rPr';
        if (!validParent) return refused();
        if (tag.name === 'f') {
          // A removed master can affect a kept slave. Keep all shared/array and
          // other specialised formula topologies on the complete loader.
          // The pinned CellXform consumes only si/t/ref. These standard boolean
          // flags do not introduce shared-cell dependencies and are ignored by
          // that same normal loader; preserve their raw XML unchanged.
          if (Object.entries(tag.attributes).some(([key, value]) => key !== 't' && (!['aca', 'ca', 'bx'].includes(key) || !/^(?:true|false|0|1)$/.test(value))) || tag.attributes.t !== undefined && tag.attributes.t !== 'normal') return refused();
          cell.formula ||= tag.attributes.t === 'normal';
        }
        if (tag.name === 'r') cell.rich = true;
      }
      if (tag.name === 'mergeCell') {
        if (parent !== 'mergeCells') return refused();
        const parts = (tag.attributes.ref ?? '').split(':');
        if (parts.length > 2) return refused();
        const first = coordinate(parts[0]), last = coordinate(parts[1] ?? parts[0]);
        if (last.row < first.row || last.column < first.column || last.row > limits.rows || last.column > limits.columns) return refused();
      }
      if (tag.name === 'hyperlink') {
        if (parent !== 'hyperlinks') return refused();
        const address = coordinate(tag.attributes.ref);
        if (address.row > limits.rows || address.column > limits.columns) return refused();
      }
      stack.push(tag.name);
    });
    const text = (value: string) => {
      if (!cell || !value) return;
      const leaf = stack.at(-1);
      if (leaf === 'f') cell.formula = true;
      else if (leaf === 'v' || leaf === 't') {
        cell.value = true;
        if (cell.type === 's' && leaf === 'v') { cell.sharedIndex += value; if (cell.sharedIndex.length > 32) refused(); }
      } else if (value.trim()) refused();
    };
    // The pinned normal ExcelJS parseSax bridge does not forward CDATA as text.
    // Keep CDATA files on that exact path rather than guessing count semantics.
    parser.on('text', text);
    parser.on('closetag', (tag: Tag) => {
      if (stack.pop() !== tag.name) return refused();
      if (tag.name === 'c' && row && cell) {
        if (cell.type === 's' && cell.value && !cell.formula && !cell.rich) {
          if (!/^\d+$/.test(cell.sharedIndex) || Number(cell.sharedIndex) >= strings) return refused();
        }
        const hasValues = cell.value || cell.formula || cell.rich;
        if (hasValues || cell.style) row.materializedColumn = cell.column;
        row.hasValues ||= hasValues;
        if (!row.outside && cell.column > limits.columns) row.cutEnd = parser.position;
        cell = undefined;
      } else if (tag.name === 'row' && row) {
        // Empty/style-only overflow rows have subtle normal-loader presence and
        // count semantics; leave them to that loader instead of inferring them.
        if (row.outside && !row.hasValues) return refused();
        if (row.hasValues) columnCount = Math.max(columnCount, row.materializedColumn);
        if (row.outside) {
          // Strictly increasing row numbers make all overflow rows one suffix.
          // Do not retain one span/slice per source row in a million-row file.
          if (outsideSpan) outsideSpan.end = parser.position;
          else spans.push(outsideSpan = { start: row.start, end: parser.position });
        }
        else if (row.cutStart !== undefined && row.cutEnd !== undefined) spans.push({ start: row.cutStart, end: row.cutEnd });
        row = undefined;
      }
    });
  });
  if (stack.length || row || cell || dataSections !== 1) return refused();
  if (!spans.length) return { counts: { rowCount, columnCount } };
  let offset = 0;
  const parts: string[] = [];
  for (const span of spans) {
    if (span.start < offset || span.end <= span.start || span.end > source.length) return refused();
    parts.push(source.slice(offset, span.start)); offset = span.end;
  }
  parts.push(source.slice(offset));
  return { counts: { rowCount, columnCount }, source: parts.join('') };
}

/** Optimisation only: any uncertainty goes back to the exact original package.
 * The returned bytes are private preview input, never a save/edit/native source. */
async function prepareFromSource(source: XlsxSource, limits: XlsxPreviewLimits): Promise<BoundedXlsxPreview | undefined> {
  if (![limits.rows, limits.columns].every(value => Number.isSafeInteger(value) && value > 0) || limits.rows > 1048576 || limits.columns > 16384) return undefined;
  try {
    const { zip } = source;
    // These parts can introduce source-dependent objects or unsupported sheet
    // topology. Preserve the full reader for them, as for the existing editor.
    if (Object.keys(zip.files).some(path => /^xl\/(?:charts|drawings|pivot|externalLinks|slicer|embeddings|tables|connections|queryTables|threadedComments)|vbaProject/i.test(path))) return undefined;
    const paths = await sheetPaths(source), strings = await sharedStringCount(source), sheets = new Map<string, XlsxPreviewCounts>();
    let changed = false;
    for (const sheet of paths) {
      const result = trimWorksheet(await source.xml(sheet.path), limits, strings);
      sheets.set(sheet.id, result.counts);
      if (result.source !== undefined) { zip.file(sheet.path, result.source); changed = true; }
    }
    if (!changed) return undefined;
    return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), sheets };
  } catch {
    // Do not convert malformed files into successes or replace their errors.
    // SheetAdapter will run the ordinary loader on the untouched input bytes.
    return undefined;
  }
}

type XlsxFeatureResult = { ok: true; value: string[] } | { ok: false; error: unknown };
/** Complete-source inspection and bounded preview share one short-lived ZIP
 * and original XML decode per entry. Preview reads record original feature
 * metadata before private replacements; inspect any remaining original entries.
 * Defer inspection errors until after the ordinary Workbook
 * loader, preserving its established failure precedence and full fallback. */
export async function prepareXlsxOpen(bytes: Uint8Array, limits: XlsxPreviewLimits): Promise<{ preview?: BoundedXlsxPreview; features?: XlsxFeatureResult }> {
  let source: XlsxSource;
  try { source = await openXlsxSource(bytes); } catch { return {}; }
  try {
    const preview = await prepareFromSource(source, limits);
    let features: XlsxFeatureResult;
    try { features = { ok: true, value: await xlsxSourceFeatures(source) }; }
    catch (error) { features = { ok: false, error }; }
    return { preview, features };
  } finally { source.release(); }
}
