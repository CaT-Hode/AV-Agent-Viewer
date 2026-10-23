import type { SyntaxNode } from '@lezer/common';
import type { MarkdownConfig } from '@lezer/markdown';

export type MarkdownMathRange = { from: number; to: number; bodyFrom: number; bodyTo: number; block: boolean; parts: { from: number; to: number }[] };
/** Both projections use the parser's exact delimiter ranges, including escaped
 * TeX delimiters. An unfinished equation stays editable source. */
export function markdownMathRange(node: SyntaxNode): MarkdownMathRange | undefined {
  if (node.name !== 'InlineMath' && node.name !== 'BlockMath') return;
  const marks = node.getChildren('MathMark');
  if (marks.length !== 2) return;
  const text = node.getChildren('MathText'), bodyFrom = marks[0].to, bodyTo = marks[1].from;
  return { from: node.from, to: node.to, bodyFrom, bodyTo, block: node.name === 'BlockMath', parts: text.length ? text.map(part => ({ from: part.from, to: part.to })) : [{ from: bodyFrom, to: bodyTo }] };
}
function escaped(text: string, at: number) { let slash = at; while (slash > 0 && text.charCodeAt(slash - 1) === 92) slash--; return (at - slash) % 2 === 1; }
function blockStart(text: string) { return text.startsWith('$$') && text[2] !== '$' ? '$$' : text.startsWith('\\[') ? '\\[' : undefined; }
function blockClose(text: string, close: string, from = 0) {
  const end = text.trimEnd().length - close.length;
  return end >= from && text.slice(end, end + close.length) === close && !escaped(text, end) && (close !== '$$' || text[end - 1] !== '$') ? end : -1;
}
const inlineMathScans = new WeakMap<object, { end: number; dollar?: number; paren?: number }>();

/** Block extensions participate in Lezer's incremental tree, so headings and
 * syntax within TeX/YAML are not misclassified as ordinary Markdown. */
export const typoraMarkdownSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'BlockMath', block: true }, { name: 'InlineMath' }, { name: 'MathMark' }, { name: 'MathText' }, { name: 'Frontmatter', block: true }],
  parseBlock: [
    { name: 'BlockMath', before: 'FencedCode',
      parse(context, line) {
        const text = line.text.slice(line.pos), opening = blockStart(text);
        if (line.indent - line.baseIndent >= 4 || !opening) return false;
        const closing = opening === '$$' ? '$$' : '\\]', sameLine = blockClose(text, closing, 2);
        // Text after a same-line closing delimiter belongs to a paragraph.
        if (sameLine < 0 && text.slice(2).includes(closing)) return false;
        const from = context.lineStart + line.pos, marks = [context.elt('MathMark', from, from + 2)];
        if (sameLine >= 0) { marks.push(context.elt('MathText', from + 2, from + sameLine), context.elt('MathMark', from + sameLine, from + sameLine + 2)); context.nextLine(); }
        else {
          marks.push(context.elt('MathText', from + 2, context.lineStart + line.text.length));
          while (context.nextLine()) {
            const end = line.indent - line.baseIndent < 4 ? blockClose(line.text.slice(line.pos), closing) : -1;
            const start = context.lineStart + line.basePos;
            if (end >= 0) { const close = context.lineStart + line.pos + end; marks.push(context.elt('MathText', start, close), context.elt('MathMark', close, close + 2)); context.nextLine(); break; }
            marks.push(context.elt('MathText', start, context.lineStart + line.text.length));
          }
        }
        context.addElement(context.elt('BlockMath', from, context.prevLineEnd(), marks)); return true;
      },
      endLeaf: (_context, line) => line.indent - line.baseIndent < 4 && !!blockStart(line.text.slice(line.pos)),
    },
    { name: 'Frontmatter', before: 'HorizontalRule',
      parse(context, line) {
        if (context.lineStart !== 0 || !/^\uFEFF?---[ \t]*$/.test(line.text)) return false;
        while (context.nextLine()) if (/^(?:---|\.\.\.)[ \t]*$/.test(line.text)) { context.nextLine(); break; }
        context.addElement(context.elt('Frontmatter', 0, context.prevLineEnd())); return true;
      },
    },
  ],
  parseInline: [{ name: 'InlineMath', before: 'Escape', parse(context, next, position) {
    const dollar = next === 36, slash = next === 92 && context.char(position + 1) === 40;
    if (!dollar && !slash || dollar && (context.char(position - 1) === 36 || context.char(position + 1) === 36 || /\s/.test(context.slice(position + 1, position + 2)))) return -1;
    let scan = inlineMathScans.get(context);
    if (!scan || position >= scan.end) { const nextLine = context.text.indexOf('\n', position - context.offset); scan = { end: nextLine < 0 ? context.end : context.offset + nextLine }; inlineMathScans.set(context, scan); }
    const failure = dollar ? 'dollar' : 'paren';
    if (scan[failure] !== undefined && position >= scan[failure]!) return -1;
    const width = dollar ? 1 : 2, begin = position + width, end = scan.end;
    let close = begin;
    while (close < end) {
      close = context.text.indexOf(dollar ? '$' : '\\)', close - context.offset);
      if (close < 0) { scan[failure] = position; return -1; }
      close += context.offset;
      if (close >= end) { scan[failure] = position; return -1; }
      if (!escaped(context.text, close - context.offset) && close > begin && (!dollar || context.char(close - 1) !== 36 && context.char(close + 1) !== 36 && !/\s/.test(context.slice(close - 1, close)) && !(context.char(close + 1) >= 48 && context.char(close + 1) <= 57))) {
        return context.addElement(context.elt('InlineMath', position, close + width, [context.elt('MathMark', position, begin), context.elt('MathMark', close, close + width)]));
      }
      close += width;
    }
    scan[failure] = position; return -1;
  } }],
};
