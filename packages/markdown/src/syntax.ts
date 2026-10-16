import type { MarkdownConfig } from '@lezer/markdown';

/** Block extensions participate in Lezer's incremental tree, so headings and
 * syntax within TeX/YAML are not misclassified as ordinary Markdown. */
export const typoraMarkdownSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'BlockMath', block: true }, { name: 'MathMark' }, { name: 'Frontmatter', block: true }],
  parseBlock: [
    { name: 'BlockMath', before: 'FencedCode',
      parse(context, line) {
        if (line.indent - line.baseIndent >= 4 || !/^\$\$[ \t]*$/.test(line.text.slice(line.pos))) return false;
        const from = context.lineStart + line.pos, marks = [context.elt('MathMark', from, from + 2)];
        while (context.nextLine()) { if (line.indent - line.baseIndent < 4 && /^\$\$[ \t]*$/.test(line.text.slice(line.pos))) { const start = context.lineStart + line.pos; marks.push(context.elt('MathMark', start, start + 2)); context.nextLine(); break; } }
        context.addElement(context.elt('BlockMath', from, context.prevLineEnd(), marks)); return true;
      },
      endLeaf: (_context, line) => line.indent - line.baseIndent < 4 && /^\$\$[ \t]*$/.test(line.text.slice(line.pos)),
    },
    { name: 'Frontmatter', before: 'HorizontalRule',
      parse(context, line) {
        if (context.lineStart !== 0 || !/^\uFEFF?---[ \t]*$/.test(line.text)) return false;
        while (context.nextLine()) if (/^(?:---|\.\.\.)[ \t]*$/.test(line.text)) { context.nextLine(); break; }
        context.addElement(context.elt('Frontmatter', 0, context.prevLineEnd())); return true;
      },
    },
  ],
};
