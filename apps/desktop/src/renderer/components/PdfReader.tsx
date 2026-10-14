import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { bytes } from '../lib/transport';
import { useDocumentPaperColor } from '../lib/document-paper';
import type { DocumentInfo, EditOperation } from '../../../../../packages/contracts/src/index';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
type PaintedPage = { page: pdfjs.PDFPageProxy; canvas: HTMLCanvasElement; viewport: pdfjs.PageViewport; ratio: number; color?: string; disposed: boolean; pending?: Promise<void>; task?: pdfjs.RenderTask };

export function PdfReader({ document, zoom = 1, note, highlight, edit, pageRef, onReady }: { document: DocumentInfo; zoom?: number; note: string; highlight: boolean; edit(operation: EditOperation): Promise<void>; pageRef: React.RefObject<number>; onReady(): void }) {
  const host = useRef<HTMLDivElement>(null), [error, setError] = useState('');
  const paperColor = useDocumentPaperColor();
  const currentPaper = useRef(paperColor); currentPaper.current = paperColor;
  const paintedPages = useRef<PaintedPage[]>([]);
  const paint = (item: PaintedPage): Promise<void> => {
    if (item.pending) return item.pending;
    const pending = (async () => {
      // Repaint cached page operators on colour changes; keep text layers,
      // selection, scroll position and the loaded PDF document intact.
      while (!item.disposed && item.color !== currentPaper.current) {
        const background = currentPaper.current;
        item.task = item.page.render({ canvas: item.canvas, canvasContext: item.canvas.getContext('2d')!, viewport: item.viewport, background, transform: item.ratio === 1 ? undefined : [item.ratio,0,0,item.ratio,0,0] });
        await item.task.promise; item.color = background; item.canvas.dataset.documentPaper = background;
      }
    })().catch(error => { if (!item.disposed) throw error; }).finally(() => { item.pending = undefined; item.task = undefined; });
    item.pending = pending; return pending;
  };
  const callback = useRef({ note, highlight, edit, pageRef, onReady }); callback.current = { note, highlight, edit, pageRef, onReady };
  useEffect(() => {
    let disposed = false; let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    const render = async () => {
      const input = await bytes(document.id); task = pdfjs.getDocument({ data: input }); const pdf = await task.promise;
      if (disposed) return; host.current!.replaceChildren();
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i); if (disposed) return;
        const scale = Math.min(1.1, (host.current!.clientWidth - 60) / page.getViewport({ scale: 1 }).width) * zoom;
        const viewport = page.getViewport({ scale }), ratio = window.devicePixelRatio || 1;
        const wrap = window.document.createElement('div'); wrap.className = 'pdf-page'; wrap.dataset.pageIndex = String(i - 1); wrap.style.width = viewport.width + 'px'; wrap.style.height = viewport.height + 'px'; wrap.style.setProperty('--scale-factor', String(scale)); wrap.style.setProperty('--total-scale-factor', String(scale));
        const canvas = window.document.createElement('canvas'); canvas.width = viewport.width * ratio; canvas.height = viewport.height * ratio; canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px'; wrap.appendChild(canvas);
        const layer = window.document.createElement('div'); layer.className = 'textLayer'; wrap.appendChild(layer); host.current!.appendChild(wrap);
        const painted: PaintedPage = { page, canvas, viewport, ratio, disposed: false }; paintedPages.current.push(painted);
        await paint(painted);
        const text = await page.getTextContent(); if (disposed) return; await new pdfjs.TextLayer({ textContentSource: text, container: layer, viewport }).render();
        wrap.addEventListener('pointerdown', () => { callback.current.pageRef.current = i - 1; });
        wrap.addEventListener('click', event => { const current = callback.current; if (!current.note && !current.highlight) return; const rect = wrap.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height; void current.edit(current.highlight ? { kind: 'pdf.highlight', pageIndex: i - 1, x, y, width: Math.min(0.25, 1 - x), height: Math.min(0.03, 1 - y) } : { kind: 'pdf.addText', pageIndex: i - 1, x, y, text: current.note, size: 16 }).catch(() => {}); });
      }
      if (!disposed) callback.current.onReady();
    };
    void render().catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; for (const painted of paintedPages.current) { painted.disposed = true; painted.task?.cancel(); } paintedPages.current = []; void task?.destroy(); };
  }, [document.id, document.revision, zoom]);
  useEffect(() => { let active = true; void Promise.all(paintedPages.current.map(paint)).catch(error => { if (active) setError(String(error)); }); return () => { active = false; }; }, [paperColor]);
  return <div className="pdf-content" ref={host}>{error && <p className="error-text">{error}</p>}</div>;
}
