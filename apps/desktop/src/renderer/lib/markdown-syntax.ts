import type { MarkdownConfig } from '@lezer/markdown';
import { typoraMarkdownSyntax as blocks } from '../../../../../packages/markdown/src/syntax';

// Plain text contributes no inline nodes. Jump over it in one native regex
// scan instead of calling every Markdown/GFM token parser for each code unit.
// Keep every CommonMark/GFM trigger, including bare URL prefixes and possible
// email starts before @; the original parser still decides their semantics.
const tokens = /[\\&`<*_!\[\]~@]| {2,}\n|www\.|https?:\/\/|mailto:|xmpp:/g;
const emailPositions = new WeakMap<object, number>();
export const typoraMarkdownSyntax: MarkdownConfig = {
  ...blocks,
  parseInline: [{ name: 'PlainTextRun', before: 'Escape', parse(context, _next, position) {
    const from = position - context.offset; tokens.lastIndex = from;
    const token = tokens.exec(context.text); let end = token?.index ?? context.text.length;
    // GFM starts a bare email at its local part, up to 100 characters before
    // @. Leave that bounded prefix to its existing parser, including malformed
    // addresses and its exact preceding-character rule.
    let email = emailPositions.get(context);
    if (email === undefined || email >= 0 && email < from) { email = context.text.indexOf('@', from); emailPositions.set(context, email); }
    // An underscore or another Markdown trigger may be inside the email's
    // local part, so find @ independently of the next syntax punctuation.
    if (email >= 0) end = Math.min(end, Math.max(from, email - 100));
    return end > from ? context.offset + end : -1;
  } }],
};
