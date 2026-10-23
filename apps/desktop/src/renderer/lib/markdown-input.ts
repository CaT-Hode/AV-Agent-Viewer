import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState, Prec, Transaction, type StateCommand } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { CompletionContext, pickedCompletion, type CompletionSource } from '@codemirror/autocomplete';
import { html, htmlCompletionSource } from '@codemirror/lang-html';

const completionHtml = html({ matchClosingTags: false, autoCloseTags: false }).language;
const htmlTags = new Set('strong b em i u s del mark sub sup kbd small span a br hr img p div section blockquote h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr th td pre code details summary audio video source iframe input'.split(' '));
const htmlVoidTags = new Set('br hr img source input'.split(' '));
const htmlAttributes = new Set('id class title style lang dir href target rel src alt width height controls loop muted poster preload open type checked disabled colspan rowspan scope align'.split(' '));

/** Reuse the HTML grammar and completion schema on a bounded source window.
 * Incomplete inline tags are plain Markdown paragraphs, so the normal mounted
 * HTML completion source cannot recognize their attributes or closing tags. */
export function markdownHtmlCompletion(autoPair: () => boolean): CompletionSource {
  return context => {
    const { state, pos } = context;
    if (state.readOnly || state.selection.ranges.length !== 1 || context.view?.composing) return null;
    const offset = Math.max(0, pos - 2048), before = state.sliceDoc(offset, pos), line = state.doc.lineAt(pos);
    const emptyLine = context.explicit && line.from >= offset && /^[ \t]*$/.test(before.slice(line.from - offset));
    if (!before.includes('<') && !emptyLine) return null;
    const tree = ensureSyntaxTree(state, pos, 25);
    if (!tree) return null;
    for (let node = tree.resolveInner(pos, -1); node; node = node.parent!) if (['CodeBlock', 'FencedCode', 'InlineCode', 'InlineMath', 'BlockMath', 'Frontmatter', 'Link', 'Image', 'Autolink', 'CommentBlock', 'ProcessingInstructionBlock'].includes(node.name)) return null;
    const fragment = EditorState.create({ doc: before + state.sliceDoc(pos, Math.min(state.doc.length, pos + 2048)), extensions: completionHtml });
    const local = pos - offset, at = ensureSyntaxTree(fragment, local, 25)?.resolveInner(local, -1);
    let tag = at;
    while (tag && !['OpenTag', 'SelfClosingTag', 'CloseTag', 'IncompleteTag', 'IncompleteCloseTag', 'StartTag', 'StartCloseTag'].includes(tag.name)) tag = tag.parent ?? undefined;
    if (!tag && !emptyLine) return null;
    if (tag) { let slash = offset + tag.from; while (slash > 0 && state.doc.sliceString(slash - 1, slash) === '\\') slash--; if ((offset + tag.from - slash) % 2) return null; }
    const result = htmlCompletionSource(new CompletionContext(fragment, local, context.explicit));
    if (!result) return null;
    const closing = !!tag && /CloseTag$/.test(tag.name), currentClose = tag?.parent?.getChild('CloseTag')?.getChild('TagName');
    const existingClose = currentClose ? fragment.sliceDoc(currentClose.from, currentClose.to).toLowerCase() : '';
    const hasAttributes = !!tag?.getChild('Attribute'), selfClosing = !!tag && /\/\s*>$/.test(fragment.sliceDoc(tag.from, tag.to));
    const candidates = [...result.options];
    // The upstream source treats an unfinished CloseTag as already closed.
    // Retain its schema, using the same HTML tree to offer its real ancestors.
    if (closing && !candidates.length) for (let element = tag?.parent; element; element = element.parent) {
      const nameNode = element.name === 'Element' ? element.getChild('OpenTag')?.getChild('TagName') : null;
      if (!nameNode) continue;
      const label = fragment.sliceDoc(nameNode.from, nameNode.to);
      if (!candidates.some(option => option.label === label)) candidates.push({ label, type: 'type', apply: label + (/^[ \t]*>/.test(fragment.sliceDoc(result.to ?? local, (result.to ?? local) + 64)) ? '' : '>') });
    }
    const options = candidates.filter(option => option.type === 'type' ? htmlTags.has(option.label.replace(/^<\/?|^\//, '').replace(/>$/, '').toLowerCase()) : option.type !== 'property' || htmlAttributes.has(option.label) || option.label.startsWith('aria-')).map(option => {
      if (option.type !== 'type' || closing || option.label.startsWith('/') || option.label.startsWith('</')) return option;
      const name = option.label.replace(/^</, '').replace(/>$/, '');
      return { ...option, label: name, apply(view: EditorView, completion: typeof option, from: number, to: number) {
        const leading = option.label.startsWith('<') ? '<' : '';
        if (hasAttributes || selfClosing) { view.dispatch({ changes: { from, to, insert: leading + name }, selection: { anchor: from + leading.length + name.length }, annotations: pickedCompletion.of(completion), userEvent: 'input.complete' }); return; }
        const end = /^[ \t]*>/.exec(view.state.sliceDoc(to, Math.min(view.state.doc.length, to + 64))), opening = leading + name + '>';
        const pair = autoPair() && !htmlVoidTags.has(name.toLowerCase()) && existingClose !== name.toLowerCase();
        view.dispatch({ changes: { from, to: to + (end?.[0].length ?? 0), insert: opening + (pair ? '</' + name + '>' : '') }, selection: EditorSelection.cursor(from + opening.length), annotations: [pickedCompletion.of(completion), isolateHistory.of('full')], userEvent: 'input.complete', scrollIntoView: true });
      } };
    });
    return options.length ? { ...result, from: offset + result.from, to: result.to === undefined ? undefined : offset + result.to, options } : null;
  };
}

/** Continue block containers without creating another list item. */
function blockContinuation(prefix: string): string | undefined {
  let continuation = '', offset = 0;
  while (offset < prefix.length) {
    const rest = prefix.slice(offset), whitespace = /^[ \t]+/.exec(rest);
    if (whitespace) { continuation += whitespace[0]; offset += whitespace[0].length; continue; }
    if (rest[0] === '>') { continuation += '>'; offset++; continue; }
    const list = /^(?:[-+*]|\d+[.)])([ \t]+)/.exec(rest);
    if (!list) return undefined;
    continuation += ' '.repeat(list[0].length - list[1].length) + list[1]; offset += list[0].length;
  }
  return continuation;
}

