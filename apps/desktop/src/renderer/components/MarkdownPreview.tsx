import { useEffect, useRef } from 'react';
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdownLivePreview, refreshMarkdownPreview } from '../lib/markdown-live-preview';
import { typoraMarkdownSyntax } from '../lib/markdown-syntax';
import { boundedMarkdownLanguage } from '../lib/markdown-language';
import { activateMarkdownSurface, markdownSurface, previewSourcePosition } from '../lib/markdown-surfaces';
import { textReplacement } from '../lib/text-drafts';
import type { TextEditorContext } from './TextEditor';

const synchronizePreview = Annotation.define<boolean>();
type Props = { value: string; documentId: string; viewId: string; revision: number; pending?: boolean; onContext(context: TextEditorContext): void };

/** A virtual, read-only projection. Only prop synchronization can change this
 * document. It owns no command, history, save barrier or authoring listeners. */
export function MarkdownPreview(props: Props) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null), latest = useRef(props); latest.current = props;
  const synchronize = useRef<() => void>(() => {});
  const republish = useRef<() => void>(() => {});
  useEffect(() => {
    let frame = 0, previous = latest.current.value, selected = { from: 0, to: 0 }, synchronizing = false, eol = previous.includes('\r\n') ? '\r\n' : '\n';
    const publish = () => {
      frame = 0; const actor = synchronizing ? 'agent' : 'human'; synchronizing = false; if (editor.current !== view || markdownSurface(props.viewId) !== 'preview') return;
      const selection = window.getSelection(), contained = !!selection?.anchorNode && !!selection.focusNode && view.contentDOM.contains(selection.anchorNode) && view.contentDOM.contains(selection.focusNode);
      const from = contained ? previewSourcePosition(view, selection!.anchorNode!, selection!.anchorOffset) : selected.from;
      const to = contained ? previewSourcePosition(view, selection!.focusNode!, selection!.focusOffset) : selected.to;
      const start = Math.min(from ?? 0, to ?? from ?? 0), end = Math.max(from ?? 0, to ?? from ?? 0);
      if (contained && from !== undefined && to !== undefined) selected = { from: start, to: end };
      const detail = { viewId: props.viewId, from: start, to: end, accepted: false };
      if (from !== undefined && to !== undefined) window.dispatchEvent(new CustomEvent('agentviewer:markdown-preview-selection', { detail }));
      const sourceOffset = (position: number) => position + (eol === '\r\n' ? view.state.doc.lineAt(position).number - 1 : 0);
      const rect = contained && selection!.rangeCount ? selection!.getRangeAt(0).getBoundingClientRect() : undefined, visible = view.visibleRanges[0];
      latest.current.onContext({ actor, ready: !latest.current.pending && detail.accepted, composing: false, from: sourceOffset(start), to: sourceOffset(end), text: contained && from !== undefined && to !== undefined ? view.state.doc.sliceString(start, end, eol) : '', visibleText: visible ? view.state.doc.sliceString(visible.from, Math.min(visible.to, visible.from + 24000), eol) : '', scrollTop: view.scrollDOM.scrollTop || view.dom.closest<HTMLElement>('.document-content')?.scrollTop || 0, ...(rect ? { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}) });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(publish); };
    const activate = () => { activateMarkdownSurface(props.viewId, 'preview'); schedule(); };
    const link = (event: MouseEvent) => {
      activate(); if (!event.ctrlKey && !event.metaKey) return false;
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-markdown-link],[data-markdown-reference],[data-markdown-footnote]'); if (!target) return false;
      event.preventDefault(); let href = target.dataset.markdownLink ?? '', offset = 0;
      for (const line of view.state.doc.iterLines()) {
        if (target.dataset.markdownFootnote && line.startsWith('[^' + target.dataset.markdownFootnote + ']:')) { view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: 'center' }) }); return true; }
        if (target.dataset.markdownReference) { const definition = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))/.exec(line); if (definition?.[1].trim().toLowerCase() === target.dataset.markdownReference.trim().toLowerCase()) { href = definition[2] ?? definition[3]; break; } }
        if (!target.dataset.markdownFootnote && !target.dataset.markdownReference) break; offset += line.length + 1;
      }
      if (href.startsWith('#')) { let wanted: string; try { wanted = decodeURIComponent(href.slice(1)); } catch { return true; } let destination: number | undefined; syntaxTree(view.state).iterate({ enter: node => { if (destination === undefined && /^(ATX|Setext)Heading/.test(node.name) && view.state.sliceDoc(node.from, node.to).replace(/^#{1,6}\s+/, '').replace(/\n(?:=+|-+)\s*$/, '').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim().replace(/\s+/g, '-') === wanted.toLowerCase()) destination = node.from; } }); if (destination !== undefined) view.dispatch({ effects: EditorView.scrollIntoView(destination, { y: 'start', yMargin: 48 }) }); }
      else if (href) window.dispatchEvent(new CustomEvent('agentviewer:markdown-link', { detail: { documentId: props.documentId, viewId: props.viewId, href } })); return true;
    };
    const view = new EditorView({ parent: host.current!, dispatchTransactions: (transactions, target) => { if (transactions.some(transaction => transaction.docChanged && !transaction.annotation(synchronizePreview))) return; target.update(transactions); }, state: EditorState.create({ doc: previous.replace(/\r\n?/g, '\n'), extensions: [
      boundedMarkdownLanguage(markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [typoraMarkdownSyntax] })), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping,
      EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': 'Markdown 只读预览' }),
      EditorState.transactionFilter.of(transaction => transaction.docChanged && !transaction.annotation(synchronizePreview) ? [] : transaction),
      markdownLivePreview(props.documentId), EditorView.updateListener.of(update => { if (update.docChanged) selected = { from: update.changes.mapPos(selected.from), to: update.changes.mapPos(selected.to) }; if (update.docChanged || update.selectionSet || update.viewportChanged) schedule(); }),
      EditorView.domEventHandlers({ focus: () => { activate(); return false; }, mousedown: link, scroll: () => { if (markdownSurface(props.viewId) === 'preview') schedule(); return false; } }),
    ] }) });
    editor.current = view;
    republish.current = schedule;
    synchronize.current = () => { if (latest.current.value === previous) return; const change = textReplacement(view.state.doc.toString(), latest.current.value.replace(/\r\n?/g, '\n')); previous = latest.current.value; eol = previous.includes('\r\n') ? '\r\n' : '\n'; if (change) { synchronizing = true; view.dispatch({ changes: { from: change.from, to: change.to, insert: change.text }, annotations: [synchronizePreview.of(true), Transaction.addToHistory.of(false)] }); } };
    const nativeSelection = () => { const selection = window.getSelection(); if (selection?.anchorNode && view.contentDOM.contains(selection.anchorNode)) { activateMarkdownSurface(props.viewId, 'preview'); schedule(); } };
    const observer = new MutationObserver(() => { if (editor.current === view) view.dispatch({ effects: refreshMarkdownPreview.of(null) }); }); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-document-paper'] });
    document.addEventListener('selectionchange', nativeSelection);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('selectionchange', nativeSelection); republish.current = () => {}; view.destroy(); editor.current = null; if (markdownSurface(props.viewId) === 'preview') activateMarkdownSurface(props.viewId, 'source'); };
  }, [props.documentId, props.viewId]);
  useEffect(() => { synchronize.current(); }, [props.value]);
  useEffect(() => { republish.current(); }, [props.pending, props.revision]);
  return <div className="markdown-editor markdown-live markdown-readonly-preview" ref={host} data-markdown-preview={props.viewId} />;
}
