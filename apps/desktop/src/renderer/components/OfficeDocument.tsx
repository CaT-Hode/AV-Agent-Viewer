import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Grip, Maximize2, Plus } from 'lucide-react';
import { editOperationSchema, type DocumentInfo, type EditOperation, type OfficeTextStyle, type ReadingContext, type Sheet, type SheetCell, type TextBlock, type ViewInfo } from '../../../../../packages/contracts/src/index';
import { addressPosition, columnName, normalizedRange, parseClipboardGrid, rangeContains, serializeGrid, textStyle, type OfficeTarget } from './office/OfficeShared';
import { OfficeDraftRegistry, useOfficeDraft, type OfficeDraftController } from './office/OfficeDrafts';
import '../office-editing.css';

export type OfficeDocumentProps = {
  document: DocumentInfo; view: Pick<ViewInfo, 'id'>; edit(operation: EditOperation): Promise<void>; zoom?: number;
  onTarget?(target: OfficeTarget): void; onContext?(context: Partial<ReadingContext>): void;
  onSelection?(selection: ReadingContext['selection']): void; reportError?(error: unknown): void;
  onDraftController?(controller: OfficeDraftController | undefined): void; onDraftChange?(dirty: boolean): void;
};
export type { OfficeDraftController } from './office/OfficeDrafts';
type EditorProps = Pick<OfficeDocumentProps, 'edit' | 'onContext' | 'onSelection' | 'reportError'> & { document: Pick<DocumentInfo, 'capabilities'>; view: Pick<ViewInfo, 'id'>; selectTarget(target: OfficeTarget): void; drafts: OfficeDraftRegistry };
type RenderProps = EditorProps & { document: Pick<DocumentInfo, 'id' | 'format' | 'model' | 'capabilities'>; zoom?: number; target?: OfficeTarget; editor: EditorProps };
const renderCounts = { document: 0, word: 0, presentation: 0, spreadsheet: 0, cell: 0, text: 0, notes: 0 };
/** Counter-only diagnostics. The trusted test renderer exposes this on demand. */
export const officeRenderStats = () => ({ ...renderCounts });
const sameStyle = (left?: CSSProperties, right?: CSSProperties) => left === right || !!left && !!right && Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.is(left[key as keyof CSSProperties], right[key as keyof CSSProperties]));
const hex = (value?: string) => value && /^[a-f\d]{6}$/i.test(value) ? '#' + value : undefined;
function fontStyle(style: OfficeTextStyle): CSSProperties {
  return { fontFamily: style.fontName, fontSize: style.fontSize ? style.fontSize * 4 / 3 : undefined, fontWeight: style.bold === undefined ? undefined : style.bold ? 700 : 400, fontStyle: style.italic === undefined ? undefined : style.italic ? 'italic' : 'normal', color: hex(style.color), backgroundColor: hex(style.highlight), textDecoration: [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ') || (style.underline !== undefined || style.strike !== undefined ? 'none' : undefined) };
}
function selectOffsets(host: HTMLElement) {
  const selected = window.getSelection();
  if (!selected?.rangeCount) return undefined;
  const range = selected.getRangeAt(0);
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return undefined;
  const prefix = range.cloneRange(); prefix.selectNodeContents(host); prefix.setEnd(range.startContainer, range.startOffset);
  return { from: prefix.toString().length, to: prefix.toString().length + range.toString().length, text: range.toString(), rect: range.getBoundingClientRect() };
}
function restoreOffsets(host: HTMLElement, from: number, to: number) {
  const walker = window.document.createTreeWalker(host, NodeFilter.SHOW_TEXT), range = window.document.createRange();
  let node = walker.nextNode(), offset = 0, start = false;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (!start && from <= offset + length) { range.setStart(node, Math.max(0, from - offset)); start = true; }
    if (start && to <= offset + length) { range.setEnd(node, Math.max(0, to - offset)); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return; }
    offset += length; node = walker.nextNode();
  }
}

/** Unmanaged text children protect IME, local drafts and the native text range. */
function EditableBlockImpl({ block, slideId, props, className, style }: { block: TextBlock; slideId?: string; props: EditorProps; className?: string; style?: CSSProperties }) {
  renderCounts.text++;
  const host = useRef<HTMLDivElement>(null), dirty = useRef(false), baseline = useRef(block.text), pending = useRef<Promise<void> | undefined>(undefined), composing = useRef(false);
  const [error, setError] = useState(''), [commitVersion, setCommitVersion] = useState(0);
  const contentSignature = JSON.stringify([block.text, block.runs]);
  const sync = () => {
    const element = host.current; if (!element || dirty.current) return;
    // A preserved document range is not permission to steal focus from a font
    // field, formula bar or another editor. Chrome focuses a contenteditable
    // when addRange is called, even if its range had merely survived a blur.
    const selection = window.document.activeElement === element ? selectOffsets(element) : undefined;
    const children = (block.runs?.length ? block.runs : [{ text: block.text }]).map(run => {
      const span = window.document.createElement('span'); span.textContent = run.text;
      for (const [key, value] of Object.entries(fontStyle(run))) if (value !== undefined) (span.style as unknown as Record<string, string>)[key] = typeof value === 'number' && key === 'fontSize' ? `${value}px` : String(value);
      return span;
    });
    element.replaceChildren(...children); baseline.current = block.text;
    if (selection) restoreOffsets(element, selection.from, selection.to);
  };
  useLayoutEffect(sync, [block.id, contentSignature, commitVersion]);
  const target = (): OfficeTarget => ({ viewId: props.view.id, blockId: slideId ? undefined : block.id, slideId, shapeId: slideId ? block.id : undefined });
  const publish = () => {
    const element = host.current, range = element && selectOffsets(element);
    props.selectTarget({ ...target(), from: range?.from, to: range?.to, selectedText: range?.text });
    props.onContext?.({ locator: { kind: slideId ? 'slide-object' : 'paragraph', blockId: slideId ? undefined : block.id, slideId, shapeId: slideId ? block.id : undefined, from: range?.from, to: range?.to }, visibleText: block.text });
    if (range?.text) props.onSelection?.({ kind: 'text', text: range.text, rect: { x: range.rect.x, y: range.rect.y, width: range.rect.width, height: range.rect.height }, locator: { kind: 'text-range', blockId: slideId ? undefined : block.id, slideId, shapeId: slideId ? block.id : undefined, from: range.from, to: range.to, quote: range.text } });
  };
  const commit = (): Promise<void> => {
    if (pending.current) return pending.current;
    if (composing.current) return Promise.reject(new Error('正在输入法组合输入，请完成输入后再保存。'));
    const element = host.current; if (!element || !dirty.current) return Promise.resolve();
    const text = element.innerText.replace(/\r\n/g, '\n');
    if (text === block.text) { dirty.current = false; baseline.current = text; setError(''); props.drafts.notify(); return Promise.resolve(); }
    if (baseline.current !== block.text) { const message = '此处原文已更新。当前输入已保留，请检查后重新编辑。'; setError(message); return Promise.reject(new Error(message)); }
    const operation = (async () => {
      try { await props.edit(editOperationSchema.parse(slideId ? { kind: 'slides.setText', slideId, shapeId: block.id, text } : { kind: 'word.setBlock', blockId: block.id, text })); dirty.current = (host.current?.innerText.replace(/\r\n/g, '\n') ?? text) !== text; baseline.current = text; setError(''); setCommitVersion(old => old + 1); }
      catch (cause) { setError('修改未应用，输入已保留'); throw cause; }
      finally { pending.current = undefined; props.drafts.notify(); }
    })(); pending.current = operation; return operation;
  };
  const localCommit = () => void commit().catch(cause => props.reportError?.(cause));
  useOfficeDraft(props.drafts, `text:${slideId ?? 'word'}:${block.id}`, { isDirty: () => dirty.current || !!pending.current || composing.current, flush: commit, discard: () => { dirty.current = false; composing.current = false; sync(); setError(''); } });
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase()) && props.document.capabilities.editKinds.includes('office.setTextStyle')) {
      event.preventDefault();
      if (dirty.current) { setError('请先提交当前文字（Ctrl+Enter），再设置格式'); return; }
      const selection = host.current && selectOffsets(host.current), from = selection?.text ? selection.from : 0, to = selection?.text ? selection.to : block.text.length;
      if (to <= from) return;
      const key = event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : 'underline', current = textStyle(block, { ...target(), from, to });
      void props.edit(editOperationSchema.parse({ kind: 'office.setTextStyle', blockId: block.id, slideId, from, to, expectedText: selection?.text || block.text, [key]: !current[key] })).catch(cause => props.reportError?.(cause)); return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); localCommit(); }
    if (event.key === 'Escape' && !composing.current) { event.preventDefault(); dirty.current = false; sync(); setError(''); props.drafts.notify(); }
  };
  return <div className="office-block-shell"><div ref={host} className={className} style={style} data-block-id={block.id} data-slide-id={slideId} data-style={block.style ?? 'Normal'} contentEditable={props.document.capabilities.editKinds.includes(slideId ? 'slides.setText' : 'word.setBlock')} suppressContentEditableWarning role="textbox" aria-label={slideId ? '幻灯片文本对象' : block.tableId ? '表格单元格文字' : '文档段落'} aria-multiline onFocus={publish} onMouseUp={publish} onKeyUp={publish} onInput={() => { dirty.current = true; setError(''); props.drafts.notify(); }} onBlur={localCommit} onCompositionStart={() => { composing.current = true; props.drafts.notify(); }} onCompositionEnd={() => { composing.current = false; dirty.current = true; props.drafts.notify(); }} onKeyDown={keyboard} />{error && <span className="office-draft-error" role="alert">{error}</span>}</div>;
}
const EditableBlock = memo(EditableBlockImpl, (left, right) => left.block === right.block && left.slideId === right.slideId && left.props === right.props && left.className === right.className && sameStyle(left.style, right.style));

