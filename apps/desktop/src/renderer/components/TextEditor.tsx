import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { languages } from '@codemirror/language-data';
import { undo, redo, undoDepth, redoDepth, indentWithTab, isolateHistory } from '@codemirror/commands';
import { openSearchPanel, search, selectNextOccurrence } from '@codemirror/search';
import { syntaxTree } from '@codemirror/language';
import { markdownLivePreview, refreshMarkdownPreview } from '../lib/markdown-live-preview';
import { MARKDOWN_COMMANDS, markdownTransformRange, type MarkdownCommandEventDetail, type MarkdownCommandName } from '../../../../../packages/markdown/src/commands';
import { textReplacement, type TextEditorBarrier, type TextEditorChange } from '../lib/text-drafts';
import { call } from '../lib/transport';
import { markdownStatistics, type MarkdownStatistics } from '../lib/markdown-statistics';
import { markdownOutline } from '../lib/markdown-outline';
import { typoraMarkdownSyntax } from '../lib/markdown-syntax';
import { boundedMarkdownLanguage } from '../lib/markdown-language';
import { MARKDOWN_EXTERNAL_EDIT_EVENT, type MarkdownExternalEdit } from '../lib/markdown-external-edit';
import { activateMarkdownSurface, markdownSurface } from '../lib/markdown-surfaces';
import '../markdown-editor.css';

export type TextEditorContext = { text: string; from: number; to: number; scrollTop: number; visibleText: string; actor: 'human' | 'agent'; ready: boolean; composing: boolean; rect?: { x: number; y: number; width: number; height: number } };
type Props = { value: string; format: string; live?: boolean; viewId?: string; documentId?: string; revision?: number; pending?: boolean; onChange(text: string, change?: TextEditorChange): void; onContext(update: TextEditorContext): void };
const normalize = (text: string) => text.replace(/\r\n?/g, '\n');
const editingKeys: [string, MarkdownCommandName][] = [
  ['Mod-b', 'bold'], ['Mod-i', 'italic'], ['Mod-u', 'underline'], ['Alt-Shift-5', 'strike'], ['Mod-Shift-`', 'code'],
  ['Mod-k', 'link'], ['Mod-Shift-i', 'image'], ['Mod-Shift-k', 'codeBlock'], ['Mod-Shift-m', 'mathBlock'], ['Mod-Shift-q', 'quote'],
  ['Mod-Shift-[', 'ordered'], ['Mod-Shift-]', 'bullet'], ['Mod-t', 'table'], ['Mod-\\', 'clear'],
  ...Array.from({ length: 7 }, (_, level) => ['Mod-' + level, 'heading' + level] as [string, MarkdownCommandName]),
];

