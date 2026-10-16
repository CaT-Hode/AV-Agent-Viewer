import { EditorView } from '@codemirror/view';

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
