import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';

export function TextEditor({ value, format, onChange, onContext }: { value: string; format: string; onChange(text: string): void; onContext(update: { text: string; from: number; to: number; scrollTop: number; visibleText: string; rect?: {x:number;y:number;width:number;height:number} }): void }) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null), callbacks = useRef({ onChange, onContext }); callbacks.current = { onChange, onContext };
  const externalUpdate = useRef(false);
  useEffect(() => {
    const emit = (view: EditorView) => { const selection = view.state.selection.main; const range = view.visibleRanges[0]; const box=view.coordsAtPos(selection.to); callbacks.current.onContext({ rect:box?{x:box.left,y:box.top,width:box.right-box.left,height:box.bottom-box.top}:undefined, text: view.state.sliceDoc(selection.from, selection.to), from: selection.from, to: selection.to, scrollTop: view.scrollDOM.scrollTop, visibleText: range ? view.state.sliceDoc(range.from, range.to) : '' }); };
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: [basicSetup, format === 'html' ? html() : markdown(), EditorView.lineWrapping, EditorView.theme({ '&': { height: '100%', fontSize: '14px' }, '.cm-content': { fontFamily: 'Cascadia Code, Consolas, monospace', padding: '16px 0' }, '.cm-gutters': { background: '#f7f8fb', border: '0' }, '.cm-scroller': { overflow: 'auto' } }), EditorView.updateListener.of(update => { if (update.docChanged && !externalUpdate.current) callbacks.current.onChange(update.state.doc.toString()); if (update.docChanged || update.selectionSet || update.viewportChanged) emit(update.view); }), EditorView.domEventHandlers({ scroll: (_event, view) => { emit(view); return false; } })] }) });
    editor.current = view; emit(view); return () => { view.destroy(); editor.current = null; };
  }, [format]);
  useEffect(() => { const view = editor.current; if (view && view.state.doc.toString() !== value) { externalUpdate.current = true; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); externalUpdate.current = false; } }, [value]);
  return <div className="source-editor" ref={host} />;
}
