import { serializeMarkdownTable } from '../../../../../packages/markdown/src/commands';
import TurndownService from 'turndown';
import { gfm as pasteGfm } from 'turndown-plugin-gfm';
import DOMPurify from 'dompurify';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import type { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';

const converter = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
converter.use(pasteGfm);
converter.addRule('documentTable', {
  filter: 'table',
  replacement(_content, node) {
    const table = node as HTMLTableElement;
    const rows = [...table.rows];
    if (!rows.length) return '';
    const cells = rows.map(row => [...row.cells]);
    const width = cells[0].length;
    // A pipe table cannot encode merged cells or a nested table. The input
    // has already been sanitized, and HTML retains that structure in Markdown.
    if (!width || table.querySelector('table') || cells.some(row => row.length !== width || row.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1))) {
      return '\n\n' + table.outerHTML + '\n\n';
    }
    const hasHeader = rows[0].parentElement?.tagName === 'THEAD' || cells[0].every(cell => cell.tagName === 'TH');
    const values = cells.map(row => row.map(cell => converter.turndown(cell.innerHTML).trim()));
    const header = hasHeader ? values.shift()! : Array<string>(width).fill('');
    const align = cells[0].map(cell => {
      const value = cell.style.textAlign || cell.getAttribute('align');
      return value === 'left' || value === 'center' || value === 'right' ? value : null;
    });
    return '\n\n' + serializeMarkdownTable({header,rows:values,align}) + '\n\n';
  },
});
converter.addRule('styledText', {
  filter: 'span',
  replacement(content, node) {
    const style = (node as HTMLElement).style;
    if (!content.trim()) return content;
    if (style.fontStyle === 'italic') content = '*' + content + '*';
    if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600) content = '**' + content + '**';
    if (style.textDecoration.includes('line-through')) content = '~~' + content + '~~';
    return content;
  },
});
converter.addRule('inlineTags', {
  filter: ['u', 'sub', 'sup', 'mark', 'kbd'],
  replacement(content, node) {
    const tag = node.nodeName.toLowerCase();
    return '<' + tag + '>' + content + '</' + tag + '>';
  },
});

export function pasteMarkdown(event: ClipboardEvent, view: EditorView, plain: boolean) {
  const data = event.clipboardData;
  if (!data || view.state.readOnly || view.compositionStarted) return false;
  const markdown = !plain && data.getData('text/markdown');
  const html = !plain && !markdown && data.getData('text/html');
  if (!plain && !markdown && !html) return false;
  const text =
    markdown ||
    (html
      ? converter
          .turndown(DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script', 'iframe', 'object'] }))
          .trim()
      : data.getData('text/plain'));
  if (!text) return false;
  view.dispatch(view.state.replaceSelection(text.replace(/\r\n?/g, '\n')), {
    userEvent: 'input.paste',
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  });
  return true;
}

export function copyMarkdown(event: ClipboardEvent, view: EditorView, sourceOnly: boolean, eol: string) {
  if (!event.clipboardData || view.state.selection.main.empty) return false;
  const source = view.state.selection.ranges
    .map((range) => view.state.doc.sliceString(range.from, range.to, eol))
    .join(eol);
  event.clipboardData.setData('text/markdown', source);
  if (sourceOnly) event.clipboardData.setData('text/plain', source);
  else {
    const html = micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    for (const br of body.querySelectorAll('br')) br.replaceWith('\n');
    event.clipboardData.setData('text/plain', (body.textContent || source).replace(/\r?\n/g, eol));
    event.clipboardData.setData('text/html', html);
  }
  return true;
}
