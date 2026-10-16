/** Source-preserving Markdown operations. Positions are UTF-16 offsets, just
 * like CodeMirror and text.replace. No renderer, DOM, file or model state lives
 * here; callers apply the returned replacement as one ordinary edit. */
export const MARKDOWN_COMMANDS = [
  'bold', 'italic', 'strike', 'underline', 'code', 'highlight', 'sub', 'super', 'clear', 'link', 'referenceLink', 'emoji', 'image',
  'heading0', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6',
  'quote', 'bullet', 'ordered', 'task', 'codeBlock', 'codeLanguage', 'mathBlock', 'mathInline', 'mermaid', 'sequence', 'flow', 'callout', 'table', 'rule', 'toc', 'frontmatter', 'footnote',
  'tableAddRow', 'tableDeleteRow', 'tableAddColumn', 'tableDeleteColumn',
  'tableMoveRowUp', 'tableMoveRowDown', 'tableMoveColumnLeft', 'tableMoveColumnRight',
  'tableAlign', 'tableAlignLeft', 'tableAlignCenter', 'tableAlignRight', 'tableAlignNone',
] as const;
export type MarkdownCommandName = typeof MARKDOWN_COMMANDS[number];
export type MarkdownViewCommandName = 'find' | 'replace' | 'undo' | 'redo' | 'focus' | 'typewriter' | 'spellcheck' | 'autoPair';
export type MarkdownToolCommandName = MarkdownCommandName | MarkdownViewCommandName;
export type MarkdownCommandEventDetail = { viewId: string; command: MarkdownToolCommandName; value?: unknown };
export type MarkdownReplacement = { from: number; to: number; insert: string; selection?: { anchor: number; head: number } };
export type MarkdownTableAlignment = 'left' | 'center' | 'right' | null;
export interface MarkdownTableCell { from: number; to: number; text: string }
export interface MarkdownTableRow { from: number; to: number; kind: 'header' | 'delimiter' | 'body'; cells: MarkdownTableCell[] }
export interface MarkdownTable {
  from: number; to: number;
  /** Cell strings are Markdown source, including existing escapes/inline code. */
  header: string[]; rows: string[][]; align: MarkdownTableAlignment[];
  rowRanges: MarkdownTableRow[]; prefix: string; eol: '\n' | '\r\n';
}
export interface MarkdownTextSource {
  readonly length: number;
  sliceString(from: number, to?: number): string;
  lineAt(position: number): { from: number; to: number };
}
/** Local formatting consumes only its source block. The optional enclosing
 * range comes from the incremental syntax tree (tables/fences), never a search
 * for a similar substring elsewhere. Global footnotes intentionally inspect the
 * document only when that explicit command is invoked. */
