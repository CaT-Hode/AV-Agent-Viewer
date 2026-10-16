import { StateField, type EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

export type MarkdownOutlineItem = { index: number; title: string; level: number; from: number; to: number };
type Span = { from: number; to: number };
type Index = { items: MarkdownOutlineItem[]; parsedTo: number; pending: Span[] };
function merge(spans: Span[]) { const result: Span[] = []; for (const span of spans.sort((a, b) => a.from - b.from)) { const previous = result.at(-1); if (previous && span.from <= previous.to) previous.to = Math.max(previous.to, span.to); else result.push({ ...span }); } return result; }
function block(state: EditorState, position: number, side: -1 | 1) {
  let node = syntaxTree(state).resolveInner(position, side);
  while (node.parent && !/^(?:Paragraph|FencedCode|BlockMath|Frontmatter|HTMLBlock|CodeBlock|Table|(?:ATX|Setext)Heading\d|ListItem)$/.test(node.name)) node = node.parent;
  return node.name === 'Document' ? { from: state.doc.lineAt(position).from, to: state.doc.lineAt(position).to } : { from: node.from, to: node.to };
}
function read(state: EditorState, spans: Span[]) {
  const headings: MarkdownOutlineItem[] = [];
  for (const span of spans) syntaxTree(state).iterate({ from: span.from, to: span.to, enter: reference => {
    const match = /^(?:ATX|Setext)Heading(\d)$/.exec(reference.name);
    if (match) { if (reference.from >= span.from && reference.from <= span.to) { const title = state.sliceDoc(reference.from, Math.min(reference.to, reference.from + 240)).replace(/^ {0,3}#{1,6}\s+/, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/\n(?:=+|-+)\s*$/, ''); headings.push({ index: 0, title, level: Number(match[1]), from: reference.from, to: reference.to }); } return false; }
    if (['Paragraph', 'FencedCode', 'BlockMath', 'Frontmatter', 'HTMLBlock', 'CodeBlock', 'Table', 'LinkReference'].includes(reference.name)) return false;
  } });
  return headings;
}

/** Source positions are mapped by the actual CM change set. Reparse only old
 * and new affected blocks, plus newly available background parse fragments. */
export const markdownOutline = StateField.define<Index>({
  create(state) { const parsedTo = syntaxTree(state).length; return { items: read(state, [{ from: 0, to: parsedTo }]).map((item, index) => ({ ...item, index })), parsedTo, pending: [] }; },
  update(value, transaction) {
    const tree = syntaxTree(transaction.state), previousTree = syntaxTree(transaction.startState);
    if (!transaction.docChanged && tree === previousTree) return value;
    const changes = transaction.changes, state = transaction.state, spans: Span[] = value.pending.map(span => ({ from: changes.mapPos(span.from), to: changes.mapPos(span.to) }));
    let items = transaction.docChanged ? value.items.map(item => ({ ...item, from: changes.mapPos(item.from), to: changes.mapPos(item.to) })) : value.items;
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      const oldFirst = block(transaction.startState, fromA, 1), oldLast = block(transaction.startState, toA, -1), first = block(state, fromB, 1), last = block(state, toB, -1);
      spans.push({ from: Math.min(changes.mapPos(oldFirst.from), first.from), to: Math.max(changes.mapPos(oldLast.to), last.to) });
    });
    const previousParsedTo = transaction.docChanged ? changes.mapPos(value.parsedTo) : value.parsedTo;
    if (tree.length > previousParsedTo) spans.push({ from: previousParsedTo, to: tree.length });
    const combined = merge(spans), available = combined.filter(span => span.from <= tree.length).map(span => ({ from: span.from, to: Math.min(span.to, tree.length) }));
    items = [...items.filter(item => !available.some(span => item.from >= span.from && item.from <= span.to)), ...read(state, available)].sort((a, b) => a.from - b.from);
    const unique = items.filter((item, index) => !index || item.from !== items[index - 1].from).map((item, index) => ({ ...item, index }));
    const unchanged = unique.length === value.items.length && unique.every((item, index) => Object.keys(item).every(key => item[key as keyof MarkdownOutlineItem] === value.items[index][key as keyof MarkdownOutlineItem]));
    return { items: unchanged ? value.items : unique, parsedTo: tree.length, pending: combined.filter(span => span.to > tree.length).map(span => ({ from: Math.max(span.from, tree.length), to: span.to })) };
  },
});