function WordDocumentImpl(props: RenderProps) {
  renderCounts.word++;
  const { document, zoom = 1 } = props, blocks = document.model.blocks ?? [], layout = document.model.pageLayout;
  const groups: ({ kind: 'paragraph'; block: TextBlock } | { kind: 'table'; id: string; blocks: TextBlock[] })[] = [];
  const tables = new Map<string, TextBlock[]>();
  for (const block of blocks) {
    if (!block.tableId) groups.push({ kind: 'paragraph', block });
    else { const existing = tables.get(block.tableId); if (existing) existing.push(block); else { const entries = [block]; tables.set(block.tableId, entries); groups.push({ kind: 'table', id: block.tableId, blocks: entries }); } }
  }
  // TextBlock's scalar font fields summarize the first OOXML run. They are not
  // paragraph defaults: inheriting them would style every unselected sibling.
  const paragraphStyle = (block: TextBlock): CSSProperties => ({ ...(block.runs?.length ? {} : fontStyle(block)), textAlign: block.alignment === 'both' ? 'justify' : block.alignment as CSSProperties['textAlign'], marginTop: (block.spacingBefore ?? 0) * 4 / 3, marginBottom: (block.spacingAfter ?? 8) * 4 / 3, lineHeight: block.lineSpacing ?? 1.5, paddingLeft: (block.indentLeft ?? 0) * 4 / 3, paddingRight: (block.indentRight ?? 0) * 4 / 3, textIndent: (block.indentFirstLine ?? 0) * 4 / 3 });
  return <div className="office-word-stage"><article className="office-word-paper" style={{ width: layout ? layout.width * 4 / 3 : 816, minHeight: layout ? layout.height * 4 / 3 : 1056, padding: layout ? `${layout.margins.top * 4 / 3}px ${layout.margins.right * 4 / 3}px ${layout.margins.bottom * 4 / 3}px ${layout.margins.left * 4 / 3}px` : undefined, zoom }} aria-label="Word 文档编辑区">
    {groups.map(group => group.kind === 'paragraph' ? <EditableBlock key={group.block.id} block={group.block} props={props.editor} className="office-word-paragraph" style={paragraphStyle(group.block)} /> : <table className="office-word-table" key={group.id}><tbody>{Array.from({ length: Math.max(...group.blocks.map(block => block.tableRow ?? 0)) + 1 }, (_, row) => <tr key={row}>{Array.from({ length: Math.max(...group.blocks.map(block => block.tableColumn ?? 0)) + 1 }, (_, column) => <td key={column}>{group.blocks.filter(block => block.tableRow === row && block.tableColumn === column).map(block => <EditableBlock key={block.id} block={block} props={props.editor} className="office-word-paragraph" style={paragraphStyle(block)} />)}</td>)}</tr>)}</tbody></table>)}
  </article></div>;
}

