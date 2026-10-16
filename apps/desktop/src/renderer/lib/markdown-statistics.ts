import { StateField, type Text } from '@codemirror/state';

export type MarkdownStatistics = { words: number; characters: number; lines: number };
type Span = { from: number; to: number };
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const alphabetic = /[\p{L}\p{N}]/u;
function kind(character: string) {
  const code = character.codePointAt(0)!;
  if (code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122) return 1;
  if (character === "'" || character === '’' || character === '-') return 2;
  if (code < 128) return 0;
  return cjk.test(character) ? 3 : alphabetic.test(character) ? 1 : 0;
}
function merge(spans: Span[]) {
  const result: Span[] = [];
  for (const span of spans.sort((a, b) => a.from - b.from)) { const previous = result.at(-1); if (previous && span.from <= previous.to) previous.to = Math.max(previous.to, span.to); else result.push({ ...span }); }
  return result;
}
function boundary(document: Text, position: number, side: -1 | 1) {
  if (position <= 0 || position >= document.length) return position;
  return /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(document.sliceString(position - 1, position + 1)) ? position + side : position;
}
function count(document: Text, from = 0, to = document.length) {
  let words = 0, characters = 0, previous = 0, beforePrevious = 0;
  // A word's start depends on at most its two predecessors. Context is read
  // but never counted, so adjacent incremental windows compose exactly.
  for (const character of document.sliceString(Math.max(0, from - 4), from)) { beforePrevious = previous; previous = kind(character); }
  const cursor = document.iterRange(from, to);
  while (!cursor.next().done) for (const character of cursor.value) {
    const current = kind(character); characters++;
    if (current === 3 || current === 1 && previous !== 1 && !(previous === 2 && beforePrevious === 1)) words++;
    beforePrevious = previous; previous = current;
  }
  return { words, characters };
}

/** Count source including code and metadata. Editing recounts changed text plus
 * two surrounding codepoints, even in multi-megabyte lines. Cursor, scroll and
 * preview refreshes do no counting or source serialization. */
export const markdownStatistics = StateField.define<MarkdownStatistics>({
  create: state => ({ ...count(state.doc), lines: state.doc.lines }),
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    const before = transaction.startState.doc, after = transaction.state.doc, oldSpans: Span[] = [], newSpans: Span[] = [];
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      oldSpans.push({ from: boundary(before, Math.max(0, fromA - 4), -1), to: boundary(before, Math.min(before.length, toA + 4), 1) });
      newSpans.push({ from: boundary(after, Math.max(0, fromB - 4), -1), to: boundary(after, Math.min(after.length, toB + 4), 1) });
    });
    let words = value.words, characters = value.characters;
    for (const span of merge(oldSpans)) { const counted = count(before, span.from, span.to); words -= counted.words; characters -= counted.characters; }
    for (const span of merge(newSpans)) { const counted = count(after, span.from, span.to); words += counted.words; characters += counted.characters; }
    return { words, characters, lines: after.lines };
  },
});