export function markdownTransformRange(source: MarkdownTextSource, from: number, to: number, command: MarkdownCommandName, value?: unknown, enclosing?: { from: number; to: number }): MarkdownReplacement {
  if (command === 'footnote' || command === 'frontmatter' || command === 'referenceLink') return markdownTransform(source.sliceString(0, source.length), from, to, command, value);
  const first = source.lineAt(from), last = source.lineAt(Math.max(from, to - 1));
  const start = Math.max(0, Math.min(first.from, enclosing?.from ?? first.from) - 2), end = Math.min(source.length, Math.max(last.to, enclosing?.to ?? last.to) + 2);
  const result = markdownTransform(source.sliceString(start, end), from - start, to - start, command, value);
  return { ...result, from: result.from + start, to: result.to + start, ...(result.selection ? { selection: { anchor: result.selection.anchor + start, head: result.selection.head + start } } : {}) };
}
type Line = { from: number; to: number; next: number; text: string };
const eolFor = (source: string): '\n' | '\r\n' => source.includes('\r\n') ? '\r\n' : '\n';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function sourceLines(source: string): Line[] {
  const result: Line[] = []; let start = 0;
  for (;;) {
    const newline = source.indexOf('\n', start), next = newline < 0 ? source.length : newline + 1;
    const end = newline < 0 ? source.length : newline > start && source[newline - 1] === '\r' ? newline - 1 : newline;
    result.push({ from: start, to: end, next, text: source.slice(start, end) });
    if (newline < 0) return result;
    start = next;
  }
}
function prefixOf(text: string) {
  const prefix = /^\s*(?:>\s*)*/.exec(text)?.[0] ?? '';
  return { prefix, content: text.slice(prefix.length), quotes: (prefix.match(/>/g) ?? []).length, indented: /^[ \t]{4}|^\t/.test(prefix) };
}
function cellsOf(line: Line, prefix: string) {
  const raw = line.text.slice(prefix.length), boundaries: number[] = []; let backslashes = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '|' && backslashes % 2 === 0) boundaries.push(i);
    backslashes = raw[i] === '\\' ? backslashes + 1 : 0;
  }
  const pieces: { start: number; end: number }[] = []; let start = 0;
  for (const boundary of boundaries) { pieces.push({ start, end: boundary }); start = boundary + 1; }
  pieces.push({ start, end: raw.length });
  if (boundaries.length && !raw.slice(0, boundaries[0]).trim()) pieces.shift();
  if (boundaries.length && !raw.slice(boundaries.at(-1)! + 1).trim()) pieces.pop();
  return { hasPipe: boundaries.length > 0, cells: pieces.map(piece => {
    const part = raw.slice(piece.start, piece.end), leading = /^\s*/.exec(part)![0].length, text = part.trim();
    const from = line.from + prefix.length + piece.start + leading;
    return { from, to: from + text.length, text };
  }) };
}
/** Find a real pipe table outside fenced code. With position supplied, never
 * choose a different table elsewhere in the document. Row/cell ranges refer
 * to original trimmed source; escaped pipes use backslash parity, also inside
 * code spans, as required by GFM. Overflow cells are retained, never dropped. */
