import { scrollReadingTarget } from '../lib/reading-scroll';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HtmlPreview } from './HtmlPreview';
import { call, desktop, windowId } from '../lib/transport';
import type { DocumentInfo, EditOperation, ReadingContext, ViewInfo } from '../../../../../packages/contracts/src/index';
import type { OfficeTarget } from './OfficeTools';
import { OfficeDocument, type OfficeDraftController } from './OfficeDocument';
const PdfReader = lazy(() => import('./PdfReader').then(m => ({ default: m.PdfReader })));
const TextEditor = lazy(() => import('./TextEditor').then(m => ({ default: m.TextEditor })));
export type PdfToolsState = { note: string; highlight: boolean; ocrBusy: boolean; ocrResult?: { pageIndex: number; text: string; confidence: number } };
type PdfToolCommand = { viewId: string; action: 'note' | 'highlight' | 'rotate' | 'add-page' | 'ocr' | 'clear-ocr'; text?: string };

export function DocumentPane({ document, view, edit, onTextChange, reportError, onPdfToolsChange, onOfficeTargetChange, onOfficeDraftController, onOfficeDraftChange, onReaderScroll, onZoomChange, obscured, annotations = [] }: { document: DocumentInfo; view: ViewInfo; edit(operation: EditOperation): Promise<void>; onTextChange(text: string): void; reportError(error: unknown): void; annotations?: {sourceRevision:number;selection:ReadingContext['selection']}[]; obscured?: boolean; onReaderScroll?: (y: number) => void; onZoomChange?(factor: number): void; onPdfToolsChange?: (state: PdfToolsState) => void; onOfficeTargetChange?: (target: OfficeTarget) => void; onOfficeDraftController?(controller: OfficeDraftController | undefined): void; onOfficeDraftChange?(state: { viewId: string; dirty: boolean }): void }) {
  const host = useRef<HTMLDivElement>(null), page = useRef(0), [slideIndex, setSlideIndex] = useState(0), [sheetId, setSheetId] = useState(document.model.sheets?.[0]?.id), [note, setNote] = useState(''), [highlight, setHighlight] = useState(false), [ocrBusy, setOcrBusy] = useState(false), [ocrResult, setOcrResult] = useState<{ pageIndex: number; text: string; confidence: number }>();
  const lastReport = useRef(0), selection = useRef<ReadingContext['selection']>({ kind: 'none', text: '' }), sourceContext = useRef<Partial<ReadingContext>>({}), previewContext = useRef<Partial<ReadingContext>>({});
  const officeContext = useRef<Partial<ReadingContext>>({});
  const zoom = view.zoom ?? 1, zoomRef = useRef(zoom), zoomCallback = useRef(onZoomChange);
  zoomRef.current = zoom; zoomCallback.current = onZoomChange;
  useEffect(() => {
    const node = host.current; if (!node || document.format === 'web') return;
    let frame = 0, delta = 0;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); delta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1);
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0; const next = Math.max(.25, Math.min(4, Math.round(zoomRef.current * Math.exp(-Math.max(-240, Math.min(240, delta)) * .001) * 100) / 100)); delta = 0;
        if (next !== zoomRef.current) { zoomRef.current = next; zoomCallback.current?.(next); }
      });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { node.removeEventListener('wheel', wheel); cancelAnimationFrame(frame); };
  }, [document.format, view.id]);
  useEffect(() => { if (document.format === 'pdf') onPdfToolsChange?.({ note, highlight, ocrBusy, ocrResult }); }, [document.format, view.id, note, highlight, ocrBusy, ocrResult, onPdfToolsChange]);
  const emit = (extra: Partial<ReadingContext> = {}, force = false) => {
    if (document.format === 'web' && desktop) return;
    if (!host.current || (!force && Date.now() - lastReport.current < 120)) return;
    lastReport.current = Date.now();
    const root = host.current, rect = root.getBoundingClientRect(), visible = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,p,li,td,[data-block-id],[data-page-index]')].filter(n => { const b = n.getBoundingClientRect(); return b.bottom > rect.top && b.top < rect.bottom && b.right > rect.left && b.left < rect.right; });
    const visibleText = visible.map(n => n.querySelector('input') ? [...n.querySelectorAll<HTMLInputElement>('input')].map(input => `${input.getAttribute('aria-label')}: ${input.value}`).join('\n') : n.innerText).join('\n').slice(0, 24000);
    const current = visible[0], currentPage = current?.closest<HTMLElement>('[data-page-index]')?.dataset.pageIndex ?? current?.dataset.pageIndex;
    if (currentPage !== undefined) page.current = Number(currentPage);
    const context = { contentRevision: document.revision, locator: { kind: document.format, blockId: current?.dataset.blockId, pageIndex: document.format === 'pdf' ? page.current : undefined, slideId: document.model.slides?.[slideIndex]?.id, sheetId, scrollTop: root.scrollTop, quote: current?.innerText?.slice(0, 120) || document.title }, visibleText, selection: selection.current, ...(document.format === 'html' && view.mode === 'read' ? previewContext.current : {}), ...(['docx','pptx','xlsx'].includes(document.format) ? officeContext.current : {}), ...(view.mode !== 'read' ? sourceContext.current : {}), ...extra };
    void call('report-context', { viewId: view.id, context }).catch(reportError);
  };
  useEffect(() => { const timer = setTimeout(() => { if (window.getSelection()?.toString()) onSelection(); else { selection.current = { ...selection.current, rect: undefined, pageRects: undefined }; emit({}, true); } }, 200); return () => clearTimeout(timer); }, [document.id, document.revision, view.mode, slideIndex, sheetId, zoom]);
  useEffect(() => { if (ocrResult) emit({}, true); }, [ocrResult]);
  useEffect(() => { const navigate = (event: Event) => { const index = (event as CustomEvent<{ index: number }>).detail.index; if (document.format === 'pptx') setSlideIndex(Math.max(0, Math.min(index, (document.model.slides?.length ?? 1) - 1))); if (document.format === 'xlsx') setSheetId(document.model.sheets?.[index]?.id); if (document.format === 'docx') scrollReadingTarget(host.current?.querySelectorAll<HTMLElement>('[data-block-id]')[index]); }; window.addEventListener('agentviewer:navigate-structure', navigate); return () => window.removeEventListener('agentviewer:navigate-structure', navigate); }, [document.id, document.format, document.model]);
  useEffect(() => { if (document.format !== 'web' || !desktop) return; let disposed = false; const reportBounds = () => { if (disposed || !host.current) return; const rect = host.current.getBoundingClientRect(); void call('browser-layout', { windowId, views: obscured ? [] : [{ viewId: view.id, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }] }).catch(reportError); }; const observer = new ResizeObserver(reportBounds); observer.observe(host.current!); reportBounds(); return () => { disposed = true; observer.disconnect(); void call('browser-layout', { windowId, views: [] }).catch(() => {}); }; }, [document.id, view.id, obscured]);
  const applyEdit = (operation: EditOperation) => { void edit(operation).catch(() => {}); };
  const runOcr = async () => {
    const pageIndex = page.current, canvas = host.current?.querySelector<HTMLCanvasElement>(`.pdf-page[data-page-index="${pageIndex}"] canvas`);
    if (!canvas) { reportError('当前 PDF 页面尚未渲染完成。'); return; }
    setOcrBusy(true);
    try { setOcrResult(await call<{ pageIndex: number; text: string; confidence: number }>('ocr-image', { viewId: view.id, pageIndex, dataUrl: canvas.toDataURL('image/png') })); }
    catch (error) { reportError(error); }
    finally { setOcrBusy(false); }
  };
  useEffect(() => {
    if (document.format !== 'pdf') return;
    const handleTool = (event: Event) => {
      const command = (event as CustomEvent<PdfToolCommand>).detail;
      if (command.viewId !== view.id) return;
      if (command.action === 'note') { setNote(command.text ?? ''); setHighlight(false); }
      else if (command.action === 'highlight') { setHighlight(!highlight); setNote(''); }
      else if (command.action === 'rotate') applyEdit({ kind: 'pdf.rotate', pageIndex: page.current, degrees: 90 });
      else if (command.action === 'add-page') applyEdit({ kind: 'pdf.addPage' });
      else if (command.action === 'ocr' && !ocrBusy) void runOcr();
      else if (command.action === 'clear-ocr') setOcrResult(undefined);
    };
    window.addEventListener('agentviewer:pdf-tool', handleTool);
    return () => window.removeEventListener('agentviewer:pdf-tool', handleTool);
  }, [document.format, document.revision, view.id, highlight, ocrBusy]);
  const publishSelection = (selected: ReadingContext['selection']) => { selection.current = selected; emit({}, true); window.dispatchEvent(new CustomEvent('agentviewer:selection-tools', { detail: { viewId: view.id, revision: document.revision, selection: selected } })); };
  const onSelection = () => {
    const native = window.getSelection();
    if (!native?.rangeCount || !native.anchorNode || !host.current?.contains(native.anchorNode) || !native.toString()) return;
    const range = native.getRangeAt(0), text = native.toString(), rect = range.getBoundingClientRect();
    const element = native.anchorNode.nodeType === Node.ELEMENT_NODE ? native.anchorNode as Element : native.anchorNode.parentElement;
    const block = element?.closest<HTMLElement>('[data-block-id]'), pdfPage = element?.closest<HTMLElement>('[data-page-index]');
    let from: number | undefined, to: number | undefined;
    if (block && block.contains(range.endContainer)) { const prefix=range.cloneRange();prefix.selectNodeContents(block);prefix.setEnd(range.startContainer,range.startOffset);from=prefix.toString().length;to=from+text.length; }
    const pageRects: NonNullable<ReadingContext['selection']['pageRects']> = [];
    if(document.format==='pdf') for(const pageElement of host.current.querySelectorAll<HTMLElement>('.pdf-page')) {
      const pageBox=pageElement.getBoundingClientRect();
      for(const r of range.getClientRects()) { const x=Math.max(r.left,pageBox.left),y=Math.max(r.top,pageBox.top),right=Math.min(r.right,pageBox.right),bottom=Math.min(r.bottom,pageBox.bottom);if(right<=x||bottom<=y||r.width>pageBox.width*.98)continue;
        const next={pageIndex:Number(pageElement.dataset.pageIndex),x:(x-pageBox.left)/pageBox.width,y:(y-pageBox.top)/pageBox.height,width:(right-x)/pageBox.width,height:(bottom-y)/pageBox.height};
        if(!pageRects.some(old=>old.pageIndex===next.pageIndex&&Math.abs(old.x-next.x)<.001&&Math.abs(old.y-next.y)<.001&&Math.abs(old.width-next.width)<.001))pageRects.push(next);
      }
    }
    publishSelection({kind:'text',text,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},pageRects:pageRects.length?pageRects:undefined,locator:{kind:'text-quote',quote:text,blockId:document.format==='docx'?block?.dataset.blockId:undefined,shapeId:document.format==='pptx'?block?.dataset.blockId:undefined,pageIndex:pdfPage?Number(pdfPage.dataset.pageIndex):undefined,slideId:block?.closest<HTMLElement>('[data-slide-id]')?.dataset.slideId ?? officeContext.current.locator?.slideId ?? document.model.slides?.[slideIndex]?.id,from,to}});
  };
  const officeCallbacks = useRef({ edit, reportError, onOfficeTargetChange, onOfficeDraftController, onOfficeDraftChange, emit, publishSelection, viewId: view.id });
  officeCallbacks.current = { edit, reportError, onOfficeTargetChange, onOfficeDraftController, onOfficeDraftChange, emit, publishSelection, viewId: view.id };
  const officeView = useMemo(() => ({ id: view.id }), [view.id]);
  // React memo can skip the whole Office tree when only reading context polls.
  // These bridges preserve callback identity while always calling fresh owners
  // and using the current document revision for emitted selection snapshots.
  const officeBridge = useMemo(() => ({
    edit: (operation: EditOperation) => officeCallbacks.current.edit(operation),
    reportError: (error: unknown) => officeCallbacks.current.reportError(error),
    onTarget: (target: OfficeTarget) => officeCallbacks.current.onOfficeTargetChange?.(target),
    onDraftController: (controller: OfficeDraftController | undefined) => officeCallbacks.current.onOfficeDraftController?.(controller),
    onDraftChange: (dirty: boolean) => officeCallbacks.current.onOfficeDraftChange?.({ viewId: officeCallbacks.current.viewId, dirty }),
    onContext: (partial: Partial<ReadingContext>) => { officeContext.current = partial; officeCallbacks.current.emit(partial, true); },
    onSelection: (selected: ReadingContext['selection']) => officeCallbacks.current.publishSelection(selected),
  }), []);
  const textEditor = <Suspense fallback={<p className="loading">加载编辑器…</p>}><TextEditor value={document.model.text ?? ''} format={document.format} onChange={onTextChange} onContext={context => { onReaderScroll?.(context.scrollTop); selection.current = { kind: context.text ? 'text' : 'none', text: context.text, locator: { kind: 'source-range', from: context.from, to: context.to } }; sourceContext.current = { locator: { kind: 'source-range', from: context.from, to: context.to, scrollTop: context.scrollTop }, visibleText: context.visibleText }; emit(sourceContext.current, true); if(context.text && context.rect) publishSelection({...selection.current,rect:context.rect}); }} /></Suspense>;
  const reading = document.format === 'markdown' ? <article className="prose"><ReactMarkdown urlTransform={url => url.startsWith('agentviewer://document/') ? url : defaultUrlTransform(url)} remarkPlugins={[remarkGfm]}>{document.model.text ?? ''}</ReactMarkdown></article> : <HtmlPreview highlights={annotations.filter(note=>note.sourceRevision===document.revision).map(note=>note.selection.text)} html={document.model.text ?? ''} onContext={(text, selected, scrollTop, rect) => { onReaderScroll?.(scrollTop); selection.current = { kind: selected ? 'text' : 'none', text: selected, locator: selected ? { kind: 'html-text-quote', quote: selected } : undefined }; previewContext.current = { locator: { kind: 'html-viewport', scrollTop, quote: text.slice(0, 120) }, visibleText: text }; emit(previewContext.current, true); if(selected && rect) publishSelection({...selection.current,rect}); }} />;
  let content;
  if (document.format === 'markdown' || document.format === 'html') content = view.mode === 'source' ? textEditor : view.mode === 'split' ? <div className="split-view"><div>{textEditor}</div><div className="split-reading">{reading}</div></div> : reading;
  else if (['docx', 'pptx', 'xlsx'].includes(document.format)) content = <OfficeDocument document={document} view={officeView} zoom={zoom} {...officeBridge} />;
  else if (document.format === 'pdf') content = <><Suspense fallback={<p className="loading">加载 PDF 引擎…</p>}><PdfReader document={document} zoom={zoom} note={note} highlight={highlight} pageRef={page} onReady={() => emit({}, true)} edit={async operation => { await edit(operation); setNote(''); setHighlight(false); }} /></Suspense></>;
  else content = desktop ? <div className="browser-placeholder">正在呈现网页…</div> : <iframe title="网页预览" className="web-preview" src={document.model.url} />;
  return <div className={'document-content format-' + document.format} data-reading-zoom={zoom} ref={host} onScrollCapture={event => { onReaderScroll?.((event.target as HTMLElement).scrollTop); emit(); }} onMouseUp={onSelection} onKeyUp={onSelection}><div className="reading-content-body" style={{ zoom: document.format === 'pdf' || document.format === 'web' || ['docx','pptx','xlsx'].includes(document.format) ? 1 : zoom }}>{content}</div></div>;
}