function SlideNotesImpl({ props, slideId, source }: { props: EditorProps; slideId: string; source: string }) {
  renderCounts.notes++;
  const [notes, setNotes] = useState(source), [error, setError] = useState('');
  const value = useRef(source), dirty = useRef(false), baseline = useRef(source), composing = useRef(false), pending = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => { if (!dirty.current) { value.current = source; setNotes(source); baseline.current = source; } }, [source]);
  const commit = (): Promise<void> => {
    if (pending.current) return pending.current;
    if (composing.current) return Promise.reject(new Error('正在输入法组合输入，请完成备注输入后再保存。'));
    if (!dirty.current) return Promise.resolve();
    if (baseline.current !== source) { setError('原备注已更新，当前输入已保留'); return Promise.reject(new Error('原备注已更新，请先检查当前输入。')); }
    const text = value.current, operation = (async () => {
      try { await props.edit(editOperationSchema.parse({ kind: 'slides.setNotes', slideId, text })); baseline.current = text; dirty.current = value.current !== text; setError(''); }
      catch (cause) { setError('备注未保存，输入已保留'); throw cause; }
      finally { pending.current = undefined; props.drafts.notify(); }
    })(); pending.current = operation; return operation;
  };
  useOfficeDraft(props.drafts, `notes:${slideId}`, { isDirty: () => dirty.current || composing.current || !!pending.current, flush: commit, discard: () => { value.current = source; baseline.current = source; dirty.current = false; setNotes(source); setError(''); } });
  return <details className="office-slide-notes"><summary>演讲者备注 <ChevronDown size={14} /></summary><textarea aria-label="当前幻灯片备注" value={notes} rows={3} onChange={event => { value.current = event.target.value; dirty.current = value.current !== source; setNotes(value.current); setError(''); props.drafts.notify(); }} onCompositionStart={() => { composing.current = true; props.drafts.notify(); }} onCompositionEnd={() => { composing.current = false; props.drafts.notify(); }} /><button disabled={!dirty.current || !props.document.capabilities.editKinds.includes('slides.setNotes')} onClick={() => void commit().catch(cause => props.reportError?.(cause))}>保存备注</button>{error && <p role="alert">{error}</p>}</details>;
}

const WordDocument = memo(WordDocumentImpl);
const SlideNotes = memo(SlideNotesImpl);

