import { EditorState, StateEffect, StateField, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { parseMarkdownTable, serializeMarkdownTable } from '../../../../../packages/markdown/src/commands';
import { renderMarkdownDiagram, renderMarkdownFormula } from './markdown-renderers';
import { call } from './transport';
import DOMPurify from 'dompurify';
import { loadMarkdownEmoji, markdownEmoji } from './markdown-emoji';
import { mappedPreviewText } from './markdown-surfaces';

export const refreshMarkdownPreview = StateEffect.define<null>();
export const revealMarkdownBlock = StateEffect.define<{ from: number; to: number } | null>();
const previewViewport = StateEffect.define<{ from: number; to: number }>();
// Pointer selection is interpreted against the already painted projection.
// Revealing delimiters partway through a drag moves its remaining hit targets.
const pointerSelection = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) { return transaction.selection ? transaction.isUserEvent('select.pointer') : transaction.docChanged ? false : value; },
});
type Span = { from: number; to: number };
const buffer = 2500;

function mergeSpans(spans: Span[]): Span[] {
  const result: Span[] = [];
  for (const span of spans.sort((a, b) => a.from - b.from)) {
    const previous = result.at(-1);
    if (previous && previous.to >= span.from) previous.to = Math.max(previous.to, span.to);
    else result.push({ ...span });
  }
  return result;
}
/** Lezer already incrementally reparses Markdown. Limit work to the top-level
 * blocks affected by this transaction and the visible window. A giant paragraph
 * or code block must not turn a cursor move into a full-document string copy. */
function affectedBlocks(state: EditorState, spans: Span[], viewport: Span) {
  return mergeSpans(spans.flatMap(span => {
    if (span.to < viewport.from || span.from > viewport.to) return [];
    const from = Math.max(viewport.from, span.from), to = Math.min(viewport.to, span.to);
    const enclosing = (position: number, side: -1 | 1) => {
      let node = syntaxTree(state).resolveInner(position, side);
      while (node.parent && node.parent.name !== 'Document') node = node.parent;
      return node;
    };
    const first = enclosing(from, 1), last = enclosing(to, -1);
    return [{ from: Math.max(viewport.from, state.doc.lineAt(Math.max(viewport.from, Math.min(from, first.from))).from),
      to: Math.min(viewport.to, state.doc.lineAt(Math.min(viewport.to, Math.max(to, last.to))).to) }];
  }));
}

function selected(state: EditorState, from: number, to: number) {
  if (state.facet(EditorState.readOnly)) return false;
  return state.selection.ranges.some(range => range.empty ? range.head >= from && range.head <= to : range.from < to && range.to > from);
}
/** Editing visible inline text must not insert source delimiters before the
 * clicked glyph. Reveal syntax when the caret enters a delimiter, or a source
 * selection includes one; the interior remains stable for clicks and drags. */
function syntaxSelected(state: EditorState, from: number, to: number, contentFrom: number, contentTo: number) {
  if (state.facet(EditorState.readOnly) || state.field(pointerSelection, false)) return false;
  return state.selection.ranges.some(range => range.empty
    ? range.head >= from && range.head < contentFrom || range.head > contentTo && range.head <= to
    : range.from < contentFrom && range.to > from || range.from < to && range.to > contentTo);
}
function editBlock(view: EditorView, position: number) {
  view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus();
}
function preventWidgetSelection(event: MouseEvent) { event.preventDefault(); }

/** CodeMirror measures each block's border box. Keep vertical margins inside
 * a formatting context so its height map matches the pixels used by the mouse. */
function measuredBlock(content: HTMLElement) {
  const block = document.createElement('div'); block.className = 'md-measured-block'; block.append(content); return block;
}

class PrefixWidget extends WidgetType {
  constructor(readonly text: string, readonly checked?: boolean, readonly position = 0) { super(); }
  eq(other: PrefixWidget) { return this.text === other.text && this.checked === other.checked && this.position === other.position; }
  toDOM(view: EditorView) {
    if (this.checked !== undefined) {
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked;
      input.disabled = view.state.facet(EditorState.readOnly);
      input.className = 'md-task-checkbox'; input.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为已完成');
      input.addEventListener('mousedown', preventWidgetSelection);
      input.addEventListener('change', () => { const position = view.posAtDOM(input); if (/^\[[ xX]\]$/.test(view.state.sliceDoc(position, position + 3))) view.dispatch({ changes: { from: position + 1, to: position + 2, insert: input.checked ? 'x' : ' ' }, userEvent: 'input.task' }); });
      return input;
    }
    const span = document.createElement('span'); span.className = 'md-list-marker'; span.dataset.markdownWidget = 'true'; span.textContent = this.text; return span;
  }
  ignoreEvent() { return this.checked !== undefined; }
}

const stagedImageSource = 'data-markdown-asset-source';
const stagedMediaSource = 'data-av-local-media';
/** Preserve only image resource references across the normal HTML sanitizer.
 * They become live src values only after backend ownership and byte validation. */