/** A standalone TeX opener is not an ordinary paired Markdown bracket. */
export function markdownMathBracketInput(enabled: () => boolean) {
  return Prec.highest(EditorView.inputHandler.of((view, from, to, text, insert) => {
    if (!enabled() || text !== '[' || from !== to || view.composing || view.compositionStarted || view.state.readOnly) return false;
    const line = view.state.doc.lineAt(from);
    if (from !== line.to || !line.text.endsWith('\\') || blockContinuation(line.text.slice(0, -1)) === undefined) return false;
    const tree = ensureSyntaxTree(view.state, from, 25);
    if (!tree) return false;
    for (let node = tree.resolveInner(from, -1); node; node = node.parent!) if (['CodeBlock', 'FencedCode', 'BlockMath', 'Frontmatter', 'HTMLBlock'].includes(node.name)) return false;
    view.dispatch(insert()); return true;
  }));
}

/** Explicit block openers expand in one undoable transaction. This command
 * does not own ordinary Enter, single-dollar amounts, or inline delimiters. */
export const markdownBlockEnter: StateCommand = ({ state, dispatch }) => {
  const selected = state.selection.main;
  if (state.readOnly || state.selection.ranges.length !== 1 || !selected.empty) return false;
  const line = state.doc.lineAt(selected.head);
  if (selected.head !== line.to) return false;
  const opening = /(\$\$|\\\[|`{3,}[^`]*|~{3,}.*)[ \t]*$/.exec(line.text);
  if (!opening) return false;
  const continuation = blockContinuation(line.text.slice(0, opening.index));
  if (continuation === undefined) return false;
  const fence = /^(`{3,}|~{3,})/.exec(opening[1])?.[1];
  const closer = fence ?? (opening[1] === '$$' ? '$$' : '\\]'), from = line.from + opening.index;
  // Do not guess the enclosing context when a distant document position has
  // not been parsed yet. The normal Enter command remains available.
  const tree = ensureSyntaxTree(state, line.to, 25);
  if (!tree) return false;
  let existingCloser = false;
  for (let node = tree.resolveInner(from + 1, 1); node; node = node.parent!) {
    if (['CodeBlock', 'Frontmatter', 'HTMLBlock'].includes(node.name)) return false;
    if (node.name !== 'FencedCode' && node.name !== 'BlockMath') continue;
    if (node.from !== from || (node.name === 'FencedCode') !== !!fence) return false;
    const mark = fence ? 'CodeMark' : 'MathMark';
    existingCloser = node.getChildren(mark).some(child => child.from > from);
  }
  const body = '\n' + continuation;
  dispatch(state.update({ changes: { from: line.to, insert: body + (existingCloser ? '' : '\n' + continuation + closer) },
    selection: EditorSelection.cursor(line.to + body.length), scrollIntoView: true,
    annotations: [Transaction.userEvent.of('input.block'), isolateHistory.of('full')],
  }));
  return true;
};

/** Chromium's normal DOM-diff input path compares an entire changed line.
 * For an ordinary, cancellable insertion in a huge line we already have the
 * exact replacement from beforeinput. Keep CodeMirror's input handlers
 * (including bracket pairing), multiple ranges, transaction filters and undo;
 * leave composition, spellcheck replacements and unusual target ranges to its
 * native path. This deliberately does not synthesize IME transactions. */
export const boundedMarkdownInput = EditorView.domEventHandlers({ beforeinput(event, view) {
  if (!event.cancelable || event.inputType !== 'insertText' || event.data === null || event.isComposing || view.compositionStarted || view.composing || view.state.readOnly) return false;
  const selection = view.state.selection.main;
  if (view.state.doc.lineAt(selection.head).length < 64 * 1024) return false;
  const ranges = event.getTargetRanges();
  if (ranges.length > 1) return false;
  if (ranges.length) {
    const range = ranges[0];
    try { if (view.posAtDOM(range.startContainer, range.startOffset) !== selection.from || view.posAtDOM(range.endContainer, range.endOffset) !== selection.to) return false; }
    catch { return false; }
  }
  let transaction: ReturnType<typeof view.state.update> | undefined;
  const insert = () => transaction ??= view.state.update(view.state.replaceSelection(event.data!), { userEvent: 'input.type', scrollIntoView: true });
  // Returning true from a DOM handler prevents the browser's mutation only
  // after every configured inputHandler has had its normal opportunity.
  if (!view.state.facet(EditorView.inputHandler).some(handler => handler(view, selection.from, selection.to, event.data!, insert))) view.dispatch(insert());
  return true;
} });