function PresentationDocumentImpl(props: RenderProps) {
  renderCounts.presentation++;
  const slides = props.document.model.slides ?? [], [slideId, setSlideId] = useState(slides[0]?.id), [dragBounds, setDragBounds] = useState<Record<string, { x: number; y: number; width: number; height: number }>>({});
  const slide = slides.find(item => item.id === slideId) ?? slides[0], index = slides.findIndex(item => item.id === slide?.id), canvas = useRef<HTMLDivElement>(null);
  useEffect(() => { const navigate = (event: Event) => { const i = (event as CustomEvent<{ index: number }>).detail.index; if (slides[i]) void props.drafts.flush().then(() => setSlideId(slides[i].id)).catch(cause => props.reportError?.(cause)); }; window.addEventListener('agentviewer:navigate-structure', navigate); return () => window.removeEventListener('agentviewer:navigate-structure', navigate); }, [slides]);
  useEffect(() => { if (slide) { props.selectTarget({ viewId: props.view.id, slideId: slide.id }); props.onContext?.({ locator: { kind: 'slide', slideId: slide.id }, visibleText: slide.blocks.map(block => block.text).join('\n') }); } }, [slide?.id]);
  const showSlide = (id: string) => { void props.drafts.flush().then(() => { setSlideId(id); props.selectTarget({ viewId: props.view.id, slideId: id }); }).catch(cause => props.reportError?.(cause)); };
  const drag = (event: PointerEvent<HTMLButtonElement>, block: TextBlock, resize: boolean) => {
    if (!slide || !canvas.current || !props.document.capabilities.editKinds.includes('slides.setShapeBounds')) return;
    event.preventDefault(); event.stopPropagation(); props.selectTarget({ viewId: props.view.id, slideId: slide.id, shapeId: block.id });
    const pointer = event.pointerId, button = event.currentTarget, rect = canvas.current.getBoundingClientRect(), start = { x: event.clientX, y: event.clientY }, original = dragBounds[block.id] ?? { x: block.x ?? .1, y: block.y ?? .1, width: block.width ?? .8, height: block.height ?? .2 };
    button.setPointerCapture(pointer); let next = original;
    const move = (e: globalThis.PointerEvent) => { const dx = (e.clientX - start.x) / rect.width, dy = (e.clientY - start.y) / rect.height; next = resize ? { ...original, width: Math.max(.02, Math.min(1 - original.x, original.width + dx)), height: Math.max(.02, Math.min(1 - original.y, original.height + dy)) } : { ...original, x: Math.max(0, Math.min(1 - original.width, original.x + dx)), y: Math.max(0, Math.min(1 - original.height, original.y + dy)) }; setDragBounds(old => ({ ...old, [block.id]: next })); };
    const finish = () => { button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', cancel); if (button.hasPointerCapture(pointer)) button.releasePointerCapture(pointer); void props.edit(editOperationSchema.parse({ kind: 'slides.setShapeBounds', slideId: slide.id, shapeId: block.id, ...next })).then(() => setDragBounds(old => { const copy = { ...old }; delete copy[block.id]; return copy; })).catch(cause => { setDragBounds(old => { const copy = { ...old }; delete copy[block.id]; return copy; }); props.reportError?.(cause); }); };
    const cancel = () => { button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', cancel); setDragBounds(old => { const copy = { ...old }; delete copy[block.id]; return copy; }); };
    button.addEventListener('pointermove', move); button.addEventListener('pointerup', finish, { once: true }); button.addEventListener('pointercancel', cancel, { once: true });
  };
  if (!slide) return <p className="office-empty">尚无幻灯片。使用工具带创建第一张幻灯片。</p>;
  return <div className="office-presentation-stage">
    <div className="office-slide-strip" aria-label="幻灯片导航">{slides.map((item, i) => <button key={item.id} className={slide.id === item.id ? 'selected' : ''} aria-label={`第 ${i + 1} 张幻灯片`} aria-current={slide.id === item.id ? 'page' : undefined} onClick={() => showSlide(item.id)}><span className="office-slide-thumbnail" style={{ backgroundColor: hex(item.background) ?? '#fff' }}>{item.blocks.slice(0, 3).map(block => <span key={block.id}>{block.text.slice(0, 48)}</span>)}</span><span>{i + 1}</span></button>)}</div>
    <div className="office-slide-stage"><div className="office-slide-canvas" data-slide-id={slide.id} ref={canvas} style={{ aspectRatio: `${props.document.model.width ?? 960} / ${props.document.model.height ?? 540}`, backgroundColor: hex(slide.background) ?? '#fff', zoom: props.zoom ?? 1 }}>
      {slide.blocks.map(block => { const bounds = dragBounds[block.id] ?? block; const selected = props.target?.shapeId === block.id; return <div key={block.id} className={'office-slide-object' + (selected ? ' selected' : '')} data-shape-id={block.id} style={{ left: (bounds.x ?? .1) * 100 + '%', top: (bounds.y ?? .1) * 100 + '%', width: (bounds.width ?? .8) * 100 + '%', height: (bounds.height ?? .2) * 100 + '%', backgroundColor: hex(block.fill), border: block.lineColor ? `${(block.lineWidth ?? 1) * 4 / 3}px solid ${hex(block.lineColor)}` : undefined, transform: block.rotation ? `rotate(${block.rotation}deg)` : undefined }} onPointerDown={() => props.selectTarget({ viewId: props.view.id, slideId: slide.id, shapeId: block.id })}>
        <EditableBlock block={block} slideId={slide.id} props={props.editor} className="office-slide-text" style={{ ...(block.runs?.length ? {} : fontStyle(block)), textAlign: block.alignment as CSSProperties['textAlign'] }} />
        {selected && props.document.capabilities.editKinds.includes('slides.setShapeBounds') && <><button className="office-object-move" aria-label="拖动对象" title="拖动对象" onPointerDown={event => drag(event, block, false)}><Grip size={13} /></button><button className="office-object-resize" aria-label="调整对象尺寸" title="调整对象尺寸" onPointerDown={event => drag(event, block, true)}><Maximize2 size={12} /></button></>}
      </div>; })}
    </div></div>
    <div className="office-slide-footer"><button className="icon-button" aria-label="上一张" disabled={index <= 0} onClick={() => showSlide(slides[index - 1].id)}><ArrowLeft size={16} /></button><span>{index + 1} / {slides.length}</span><button className="icon-button" aria-label="下一张" disabled={index >= slides.length - 1} onClick={() => showSlide(slides[index + 1].id)}><ArrowRight size={16} /></button></div>
    <SlideNotes key={slide.id} props={props.editor} slideId={slide.id} source={slide.notes ?? ''} />
  </div>;
}

const PresentationDocument = memo(PresentationDocumentImpl);

function CellEditorImpl({ cell, editable, selected, props, sheetId, onMove }: { cell: SheetCell; editable: boolean; selected: boolean; props: EditorProps; sheetId: string; onMove(address: string, row: number, column: number, extend: boolean): void }) {
  renderCounts.cell++;
  const original = cell.formula ? '=' + cell.formula : cell.value, [draft, setDraft] = useState(original), [editing, setEditing] = useState(false), [error, setError] = useState('');
  const value = useRef(original), dirty = useRef(false), baseline = useRef(original), pending = useRef<Promise<void> | undefined>(undefined), composing = useRef(false), input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!dirty.current) { setDraft(original); value.current = original; baseline.current = original; } }, [original]);
  const commit = (): Promise<void> => {
    if (pending.current) return pending.current;
    if (composing.current) return Promise.reject(new Error('正在输入法组合输入，请完成单元格输入后再保存。'));
    if (!dirty.current) { setEditing(false); return Promise.resolve(); }
    const text = value.current;
    if (baseline.current !== original && text !== original) { setError('原单元格已更新，当前输入已保留'); return Promise.reject(new Error('原单元格已更新，请先检查当前输入。')); }
    const operation = (async () => {
      try { const valueType = text.startsWith('=') ? undefined : cell.valueType === 'number' && Number.isFinite(Number(text)) ? 'number' : cell.valueType === 'boolean' && /^(true|false)$/i.test(text) ? 'boolean' : 'text'; await props.edit(editOperationSchema.parse({ kind: 'sheets.setCell', sheetId: sheetId, address: cell.address, value: text.startsWith('=') ? '' : valueType === 'boolean' ? text.toLowerCase() : text, formula: text.startsWith('=') ? text.slice(1) : undefined, valueType })); dirty.current = value.current !== text; baseline.current = valueType === 'boolean' ? text.toLowerCase() : text; if (!dirty.current) setEditing(false); setError(''); }
      catch (cause) { setError('修改未应用，输入已保留'); throw cause; }
      finally { pending.current = undefined; props.drafts.notify(); }
    })(); pending.current = operation; return operation;
  };
  const localCommit = () => void commit().catch(cause => props.reportError?.(cause));
  useOfficeDraft(props.drafts, `cell:${sheetId}:${cell.address}`, { isDirty: () => dirty.current || composing.current || !!pending.current, flush: commit, discard: () => { dirty.current = false; value.current = original; baseline.current = original; setDraft(original); setEditing(false); setError(''); } });
  const wrapped = cell.wrap && !editing && !dirty.current;
  return <div className={'office-cell-editor' + (wrapped ? ' wrapped' : '')}>{wrapped && <span className="office-cell-display" style={{ ...fontStyle(cell), backgroundColor: undefined, textAlign: cell.horizontal as CSSProperties['textAlign'] }}>{cell.value || '\u00a0'}</span>}<input ref={input} className={'office-cell-input' + (error ? ' has-error' : '')} aria-label={cell.address} title={error || undefined} data-cell-address={cell.address} readOnly={!editable || !editing} value={editing || dirty.current ? draft : cell.value} style={{ ...fontStyle(cell), backgroundColor: undefined, textAlign: cell.horizontal as CSSProperties['textAlign'], color: wrapped ? 'transparent' : hex(cell.color) }} onDoubleClick={() => { if (editable) { setEditing(true); input.current?.select(); } }} onChange={event => { dirty.current = true; value.current = event.target.value; setDraft(value.current); setError(''); props.drafts.notify(); }} onBlur={localCommit} onCompositionStart={() => { composing.current = true; props.drafts.notify(); }} onCompositionEnd={() => { composing.current = false; props.drafts.notify(); }} onKeyDown={event => {
    if (!editing && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.key)) { event.preventDefault(); onMove(cell.address, event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0, event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey) ? -1 : event.key === 'ArrowRight' || event.key === 'Tab' ? 1 : 0, event.key === 'Tab' ? false : event.shiftKey); return; }
    if ((event.key === 'F2' || event.key === 'Enter') && !editing && editable) { event.preventDefault(); setEditing(true); return; }
    if (event.key === 'Enter' && !composing.current) { event.preventDefault(); localCommit(); }
    if (event.key === 'Escape' && !composing.current) { dirty.current = false; value.current = original; setDraft(original); baseline.current = original; setEditing(false); setError(''); props.drafts.notify(); }
    if (selected && !editing && editable && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); dirty.current = true; value.current = event.key; setDraft(event.key); setEditing(true); props.drafts.notify(); }
  }} /></div>;
}

