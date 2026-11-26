import type { SyntaxNode } from '@lezer/common';
import { mappedPreviewText } from './markdown-surfaces';

const tags: Record<string, string> = {
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  Strikethrough: 'del',
  InlineCode: 'code',
  Highlight: 'mark',
  Subscript: 'sub',
  Superscript: 'sup',
};
/** Each visible fragment uses the offsets of the existing TableCell syntax
 * node. Split-view selections still resolve across hidden inline delimiters. */
export function tableCellText(
  cell: HTMLElement,
  root: HTMLElement,
  raw: string,
  start: number,
  at: SyntaxNode,
  base: number
) {
  let node: SyntaxNode | null = at;
  while (node && node.name !== 'TableCell') node = node.parent;
  if (!node?.firstChild) {
    mappedPreviewText(cell, root, raw, start, true);
    return;
  }
  function append(parent: HTMLElement, from: number, to: number) {
    if (to <= from) return;
    const span = document.createElement('span');
    mappedPreviewText(span, root, raw.slice(from - base, to - base), start + from - base, true);
    parent.append(span);
  }
  function visit(parent: HTMLElement, container: SyntaxNode, from: number, to: number) {
    let cursor = from;
    for (let child = container.firstChild; child; child = child.nextSibling) {
      if (child.from < from || child.to > to) continue;
      append(parent, cursor, child.from);
      cursor = child.to;
      const tag = tags[child.name],
        first = child.firstChild,
        last = child.lastChild;
      if (tag && first?.name.endsWith('Mark') && last?.name.endsWith('Mark')) {
        const inner = document.createElement(tag);
        if (tag === 'code') inner.className = 'md-inline-code';
        visit(inner, child, first.to, last.from);
        parent.append(inner);
      } else if (child.name === 'Link' && child.getChild('URL') && child.getChildren('LinkMark').length >= 3) {
        const link = document.createElement('span'),
          marks = child.getChildren('LinkMark'),
          url = child.getChild('URL')!;
        link.className = 'md-link';
        link.dataset.markdownLink = raw.slice(url.from - base, url.to - base);
        visit(link, child, marks[0].to, marks[1].from);
        parent.append(link);
      } else append(parent, child.from, child.to);
    }
    append(parent, cursor, to);
  }
  visit(cell, node, base, base + raw.length);
}