function sanitizedMarkdownHtml(source: string, block = false) {
  const inert = new DOMParser().parseFromString(source, 'text/html');
  for (const node of inert.querySelectorAll('[' + stagedImageSource + ']')) node.removeAttribute(stagedImageSource);
  for (const node of inert.querySelectorAll('[' + stagedMediaSource + ']')) node.removeAttribute(stagedMediaSource);
  for (const image of inert.querySelectorAll('img[src]')) {
    const path = image.getAttribute('src')!;
    if (path.startsWith('agentviewer-asset:')) { image.setAttribute(stagedImageSource, path); image.removeAttribute('src'); }
  }
  for (const media of inert.querySelectorAll('audio[src],video[src],source[src]')) {
    const path = media.getAttribute('src')!;
    if (!/^[a-z][\w+.-]*:/i.test(path) || /^file:/i.test(path) || /^[a-z]:[\\/]/i.test(path)) { media.setAttribute(stagedMediaSource, path); media.removeAttribute('src'); }
  }
  return new DOMParser().parseFromString(DOMPurify.sanitize(inert.body.innerHTML, block ? { ADD_TAGS: ['iframe'], ADD_ATTR: ['allowfullscreen', 'controls'] } : {}), 'text/html');
}
function standaloneImage(source: string) {
  const template = document.createElement('template'); template.innerHTML = source;
  const nodes = [...template.content.childNodes].filter(node => node.nodeType !== Node.TEXT_NODE || node.textContent!.trim());
  return nodes.length === 1 && nodes[0].nodeType === Node.ELEMENT_NODE && (nodes[0] as Element).tagName === 'IMG';
}
function standaloneMedia(source: string) {
  if (!/^\s*<(?:audio|video|iframe)\b/i.test(source)) return false;
  const template = document.createElement('template'); template.innerHTML = source;
  const nodes = [...template.content.childNodes].filter(node => node.nodeType !== Node.TEXT_NODE || node.textContent!.trim());
  return nodes.length === 1 && nodes[0].nodeType === Node.ELEMENT_NODE && ['AUDIO', 'VIDEO', 'IFRAME'].includes((nodes[0] as Element).tagName);
}

