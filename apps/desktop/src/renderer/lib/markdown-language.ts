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

function lineBoundaryFragment(fragment: TreeFragment, input: Input): TreeFragment | undefined {
  const end = Math.min(fragment.to, input.length), smallStart = Math.max(0, end - 256);
  const small = input.read(smallStart, end), last = small.lastIndexOf('\n');
  let boundary = last < 0 ? -1 : smallStart + last + 1;
  if (boundary < 0 && smallStart > 0) {
    const start = Math.max(0, end - fragmentLineBudget);
    const previous = input.read(start, smallStart).lastIndexOf('\n');
    if (previous >= 0) boundary = start + previous + 1;
    else if (start > 0) {
      // A huge final paragraph cannot be reused, but the earlier complete
      // blocks can. The old tree locates that block without copying/scanning
      // its multi-megabyte line. Confirm the real input still has its boundary.
      let block = fragment.tree.resolveInner(end + fragment.offset, -1);
      while (block.parent?.parent) block = block.parent;
      const from = block.from - fragment.offset;
      if (from > fragment.from && from <= end && input.read(from - 1, from) === '\n') boundary = from;
    }
  }
  if (boundary <= fragment.from) return undefined;
  // FragmentCursor itself discards everything after this same last newline.
  // Shortening only that unusable tail preserves its reuse limit, while its
  // backwards search now performs a single read rather than one per character.
  return boundary === fragment.to ? fragment : new TreeFragment(fragment.from, boundary, fragment.tree, fragment.offset, fragment.openStart, fragment.openEnd);
}

/** Lezer Markdown searches backwards from each reused fragment's end one
 * character at a time to find a line boundary. A changed multi-megabyte line
 * cannot reuse its paragraph, but that search still performs millions of rope
 * reads. Trim unusable line tails and preserve safe earlier blocks; the original
 * parser then reparses the changed blocks with the same grammar/mixed parsers. */
export class BoundedMarkdownParser extends Parser {
  constructor(private readonly inner: Parser) { super(); }

  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    const reusable = fragments.flatMap(fragment => {
      const startSafe = codeIndentationFragment(fragment);
      const contextSafe = startSafe && tableContextFragment(startSafe, input);
      const safe = contextSafe && lineBoundaryFragment(contextSafe, input); return safe ? [safe] : [];
    });
    return this.inner.startParse(input, reusable, ranges);
  }
}

/** Wrap the fully configured Markdown language, preserving language data,
 * keymaps, HTML completion and nested code languages through public APIs. */
export function boundedMarkdownLanguage(support: LanguageSupport): LanguageSupport {
  return new LanguageSupport(new Language(support.language.data, new BoundedMarkdownParser(support.language.parser), [], support.language.name), support.support);
}
