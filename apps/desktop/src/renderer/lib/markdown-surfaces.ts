import type { EditorView } from '@codemirror/view';

const surfaces = new Map<string, 'source' | 'preview'>();
export const markdownSurface = (viewId?: string) => viewId ? surfaces.get(viewId) ?? 'source' : 'source';
export function activateMarkdownSurface(viewId: string | undefined, surface: 'source' | 'preview') { if (viewId) { if (surface === 'source') surfaces.delete(viewId); else surfaces.set(viewId, surface); } }
type SourceMap = { root: HTMLElement; from: number; boundaries: number[] };
const mappings = new WeakMap<Node, SourceMap>();

/** Widget coordinates stay relative to their current CM position, so edits
 * before a retained widget cannot make its selection offsets stale. */
export function mappedPreviewText(element: HTMLElement, root: HTMLElement, raw: string, from: number, decode = false) {
  let text = '', cursor = 0; const boundaries = [0];
  const append = (to: number) => { while (cursor < to) { text += raw[cursor++]; boundaries.push(cursor); } };
  if (decode) for (const match of raw.matchAll(/\\\||<br\s*\/?>|\n(?: {4}|\t)/gi)) { append(match.index!); text += match[0] === '\\|' ? '|' : '\n'; cursor = match.index! + match[0].length; boundaries.push(cursor); }
  append(raw.length); element.textContent = text; mappings.set(element, { root, from, boundaries });
}
export function previewSourcePosition(view: EditorView, node: Node, offset: number): number | undefined {
  for (let current: Node | null = node; current && current !== view.contentDOM; current = current.parentNode) {
    const mapping = mappings.get(current);
    if (mapping) { const range = document.createRange(); range.selectNodeContents(current); try { range.setEnd(node, offset); const index = range.toString().length, local = mapping.boundaries[index]; return local === undefined ? undefined : view.posAtDOM(mapping.root) + mapping.from + local; } catch { return undefined; } }
    if (current instanceof HTMLElement && current.dataset.markdownWidget === 'true') return undefined;
  }
  try { return view.posAtDOM(node, offset); } catch { return undefined; }
}

/** Inverse mapping for retaining a native preview Range across a source
 * transaction. Only rendered text participates; complex unmapped HTML/SVG
 * remains unavailable instead of inventing a source position. */
export function previewDOMPosition(view: EditorView, position: number): { node: Node; offset: number } | undefined {
  const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
  for (let node: Node | null; (node = walker.nextNode());) {
    const start = previewSourcePosition(view, node, 0), end = previewSourcePosition(view, node, node.textContent?.length ?? 0);
    if (start === undefined || end === undefined || position < start || position > end) continue;
    let low = 0, high = node.textContent?.length ?? 0;
    while (low < high) { const middle = (low + high) >>> 1, value = previewSourcePosition(view, node, middle); if (value === undefined) break; if (value < position) low = middle + 1; else high = middle; }
    if (previewSourcePosition(view, node, low) === position) return { node, offset: low };
  }
  return undefined;
}