class RenderWidget extends WidgetType {
  constructor(readonly kind: 'math' | 'diagram' | 'image' | 'html' | 'metadata' | 'footnote' | 'rule' | 'toc', readonly source: string, readonly from: number, readonly block: boolean, readonly documentId: string, readonly document?: Text, readonly diagramLanguage: 'mermaid' | 'sequence' | 'flow' = 'mermaid') { super(); }
  eq(other: RenderWidget) { return this.kind === other.kind && this.source === other.source && this.from === other.from && this.documentId === other.documentId && this.document === other.document && this.diagramLanguage === other.diagramLanguage; }
  toDOM(view: EditorView) {
    const host = document.createElement(this.block ? 'div' : 'span'); host.className = 'md-render md-render-' + this.kind; host.dataset.markdownWidget = 'true';
    const readOnly = view.state.facet(EditorState.readOnly);
    if (this.kind === 'diagram') host.dataset.diagramLanguage = this.diagramLanguage;
    if (this.kind === 'rule') { host.append(document.createElement('hr')); }
    else if (this.kind === 'image') {
      const match = this.source.match(/^!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["']([^"']*)["'])?\s*\)$/), raw = /^\s*<img\b/i.test(this.source) ? sanitizedMarkdownHtml(this.source).querySelector('img') : null;
      if (match || raw) {
        const image = document.createElement('img'); image.alt = match?.[1] ?? raw?.alt ?? ''; image.title = match?.[4] ?? image.alt; image.loading = 'lazy';
        const url = match ? match[2] ?? match[3] : raw!.getAttribute(stagedImageSource) ?? raw!.getAttribute('src') ?? '';
        const width = raw?.style.width || raw?.getAttribute('width'); if (width && /^\d+(?:\.\d+)?(?:%|px)?$/.test(width)) { if (width.endsWith('%')) { host.style.width = width; image.style.width = '100%'; } else image.style.width = /^\d+$/.test(width) ? width + 'px' : width; }
        if (/^(https?:|data:image\/(?:png|jpeg|gif|webp|bmp|avif|svg\+xml);base64,)/i.test(url)) image.src = url;
        else if (!/^[a-z][\w+.-]*:/i.test(url) || url.startsWith('agentviewer-asset:')) void call<{ url: string }>('markdown-resource', { documentId: this.documentId, path: url }).then(result => { if (host.isConnected) image.src = result.url; }).catch(() => image.dispatchEvent(new Event('error')));
        image.addEventListener('error', () => { image.hidden = true; const label = document.createElement('span'); label.textContent = '图片无法加载 · ' + image.alt; host.append(label); }); host.append(image);
        const tools = document.createElement('span'); tools.className = 'md-image-toolbar';
        for (const width of ['25%', '50%', '75%', '100%']) { const button = document.createElement('button'); button.type = 'button'; button.textContent = width; button.setAttribute('aria-label', '图片宽度 ' + width); button.addEventListener('mousedown', preventWidgetSelection); button.addEventListener('click', event => { event.stopPropagation(); const from = view.posAtDOM(host); if (view.state.sliceDoc(from, from + this.source.length) !== this.source) return; const template = document.createElement('template'); template.innerHTML = '<img>'; const tag = template.content.firstElementChild as HTMLImageElement; tag.setAttribute('src', url); tag.alt = image.alt; tag.style.width = width; view.dispatch({ changes: { from, to: from + this.source.length, insert: tag.outerHTML }, userEvent: 'input.image-size' }); }); tools.append(button); }
        if (!readOnly) host.append(tools);
      } else host.textContent = this.source;
    } else if (this.kind === 'metadata') {
      const title = document.createElement('strong'); title.textContent = '文档信息'; host.append(title); const list = document.createElement('dl');
      let offset = this.source.indexOf('\n') + 1;
      for (const line of this.source.split('\n').slice(1, -1)) { const start = offset; offset += line.length + 1; const pair = /^([\w.-]+):([ \t]*)(.*)$/.exec(line); if (!pair) continue; const key = document.createElement('dt'), value = document.createElement('dd'), input = document.createElement('input'); key.textContent = pair[1]; input.value = pair[3]; input.setAttribute('aria-label', '文档信息 ' + pair[1]); input.dataset.markdownSourceOffset = String(start + pair[1].length + 1 + pair[2].length); input.addEventListener('click', event => event.stopPropagation()); input.addEventListener('input', () => input.dataset.markdownCellDirty = 'true'); input.addEventListener('change', () => { if (input.dataset.markdownCellDirty !== 'true') return; input.dataset.markdownCellDirty = 'false'; if (input.value === pair[3]) return; const from = view.posAtDOM(host); if (view.state.sliceDoc(from, from + this.source.length) !== this.source) return; view.dispatch({ changes: { from: from + start + pair[1].length + 1 + pair[2].length, to: from + start + line.length, insert: input.value.replace(/[\r\n]/g, '') }, userEvent: 'input.metadata' }); }); input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); input.dispatchEvent(new Event('change')); } if (event.key === 'Escape') view.focus(); }); value.append(input); list.append(key, value); } host.append(list);
      const source = document.createElement('button'); source.type = 'button'; source.textContent = '编辑 YAML 源码'; source.addEventListener('mousedown', preventWidgetSelection); source.addEventListener('click', event => { event.stopPropagation(); const from = view.posAtDOM(host); view.dispatch({ effects: revealMarkdownBlock.of({ from, to: from + this.source.length }), selection: { anchor: from + 4 } }); view.focus(); }); host.append(source);
    } else if (this.kind === 'footnote') {
      const match = /^\[\^([^\]]+)\]:[ \t]*([\s\S]*)$/.exec(this.source); if (match) { const label = document.createElement('label'), input = document.createElement('textarea'); label.textContent = '脚注 ' + match[1]; input.value = match[2].replace(/\n(?: {4}|\t)/g, '\n'); input.setAttribute('aria-label', '脚注内容 ' + match[1]); input.addEventListener('click', event => event.stopPropagation()); input.addEventListener('input', () => input.dataset.markdownCellDirty = 'true'); input.addEventListener('change', () => { if (input.dataset.markdownCellDirty !== 'true') return; input.dataset.markdownCellDirty = 'false'; const from = view.posAtDOM(host), insert = '[^' + match[1] + ']: ' + input.value.replace(/\n/g, '\n    '); if (insert !== this.source && view.state.sliceDoc(from, from + this.source.length) === this.source) view.dispatch({ changes: { from, to: from + this.source.length, insert }, userEvent: 'input.footnote' }); }); label.append(input); host.append(label); } else host.textContent = this.source;
    } else if (this.kind === 'html') {
      host.innerHTML = sanitizedMarkdownHtml(this.source, true).body.innerHTML;
      for (const link of host.querySelectorAll('a[href]')) { (link as HTMLElement).dataset.markdownLink = link.getAttribute('href') ?? ''; link.addEventListener('click', event => event.preventDefault()); }
      for (const frame of host.querySelectorAll('iframe')) { if (!/^https?:/i.test(frame.getAttribute('src') ?? '')) frame.remove(); else { frame.setAttribute('sandbox', 'allow-scripts allow-presentation'); frame.setAttribute('referrerpolicy', 'no-referrer'); frame.setAttribute('loading', 'lazy'); } }
      for (const image of host.querySelectorAll('img')) { const path = image.getAttribute(stagedImageSource) ?? image.getAttribute('src') ?? ''; image.removeAttribute(stagedImageSource); if (path && (!/^[a-z][\w+.-]*:/i.test(path) || path.startsWith('agentviewer-asset:'))) void call<{ url: string }>('markdown-resource', { documentId: this.documentId, path }).then(result => { if (host.isConnected) image.src = result.url; }).catch(() => { image.alt = '图片无法加载 · ' + image.alt; }); }
      for (const media of host.querySelectorAll<HTMLMediaElement>('audio,video')) { media.controls = true; media.preload = 'metadata'; }
      for (const source of host.querySelectorAll<HTMLMediaElement | HTMLSourceElement>('audio[' + stagedMediaSource + '],video[' + stagedMediaSource + '],source[' + stagedMediaSource + ']')) {
        const path = source.getAttribute(stagedMediaSource)!; source.removeAttribute(stagedMediaSource);
        void call<{ url: string }>('markdown-media', { documentId: this.documentId, path }).then(result => { if (!host.isConnected) return; source.src = result.url; const player = source instanceof HTMLMediaElement ? source : source.closest('audio,video') as HTMLMediaElement | null; player?.load(); }).catch(() => { if (!host.isConnected) return; const message = document.createElement('span'); message.className = 'md-media-error'; message.textContent = '媒体无法加载 · ' + path; host.append(message); });
      }
      const source = document.createElement('button'); source.className = 'md-html-source-button'; source.type = 'button'; source.textContent = '编辑 HTML 源码'; source.addEventListener('mousedown', preventWidgetSelection); source.addEventListener('click', event => { event.stopPropagation(); const from = view.posAtDOM(host); view.dispatch({ effects: revealMarkdownBlock.of({ from, to: from + this.source.length }), selection: { anchor: from } }); view.focus(); }); host.append(source);
    } else if (this.kind === 'toc') {
      host.setAttribute('aria-label', '文档目录'); const title = document.createElement('strong'); title.textContent = '目录'; host.append(title);
      let index = 0;
      syntaxTree(view.state).iterate({ enter: node => {
        const level = /^ATXHeading(\d)|^SetextHeading(\d)/.exec(node.name); if (!level) return ['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'].includes(node.name) ? undefined : false;
        const headingIndex = index++;
        const button = document.createElement('button'); button.type = 'button'; button.textContent = view.state.sliceDoc(node.from, node.to).replace(/^#{1,6}\s+/, '').replace(/\n(?:=+|-+)\s*$/, '');
        button.style.paddingInlineStart = (Math.max(0, Number(level[1] ?? level[2]) - 1) * 14) + 'px';
        button.addEventListener('mousedown', preventWidgetSelection); button.addEventListener('click', event => { event.stopPropagation(); let current = 0, position: number | undefined; syntaxTree(view.state).iterate({ enter: entry => { if (/^(ATX|Setext)Heading/.test(entry.name) && current++ === headingIndex) position = entry.from; } }); if (position !== undefined) editBlock(view, position); }); host.append(button); return false;
      } });
    } else {
      host.textContent = this.kind === 'math' ? this.source : '正在绘制图表…';
      // Offscreen buffered widgets do not initialize MathJax/Mermaid. Rendering
      // is requested only when the actual widget approaches the scroll viewport.
      const observer = new IntersectionObserver(entries => { if (!entries.some(entry => entry.isIntersecting)) return; observer.disconnect();
        const render = this.kind === 'math' ? renderMarkdownFormula(this.source, this.block) : renderMarkdownDiagram(this.source, this.diagramLanguage);
        void render.then(html => { if (host.isConnected) { host.innerHTML = html; view.requestMeasure(); } }).catch(() => { if (host.isConnected) { host.classList.add('md-render-error'); host.textContent = '无法呈现，点击编辑源码'; view.requestMeasure(); } });
      }, { rootMargin: '200px' }); observer.observe(host);
      (host as HTMLElement & { markdownDispose?: () => void }).markdownDispose = () => observer.disconnect();
    }
    if (readOnly) {
      for (const control of host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) { const text = document.createElement('span'); const offset = this.kind === 'metadata' ? Number(control.dataset.markdownSourceOffset ?? -1) : this.kind === 'footnote' ? (/^\[\^[^\]]+\]:[ \t]*/.exec(this.source)?.[0].length ?? -1) : -1; if (offset >= 0) mappedPreviewText(text, host, this.kind === 'footnote' ? this.source.slice(offset) : control.value, offset, this.kind === 'footnote'); else text.textContent = control.value; control.replaceWith(text); }
      for (const button of host.querySelectorAll<HTMLButtonElement>('button')) if (this.kind !== 'toc') button.remove();
    }
    if (!readOnly && this.kind !== 'toc') host.addEventListener(['html', 'metadata', 'footnote'].includes(this.kind) ? 'dblclick' : 'click', event => { if (this.kind === 'html' && (event.target as HTMLElement).closest('video,audio,iframe,a,input,button,textarea')) return; event.preventDefault(); const from = view.posAtDOM(host); if (['metadata', 'html', 'footnote'].includes(this.kind)) view.dispatch({ effects: revealMarkdownBlock.of({ from, to: from + this.source.length }) }); editBlock(view, from + (this.kind === 'math' ? this.block ? 3 : 1 : 0)); });
    return this.block ? measuredBlock(host) : host;
  }
  ignoreEvent() { return true; }
  destroy(dom: HTMLElement) { const content = dom.matches('.md-measured-block') ? dom.firstElementChild : dom; (content as HTMLElement & { markdownDispose?: () => void })?.markdownDispose?.(); }
}

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number) { super(); }
  eq(other: TableWidget) { return this.source === other.source && this.from === other.from; }
  toDOM(view: EditorView) {
    const parsed = parseMarkdownTable(this.source); const host = document.createElement('div'); host.className = 'md-table-widget'; host.dataset.markdownWidget = 'true';
    if (!parsed) { host.textContent = this.source; return measuredBlock(host); }
    const tools = document.createElement('div'); tools.className = 'md-table-toolbar';
    const button = (label: string, text: string, action: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label); node.textContent = text; node.addEventListener('mousedown', preventWidgetSelection); node.addEventListener('click', action); tools.append(node); };
    let activeRow = 0, activeColumn = 0;
    const replace = (focusRow = activeRow, focusColumn = activeColumn) => {
      const from = view.posAtDOM(host); if (view.state.sliceDoc(from, from + this.source.length) !== this.source) return;
      const insert = serializeMarkdownTable(parsed), next = parseMarkdownTable(insert), cell = next?.rowRanges.filter(row => row.kind !== 'delimiter')[focusRow]?.cells[focusColumn];
      view.dispatch({ changes: { from, to: from + this.source.length, insert }, selection: cell ? { anchor: from + cell.from, head: from + cell.to } : undefined, userEvent: 'input.table' });
      view.requestMeasure();
      requestAnimationFrame(() => { const replacement = [...view.dom.querySelectorAll<HTMLElement>('.md-table-widget')].find(node => view.posAtDOM(node) === from); const target = replacement?.querySelector<HTMLInputElement>(`tr:nth-child(${focusRow + 1}) :is(th,td):nth-child(${focusColumn + 1}) input`); target?.focus(); });
    };
    button('增加一行', '+ 行', () => { parsed.rows.push(parsed.header.map(() => '')); replace(); });
    button('增加一列', '+ 列', () => { parsed.header.push(''); parsed.align.push(null); parsed.rows.forEach(row => row.push('')); replace(); });
    button('删除当前行', '− 行', () => { if (activeRow === 0) { if (parsed.rows.length) parsed.header = parsed.rows.shift()!; else { const from = view.posAtDOM(host); view.dispatch({ changes: { from, to: from + this.source.length, insert: '' }, userEvent: 'input.table' }); return; } } else parsed.rows.splice(activeRow - 1, 1); replace(Math.min(activeRow, parsed.rows.length)); });
    button('删除当前列', '− 列', () => { if (parsed.header.length < 2) return; parsed.header.splice(activeColumn, 1); parsed.align.splice(activeColumn, 1); parsed.rows.forEach(row => row.splice(activeColumn, 1)); replace(activeRow, Math.min(activeColumn, parsed.header.length - 1)); });
    button('当前列左对齐', '左', () => { parsed.align[activeColumn] = 'left'; replace(); });
    button('当前列居中', '中', () => { parsed.align[activeColumn] = 'center'; replace(); });
    button('当前列右对齐', '右', () => { parsed.align[activeColumn] = 'right'; replace(); });
    button('上移当前行', '↑', () => { if (activeRow < 2) return; [parsed.rows[activeRow - 2], parsed.rows[activeRow - 1]] = [parsed.rows[activeRow - 1], parsed.rows[activeRow - 2]]; replace(activeRow - 1); });
    button('下移当前行', '↓', () => { if (!activeRow || activeRow >= parsed.rows.length) return; [parsed.rows[activeRow - 1], parsed.rows[activeRow]] = [parsed.rows[activeRow], parsed.rows[activeRow - 1]]; replace(activeRow + 1); });
    button('左移当前列', '←', () => { if (!activeColumn) return; for (const row of [parsed.header, ...parsed.rows]) [row[activeColumn - 1], row[activeColumn]] = [row[activeColumn], row[activeColumn - 1]]; [parsed.align[activeColumn - 1], parsed.align[activeColumn]] = [parsed.align[activeColumn], parsed.align[activeColumn - 1]]; replace(activeRow, activeColumn - 1); });
    button('右移当前列', '→', () => { if (activeColumn >= parsed.header.length - 1) return; for (const row of [parsed.header, ...parsed.rows]) [row[activeColumn], row[activeColumn + 1]] = [row[activeColumn + 1], row[activeColumn]]; [parsed.align[activeColumn], parsed.align[activeColumn + 1]] = [parsed.align[activeColumn + 1], parsed.align[activeColumn]]; replace(activeRow, activeColumn + 1); });
    button('编辑表格源码', '</>', () => { const from = view.posAtDOM(host); view.dispatch({ effects: revealMarkdownBlock.of({ from, to: from + this.source.length }), selection: { anchor: from } }); view.focus(); });
    const readOnly = view.state.facet(EditorState.readOnly);
    if (!readOnly) host.append(tools); const table = document.createElement('table'); const rows = [parsed.header, ...parsed.rows];
    rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      row.forEach((cell, column) => {
        const td = document.createElement(rowIndex === 0 ? 'th' : 'td'); const input = document.createElement('input'); input.value = cell.replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n');
        if (readOnly) { const range = parsed.rowRanges[rowIndex === 0 ? 0 : rowIndex + 1]?.cells[column]; if (range) mappedPreviewText(td, host, range.text, range.from, true); else td.textContent = cell; td.style.textAlign = parsed.align[column] ?? 'left'; tr.append(td); return; }
        input.setAttribute('aria-label', `表格第 ${rowIndex + 1} 行第 ${column + 1} 列`); input.style.textAlign = parsed.align[column] ?? 'left';
        input.addEventListener('focus', () => { activeRow = rowIndex; activeColumn = column; const from = view.posAtDOM(host), range = parsed.rowRanges[rowIndex === 0 ? 0 : rowIndex + 1]?.cells[column]; if (range) view.dispatch({ selection: { anchor: from + range.from, head: from + range.to } }); });
        input.addEventListener('input', () => { row[column] = input.value.replaceAll('\n', '<br>'); input.dataset.markdownCellDirty = 'true'; });
        const commit = () => { if (input.dataset.markdownCellDirty !== 'true') return false; const value = input.value.replaceAll('\n', '<br>'); input.dataset.markdownCellDirty = 'false'; if (value !== cell) { row[column] = value; return true; } return false; };
        input.addEventListener('change', () => { if (commit()) replace(); });
        input.addEventListener('paste', event => { const text = event.clipboardData?.getData('text/plain'); if (!text?.includes('\t')) return; event.preventDefault(); const pasted = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(line => line.split('\t')); const width = Math.max(parsed.header.length, column + Math.max(...pasted.map(row => row.length))); while (parsed.header.length < width) { parsed.header.push(''); parsed.align.push(null); } while (parsed.rows.length < rowIndex + pasted.length - 1) parsed.rows.push(Array(width).fill('')); for (let index = 0; index < pasted.length; index++) { const target = rowIndex + index === 0 ? parsed.header : parsed.rows[rowIndex + index - 1]; pasted[index].forEach((value, offset) => target[column + offset] = value); } replace(); });
        input.addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.preventDefault(); if (commit()) replace(); view.focus(); }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault(); const changed = commit(), direction = event.shiftKey ? -1 : 1, targetIndex = event.key === 'Enter' ? (rowIndex + direction) * row.length + column : rowIndex * row.length + column + direction;
            if (targetIndex < 0) { view.focus(); return; }
            const targetRow = Math.floor(targetIndex / row.length), targetColumn = targetIndex % row.length;
            if (targetRow >= rows.length) parsed.rows.push(parsed.header.map(() => ''));
            if (changed || targetRow >= rows.length) replace(targetRow, targetColumn);
            else host.querySelector<HTMLInputElement>(`tr:nth-child(${targetRow + 1}) :is(th,td):nth-child(${targetColumn + 1}) input`)?.focus();
          }
          if ((event.ctrlKey || event.metaKey) && /^[zy]$/i.test(event.key)) { event.preventDefault(); window.dispatchEvent(new CustomEvent('agentviewer:markdown-command', { detail: { viewId: view.dom.closest<HTMLElement>('[data-markdown-view]')?.dataset.markdownView, command: event.key.toLowerCase() === 'z' && !event.shiftKey ? 'undo' : 'redo' } })); }
        });
        td.append(input); tr.append(td);
      }); table.append(tr);
    }); host.append(table); return measuredBlock(host);
  }
  ignoreEvent() { return true; }
}

