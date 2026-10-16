import { Language, LanguageSupport } from '@codemirror/language';
import { Parser, type Input, type PartialParse, type TreeFragment } from '@lezer/common';

const fragmentLineBudget = 64 * 1024;

/** Lezer Markdown searches backwards from each reused fragment's end one
 * character at a time to find a line boundary. A changed multi-megabyte line
 * cannot reuse its paragraph, but that search still performs millions of rope
 * reads. Discard only fragments with an unbounded trailing line; the original
 * parser then reparses them with exactly the same grammar and mixed parsers. */
export class BoundedMarkdownParser extends Parser {
  constructor(private readonly inner: Parser) { super(); }

  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    const reusable = fragments.filter(fragment => {
      const end = Math.min(fragment.to, input.length);
      if (end <= fragmentLineBudget) return true;
      // Normal lines need only a small read. No newline in the bounded tail
      // means reuse would trigger the upstream per-character backwards scan.
      return input.read(Math.max(0, end - 256), end).includes('\n')
        || input.read(end - fragmentLineBudget, end).includes('\n');
    });
    return this.inner.startParse(input, reusable, ranges);
  }
}

/** Wrap the fully configured Markdown language, preserving language data,
 * keymaps, HTML completion and nested code languages through public APIs. */
export function boundedMarkdownLanguage(support: LanguageSupport): LanguageSupport {
  return new LanguageSupport(new Language(support.language.data, new BoundedMarkdownParser(support.language.parser), [], support.language.name), support.support);
}