/** One persistent source editor owns both the live document and source mode. */
export function TextEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null), latest = useRef(props); latest.current = props;
  const liveMode = useRef(new Compartment()), externalUpdate = useRef(false), composing = useRef(false), eol = useRef('\n');
  const [statistics, setStatistics] = useState<MarkdownStatistics>({ words: 0, characters: 0, lines: 1 });
  const emitRef = useRef<() => void>(() => {});
  const synchronizeRef = useRef<() => void>(() => {});
  useEffect(() => {
    eol.current = latest.current.value.includes('\r\n') ? '\r\n' : '\n';
    // CodeMirror documents are immutable. Selection and scroll updates reuse
    // the same tree, so they need not serialize the entire document again.
    let serializedDocument: EditorState['doc'] | undefined, serializedText = '', emittedText = latest.current.value;
    let changeTimer: ReturnType<typeof setTimeout> | undefined, localDirty = false, synchronized = true, contextFrame = 0, sourceRevision = latest.current.revision ?? 0;
    let externalEdit: { requestId: string; baseRevision: number; document: EditorState['doc']; revision?: number } | undefined, externalHuman = false;
    const externalConflict = () => window.dispatchEvent(new CustomEvent('agentviewer:markdown-error', { detail: { viewId: latest.current.viewId, message: '选区操作同步期间内容已变化；本地草稿已保留，该操作未混入当前撤销记录。' } }));
    let publishedOutline: unknown;
    const identity = { documentId: latest.current.documentId, viewId: latest.current.viewId, revision: latest.current.revision ?? 0 }, imports = new Map<string, { from: number; to: number }>(), importTasks = new Set<Promise<void>>();
    const spelling = new Compartment(), pairs = new Compartment(), bindings = new Compartment(); let spellcheck = true, autoPair = true;
    let preferences: { imageRoot?: string; upload?: unknown; keybindings?: Record<string, string> } = {};
    const serialize = (state: EditorState) => {
      if (serializedDocument !== state.doc) { serializedDocument = state.doc; serializedText = state.doc.sliceString(0, state.doc.length, eol.current); }
      return serializedText;
    };
    const sourceOffset = (state: EditorState, position: number) => position + (eol.current === '\r\n' ? state.doc.lineAt(position).number - 1 : 0);
    const stateChanged = () => window.dispatchEvent(new CustomEvent('agentviewer:text-editor-state', { detail: { documentId: latest.current.documentId, viewId: latest.current.viewId, composing: composing.current, dirty: localDirty } }));
    const publishOutline = (state: EditorState, force = false) => { if (latest.current.format !== 'markdown') return; const items = state.field(markdownOutline).items; if (force || items !== publishedOutline) { publishedOutline = items; window.dispatchEvent(new CustomEvent('agentviewer:markdown-outline', { detail: { documentId: identity.documentId, viewId: identity.viewId, items } })); } };
    const flushWidget = (view: EditorView) => { for (const input of view.dom.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-markdown-cell-dirty="true"]')) if (input.isConnected) input.dispatchEvent(new Event('change')); };
    const flush = (view: EditorView) => {
      if (changeTimer) clearTimeout(changeTimer); changeTimer = undefined;
      if (!localDirty || composing.current || view.composing) return;
      const started = performance.now();
      const text = serialize(view.state), before = emittedText;
      if (text === before) { localDirty = false; stateChanged(); return; }
      emittedText = text; localDirty = false;
      synchronized = false;
      latest.current.onChange(text, identity.documentId && identity.viewId ? { documentId: identity.documentId, viewId: identity.viewId, baseRevision: sourceRevision, fromText: before } : undefined);
      stateChanged();
      if (window.agentViewer?.testMode) performance.measure('agentviewer:markdown-flush', { start: started, end: performance.now(), detail: { characters: view.state.doc.length } });
    };
    const emit = (view: EditorView, actor: 'human' | 'agent' = 'human') => {
      if (markdownSurface(identity.viewId) !== 'preview') {
      const selected = view.state.selection.main, visible = view.visibleRanges[0], box = view.coordsAtPos(selected.to);
      const native = window.getSelection(), nativeRect = !selected.empty && native?.rangeCount && view.dom.contains(native.anchorNode) ? native.getRangeAt(0).getBoundingClientRect() : undefined;
      const rect = nativeRect && nativeRect.width ? nativeRect : box;
      const scroll = view.scrollDOM.scrollHeight > view.scrollDOM.clientHeight + 2 ? view.scrollDOM : view.dom.closest<HTMLElement>('.document-content');
      latest.current.onContext({ actor, ready: !latest.current.pending && !composing.current && !localDirty && synchronized, composing: composing.current,
        rect: rect ? { x: rect.left, y: rect.top, width: Math.max(1, rect.right - rect.left), height: rect.bottom - rect.top } : undefined,
        text: view.state.doc.sliceString(selected.from, selected.to, eol.current), from: sourceOffset(view.state, selected.from), to: sourceOffset(view.state, selected.to),
        scrollTop: scroll?.scrollTop ?? 0, visibleText: visible ? view.state.doc.sliceString(visible.from, Math.min(visible.to, visible.from + 24000), eol.current) : '',
      });
      }
      window.dispatchEvent(new CustomEvent('agentviewer:markdown-editor-history', { detail: { viewId: latest.current.viewId, canUndo: undoDepth(view.state) > 0, canRedo: redoDepth(view.state) > 0 } }));
      setStatistics(view.state.field(markdownStatistics));
    };
    const format = (view: EditorView, command: MarkdownCommandName, value?: unknown) => {
      if (view.composing || composing.current) return false;
      const range = view.state.selection.main;
      let node = syntaxTree(view.state).resolveInner(range.from, 1), enclosing: { from: number; to: number } | undefined;
      while (node.parent) { if (['Table', 'FencedCode'].includes(node.name)) { enclosing = { from: node.from, to: node.to }; break; } node = node.parent; }
      const result = markdownTransformRange(view.state.doc, range.from, range.to, command, value, enclosing);
      if (!result) return false;
      view.dispatch({ changes: { from: result.from, to: result.to, insert: result.insert }, selection: result.selection ? EditorSelection.range(result.selection.anchor, result.selection.head) : undefined, scrollIntoView: true, userEvent: 'input.format' });
      view.focus(); return true;
    };
    const execute = (command: string, value?: unknown): boolean => {
      if (composing.current || view.composing) return false;
      flushWidget(view);
      if (command === 'undo') return undo(view);
      if (command === 'redo') return redo(view);
      if (command === 'spellcheck') { spellcheck = !spellcheck; view.dispatch({ effects: spelling.reconfigure(EditorView.contentAttributes.of({ spellcheck: String(spellcheck) })) }); window.dispatchEvent(new CustomEvent('agentviewer:markdown-editor-history', { detail: { viewId: identity.viewId, spellcheck } })); return true; }
      if (command === 'autoPair') { autoPair = !autoPair; view.dispatch({ effects: pairs.reconfigure(Prec.highest(EditorState.languageData.of(() => [{ closeBrackets: { brackets: autoPair ? ['(', '[', '{', '"', "'", '`'] : [] } }]))) }); window.dispatchEvent(new CustomEvent('agentviewer:markdown-editor-history', { detail: { viewId: identity.viewId, autoPair } })); return true; }
      if (command === 'find' || command === 'replace') { openSearchPanel(view); if (command === 'replace') queueMicrotask(() => view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]')?.focus()); return true; }
      if (command === 'focus' || command === 'typewriter') { const active = host.current?.classList.toggle('markdown-' + command); window.dispatchEvent(new CustomEvent('agentviewer:markdown-editor-history', { detail: { viewId: latest.current.viewId, canUndo: undoDepth(view.state) > 0, canRedo: redoDepth(view.state) > 0, focus: host.current?.classList.contains('markdown-focus'), typewriter: host.current?.classList.contains('markdown-typewriter') } })); if (active && command === 'typewriter') view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) }); view.requestMeasure(); return true; }
      return format(view, command as MarkdownCommandName, value);
    };
    const keybindings = (overrides: Record<string, string> = {}) => Prec.highest(keymap.of([
      ...Object.entries(overrides).filter(([command, key]) => key && key.length < 100 && [...MARKDOWN_COMMANDS, 'find', 'replace', 'undo', 'redo', 'focus', 'typewriter', 'spellcheck', 'autoPair'].includes(command)).map(([command, key]) => ({ key, run: () => execute(command) })),
      ...(latest.current.format === 'markdown' ? editingKeys.filter(([, command]) => !Object.hasOwn(overrides, command)).map(([key, command]) => ({ key, run: (view: EditorView) => format(view, command) })) : []),
      ...(!Object.hasOwn(overrides, 'replace') ? [{ key: 'Mod-h', run: () => execute('replace') }] : []),
      { key: 'Mod-d', run: selectNextOccurrence }, ...(!Object.hasOwn(overrides, 'focus') ? [{ key: 'F8', run: () => execute('focus') }] : []), ...(!Object.hasOwn(overrides, 'typewriter') ? [{ key: 'F9', run: () => execute('typewriter') }] : []), indentWithTab,
    ]));
    const view: EditorView = new EditorView({ parent: host.current!, state: EditorState.create({ doc: normalize(latest.current.value), extensions: [
      basicSetup, latest.current.format === 'html' ? html() : boundedMarkdownLanguage(markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [typoraMarkdownSyntax] })), EditorView.lineWrapping, search({ top: true }), markdownStatistics, markdownOutline,
      spelling.of(EditorView.contentAttributes.of({ spellcheck: 'true' })), pairs.of([]),
      bindings.of(keybindings()),
      liveMode.current.of(latest.current.live && latest.current.format === 'markdown' ? markdownLivePreview(latest.current.documentId ?? '') : []),
      EditorView.updateListener.of(update => {
        publishOutline(update.state);
        if (update.docChanged && !externalUpdate.current) { if (!localDirty) { localDirty = true; stateChanged(); } if (changeTimer) clearTimeout(changeTimer); changeTimer = setTimeout(() => { flush(view); emit(view); }, 120); }
        if (update.docChanged && externalUpdate.current) { emittedText = latest.current.value; synchronized = true; }
        if (update.docChanged) for (const [id, range] of imports) imports.set(id, { from: update.changes.mapPos(range.from, -1), to: update.changes.mapPos(range.to, 1) });
        if (update.docChanged || update.selectionSet || update.viewportChanged) { if (contextFrame) cancelAnimationFrame(contextFrame); const actor = externalUpdate.current && !externalHuman ? 'agent' : 'human'; contextFrame = requestAnimationFrame(() => { contextFrame = 0; if (editor.current === view) emit(view, actor); }); }
        if (host.current?.classList.contains('markdown-typewriter') && update.docChanged && !externalUpdate.current) queueMicrotask(() => { if (editor.current === view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) }); });
      }),
      EditorView.domEventHandlers({
        focus: (_event, view) => { activateMarkdownSurface(identity.viewId, 'source'); emit(view); return false; },
        scroll: (_event, view) => { emit(view); return false; },
        compositionstart: () => { composing.current = true; stateChanged(); return false; },
        compositionend: () => { requestAnimationFrame(() => { if (editor.current !== view || view.composing) return; composing.current = false; flush(view); stateChanged(); emit(view); }); return false; },
        blur: (_event, view) => { if (!composing.current) { flushWidget(view); flush(view); } return false; },
        paste: (event, view) => importImages(event.clipboardData?.files, view, event),
        drop: (event, view) => importImages(event.dataTransfer?.files, view, event),
        mousedown: event => {
          activateMarkdownSurface(identity.viewId, 'source');
          if (!event.ctrlKey && !event.metaKey) return false;
          const target = (event.target as HTMLElement).closest<HTMLElement>('[data-markdown-link],[data-markdown-reference],[data-markdown-footnote]'); if (!target) return false; event.preventDefault();
          if (target.dataset.markdownFootnote) { let offset = 0; for (const line of view.state.doc.iterLines()) { const match = /^\[\^([^\]]+)\]:/.exec(line); if (match?.[1] === target.dataset.markdownFootnote) { view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'center' }) }); view.focus(); break; } offset += line.length + 1; } return true; }
          let href = target.dataset.markdownLink ?? '';
          if (target.dataset.markdownReference) { const wanted = target.dataset.markdownReference.trim().toLowerCase().replace(/\s+/g, ' '); for (const line of view.state.doc.iterLines()) { const match = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))/.exec(line); if (match?.[1].trim().toLowerCase().replace(/\s+/g, ' ') === wanted) { href = match[2] ?? match[3]; break; } } }
          if (href.startsWith('#')) navigateAnchor(href); else if (href) window.dispatchEvent(new CustomEvent('agentviewer:markdown-link', { detail: { documentId: latest.current.documentId, viewId: latest.current.viewId, href } })); return true;
        },
      }),
    ] }) });
    editor.current = view; emitRef.current = () => emit(view);
    synchronizeRef.current = () => {
      let humanHistory = false;
      if (externalEdit) {
        if (externalEdit.revision === undefined || (latest.current.revision ?? 0) < externalEdit.revision) { if ((latest.current.revision ?? 0) > externalEdit.baseRevision) synchronized = false; return; }
        humanHistory = latest.current.revision === externalEdit.revision && externalEdit.document === view.state.doc && !localDirty && !composing.current && !view.composing;
        if (!humanHistory) externalConflict();
        externalEdit = undefined;
      }
      if (localDirty || composing.current || view.composing) return;
      if (latest.current.value === emittedText) { synchronized = true; sourceRevision = latest.current.revision ?? sourceRevision; return; }
      const change = textReplacement(view.state.doc.toString(), normalize(latest.current.value));
      if (change) { externalUpdate.current = true; externalHuman = humanHistory; try { view.dispatch({ changes: { from: change.from, to: change.to, insert: change.text }, annotations: [Transaction.addToHistory.of(humanHistory), Transaction.userEvent.of(humanHistory ? 'input.selection-tool' : 'input.remote'), ...(humanHistory ? [isolateHistory.of('full')] : [])] }); } finally { externalUpdate.current = false; externalHuman = false; } }
      emittedText = latest.current.value;
      sourceRevision = latest.current.revision ?? sourceRevision;
      synchronized = true;
    };
    const externalEditEvent = (event: Event) => {
      const detail = (event as CustomEvent<MarkdownExternalEdit>).detail;
      if (latest.current.format !== 'markdown' || detail?.documentId !== identity.documentId || detail.viewId !== identity.viewId) return;
      if (detail.phase === 'pending') {
        if (externalEdit || localDirty || composing.current || view.composing || !synchronized || latest.current.revision !== detail.baseRevision) { externalConflict(); return; }
        externalEdit = { requestId: detail.requestId, baseRevision: detail.baseRevision, document: view.state.doc }; return;
      }
      if (externalEdit?.requestId !== detail.requestId || externalEdit.baseRevision !== detail.baseRevision) return;
      if (detail.phase === 'canceled') externalEdit = undefined;
      else if (detail.revision === detail.baseRevision + 1) externalEdit.revision = detail.revision;
      else { externalEdit = undefined; externalConflict(); }
      synchronizeRef.current(); emit(view);
    };
    function navigateAnchor(href: string) {
      let wanted: string; try { wanted = decodeURIComponent(href.slice(1)); } catch { return; }
      const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim().replace(/\s+/g, '-');
      let position: number | undefined;
      syntaxTree(view.state).iterate({ enter: node => { if (position === undefined && /^(?:ATX|Setext)Heading/.test(node.name)) { const title = view.state.sliceDoc(node.from, node.to).replace(/^#{1,6}\s+/, '').replace(/\n(?:=+|-+)\s*$/, ''); if (slug(title) === wanted.toLowerCase()) position = node.from; } } });
      if (position !== undefined) { view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start', yMargin: 48 }) }); view.focus(); }
    }
    function importImages(files: FileList | undefined | null, target: EditorView, event: ClipboardEvent | DragEvent) {
      if (latest.current.format !== 'markdown' || !files?.length) return false;
      const images = [...files].filter(file => /^image\/(?:png|jpeg|gif|webp|bmp|avif|svg\+xml)$/i.test(file.type)); if (!images.length) return false;
      event.preventDefault(); event.stopPropagation();
      if (composing.current || target.composing) return true;
      let position = target.state.selection.main.from;
      if (event instanceof DragEvent) position = target.posAtCoords({ x: event.clientX, y: event.clientY }) ?? position;
      const id = crypto.randomUUID(); imports.set(id, { from: position, to: position });
      const task = (async () => {
        try {
          const paths: string[] = [];
          for (const file of images) { if (file.size > 32 * 1024 * 1024) throw new Error('单张图片不能超过 32 MiB。'); const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error ?? new Error('无法读取图片。')); reader.readAsDataURL(file); }); const result = await call<{ path: string }>('markdown-import-image', { documentId: identity.documentId, name: file.name || 'image.png', mimeType: file.type, dataUrl, ...(preferences.imageRoot ? { imageRoot: preferences.imageRoot } : {}), ...(preferences.upload ? { upload: preferences.upload } : {}) }); paths.push('![' + file.name.replace(/[\[\]\\]/g, '') + '](<' + result.path.replace(/</g, '%3C').replace(/>/g, '%3E') + '>)'); }
          const range = imports.get(id); if (editor.current !== target || !range) return;
          const insert = paths.join('\n'); target.dispatch({ changes: { from: range.from, to: range.from, insert }, selection: { anchor: range.from + insert.length }, scrollIntoView: true, userEvent: 'input.image' }); target.focus();
        } catch (error) { window.dispatchEvent(new CustomEvent('agentviewer:markdown-error', { detail: { viewId: identity.viewId, message: error instanceof Error ? error.message : String(error) } })); }
        finally { imports.delete(id); }
      })(); importTasks.add(task); void task.finally(() => importTasks.delete(task));
      return true;
    }
    const command = (event: Event) => { const detail = (event as CustomEvent<MarkdownCommandEventDetail & { handled?: boolean; error?: string }>).detail; if (detail?.viewId !== latest.current.viewId) return; try { detail.handled = execute(detail.command, detail.value); } catch (error) { detail.error = error instanceof Error ? error.message : String(error); window.dispatchEvent(new CustomEvent('agentviewer:markdown-error', { detail: { viewId: latest.current.viewId, message: detail.error } })); } };
    const previewSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ viewId: string; from: number; to: number; accepted: boolean }>).detail;
      if (detail?.viewId !== identity.viewId || localDirty || composing.current || view.composing || !synchronized || !Number.isInteger(detail.from) || !Number.isInteger(detail.to) || detail.from < 0 || detail.to < detail.from || detail.to > view.state.doc.length) return;
      detail.accepted = true;
      const current = view.state.selection.main;
      if (current.from !== detail.from || current.to !== detail.to) view.dispatch({ selection: { anchor: detail.from, head: detail.to } });
    };
    const barrier = (event: Event) => {
      const detail = (event as CustomEvent<TextEditorBarrier>).detail;
      if (detail.viewId && detail.viewId !== latest.current.viewId || detail.documentId && detail.documentId !== latest.current.documentId) return;
      detail.waitUntil(Promise.resolve().then(async () => { if (composing.current || view.composing) throw Object.assign(new Error('请先完成当前中文输入，再保存或交给 Agent。'), { code: 'TEXT_COMPOSING' }); if (detail.checkOnly && (localDirty || imports.size || view.dom.querySelector('[data-markdown-cell-dirty="true"]'))) throw Object.assign(new Error('当前编辑内容仍在同步，请稍后重试。'), { code: 'TEXT_PENDING' }); if (!detail.checkOnly) { await Promise.all(importTasks); flushWidget(view); flush(view); } }));
    };
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{ viewId: string; index?: number; from?: number; select?: boolean }>).detail; if (detail.viewId !== latest.current.viewId) return;
      let position = detail.from;
      if (position === undefined) { let index = 0; syntaxTree(view.state).iterate({ enter: node => { if (/^(ATX|Setext)Heading/.test(node.name) && index++ === detail.index) position = node.from; } }); }
      if (position !== undefined) { const anchor = Math.max(0, Math.min(view.state.doc.length, position)); view.dispatch({ ...(detail.select === false ? {} : { selection: { anchor } }), effects: EditorView.scrollIntoView(anchor, { y: 'start', yMargin: 96 }) }); if (detail.select !== false) view.focus(); }
    };
    const anchor = (event: Event) => { const detail = (event as CustomEvent<{ viewId: string; anchor: string }>).detail; if (detail?.viewId === identity.viewId) navigateAnchor(detail.anchor.startsWith('#') ? detail.anchor : '#' + detail.anchor); };
    const revealLine = (event: Event) => { const detail = (event as CustomEvent<{ viewId: string; line: number }>).detail; if (detail?.viewId !== identity.viewId || !Number.isInteger(detail.line)) return; const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, detail.line))); view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) }); view.focus(); };
    const preferenceChange = (event: Event) => { const detail = (event as CustomEvent<{ viewId: string; preferences: typeof preferences }>).detail; if (detail?.viewId !== identity.viewId || !detail.preferences) return; preferences = detail.preferences; try { view.dispatch({ effects: bindings.reconfigure(keybindings(preferences.keybindings)) }); } catch (error) { window.dispatchEvent(new CustomEvent('agentviewer:markdown-error', { detail: { viewId: identity.viewId, message: '快捷键配置无效：' + (error instanceof Error ? error.message : String(error)) } })); } };
    const outlineRequest = (event: Event) => { const detail = (event as CustomEvent<{ viewId: string }>).detail; if (detail?.viewId === identity.viewId) publishOutline(view.state, true); };
    const observer = new MutationObserver(() => { if (editor.current === view && latest.current.live) view.dispatch({ effects: refreshMarkdownPreview.of(null) }); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-document-paper'] });
    window.addEventListener('agentviewer:markdown-command', command); window.addEventListener('agentviewer:text-editor-barrier', barrier); window.addEventListener('agentviewer:markdown-navigate', navigate); window.addEventListener('agentviewer:markdown-anchor', anchor); window.addEventListener('agentviewer:markdown-reveal-line', revealLine); window.addEventListener('agentviewer:markdown-preferences', preferenceChange);
    window.addEventListener('agentviewer:markdown-outline-request', outlineRequest); publishOutline(view.state);
    window.addEventListener('agentviewer:markdown-preview-selection', previewSelection);
    window.addEventListener(MARKDOWN_EXTERNAL_EDIT_EVENT, externalEditEvent);
    window.dispatchEvent(new CustomEvent('agentviewer:markdown-preferences-request', { detail: { viewId: identity.viewId } }));
    emit(view);
    return () => { if (changeTimer) clearTimeout(changeTimer); if (contextFrame) cancelAnimationFrame(contextFrame); if (!composing.current) { flushWidget(view); flush(view); } imports.clear(); observer.disconnect(); window.removeEventListener('agentviewer:markdown-command', command); window.removeEventListener('agentviewer:text-editor-barrier', barrier); window.removeEventListener('agentviewer:markdown-navigate', navigate); window.removeEventListener('agentviewer:markdown-anchor', anchor); window.removeEventListener('agentviewer:markdown-reveal-line', revealLine); window.removeEventListener('agentviewer:markdown-preferences', preferenceChange); window.removeEventListener('agentviewer:markdown-outline-request', outlineRequest); window.removeEventListener('agentviewer:markdown-preview-selection', previewSelection); window.removeEventListener(MARKDOWN_EXTERNAL_EDIT_EVENT, externalEditEvent); if (!composing.current) stateChanged(); view.destroy(); editor.current = null; };
  }, [props.format, props.documentId, props.viewId]);
  useEffect(() => { const view = editor.current; if (view) view.dispatch({ effects: liveMode.current.reconfigure(props.live && props.format === 'markdown' ? markdownLivePreview(props.documentId ?? '') : []) }); }, [props.live, props.format, props.documentId]);
  useEffect(() => { synchronizeRef.current(); }, [props.value, props.revision]);
  useEffect(() => { emitRef.current(); }, [props.revision, props.pending]);
  return <div className={'source-editor markdown-editor' + (props.live ? ' markdown-live' : '')} ref={host} data-markdown-view={props.viewId}><output className="markdown-statistics" title="源码计数：中日韩字符逐字计数，其他文字按单词计数；字符数包含空白与标记。" aria-label="文档统计">{statistics.words.toLocaleString()} 字词 · {statistics.characters.toLocaleString()} 字符 · {statistics.lines.toLocaleString()} 行</output></div>;
}
