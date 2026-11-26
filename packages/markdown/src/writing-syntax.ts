import { GFM, parser, type MarkdownConfig, type Element } from '@lezer/markdown';

export function headingSlug(label: string) {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}
export function wikiLinkParts(raw: string) {
  const match = /^\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n|]+))?\]\]$/.exec(raw);
  if (!match) return;
  const target = match[1].trim(),
    split = target.indexOf('#');
  let path = split < 0 ? target : target.slice(0, split).trim();
  const anchor = split < 0 ? '' : headingSlug(target.slice(split + 1));
  if ((!path && !anchor) || /^(?:[a-z][\w+.-]*:|[\\/])|[\u0000-\u001f<>]/i.test(path)) return;
  path = path.replaceAll('\\', '/');
  if (path && !/\.[^./]+$/.test(path)) path += '.md';
  const label = (match[2] ?? match[1]).trim();
  if (!label) return;
  const start = (match[2] ? raw.indexOf('|') + 1 : 2) + (match[2] ?? match[1]).indexOf(label);
  return {
    href: path.split('/').map(encodeURIComponent).join('/') + (anchor ? '#' + encodeURIComponent(anchor) : ''),
    label,
    start,
    end: start + label.length,
  };
}
export function citationKeys(raw: string) {
  const group = raw.slice(1, -1).split(';');
  const keys: string[] = [];
  for (const item of group) {
    const key = /^\s*-?@([\p{L}\p{N}_][\p{L}\p{N}_.:+/-]*)(?:\s*,[^;\]\n]+)?\s*$/u.exec(item);
    if (!key) return [];
    keys.push(key[1]);
  }
  return keys;
}
export const writingSyntax: MarkdownConfig = {
  defineNodes: [
    'WikiLink',
    'Citation',
    { name: 'DefinitionList', block: true },
    'DefinitionTerm',
    'DefinitionBody',
    'DefinitionMark',
  ],
  parseInline: [
    {
      name: 'WritingReference',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91) return -1;
        const wiki = cx.char(pos + 1) === 91;
        if (!wiki && cx.char(pos + 1) !== 64 && !(cx.char(pos + 1) === 45 && cx.char(pos + 2) === 64)) return -1;
        const candidate = cx.slice(pos, Math.min(cx.end, pos + 1024)),
          stop = wiki ? ']]' : ']';
        const end = candidate.indexOf(stop, 2);
        if (
          end < 0 ||
          candidate.slice(0, end).includes('\n') ||
          [40, 91, 58].includes(cx.char(pos + end + stop.length))
        )
          return -1;
        const raw = candidate.slice(0, end + stop.length);
        if (wiki ? !wikiLinkParts(raw) : !citationKeys(raw).length) return -1;
        return cx.addElement(cx.elt(wiki ? 'WikiLink' : 'Citation', pos, pos + raw.length));
      },
    },
  ],
  parseBlock: [
    {
      name: 'DefinitionList',
      before: 'SetextHeading',
      leaf(_cx, leaf) {
        if (leaf.content.length > 2048) return null;
        return {
          finish: () => false,
          nextLine(cx, line, current) {
            if (current.content.includes('\n') || !/^:[ \t]+/.test(line.text.slice(line.pos))) return false;
            const parts: Element[] = [
              cx.elt(
                'DefinitionTerm',
                current.start,
                current.start + current.content.length,
                cx.parser.parseInline(current.content, current.start)
              ),
            ];
            do {
              const prefix = /^:[ \t]+/.exec(line.text.slice(line.pos));
              if (!prefix) break;
              const from = cx.lineStart + line.pos,
                body = from + prefix[0].length,
                end = cx.lineStart + line.text.length;
              parts.push(
                cx.elt('DefinitionBody', from, end, [
                  cx.elt('DefinitionMark', from, body),
                  ...cx.parser.parseInline(line.text.slice(line.pos + prefix[0].length), body),
                ])
              );
            } while (cx.nextLine());
            cx.addLeafElement(current, cx.elt('DefinitionList', current.start, cx.prevLineEnd(), parts));
            return true;
          },
        };
      },
    },
  ],
};

export type ReferenceOccurrence = { from: number; to: number; raw: string; keys: string[] };
/** Export uses parser ranges so quoted examples, raw HTML and formulas pass through. */
export function writingReferences(source: string, extensions: MarkdownConfig) {
  const citations: ReferenceOccurrence[] = [],
    links: { from: number; to: number; text: string }[] = [];
  if (!/\[\[|\[-?@/.test(source)) return { citations, links };
  parser
    .configure([GFM, extensions])
    .parse(source)
    .iterate({
      enter: (node) => {
        if (
          [
            'InlineCode',
            'CodeBlock',
            'FencedCode',
            'HTMLBlock',
            'Frontmatter',
            'InlineMath',
            'BlockMath',
            'Link',
            'Image',
          ].includes(node.name)
        )
          return false;
        if (node.name !== 'WikiLink' && node.name !== 'Citation') return;
        const raw = source.slice(node.from, node.to);
        if (node.name === 'Citation')
          citations.push({ from: node.from, to: node.to, raw, keys: citationKeys(raw) });
        else {
          const link = wikiLinkParts(raw);
          if (link)
            links.push({
              from: node.from,
              to: node.to,
              text: '[' + link.label.replace(/[\\`*_~[\]<>]/g, '\\$&') + '](<' + link.href + '>)',
            });
        }
        return false;
      },
    });
  return { citations, links };
}
