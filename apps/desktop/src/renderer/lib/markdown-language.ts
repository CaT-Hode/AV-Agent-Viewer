import { Language, LanguageSupport } from '@codemirror/language';
import { Parser, TreeFragment, type Input, type PartialParse, type SyntaxNode } from '@lezer/common';

const fragmentLineBudget = 64 * 1024;

function codeIndentationFragment(fragment: TreeFragment): TreeFragment | undefined {
  if (!fragment.openStart) return fragment;
  const first = fragment.tree.topNode.childAfter(fragment.from + fragment.offset);
  if (first?.name !== 'CodeBlock' || first.from - fragment.offset < fragment.from) return fragment;
  // A code block starts after its indentation. Editing only those spaces can
  // leave its unchanged CodeText fully inside an open fragment, even though
  // the new line is a paragraph. Reparse that first block, keeping later nodes.
  const start = first.to - fragment.offset;
  return start >= fragment.to ? undefined : new TreeFragment(start, fragment.to, fragment.tree, fragment.offset, true, fragment.openEnd);
}

function tableContextFragment(fragment: TreeFragment, input: Input): TreeFragment | undefined {
  if (!fragment.openEnd) return fragment;
  // Invalidating a GFM separator can turn the entire old table into a lazy
  // continuation of the paragraph/list/quote immediately before it. Upstream
  // otherwise reuses that preceding block with its obsolete ending position.
  let table: SyntaxNode | undefined;
  for (const side of [-1, 1] as const) {
    let node = fragment.tree.resolveInner(fragment.to + fragment.offset, side);
    while (node.parent) { if (node.name === 'TableDelimiter' && node.parent.name === 'Table') { table = node.parent; break; } node = node.parent; }
    if (table) break;
  }
  const previous = table?.prevSibling;
  if (!table || !previous || !['Paragraph', 'Blockquote', 'BulletList', 'OrderedList'].includes(previous.name)) return fragment;
  const gapFrom = previous.to - fragment.offset, gapTo = table.from - fragment.offset;
  if (gapTo - gapFrom > fragmentLineBudget || /\n[ \t]*\n/.test(input.read(Math.max(0, gapFrom), Math.max(0, gapTo)))) return fragment;
  const end = previous.from - fragment.offset;
  return end <= fragment.from ? undefined : new TreeFragment(fragment.from, end, fragment.tree, fragment.offset, fragment.openStart, true);
}

/** Lezer Markdown searches backwards from each reused fragment's end one
 * character at a time to find a line boundary. A changed multi-megabyte line
 * cannot reuse its paragraph, but that search still performs millions of rope
 * reads. Discard only fragments with an unbounded trailing line; the original
 * parser then reparses them with exactly the same grammar and mixed parsers. */
export class BoundedMarkdownParser extends Parser {
  constructor(private readonly inner: Parser) { super(); }

  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    const reusable = fragments.flatMap(fragment => {
      const end = Math.min(fragment.to, input.length);
      if (end > fragmentLineBudget && !input.read(Math.max(0, end - 256), end).includes('\n') && !input.read(end - fragmentLineBudget, end).includes('\n')) return [];
      // Normal lines need only a small read. No newline in the bounded tail
      // means reuse would trigger the upstream per-character backwards scan.
      const startSafe = codeIndentationFragment(fragment);
      const safe = startSafe && tableContextFragment(startSafe, input); return safe ? [safe] : [];
    });
    return this.inner.startParse(input, reusable, ranges);
  }
}

/** Wrap the fully configured Markdown language, preserving language data,
 * keymaps, HTML completion and nested code languages through public APIs. */
export function boundedMarkdownLanguage(support: LanguageSupport): LanguageSupport {
  return new LanguageSupport(new Language(support.language.data, new BoundedMarkdownParser(support.language.parser), [], support.language.name), support.support);
}
