import { parser } from '@lezer/markdown';
import { GFM } from '@lezer/markdown';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { typoraMarkdownSyntax } from './syntax';

export type MarkdownLink = { source: string; from: number; to: number; image: boolean; context: 'markdown' | 'html' };
const grammar = parser.configure([GFM, typoraMarkdownSyntax]);
const label = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/** Parse source ranges, so code examples and unrelated prose stay untouched. */
export function markdownLinks(source: string): MarkdownLink[] {
  const links: MarkdownLink[] = [], imageLabels = new Set<string>(), definitions = new Map<string, MarkdownLink>(), htmlRanges: { from: number; to: number }[] = [];
  grammar.parse(source).iterate({ enter: node => {
    if (node.name === 'Image' || node.name === 'Link' || node.name === 'LinkReference') {
      const url = node.node.getChild('URL'), reference = node.node.getChild('LinkLabel');
      if (node.name === 'Image' && !url) {
        const alt = node.node.getChildren('LinkMark');
        imageLabels.add(label(reference ? source.slice(reference.from + 1, reference.to - 1) : source.slice((alt[0]?.to ?? node.from + 2), alt[1]?.from ?? node.to - 1)));
      }
      if (!url) return;
      const raw = source.slice(url.from, url.to), entry: MarkdownLink = { source: raw.replace(/^<|>$/g, '').replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, '$1'), from: url.from, to: url.to, image: node.name === 'Image', context: 'markdown' };
      links.push(entry);
      if (node.name === 'LinkReference' && reference) definitions.set(label(source.slice(reference.from + 1, reference.to - 1)), entry);
    } else if (node.name === 'HTMLBlock' || node.name === 'HTMLTag') {
      htmlRanges.push({ from: node.from, to: node.to });
      return false;
    }
  } });
  if (htmlRanges.length) {
    // Markdown may expose the open/close tags and apparent tags inside a script
    // as separate nodes. Parse them together to retain HTML raw-text/comment
    // context. Mask all non-HTML source, retaining UTF-16 offsets, so examples
    // in Markdown fences and escaped tags cannot open spurious HTML contexts.
    let position = 0, html = '';
    for (const range of htmlRanges) { if (range.from < position) continue; html += ' '.repeat(range.from - position) + source.slice(range.from, range.to); position = range.to; }
    const walk = (element: DefaultTreeAdapterMap['node']) => {
      if ('tagName' in element) {
        if (['script', 'style', 'textarea', 'pre', 'code', 'template'].includes(element.tagName)) return;
        if (['img', 'a'].includes(element.tagName)) {
          const attribute = element.tagName === 'img' ? 'src' : 'href', value = element.attrs.find(item => item.name === attribute), location = element.sourceCodeLocation?.attrs?.[attribute];
          if (value && location) {
            const raw = html.slice(location.startOffset, location.endOffset), equal = raw.indexOf('=');
            if (equal >= 0) { let start = equal + 1; while (/\s/.test(raw[start] ?? '') && start < raw.length) start++; const quoted = raw[start] === '"' || raw[start] === "'", from = location.startOffset + start + (quoted ? 1 : 0), to = location.endOffset - (quoted ? 1 : 0); links.push({ source: value.value, from, to, image: attribute === 'src', context: 'html' }); }
          }
        }
      }
      if ('childNodes' in element) for (const child of element.childNodes) walk(child);
    };
    walk(parseFragment(html, { sourceCodeLocationInfo: true }));
  }
  for (const key of imageLabels) { const definition = definitions.get(key); if (definition) definition.image = true; }
  return links.sort((a, b) => a.from - b.from);
}

/** Return replacement text for the original source context, including brackets. */
export function encodeMarkdownLink(value: string, link: Pick<MarkdownLink, 'context'>): string {
  if (link.context === 'html') return value.replace(/[&<>"'`=\s]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;' }[char] ?? `&#${char.charCodeAt(0)};`));
  return '<' + value.replace(/[\u0000-\u0020<>"\\]/g, char => encodeURIComponent(char)) + '>';
}

export function replaceMarkdownLinks(source: string, replacements: { link: MarkdownLink; value: string }[]): string {
  let result = source;
  for (const { link, value } of replacements.slice().sort((a, b) => b.link.from - a.link.from)) result = result.slice(0, link.from) + encodeMarkdownLink(value, link) + result.slice(link.to);
  return result;
}