const CellEditor = memo(CellEditorImpl);

function SpreadsheetDocumentImpl(props: RenderProps) {
  renderCounts.spreadsheet++;
  const sheets = props.document.model.sheets ?? [], [sheetId, setSheetId] = useState(sheets[0]?.id), sheet = sheets.find(item => item.id === sheetId) ?? sheets[0];
  const [address, setAddress] = useState('A1'), [range, setRange] = useState('A1:A1'), [nameBox, setNameBox] = useState('A1'), [formula, setFormula] = useState(''), [formulaError, setFormulaError] = useState(''), [rowLimit, setRowLimit] = useState(100);
  const formulaDirty = useRef(false), formulaValue = useRef(''), formulaBaseline = useRef(''), formulaComposing = useRef(false), formulaPending = useRef<Promise<void> | undefined>(undefined), dragStart = useRef<string | undefined>(undefined), grid = useRef<HTMLTableElement>(null), [filters, setFilters] = useState<Record<number, string>>({});
  const cells = useMemo(() => new Map(sheet?.rows.flat().map(cell => [cell.address, cell]) ?? []), [sheet?.rows]);
  const emptyCells = useMemo(() => new Map<string, SheetCell>(), [sheet?.id]);
  const current = cells.get(address), original = current?.formula ? '=' + current.formula : current?.value ?? '';
  const rangeRows = (value = range) => { const [start, end] = value.split(':'), a = addressPosition(start), b = addressPosition(end ?? start); return Array.from({ length: Math.min(1000, b.row - a.row + 1) }, (_, i) => Array.from({ length: Math.min(50, b.column - a.column + 1) }, (_, j) => cells.get(`${columnName(a.column + j - 1)}${a.row + i}`)?.value ?? '')); };
  useEffect(() => { if (!formulaDirty.current) { setFormula(original); formulaValue.current = original; formulaBaseline.current = original; } }, [sheet?.id, address, original]);
  useEffect(() => { setAddress('A1'); setRange('A1:A1'); setNameBox('A1'); setRowLimit(100); setFilters({}); formulaDirty.current = false; setFormulaError(''); }, [sheet?.id]);
  useEffect(() => { const navigate = (event: Event) => { const i = (event as CustomEvent<{ index: number }>).detail.index; if (sheets[i]) void props.drafts.flush().then(() => setSheetId(sheets[i].id)).catch(cause => props.reportError?.(cause)); }; window.addEventListener('agentviewer:navigate-structure', navigate); return () => window.removeEventListener('agentviewer:navigate-structure', navigate); }, [sheets]);
  const select = (start: string, end = start) => {
    if (!sheet) return;
    if (formulaDirty.current && start !== address) { setFormulaError('请先应用或取消当前公式输入'); return; }
    const nextRange = normalizedRange(start, end); setAddress(start); setRange(nextRange); setNameBox(start === end ? start : nextRange);
    props.selectTarget({ viewId: props.view.id, sheetId: sheet.id, address: start, range: nextRange });
    const text = serializeGrid(rangeRows(nextRange));
    const first = grid.current?.querySelector<HTMLElement>(`[data-address="${nextRange.split(':')[0]}"]`), last = grid.current?.querySelector<HTMLElement>(`[data-address="${nextRange.split(':')[1]}"]`), x = first?.getBoundingClientRect(), y = last?.getBoundingClientRect();
    const selected: ReadingContext['selection'] = { kind: 'cells', text, locator: { kind: start === end ? 'cell' : 'cell-range', sheetId: sheet.id, cell: start === end ? start : nextRange }, rect: x && y ? { x: Math.min(x.left, y.left), y: Math.min(x.top, y.top), width: Math.max(x.right, y.right) - Math.min(x.left, y.left), height: Math.max(x.bottom, y.bottom) - Math.min(x.top, y.top) } : undefined };
    props.onContext?.({ locator: selected.locator!, visibleText: text }); props.onSelection?.(selected);
  };
  const movement = useRef({ select, address }); movement.current = { select, address };
  const moveCell = useCallback((addr: string, dr: number, dc: number, extend: boolean) => {
    const p = addressPosition(addr), next = `${columnName(Math.max(0, Math.min(49, p.column + dc - 1)))}${Math.max(1, Math.min(1000, p.row + dr))}`;
    setRowLimit(old => Math.max(old, addressPosition(next).row)); movement.current.select(extend ? movement.current.address : next, next);
    requestAnimationFrame(() => { const input = grid.current?.querySelector<HTMLInputElement>(`[data-cell-address="${next}"]`); input?.focus({ preventScroll: true }); input?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  }, []);
  useEffect(() => { const finish = () => { dragStart.current = undefined; }; window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish); return () => { window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); }; }, []);
  const applyFormula = (): Promise<void> => {
    if (formulaPending.current) return formulaPending.current;
    if (formulaComposing.current) return Promise.reject(new Error('正在输入法组合输入，请完成公式栏输入后再保存。'));
    if (!sheet || !formulaDirty.current) return Promise.resolve();
    const text = formulaValue.current;
    if (formulaBaseline.current !== original && text !== original) { setFormulaError('单元格已更新，公式输入已保留'); return Promise.reject(new Error('单元格已更新，请先检查当前公式输入。')); }
    const operation = (async () => {
      try { await props.edit(editOperationSchema.parse({ kind: 'sheets.setCell', sheetId: sheet.id, address, value: text.startsWith('=') ? '' : text, formula: text.startsWith('=') ? text.slice(1) : undefined })); formulaDirty.current = formulaValue.current !== text; formulaBaseline.current = text; setFormulaError(''); }
      catch (cause) { setFormulaError('修改未应用，公式输入已保留'); throw cause; }
      finally { formulaPending.current = undefined; props.drafts.notify(); }
    })(); formulaPending.current = operation; return operation;
  };
  const localFormula = () => void applyFormula().catch(cause => props.reportError?.(cause));
  const setFilter = (column: number, value: string) => { void props.drafts.flush().then(() => setFilters(old => ({ ...old, [column]: value }))).catch(cause => props.reportError?.(cause)); };
  useOfficeDraft(props.drafts, `formula:${sheet?.id ?? 'none'}`, { isDirty: () => formulaDirty.current || formulaComposing.current || !!formulaPending.current, flush: applyFormula, discard: () => { formulaDirty.current = false; formulaValue.current = original; formulaBaseline.current = original; setFormula(original); setFormulaError(''); } });
  const jump = () => { const value = nameBox.toUpperCase().trim(); if (!/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(value)) { setFormulaError('请输入单元格地址或范围，如 B8 或 A1:C3'); return; } const [start, end = start] = value.split(':'), position = addressPosition(end), first = addressPosition(start); if (Math.max(position.row, first.row) > 1000 || Math.max(position.column, first.column) > 50) { setFormulaError('当前编辑视图支持前 1000 行、50 列。输入范围已保留。'); return; } setRowLimit(Math.max(rowLimit, position.row, first.row)); select(start, end); requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-address="${start}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })); };
  if (!sheet) return <p className="office-empty">尚无工作表。</p>;
  const rangeEnd = addressPosition(range.split(':')[1] ?? address);
  const rowCount = Math.min(rowLimit, Math.max(24, sheet.rowCount ?? sheet.rows.length, rangeEnd.row)), columnCount = Math.min(50, Math.max(12, sheet.columnCount ?? Math.max(0, ...sheet.rows.map(row => row.length)), rangeEnd.column));
  const freeze = sheet.freeze ?? { rows: 0, columns: 0 }, merged = (sheet.mergedRanges ?? []).map(value => { const [a, b] = value.split(':'); return { range: value, start: addressPosition(a), end: addressPosition(b ?? a) }; });
  const filterRange = sheet.autoFilter?.split(':').map(addressPosition), headerHeight = sheet.autoFilter ? 54 : 30;
  const columnWidths = Array.from({ length: columnCount }, (_, i) => Math.max(40, (sheet.columnWidths?.[i] ?? 14) * 7 + 8));
  return <div className="office-spreadsheet-stage" data-sheet-id={sheet.id} onCopy={event => { if (!grid.current?.contains(event.target as Node) || (event.target as HTMLInputElement).readOnly === false) return; event.preventDefault(); event.clipboardData.setData('text/plain', serializeGrid(rangeRows())); }} onPaste={event => {
    if (!grid.current?.contains(event.target as Node) || (event.target as HTMLInputElement).readOnly === false || !event.clipboardData.types.includes('text/plain') || !props.document.capabilities.editKinds.includes('sheets.setRangeValues')) return;
    event.preventDefault(); if (formulaDirty.current) { setFormulaError('请先应用或取消当前公式输入'); return; }
    try { const rows = parseClipboardGrid(event.clipboardData.getData('text/plain')), start = range.split(':')[0], position = addressPosition(start), end = `${columnName(position.column + rows[0].length - 2)}${position.row + rows.length - 1}`;
      void props.edit(editOperationSchema.parse({ kind: 'sheets.setRangeValues', sheetId: sheet.id, start, rows })).then(() => { setFormulaError(''); setRowLimit(old => Math.min(1000, Math.max(old, addressPosition(end).row))); select(start, end); }).catch(cause => { setFormulaError(cause instanceof Error ? cause.message : '粘贴未应用'); props.reportError?.(cause); });
    } catch (cause) { setFormulaError(cause instanceof Error ? cause.message : '无法读取粘贴内容'); }
  }} onKeyDownCapture={event => {
    if (!grid.current?.contains(event.target as Node) || (event.target as HTMLInputElement).readOnly === false || !(event.ctrlKey || event.metaKey) || !['b', 'i', 'u'].includes(event.key.toLowerCase()) || !props.document.capabilities.editKinds.includes('sheets.setRangeFormat')) return;
    event.preventDefault(); const key = event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : 'underline'; void props.edit(editOperationSchema.parse({ kind: 'sheets.setRangeFormat', sheetId: sheet.id, range, [key]: !current?.[key] })).catch(cause => props.reportError?.(cause));
  }}>
    <div className="office-formula-bar"><input aria-label="名称框" className="office-name-box" value={nameBox} onChange={event => setNameBox(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') jump(); }} onBlur={jump} /><span className="office-formula-symbol">ƒx</span><input aria-label="公式栏" value={formula} onChange={event => { formulaDirty.current = true; formulaValue.current = event.target.value; setFormula(formulaValue.current); setFormulaError(''); props.drafts.notify(); }} onCompositionStart={() => { formulaComposing.current = true; props.drafts.notify(); }} onCompositionEnd={() => { formulaComposing.current = false; props.drafts.notify(); }} onKeyDown={event => { if (event.key === 'Enter') localFormula(); if (event.key === 'Escape' && !formulaComposing.current) { formulaDirty.current = false; formulaValue.current = original; setFormula(original); setFormulaError(''); props.drafts.notify(); } }} /><button className="icon-button" aria-label="应用公式" title="应用公式" disabled={!formulaDirty.current || !props.document.capabilities.editKinds.includes('sheets.setCell')} onClick={localFormula}><Check size={15} /></button></div>
    {formulaError && <p className="office-edit-error" role="alert">{formulaError}</p>}
    <div className="office-grid-scroll"><table ref={grid} className="office-sheet-table" style={{ zoom: props.zoom ?? 1 }} aria-label={`${sheet.name} 工作表`}><colgroup><col style={{ width: 42 }} />{columnWidths.map((width, i) => <col key={i} style={{ width }} />)}</colgroup><thead><tr><th aria-label="选择全部已加载单元格" onClick={() => select('A1', `${columnName(columnCount - 1)}${rowCount}`)}>◢</th>{columnWidths.map((_, column) => <th key={column} style={column < freeze.columns ? { position: 'sticky', left: 42 + columnWidths.slice(0, column).reduce((a, b) => a + b, 0), zIndex: 4 } : undefined}><button onClick={() => select(`${columnName(column)}1`, `${columnName(column)}${rowCount}`)}>{columnName(column)}</button>{filterRange && column + 1 >= filterRange[0].column && column + 1 <= (filterRange[1]?.column ?? filterRange[0].column) && <select aria-label={`筛选 ${columnName(column)} 列`} value={filters[column] ?? ''} onChange={event => setFilter(column, event.target.value)}><option value="">全部</option>{[...new Set(sheet.rows.slice(filterRange[0].row, Math.min(rowCount, filterRange[1]?.row ?? rowCount)).map(row => row[column]?.value ?? ''))].slice(0, 100).map(value => <option key={value} value={JSON.stringify(value)}>{value || '空白'}</option>)}</select>}</th>)}</tr></thead><tbody>
      {Array.from({ length: rowCount }, (_, row) => row).filter(row => !filterRange || row + 1 <= filterRange[0].row || row + 1 > (filterRange[1]?.row ?? filterRange[0].row) || Object.entries(filters).every(([column, value]) => !value || (cells.get(`${columnName(Number(column))}${row + 1}`)?.value ?? '') === JSON.parse(value))).map(row => <tr key={row} style={{ height: Math.max(24, (sheet.rowHeights?.[row] ?? 18) * 4 / 3) }}><th style={row < freeze.rows ? { top: headerHeight + Array.from({ length: row }, (_, i) => Math.max(24, (sheet.rowHeights?.[i] ?? 18) * 4 / 3)).reduce((a, b) => a + b, 0), zIndex: 4 } : undefined} onClick={() => select(`A${row + 1}`, `${columnName(columnCount - 1)}${row + 1}`)}>{row + 1}</th>{columnWidths.map((_, column) => {
        const addr = `${columnName(column)}${row + 1}`;
        if (!cells.has(addr) && !emptyCells.has(addr)) emptyCells.set(addr, { address: addr, value: '' });
        const cell = cells.get(addr) ?? emptyCells.get(addr)!, merge = merged.find(item => rangeContains(item.range, addr));
        if (merge && (merge.start.row !== row + 1 || merge.start.column !== column + 1)) return null;
        const sticky: CSSProperties = { backgroundColor: hex(cell.fill) ?? undefined, verticalAlign: cell.vertical === 'middle' ? 'middle' : cell.vertical === 'top' ? 'top' : 'bottom', whiteSpace: cell.wrap ? 'normal' : undefined };
        if (row < freeze.rows) Object.assign(sticky, { position: 'sticky', top: headerHeight + Array.from({ length: row }, (_, i) => Math.max(24, (sheet.rowHeights?.[i] ?? 18) * 4 / 3)).reduce((a, b) => a + b, 0), zIndex: 2, backgroundColor: hex(cell.fill) ?? 'var(--office-cell-bg)' });
        if (column < freeze.columns) Object.assign(sticky, { position: 'sticky', left: 42 + columnWidths.slice(0, column).reduce((a, b) => a + b, 0), zIndex: row < freeze.rows ? 3 : 2, backgroundColor: hex(cell.fill) ?? 'var(--office-cell-bg)' });
        if (cell.border) { for (const side of ['top', 'right', 'bottom', 'left'] as const) if (cell.border[side]) (sticky as Record<string, unknown>)[`border${side[0].toUpperCase() + side.slice(1)}`] = '1px solid #8993a3'; }
        return <td key={addr} data-address={addr} className={rangeContains(range, addr) ? 'selected' : ''} style={sticky} colSpan={merge ? merge.end.column - merge.start.column + 1 : undefined} rowSpan={merge ? merge.end.row - merge.start.row + 1 : undefined} onPointerDown={event => { if ((event.target as HTMLInputElement).readOnly === false) return; event.preventDefault(); dragStart.current = event.shiftKey ? address : addr; select(dragStart.current, addr); (event.currentTarget.querySelector('input') as HTMLInputElement)?.focus({ preventScroll: true }); }} onPointerEnter={() => { if (dragStart.current) select(dragStart.current, addr); }}><CellEditor cell={cell} sheetId={sheet.id} props={props.editor} selected={address === addr} editable={props.document.capabilities.editKinds.includes('sheets.setCell')} onMove={moveCell} /></td>;
      })}</tr>)}
    </tbody></table></div>
    <div className="office-sheet-footer"><div className="office-sheet-tabs" aria-label="工作表">{sheets.map(item => <button key={item.id} className={sheet.id === item.id ? 'selected' : ''} onClick={() => void props.drafts.flush().then(() => setSheetId(item.id)).catch(cause => props.reportError?.(cause))}>{item.name}</button>)}{props.document.capabilities.editKinds.includes('sheets.addWorksheet') && <button className="icon-button" aria-label="新建工作表" title="新建工作表" onClick={() => { let n = 1; while (sheets.some(item => item.name === `工作表${n}`)) n++; void props.edit(editOperationSchema.parse({ kind: 'sheets.addWorksheet', name: `工作表${n}` })).catch(cause => props.reportError?.(cause)); }}><Plus size={15} /></button>}</div><span>{range}</span>{(sheet.rowCount ?? sheet.rows.length) > rowLimit && <button onClick={() => setRowLimit(old => Math.min(1000, old + 100))}>显示后 100 行</button>}</div>
  </div>;
}

const SpreadsheetDocument = memo(SpreadsheetDocumentImpl);

function OfficeDocumentImpl(props: OfficeDocumentProps) {
  renderCounts.document++;
  const [target, setTarget] = useState<OfficeTarget>();
  const callbacks = useRef(props); callbacks.current = props;
  const drafts = useMemo(() => new OfficeDraftRegistry(props.view.id, dirty => callbacks.current.onDraftChange?.(dirty)), [props.view.id]);
  useLayoutEffect(() => { callbacks.current.onDraftController?.(drafts); return () => callbacks.current.onDraftController?.(undefined); }, [drafts]);
  const selectTarget = useCallback((next: OfficeTarget) => { setTarget(next); callbacks.current.onTarget?.(next); }, []);
  // Context and file metadata can change on every poll. Body and leaf editors
  // only receive their actual rendering inputs; stable bridges still invoke the
  // latest parent callbacks, and local draft state remains owned by each editor.
  const editor = useMemo<EditorProps>(() => ({ document: { capabilities: props.document.capabilities }, view: { id: props.view.id }, edit: props.edit, onContext: props.onContext, onSelection: props.onSelection, reportError: props.reportError, selectTarget, drafts }), [props.document.capabilities, props.view.id, props.edit, props.onContext, props.onSelection, props.reportError, selectTarget, drafts]);
  const bodyDocument = useMemo(() => ({ id: props.document.id, format: props.document.format, model: props.document.model, capabilities: props.document.capabilities }), [props.document.id, props.document.format, props.document.model, props.document.capabilities]);
  const child = useMemo<RenderProps>(() => ({ ...editor, document: bodyDocument, zoom: props.zoom, editor }), [editor, bodyDocument, props.zoom]);
  return <section className={'office-document-editor office-document-' + props.document.format}>
    {props.document.format === 'docx' && <WordDocument {...child} />}{props.document.format === 'pptx' && <PresentationDocument {...child} target={target} />}{props.document.format === 'xlsx' && <SpreadsheetDocument {...child} />}
  </section>;
}
export const OfficeDocument = memo(OfficeDocumentImpl);
