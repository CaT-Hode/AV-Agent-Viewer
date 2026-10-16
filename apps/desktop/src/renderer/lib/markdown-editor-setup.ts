import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, ViewPlugin, type DecorationSet, type ViewUpdate, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, keymap } from '@codemirror/view';
import { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from '@codemirror/language';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';

const special = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202d\u202e\u2066\u2067\u2069\ufeff\ufff9-\ufffc]/g;
class SpecialCharacter extends WidgetType {
  constructor(readonly character: string) { super(); }
  eq(other: SpecialCharacter) { return other.character === this.character; }
  toDOM() { const span = document.createElement('span'), code = this.character.charCodeAt(0); span.className = 'cm-specialChar'; span.textContent = code < 32 ? String.fromCharCode(0x2400 + code) : '•'; span.title = 'Control character 0x' + code.toString(16); span.setAttribute('aria-label', span.title); return span; }
  ignoreEvent() { return false; }
}
const specialCharacters = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.read(view); }
  read(view: EditorView) {
    const ranges = [];
    for (const { from, to } of view.visibleRanges) {
      // MatchDecorator.updateRange executes its regex against the whole line
      // even when the visible portion is tiny. Scan only rendered ranges.
      const text = view.state.doc.sliceString(from, to); special.lastIndex = 0;
      for (let match; (match = special.exec(text));) ranges.push(Decoration.replace({ widget: new SpecialCharacter(match[0]) }).range(from + match.index, from + match.index + match[0].length));
    }
    return Decoration.set(ranges, true);
  }
  update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = this.read(update.view); }
}, { decorations: plugin => plugin.decorations });

/** Keep basicSetup's editing features while replacing its whole-line special
 * character matcher with a viewport-bounded equivalent for desktop Chromium. */
export const markdownEditorSetup = [
  lineNumbers(), highlightActiveLineGutter(), specialCharacters, history(), foldGutter(), drawSelection(), dropCursor(),
  EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), closeBrackets(), autocompletion(),
  rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap]),
];