export function parseMarkdownTable(source: string, position?: number): MarkdownTable | undefined {
  if (position !== undefined && (!Number.isInteger(position) || position < 0 || position > source.length)) return undefined;
  const lines = sourceLines(source); let fence: { char: string; size: number } | undefined;
  for (let index = 0; index + 1 < lines.length; index++) {
    const line = lines[index], container = prefixOf(line.text), marker = /^(\x60{3,}|~{3,})(.*)$/.exec(container.content);
    if (marker) {
      if (fence) { if (marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = undefined; }
      else fence = { char: marker[1][0], size: marker[1].length };
      continue;
    }
    if (fence || container.indented) continue;
    const head = cellsOf(line, container.prefix), delimiterLine = lines[index + 1], delimiterPrefix = prefixOf(delimiterLine.text);
    if (!head.hasPipe || !head.cells.length || delimiterPrefix.quotes !== container.quotes || delimiterPrefix.indented) continue;
    const delimiter = cellsOf(delimiterLine, delimiterPrefix.prefix);
    if (delimiter.cells.length !== head.cells.length || !delimiter.cells.every(cell => /^:?-+:?$/.test(cell.text))) continue;
    const rowRanges: MarkdownTableRow[] = [{ from: line.from, to: line.to, kind: 'header', cells: head.cells }, { from: delimiterLine.from, to: delimiterLine.to, kind: 'delimiter', cells: delimiter.cells }];
    const rows: string[][] = []; let last = delimiterLine;
    for (let body = index + 2; body < lines.length; body++) {
      const candidate = lines[body], current = prefixOf(candidate.text);
      if (!current.content.trim() || current.indented || current.quotes !== container.quotes || /^(?:#{1,6}\s|(?:[-+*]|\d+[.)])\s|\x60{3,}|~{3,}|<\/?[A-Za-z]|(?:[-*_]\s*){3,}$)/.test(current.content)) break;
      const cells = cellsOf(candidate, current.prefix).cells;
      rows.push(cells.map(cell => cell.text)); rowRanges.push({ from: candidate.from, to: candidate.to, kind: 'body', cells }); last = candidate;
    }
    if (position === undefined || position >= line.from && position <= last.to) return {
      from: line.from, to: last.to, header: head.cells.map(cell => cell.text), rows,
      align: delimiter.cells.map(cell => cell.text.startsWith(':') ? cell.text.endsWith(':') ? 'center' : 'left' : cell.text.endsWith(':') ? 'right' : null),
      rowRanges, prefix: container.prefix, eol: eolFor(source),
    };
    index += rowRanges.length - 1;
  }
  return undefined;
}
function escapeCell(value: string) {
  const text = value.replace(/\r?\n/g, '<br>'); let result = '', backslashes = 0;
  for (const char of text) {
    result += char === '|' && backslashes % 2 === 0 ? '\\|' : char;
    backslashes = char === '\\' ? backslashes + 1 : 0;
  }
  return result;
}
/** Serialize only the specified table, preserving Markdown cell contents and
 * pre-existing pipe escapes. Existing extra cells become explicit columns. */
export function serializeMarkdownTable(table: Pick<MarkdownTable, 'header' | 'rows' | 'align'> & Partial<Pick<MarkdownTable, 'prefix' | 'eol'>>): string {
  const width = table.rows.reduce((largest, row) => Math.max(largest, row.length), Math.max(table.header.length, table.align.length));
  if (!width) return '';
  const prefix = table.prefix ?? '', eol = table.eol ?? '\n';
  const row = (cells: string[]) => prefix + '| ' + Array.from({ length: width }, (_, i) => escapeCell(cells[i] ?? '')).join(' | ') + ' |';
  const delimiter = Array.from({ length: width }, (_, i) => table.align[i] === 'left' ? ':---' : table.align[i] === 'center' ? ':---:' : table.align[i] === 'right' ? '---:' : '---');
  return [row(table.header), row(delimiter), ...table.rows.map(row)].join(eol);
}
function bounds(source: string, from: number, to: number) {
  if (![from, to].every(value => Number.isInteger(value) && value >= 0 && value <= source.length)) throw new RangeError('Markdown selection is outside the source.');
  return from <= to ? { from, to } : { from: to, to: from };
}
function selection(from: number, insert: string, start = 0, end = insert.length): MarkdownReplacement {
  return { from, to: from, insert, selection: { anchor: from + start, head: from + end } };
}
function replace(from: number, to: number, insert: string, start = 0, end = insert.length): MarkdownReplacement {
  return { ...selection(from, insert, start, end), to };
}
function lineRange(source: string, from: number, to: number) {
  const start = from === 0 ? 0 : source.lastIndexOf('\n', from - 1) + 1;
  const last = Math.max(from, to - 1), newline = source.indexOf('\n', last);
  const end = newline < 0 ? source.length : newline > start && source[newline - 1] === '\r' ? newline - 1 : newline;
  return { from: start, to: end, text: source.slice(start, end) };
}
function inline(source: string, from: number, to: number, left: string, right: string, placeholder: string) {
  const text = source.slice(from, to);
  // A single * or ~ must not remove one half of a bold/strike marker.
  const exact = (body: string) => left !== right || !/^[*_~]$/.test(left) || !body.startsWith(left) && !body.endsWith(right);
  if (text.startsWith(left) && text.endsWith(right) && text.length >= left.length + right.length && exact(text.slice(left.length, -right.length))) return replace(from, to, text.slice(left.length, -right.length));
  const before = from - left.length;
  if (before >= 0 && source.slice(before, from) === left && source.slice(to, to + right.length) === right && (left !== right || !/^[*_~]$/.test(left) || source[before - 1] !== left && source[to + right.length] !== right)) return replace(before, to + right.length, text);
  const body = text || placeholder;
  return replace(from, to, left + body + right, left.length, left.length + body.length);
}
function block(source: string, from: number, to: number, text: string, start = 0, end = text.length) {
  const eol = eolFor(source), before = source.slice(0, from), after = source.slice(to);
  const left = !before || /(?:\r?\n){2}$/.test(before) ? '' : before.endsWith('\n') ? eol : eol + eol;
  const right = !after || /^(?:\r?\n){2}/.test(after) ? '' : after.startsWith('\r\n') || after.startsWith('\n') ? eol : eol + eol;
  return replace(from, to, left + text + right, left.length + start, left.length + end);
}
function fencedBlock(source: string, from: number, to: number, math: boolean) {
  const lines = sourceLines(source); let opening: { line: Line; token: string } | undefined;
  for (const line of lines) {
    const found = math ? /^ {0,3}(\$\$)\s*$/.exec(line.text) : /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line.text);
    if (!found) continue;
    if (!opening) opening = { line, token: found[1] };
    else if (found[1][0] === opening.token[0] && found[1].length >= opening.token.length && (math || !found[2].trim())) {
      if (from >= opening.line.from && to <= line.to) return { from: opening.line.from, to: line.to, opening: opening.line, token: opening.token, body: source.slice(opening.line.next, line.from).replace(/\r?\n$/, '') };
      opening = undefined;
    }
  }
  return undefined;
}
function positive(value: unknown, fallback: number, maximum = 1000) {
  if (value === undefined) return fallback;
  const result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < 1 || result > maximum) throw new RangeError('Markdown table size is outside the supported range.');
  return result;
}
function destination(value: unknown) {
  const input = typeof value === 'string' ? value : typeof record(value).url === 'string' ? record(value).url as string : '';
  const url = input.trim() || 'https://';
  if (/[\u0000-\u001f\u007f]/.test(url) || /^(?:javascript|vbscript|data):/i.test(url)) throw new Error('链接地址不能包含脚本、内嵌数据或控制字符。');
  // Angle destinations retain spaces, parentheses and Windows/local paths;
  // only the delimiters themselves need percent encoding.
  return '<' + url.replace(/</g, '%3C').replace(/>/g, '%3E') + '>';
}
function tableEdit(source: string, from: number, command: MarkdownCommandName, value: unknown) {
  const table = parseMarkdownTable(source, from);
  if (!table) throw new Error('请先把光标放入 Markdown 表格。');
  const item = table.rowRanges.find(row => from >= row.from && from <= row.to) ?? table.rowRanges[0];
  let rowIndex = item.kind === 'body' ? table.rowRanges.filter(row => row.kind === 'body').indexOf(item) : -1;
  let column = item.cells.findIndex(cell => from <= cell.to); if (column < 0) column = Math.max(0, item.cells.length - 1);
  const options = record(value);
  if (options.column !== undefined) { if (!Number.isInteger(options.column) || Number(options.column) < 0 || Number(options.column) >= table.header.length) throw new RangeError('表格列位置已失效。'); column = Number(options.column); }
  const width = table.rows.reduce((largest, row) => Math.max(largest, row.length), table.header.length);
  table.header = Array.from({ length: width }, (_, i) => table.header[i] ?? '');
  table.rows = table.rows.map(row => Array.from({ length: width }, (_, i) => row[i] ?? ''));
  table.align = Array.from({ length: width }, (_, i) => table.align[i] ?? null);
  if (command === 'tableAddRow') { rowIndex++; table.rows.splice(rowIndex, 0, Array(width).fill('')); }
  else if (command === 'tableDeleteRow') {
    if (rowIndex < 0) { if (!table.rows.length) return replace(table.from, table.to, ''); table.header = table.rows.shift()!; }
    else { table.rows.splice(rowIndex, 1); rowIndex = Math.min(rowIndex, table.rows.length - 1); }
  } else if (command === 'tableAddColumn') {
    column++; table.header.splice(column, 0, ''); table.align.splice(column, 0, null); for (const row of table.rows) row.splice(column, 0, '');
  } else if (command === 'tableDeleteColumn') {
    if (width === 1) return replace(table.from, table.to, '');
    table.header.splice(column, 1); table.align.splice(column, 1); for (const row of table.rows) row.splice(column, 1); column = Math.min(column, width - 2);
  } else if (command === 'tableMoveRowUp' || command === 'tableMoveRowDown') {
    const target = rowIndex + (command === 'tableMoveRowUp' ? -1 : 1); if (rowIndex < 0 || target < 0 || target >= table.rows.length) throw new Error('当前行不能继续移动。'); [table.rows[rowIndex], table.rows[target]] = [table.rows[target], table.rows[rowIndex]]; rowIndex = target;
  } else if (command === 'tableMoveColumnLeft' || command === 'tableMoveColumnRight') {
    const target = column + (command === 'tableMoveColumnLeft' ? -1 : 1); if (target < 0 || target >= width) throw new Error('当前列不能继续移动。'); for (const row of [table.header, ...table.rows]) [row[column], row[target]] = [row[target], row[column]]; [table.align[column], table.align[target]] = [table.align[target], table.align[column]]; column = target;
  } else {
    const alignment = command === 'tableAlignLeft' ? 'left' : command === 'tableAlignCenter' ? 'center' : command === 'tableAlignRight' ? 'right' : command === 'tableAlignNone' ? null : value === null || typeof value === 'string' ? value : options.align;
    if (alignment !== null && !['left', 'center', 'right'].includes(String(alignment))) throw new Error('请选择左对齐、居中、右对齐或默认对齐。');
    table.align[column] = alignment as MarkdownTableAlignment;
  }
  const insert = serializeMarkdownTable(table), next = parseMarkdownTable(insert), target = next?.rowRanges.filter(row => row.kind !== 'delimiter')[Math.max(0, rowIndex + 1)]?.cells[column];
  return replace(table.from, table.to, insert, target?.from ?? 0, target?.to ?? 0);
}
/** value is plain command data: URL/language/alignment string, or table
 * {rows,columns,column,align}. New-table rows includes its header row. */
export function markdownTransform(source: string, from: number, to: number, command: MarkdownCommandName, value?: unknown): MarkdownReplacement {
  ({ from, to } = bounds(source, from, to));
  const text = source.slice(from, to), eol = eolFor(source);
  const wrappers: Partial<Record<MarkdownCommandName, [string, string, string]>> = {
    bold: ['**', '**', '文字'], italic: ['*', '*', '文字'], strike: ['~~', '~~', '文字'], underline: ['<u>', '</u>', '文字'],
    highlight: ['==', '==', '文字'], sub: ['~', '~', '文字'], super: ['^', '^', '文字'],
  };
  if (wrappers[command]) return inline(source, from, to, ...wrappers[command]!);
  if (command === 'emoji') return replace(from, to, typeof value === 'string' ? value : '🙂');
  if (command === 'mathInline') return inline(source, from, to, '$', '$', 'a^2 + b^2 = c^2');
  if (command === 'mermaid' || command === 'sequence' || command === 'flow') return block(source, from, to, '```' + command + eol + (text || (command === 'sequence' ? 'Alice->Bob: Hello' + eol + 'Note right of Bob: A note' + eol + 'Bob-->Alice: Reply' : command === 'flow' ? 'st=>start: 开始' + eol + 'op=>operation: 操作' + eol + 'e=>end: 结束' + eol + 'st->op->e' : 'flowchart LR' + eol + '  A[开始] --> B[完成]')) + eol + '```');
  if (command === 'callout') { const kind = typeof value === 'string' && /^(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)$/i.test(value) ? value.toUpperCase() : 'NOTE'; return block(source, from, to, '> [!' + kind + ']' + eol + '> ' + (text || '提示内容').replace(/\r?\n/g, eol + '> ')); }
  if (command === 'codeLanguage') { const existing = fencedBlock(source, from, to, false); if (!existing) throw new Error('请把光标放入代码块，再选择代码语言。'); const language = typeof value === 'string' ? value : ''; if (language && !/^[\w.+#-]+$/.test(language)) throw new Error('代码语言只能使用单行语言标识。'); const indent = /^ */.exec(existing.opening.text)![0]; const opening = indent + existing.token + language; return { from: existing.opening.from, to: existing.opening.to, insert: opening, selection: { anchor: from + opening.length - existing.opening.text.length, head: to + opening.length - existing.opening.text.length } }; }
  if (command === 'code') {
    const whole = /^(\x60+)([\s\S]*?)\1$/.exec(text);
    if (whole && !whole[2].startsWith('`') && !whole[2].endsWith('`')) {
      const body = whole[2].startsWith(' ') && whole[2].endsWith(' ') && !!whole[2].trim() ? whole[2].slice(1, -1) : whole[2];
      return replace(from, to, body);
    }
    const before = /\x60+$/.exec(source.slice(0, from))?.[0], after = /^\x60+/.exec(source.slice(to))?.[0];
    if (before && before === after && !text.includes(before)) return replace(from - before.length, to + after!.length, text);
    const longest = Math.max(0, ...(text.match(/\x60+/g) ?? []).map(run => run.length)), token = '`'.repeat(longest + 1);
    const body = text || '代码', padded = body.startsWith('`') || body.endsWith('`') || body.startsWith(' ') && body.endsWith(' ') && !!body.trim() ? ' ' + body + ' ' : body;
    return replace(from, to, token + padded + token, token.length + (padded !== body ? 1 : 0), token.length + (padded !== body ? 1 : 0) + body.length);
  }
  if (command === 'link' || command === 'image') {
    const rawLabel = (text || (command === 'image' ? '图片说明' : '链接文字')).replace(/\r?\n/g, ' ');
    let label = '', backslashes = 0;
    for (const char of rawLabel) { label += /[\[\]]/.test(char) && backslashes % 2 === 0 ? '\\' + char : char; backslashes = char === '\\' ? backslashes + 1 : 0; }
    const lead = command === 'image' ? '![' : '[';
    const url = destination(value), insert = lead + label + '](' + url + ')';
    return replace(from, to, insert, value === undefined ? lead.length + label.length + 3 : lead.length, value === undefined ? lead.length + label.length + 3 + url.length - 2 : lead.length + label.length);
  }
  if (command === 'referenceLink') { let id = 1; while (source.includes('[link-' + id + ']')) id++; const label = (text || '链接文字').replace(/[\[\]\r\n]/g, ''), reference = '[link-' + id + ']', insert = '[' + label + ']' + reference + source.slice(to) + (source.endsWith('\n\n') ? '' : source.endsWith('\n') ? eol : eol + eol) + reference + ': ' + destination(value); return replace(from, source.length, insert, value === undefined ? insert.length - 9 : 1, value === undefined ? insert.length - 1 : label.length + 1); }
  if (command === 'clear') {
    const range = from === to ? lineRange(source, from, to) : { from, to, text };
    let insert = range.text.replace(/^ {0,3}#{1,6}[ \t]+/gm, '').replace(/^([ \t]*)(?:>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/gm, '$1');
    for (let pass = 0; pass < 3; pass++) insert = insert.replace(/(\*\*|__|~~|==)([^\r\n]+?)\1/g, '$2').replace(/(?<!\*)\*([^*\r\n]+)\*(?!\*)/g, '$1').replace(/(?<!_)_([^_\r\n]+)_(?!_)/g, '$1').replace(/<\/?(?:u|sub|sup)>/gi, '').replace(/\x60+([^\x60\r\n]+)\x60+/g, '$1');
    return replace(range.from, range.to, insert);
  }
  const heading = /^heading([0-6])$/.exec(command);
  if (heading || ['quote', 'bullet', 'ordered', 'task'].includes(command)) {
    const range = lineRange(source, from, to), rows = range.text.split(/\r?\n/);
    const marker = command === 'quote' ? /^ {0,3}>[ \t]?/ : command === 'task' ? /^\s*[-+*][ \t]+\[[ xX]\][ \t]+/ : command === 'ordered' ? /^\s*\d+[.)][ \t]+/ : /^\s*[-+*][ \t]+/;
    const remove = !heading && rows.filter(row => row.trim()).every(row => marker.test(row)); let number = 0;
    const insert = rows.map(row => {
      if (heading) return (Number(heading[1]) ? '#'.repeat(Number(heading[1])) + ' ' : '') + row.replace(/^ {0,3}#{1,6}[ \t]+/, '');
      if (!row.trim()) return row;
      if (remove) return row.replace(marker, '');
      if (command === 'quote') return '> ' + row;
      const indentation = /^[ \t]*/.exec(row)![0], body = row.slice(indentation.length).replace(/^(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '');
      return indentation + (command === 'ordered' ? ++number + '. ' : command === 'task' ? '- [ ] ' : '- ') + body;
    }).join(eol);
    return replace(range.from, range.to, insert);
  }
  if (command === 'codeBlock' || command === 'mathBlock') {
    const existing = fencedBlock(source, from, to, command === 'mathBlock');
    if (existing) return replace(existing.from, existing.to, existing.body);
    const range = from === to ? { from, to, text: '' } : lineRange(source, from, to), body = range.text || (command === 'mathBlock' ? 'a^2 + b^2 = c^2' : '代码');
    const longest = Math.max(2, ...(body.match(/\x60+/g) ?? []).map(run => run.length)), token = command === 'mathBlock' ? '$$' : '`'.repeat(longest + 1);
    const language = command === 'codeBlock' ? typeof value === 'string' ? value : typeof record(value).language === 'string' ? record(value).language as string : '' : '';
    if (language && !/^[\w.+#-]+$/.test(language)) throw new Error('代码语言只能使用单行语言标识。');
    const opening = token + language + eol;
    return block(source, range.from, range.to, opening + body + eol + token, opening.length, opening.length + body.length);
  }
  if (command.startsWith('table') && command !== 'table') return tableEdit(source, from, command, value);
  if (command === 'table') {
    const options = record(value), rows = positive(options.rows, 3), columns = positive(options.columns, 3);
    if (rows * columns > 10_000) throw new RangeError('一次插入的表格最多10000个单元格。');
    const table = { header: Array.from({ length: columns }, (_, i) => '列 ' + (i + 1)), rows: Array.from({ length: rows - 1 }, () => Array(columns).fill('')), align: Array(columns).fill(null) as MarkdownTableAlignment[], eol };
    return block(source, from, to, serializeMarkdownTable(table));
  }
  if (command === 'rule' || command === 'toc') return block(source, from, to, command === 'rule' ? '---' : '[TOC]');
  if (command === 'frontmatter') {
    const start = source.charCodeAt(0) === 0xfeff ? 1 : 0, rest = source.slice(start), match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?=\r?\n|$)/.exec(rest);
    if (match) {
      const bodyStart = match[0].indexOf('\n') + 1;
      return value === undefined ? replace(start, start + match[0].length, match[0], bodyStart, bodyStart + match[1].length) : replace(start, start + match[0].length, '---' + eol + String(value) + eol + '---');
    }
    const body = typeof value === 'string' ? value : 'title: ""', insert = '---' + eol + body + eol + '---' + eol + eol;
    return replace(start, start, insert, 3 + eol.length, 3 + eol.length + body.length);
  }
  if (command === 'footnote') {
    let id = 1; while (source.includes('[^' + id + ']')) id++;
    const reference = '[^' + id + ']', tail = source.slice(to), beforeDefinition = reference + tail;
    const separator = /(?:\r?\n){2}$/.test(beforeDefinition) ? '' : beforeDefinition.endsWith('\n') ? eol : eol + eol;
    const body = text || '脚注内容', definition = '[^' + id + ']: ' + body.replace(/\r?\n/g, eol + '    '), insert = beforeDefinition + separator + definition;
    const offset = beforeDefinition.length + separator.length + ('[^' + id + ']: ').length;
    return replace(from, source.length, insert, offset, insert.length);
  }
  throw new Error('不支持的 Markdown 命令：' + command);
}
