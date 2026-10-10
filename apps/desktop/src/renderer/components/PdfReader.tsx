import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { bytes } from '../lib/transport';
import type { DocumentInfo, EditOperation } from '../../../../../packages/contracts/src/index';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfReader({ document, note, highlight, edit, pageRef, onReady }: { document: DocumentInfo; note: string; highlight: boolean; edit(operation: EditOperation): Promise<void>; pageRef: React.RefObject<number>; onReady(): void }) {
  const host = useRef<HTMLDivElement>(null), [error, setError] = useState('');
  const callback = useRef({ note, highlight, edit, pageRef, onReady }); callback.current = { note, highlight, edit, pageRef, onReady };
  useEffect(() => {
    let disposed = false; let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    const render = async () => {
      const input = await bytes(document.id); task = pdfjs.getDocument({ data: input }); const pdf = await task.promise;
      if (disposed) return; host.current!.replaceChildren();
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i); if (disposed) return;
        const scale = Math.min(1.1, (host.current!.clientWidth - 60) / page.getViewport({ scale: 1 }).width);
        const viewport = page.getViewport({ scale }), ratio = window.devicePixelRatio || 1;
        const wrap = window.document.createElement('div'); wrap.className = 'pdf-page'; wrap.dataset.pageIndex = String(i - 1); wrap.style.width = viewport.width + 'px'; wrap.style.height = viewport.height + 'px'; wrap.style.setProperty('--scale-factor', String(scale)); wrap.style.setProperty('--total-scale-factor', String(scale));
        const canvas = window.document.createElement('canvas'); canvas.width = viewport.width * ratio; canvas.height = viewport.height * ratio; canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px'; wrap.appendChild(canvas);
        const layer = window.document.createElement('div'); layer.className = 'textLayer'; wrap.appendChild(layer); host.current!.appendChild(wrap);
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
        const text = await page.getTextContent(); if (disposed) return; await new pdfjs.TextLayer({ textContentSource: text, container: layer, viewport }).render();
        wrap.addEventListener('pointerdown', () => { callback.current.pageRef.current = i - 1; });
        wrap.addEventListener('click', event => { const current = callback.current; if (!current.note && !current.highlight) return; const rect = wrap.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height; void current.edit(current.highlight ? { kind: 'pdf.highlight', pageIndex: i - 1, x, y, width: Math.min(0.25, 1 - x), height: Math.min(0.03, 1 - y) } : { kind: 'pdf.addText', pageIndex: i - 1, x, y, text: current.note, size: 16 }).catch(() => {}); });
      }
      if (!disposed) callback.current.onReady();
    };
    void render().catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; void task?.destroy(); };
  }, [document.id, document.revision]);
  return <div className="pdf-content" ref={host}>{error && <p className="error-text">{error}</p>}</div>;
}
