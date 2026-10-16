import { Table, type BlockParser, type DelimiterType, type InlineParser, type MarkdownConfig } from '@lezer/markdown';
import { classifyCharacter } from 'micromark-util-classify-character';
import { typoraMarkdownSyntax as blocks } from '../../../../../packages/markdown/src/syntax';

// Plain text contributes no inline nodes. Jump over it in one native regex
// scan instead of calling every Markdown/GFM token parser for each code unit.
// Keep every CommonMark/GFM trigger, including bare URL prefixes and possible
// email starts before @; the original parser still decides their semantics.
const tokens = /[\\&`<*_!\[\]~@=^]| {2,}\n|www\.|https?:\/\/|mailto:|xmpp:/g;
const longTokens = /[\\&`<*_!\[\]~@=^\n]/g;
const urlTokens = /www\.|https?:\/\/|mailto:|xmpp:/g;
const urlPositions = new WeakMap<object, number>();
const emailPositions = new WeakMap<object, number>();
function inlineDelimiter(name: 'Highlight' | 'Subscript' | 'Superscript', marker: number, width: number): InlineParser {
  const type: DelimiterType = {};
  return { name: 'Typora' + name, before: 'Escape', parse(context, next, position) {
    if (next !== marker || context.char(position - 1) === marker || context.char(position + width) === marker) return -1;
    for (let index = 1; index < width; index++) if (context.char(position + index) !== marker) return -1;
    const before = context.char(position - 1), after = context.char(position + width);
    const beforeClass = classifyCharacter(before < 0 ? null : before), afterClass = classifyCharacter(after < 0 ? null : after);
    const close = beforeClass !== 1 && (beforeClass !== 2 || afterClass === 1 || afterClass === 2);
    const opening = close ? context.findOpeningDelimiter(type) : null, previous = opening === null ? null : context.getDelimiterAt(opening);
    if (opening !== null && previous && previous.to < position && !context.slice(previous.to, position).includes('\n')) {
      const content = context.takeContent(opening);
      return context.addElement(context.elt(name, previous.from, position + width, [context.elt(name + 'Mark', previous.from, previous.to), ...content, context.elt(name + 'Mark', position, position + width)]));
    }
    const open = afterClass !== 1 && (afterClass !== 2 || beforeClass === 1 || beforeClass === 2);
    return context.addDelimiter(type, position, position + width, open, false);
  } };
}
export const typoraMarkdownSyntax: MarkdownConfig = {
  ...blocks,
  defineNodes: [...(blocks.defineNodes ?? []), ...['Highlight', 'Subscript', 'Superscript'].flatMap(name => [name, name + 'Mark'])],
  // GFM's hasPipe checks every UTF-16 unit in JavaScript even for a plain
  // multi-megabyte paragraph. Rule out the impossible case with the engine's
  // native string search, then retain the original escape/table semantics.
  parseBlock: [...(blocks.parseBlock ?? []), ...Table.parseBlock!.map((parser): BlockParser => ({
    ...parser,
    leaf: (context, leaf) => leaf.content.includes('|') ? parser.leaf!(context, leaf) : null,
    endLeaf: (context, line, leaf) => line.text.indexOf('|', line.basePos) >= 0 && parser.endLeaf!(context, line, leaf),
  }))],
  parseInline: [{ name: 'PlainTextRun', before: 'Escape', parse(context, _next, position) {
    const from = position - context.offset; let end: number;
    if (context.text.length < 64 * 1024) {
      tokens.lastIndex = from; end = tokens.exec(context.text)?.index ?? context.text.length;
    } else {
      // Keep the short-paragraph path unchanged. On giant leaves, separate
      // character scanning from URL alternatives and cache an absent URL.
      longTokens.lastIndex = from; end = longTokens.exec(context.text)?.index ?? context.text.length;
      // Stopping at a newline must leave the entire preceding space run for
      // the original HardBreak parser, including its exact source range.
      if (context.text.charCodeAt(end) === 10 && context.text.charCodeAt(end - 1) === 32 && context.text.charCodeAt(end - 2) === 32) {
        while (end > from && context.text.charCodeAt(end - 1) === 32) end--;
      }
      let url = urlPositions.get(context);
      if (url === undefined || url >= 0 && url < from) { urlTokens.lastIndex = from; url = urlTokens.exec(context.text)?.index ?? -1; urlPositions.set(context, url); }
      if (url >= 0) end = Math.min(end, url);
    }
    // GFM starts a bare email at its local part, up to 100 characters before
    // @. Leave that bounded prefix to its existing parser, including malformed
    // addresses and its exact preceding-character rule.
    let email = emailPositions.get(context);
    if (email === undefined || email >= 0 && email < from) { email = context.text.indexOf('@', from); emailPositions.set(context, email); }
    // An underscore or another Markdown trigger may be inside the email's
    // local part, so find @ independently of the next syntax punctuation.
    if (email >= 0) end = Math.min(end, Math.max(from, email - 100));
    return end > from ? context.offset + end : -1;
  } }, inlineDelimiter('Highlight', 61, 2), inlineDelimiter('Subscript', 126, 1), inlineDelimiter('Superscript', 94, 1)],
};
