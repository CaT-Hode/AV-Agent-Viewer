/** Source positions are JavaScript/CodeMirror UTF-16 offsets, never rendered DOM offsets. */
export type TextEditorChange = { documentId: string; viewId: string; baseRevision: number; fromText: string };
export type TextEditorState = { documentId: string; viewId: string; composing: boolean; dirty?: boolean };
export type TextEditorBarrier = { documentId?: string; viewId?: string; checkOnly: boolean; waitUntil(promise: Promise<void>): void };
export type TextReplacement = { from: number; to: number; expectedText: string; text: string };
export type TextDraft = { documentId: string; viewId: string; baseRevision: number; baseText: string; text: string; generation: number; conflict?: string };

export function textReplacement(before: string, after: string): TextReplacement | undefined {
  if (before === after) return undefined;
  let from = 0, beforeEnd = before.length, afterEnd = after.length;
  // Equal rope materializations often differ by one key near the end of a
  // large file. Let the engine compare chunks instead of visiting every UTF-16
  // unit in JavaScript on each synchronization boundary.
  const block = 64 * 1024;
  while (from + block <= beforeEnd && from + block <= afterEnd && before.slice(from, from + block) === after.slice(from, from + block)) from += block;
  while (from < beforeEnd && from < afterEnd && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  // A source operation must not split a surrogate pair even when only its low half changes.
  if (from && /[\uD800-\uDBFF]/.test(before[from - 1]) && /[\uDC00-\uDFFF]/.test(before[from] ?? '')) from--;
  while (beforeEnd - block >= from && afterEnd - block >= from && before.slice(beforeEnd - block, beforeEnd) === after.slice(afterEnd - block, afterEnd)) { beforeEnd -= block; afterEnd -= block; }
  while (beforeEnd > from && afterEnd > from && before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)) { beforeEnd--; afterEnd--; }
  if (beforeEnd < before.length && beforeEnd > from && /[\uD800-\uDBFF]/.test(before[beforeEnd - 1]) && /[\uDC00-\uDFFF]/.test(before[beforeEnd])) { beforeEnd++; afterEnd++; }
  return { from, to: beforeEnd, expectedText: before.slice(from, beforeEnd), text: after.slice(from, afterEnd) };
}

/** Conservative three-way merge. Ambiguous/overlapping edits never overwrite either source. */
export function mergeTextDraft(base: string, local: string, remote: string): { text: string; operation?: TextReplacement } | undefined {
  if (remote === base) return { text: local, operation: textReplacement(remote, local) };
  if (local === base || local === remote) return { text: remote };
  const ours = textReplacement(base, local)!, theirs = textReplacement(base, remote)!;
  const insertion = (value: TextReplacement) => value.from === value.to;
  const overlap = insertion(ours) ? ours.from >= theirs.from && ours.from <= theirs.to
    : insertion(theirs) ? theirs.from >= ours.from && theirs.from <= ours.to
    : Math.max(ours.from, theirs.from) < Math.min(ours.to, theirs.to);
  if (overlap) return undefined;
  const delta = theirs.to <= ours.from ? theirs.text.length - (theirs.to - theirs.from) : 0;
  const from = ours.from + delta, to = ours.to + delta;
  if (remote.slice(from, to) !== ours.expectedText) return undefined;
  const text = remote.slice(0, from) + ours.text + remote.slice(to);
  return { text, operation: textReplacement(remote, text) };
}

export async function textEditorBarrier(options: Omit<TextEditorBarrier, 'waitUntil'>): Promise<void> {
  const waiting: Promise<void>[] = [];
  window.dispatchEvent(new CustomEvent<TextEditorBarrier>('agentviewer:text-editor-barrier', { detail: { ...options, waitUntil: promise => waiting.push(promise) } }));
  await Promise.all(waiting);
}