class TableSourceNoticeWidget extends WidgetType {
  eq(other: WidgetType) { return other instanceof TableSourceNoticeWidget; }
  toDOM() { const hint = document.createElement('div'); hint.className = 'md-table-source-notice'; hint.textContent = '大型表格使用源码编辑；左栏仍可增删、移动行列与设置对齐。'; return measuredBlock(hint); }
}

/** Source remains the only document. Decorations never become a serializer. */
export function markdownLivePreview(documentId: string) {
  const revealed = StateField.define<{ from: number; to: number } | null>({
    create: () => null,
    update(value, transaction) {
      if (transaction.docChanged) value = value ? { from: transaction.changes.mapPos(value.from), to: transaction.changes.mapPos(value.to) } : null;
      for (const effect of transaction.effects) if (effect.is(revealMarkdownBlock)) value = effect.value;
      if (value && transaction.selection && !selected(transaction.state, value.from - 1, value.to + 1)) value = null;
      return value;
    },
  });
  const build = (state: EditorState, spans: Span[]) => {
    const started = performance.now();
    const decorations: Range<Decoration>[] = [], lineStyles = new Map<number, string[]>(), hidden: { from: number; to: number }[] = [];
    const addLine = (position: number, name: string) => { const line = state.doc.lineAt(position).from; const names = lineStyles.get(line) ?? []; if (!names.includes(name)) names.push(name); lineStyles.set(line, names); };
    const hide = (from: number, to: number, widget?: WidgetType, block = false) => { if (to <= from) return; decorations.push(Decoration.replace({ widget, block }).range(from, to)); hidden.push({ from, to }); };
    const reveal = state.field(revealed);
    const excluded = (from: number) => { let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); while (node) { if (['FencedCode', 'CodeBlock', 'BlockMath', 'Frontmatter', 'InlineCode', 'Table', 'HTMLBlock'].includes(node.name)) return true; node = node.parent; } return false; };
    for (const span of spans) {
      const source = state.sliceDoc(span.from, span.to);
      if (span.from === 0) { const metadata = /^\uFEFF?---\n[\s\S]*?\n(?:---|\.\.\.)(?=\n|$)/.exec(source); if (metadata && !(reveal && reveal.from === 0 && reveal.to >= metadata[0].length) && !selected(state, 1, metadata[0].length)) hide(0, metadata[0].length, new RenderWidget('metadata', metadata[0], 0, true, documentId), true); }
      for (const match of source.matchAll(/^\[\^([^\]]+)\]:[^\n]*(?:\n(?: {4}|\t)[^\n]*)*/gm)) { const from = span.from + match.index!, to = from + match[0].length; if (!excluded(from) && !(reveal && reveal.from <= from && reveal.to >= to) && !selected(state, from, to)) hide(from, to, new RenderWidget('footnote', match[0], from, true, documentId), true); }
    }
    for (const span of spans) syntaxTree(state).iterate({ from: span.from, to: span.to, enter: reference => {
      const node = reference.node, name = node.name, active = selected(state, node.from, node.to);
      if (node.to < span.from || node.from > span.to) return false;
      // Container nodes may cover the complete file. Read source only for a
      // widget or marker, never for Document/List/Blockquote merely to style it.
      const text = () => state.sliceDoc(node.from, node.to);
      if (hidden.some(range => node.from >= range.from && node.to <= range.to)) return false;
      const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
      if (heading) { addLine(node.from, 'md-heading md-heading-' + heading[1]); if (name.startsWith('Setext')) { const last = state.doc.lineAt(node.to).from; if (state.field(pointerSelection) || !selected(state, last, node.to)) hide(last > 0 ? last - 1 : last, node.to); } }
      if (name === 'HeaderMark') { const end = Math.min(state.doc.lineAt(node.to).to, node.to + 1); if (!syntaxSelected(state, node.from, end, end, end)) hide(node.from, end); }
      if (['StrongEmphasis', 'Emphasis', 'Strikethrough', 'Highlight', 'Subscript', 'Superscript', 'InlineCode'].includes(name)) {
        decorations.push(Decoration.mark({ class: ({ StrongEmphasis: 'md-strong', Emphasis: 'md-emphasis', Strikethrough: 'md-strike', Highlight: 'md-highlight', Subscript: 'md-sub', Superscript: 'md-super', InlineCode: 'md-inline-code' } as Record<string, string>)[name] }).range(node.from, node.to));
        const marks: SyntaxNode[] = []; for (let child = node.firstChild; child; child = child.nextSibling) if (/Mark$/.test(child.name)) marks.push(child);
        if (marks.length >= 2 && !syntaxSelected(state, node.from, node.to, marks[0].to, marks.at(-1)!.from)) for (const mark of marks) hide(mark.from, mark.to);
      }
      if (name === 'Blockquote') for (let p = state.doc.lineAt(Math.max(span.from, node.from)).number; p <= state.doc.lineAt(Math.min(span.to, node.to)).number; p++) addLine(state.doc.line(p).from, 'md-quote');
      if (name === 'QuoteMark') { const end = Math.min(node.to + 1, state.doc.lineAt(node.to).to); if (!syntaxSelected(state, node.from, end, end, end)) hide(node.from, end); }
      if (name === 'ListMark' && !syntaxSelected(state, node.from, node.to, node.to, node.to)) hide(node.from, node.to, new PrefixWidget(/^\d/.test(text()) ? text() : '•'));
      if (name === 'TaskMarker') hide(node.from, node.to, new PrefixWidget('', /[xX]/.test(text()), node.from));
      if (name === 'HorizontalRule' && !active) { hide(node.from, node.to, new RenderWidget('rule', '', node.from, true, documentId), true); return false; }
      if (name === 'Table' && node.to - node.from <= 24000 && !(reveal && reveal.from <= node.from && reveal.to >= node.to)) { hide(node.from, node.to, new TableWidget(text(), node.from), true); return false; }
      if (name === 'Table' && node.to - node.from > 24000 && node.from >= span.from) decorations.push(Decoration.widget({ widget: new TableSourceNoticeWidget(), block: true, side: -1 }).range(node.from));
      if (name === 'Image' && !active && node.to - node.from <= 24000) { hide(node.from, node.to, new RenderWidget('image', text(), node.from, false, documentId)); return false; }
      if (name === 'HTMLTag' && node.to - node.from <= 24000 && /^<img\b/i.test(text()) && !active) { hide(node.from, node.to, new RenderWidget('image', text(), node.from, false, documentId)); return false; }
      // CommonMark treats same-line <audio ...></audio> as inline HTML inside
      // a paragraph rather than HTMLBlock. Typora-style standalone players
      // still need the same sanitized, resource-resolved block projection.
      if (name === 'Paragraph' && !active && node.to - node.from <= 65536 && !(reveal && reveal.from <= node.from && reveal.to >= node.to) && standaloneMedia(text())) { hide(node.from, node.to, new RenderWidget('html', text(), node.from, true, documentId), true); return false; }
      if (name === 'HTMLBlock' && !active && node.to - node.from <= 65536 && !(reveal && reveal.from <= node.from && reveal.to >= node.to)) { const source = text(); hide(node.from, node.to, new RenderWidget(standaloneImage(source) ? 'image' : 'html', source, node.from, true, documentId), true); return false; }
      if (name === 'BlockMath' && node.to - node.from <= 24000) { const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to), body = state.sliceDoc(Math.min(first.to + 1, node.to), Math.max(first.to + 1, last.from - 1)); if (last.number > first.number && /^\$\$[ \t]*$/.test(last.text.trim())) { if (!active) hide(node.from, node.to, new RenderWidget('math', body, node.from, true, documentId), true); else { decorations.push(Decoration.mark({ class: 'md-math-source' }).range(node.from, node.to)); decorations.push(Decoration.widget({ widget: new RenderWidget('math', body, node.from, true, documentId), block: true, side: 1 }).range(last.to)); } } return false; }
      if (name === 'Link' && node.to - node.from <= 24000) {
        const url = node.getChild('URL'); const marks: SyntaxNode[] = []; for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === 'LinkMark') marks.push(child);
        if (url) decorations.push(Decoration.mark({ class: 'md-link', attributes: { 'data-markdown-link': state.sliceDoc(url.from, url.to) } }).range(node.from, node.to));
        else { const reference = /^\[([\s\S]+?)\](?:\[([^\]]*)\])?$/.exec(text()); if (reference) decorations.push(Decoration.mark({ class: 'md-link', attributes: { 'data-markdown-reference': reference[2] || reference[1] } }).range(node.from, node.to)); }
        if (url && marks.length >= 3 && !syntaxSelected(state, node.from, node.to, marks[0].to, marks[1].from)) { hide(marks[0].from, marks[0].to); hide(marks[1].from, node.to); }
      }
      if (name === 'FencedCode') {
        const info = node.getChild('CodeInfo'), language = info ? state.sliceDoc(info.from, info.to) : '', first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
        if (['mermaid', 'sequence', 'flow'].includes(language) && !active && node.to - node.from <= 24000) { const body = state.sliceDoc(Math.min(first.to + 1, node.to), Math.max(first.to + 1, last.from - 1)); hide(node.from, node.to, new RenderWidget('diagram', body, node.from, true, documentId, undefined, language as 'mermaid' | 'sequence' | 'flow'), true); return false; }
        for (let line = Math.max(first.number, state.doc.lineAt(span.from).number); line <= Math.min(last.number, state.doc.lineAt(span.to).number); line++) addLine(state.doc.line(line).from, line === first.number ? 'md-fence md-fence-start' : line === last.number ? 'md-fence md-fence-end' : 'md-fence');
      }
    } });
    // TeX, TOC and Typora highlight syntax are optional Markdown extensions,
    // kept separate from CommonMark parsing and excluded from code regions.
    const inside = (from: number) => excluded(from) || hidden.some(range => from >= range.from && from < range.to);
    for (const span of spans) {
    const source = state.sliceDoc(span.from, span.to);
    const math = /(^[ \t]*\$\$[^\n]*\n[\s\S]*?\n[ \t]*\$\$[ \t]*(?=\n|$))|(?<![\\$])\$(?!\$|\s)([^\n$]*?\S)\$(?!\$)/gm;
    for (const match of source.matchAll(math)) {
      const from = span.from + match.index!, to = from + match[0].length; if (inside(from)) continue;
      const block = !!match[1], tex = block ? match[0].replace(/^[ \t]*\$\$[^\n]*\n/, '').replace(/\n[ \t]*\$\$[ \t]*$/, '') : match[2];
      if (!selected(state, from, to)) hide(from, to, new RenderWidget('math', tex, from, block, documentId), block);
      else { decorations.push(Decoration.mark({ class: 'md-math-source' }).range(from, to)); if (block) decorations.push(Decoration.widget({ widget: new RenderWidget('math', tex, from, true, documentId), block: true, side: 1 }).range(state.doc.lineAt(to).to)); }
    }
    for (const match of source.matchAll(/^\[toc\][ \t]*$/gim)) { const from = span.from + match.index!, to = from + match[0].length; if (!inside(from) && !selected(state, from, to)) hide(from, to, new RenderWidget('toc', '', from, true, documentId, state.doc), true); }
    for (const match of source.matchAll(/^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gim)) addLine(span.from + match.index!, 'md-callout md-callout-' + match[1].toLowerCase());
    for (const match of source.matchAll(/<(u|sub|sup)>([^\n]*?)<\/\1>/g)) { const from = span.from + match.index!, to = from + match[0].length; if (inside(from)) continue; decorations.push(Decoration.mark({ class: match[1] === 'u' ? 'md-underline' : match[1] === 'sub' ? 'md-sub' : 'md-super' }).range(from, to)); if (!syntaxSelected(state, from, to, from + match[1].length + 2, to - match[1].length - 3)) { hide(from, from + match[1].length + 2); hide(to - match[1].length - 3, to); } }
    for (const match of source.matchAll(/\[\^([^\]\n]+)\](?!:)/g)) { const from = span.from + match.index!, to = from + match[0].length; if (inside(from)) continue; decorations.push(Decoration.mark({ class: 'md-footnote-reference', attributes: { 'data-markdown-footnote': match[1] } }).range(from, to)); if (!syntaxSelected(state, from, to, from + 2, to - 1)) { hide(from, from + 2); hide(to - 1, to); } }
    for (const match of source.matchAll(/:([a-z0-9_+\-]+):/g)) { const from = span.from + match.index!, to = from + match[0].length, emoji = markdownEmoji(match[1]); if (emoji && !inside(from) && !selected(state, from, to)) hide(from, to, new PrefixWidget(emoji)); }
    }
    for (const [position, names] of lineStyles) decorations.push(Decoration.line({ class: names.join(' ') }).range(position));
    const result = decorations.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
    if (window.agentViewer?.testMode) performance.measure('agentviewer:markdown-preview', { start: started, end: performance.now(), detail: { characters: spans.reduce((sum, span) => sum + span.to - span.from, 0), ranges: spans.length, decorations: result.length } });
    return result;
  };
  const field = StateField.define<{ decorations: DecorationSet; viewport: Span }>({
    create(state) { const viewport = { from: 0, to: Math.min(state.doc.length, 8000) }; return { viewport, decorations: Decoration.set(build(state, affectedBlocks(state, [viewport], viewport)), true) }; },
    update(value, transaction) {
      const state = transaction.state, changes = transaction.changes;
      let viewport = transaction.docChanged ? { from: changes.mapPos(value.viewport.from), to: changes.mapPos(value.viewport.to) } : value.viewport;
      let decorations = transaction.docChanged ? value.decorations.map(changes) : value.decorations;
      const viewportEffect = transaction.effects.find(effect => effect.is(previewViewport));
      if (viewportEffect) viewport = viewportEffect.value as Span;
      const all = !!viewportEffect || transaction.effects.some(effect => effect.is(refreshMarkdownPreview)) || !transaction.docChanged && syntaxTree(transaction.startState) !== syntaxTree(state);
      const spans: Span[] = all ? [viewport] : [];
      if (!all && transaction.docChanged) changes.iterChangedRanges((_fromA, _toA, fromB, toB) => spans.push({ from: Math.max(0, fromB - 1), to: Math.min(state.doc.length, toB + 1) }));
      if (!all && transaction.docChanged) decorations.between(viewport.from, viewport.to, (from, to, decoration) => { if (decoration.spec.widget instanceof RenderWidget && decoration.spec.widget.kind === 'toc') spans.push({ from, to }); });
      if (!all && (transaction.selection || transaction.docChanged)) {
        for (const range of transaction.startState.selection.ranges) spans.push({ from: changes.mapPos(range.from), to: changes.mapPos(range.to) });
        spans.push(...state.selection.ranges.map(({ from, to }) => ({ from, to })));
      }
      for (const effect of transaction.effects) if (effect.is(revealMarkdownBlock)) { if (effect.value) spans.push(effect.value); const previous = transaction.startState.field(revealed); if (previous) spans.push({ from: changes.mapPos(previous.from), to: changes.mapPos(previous.to) }); }
      if (!spans.length) return value;
      const rebuild = affectedBlocks(state, spans, viewport), remove = all ? [viewport] : rebuild;
      decorations = decorations.update({ filter: (from, to) => from <= viewport.to && to >= viewport.from && !remove.some(span => from <= span.to && to >= span.from), add: build(state, rebuild) });
      return { viewport, decorations };
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  });
  const viewport = ViewPlugin.fromClass(class {
    private pending = false; private destroyed = false; private emojiRequested = false;
    constructor(readonly view: EditorView) { this.schedule(); }
    update(update: { viewportChanged: boolean; docChanged: boolean }) { if (update.viewportChanged || update.docChanged) this.schedule(); }
    schedule() {
      if (this.pending) return; this.pending = true;
      queueMicrotask(() => { this.pending = false; if (this.destroyed) return;
        // A wrapped megabyte line belongs to the logical viewport in full.
        // CodeMirror's native line gaps expose only the actually drawn ranges.
        const visible = this.view.visibleRanges;
        const actual = visible.length ? { from: visible[0].from, to: visible.at(-1)!.to } : this.view.viewport, stored = this.view.state.field(field).viewport;
        if (!this.emojiRequested && /:[a-z0-9_+\-]+:/.test(this.view.state.sliceDoc(actual.from, Math.min(actual.to, actual.from + 32000)))) { this.emojiRequested = true; void loadMarkdownEmoji().then(() => { if (!this.destroyed) this.view.dispatch({ effects: refreshMarkdownPreview.of(null) }); }).catch(() => { this.emojiRequested = false; }); }
        if (actual.from >= stored.from + Math.min(buffer / 2, stored.from) && actual.to <= stored.to - Math.min(buffer / 2, this.view.state.doc.length - stored.to)) return;
        this.view.dispatch({ effects: previewViewport.of({ from: Math.max(0, actual.from - buffer), to: Math.min(this.view.state.doc.length, actual.to + buffer) }) });
      });
    }
    destroy() { this.destroyed = true; }
  });
  return [pointerSelection, revealed, field, viewport];
}
