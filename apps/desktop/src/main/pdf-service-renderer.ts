import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf-service-worker.mjs', import.meta.url).href;
const documents = new Map<string, { pdf: pdfjs.PDFDocumentProxy; task: pdfjs.PDFDocumentLoadingTask }>();
type Request = { action: 'load' | 'text' | 'render' | 'close'; key: string; data?: string; page?: number; scale?: number };
async function request(input: Request) {
  if (input.action === 'close') { await documents.get(input.key)?.task.destroy(); documents.delete(input.key); return {}; }
  if (input.action === 'load') {
    if (!documents.has(input.key)) {
      while (documents.size >= 2) { const key = documents.keys().next().value!; await documents.get(key)!.task.destroy(); documents.delete(key); }
      const source = atob(input.data!), data = new Uint8Array(source.length);
      for (let index = 0; index < source.length; index++) data[index] = source.charCodeAt(index);
      const task = pdfjs.getDocument({ data, enableXfa: false, useWorkerFetch: false, disableAutoFetch: true });
      const pdf = await task.promise;
      documents.set(input.key, { pdf, task });
    }
    return { pageCount: documents.get(input.key)!.pdf.numPages, parser: 'pdfjs-' + pdfjs.version };
  }
  const pdf = documents.get(input.key)?.pdf;
  if (!pdf) throw new Error('PDF_SOURCE_EXPIRED');
  const index = input.page ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || index >= pdf.numPages) throw new Error('PDF_PAGE_RANGE');
  const page = await pdf.getPage(index + 1), viewport = page.getViewport({ scale: 1 });
  if (input.action === 'text') {
    const content = await page.getTextContent(), items = content.items.filter((item): item is TextItem => 'str' in item);
    let text = '';
    const spans = items.slice(0, 500).map(item => {
      const transform = pdfjs.Util.transform(viewport.transform, item.transform), style = content.styles[item.fontName], height = Math.hypot(transform[2], transform[3]), from = text.length;
      const angle = Math.atan2(transform[1], transform[0]) + (style?.vertical ? Math.PI / 2 : 0), advance = style?.vertical ? item.height : item.width;
      const ascent = height * (style?.ascent ?? (style?.descent !== undefined ? 1 + style.descent : 1));
      const x = transform[4] + Math.sin(angle) * ascent, y = transform[5] - Math.cos(angle) * ascent;
      const quad = [[x, y], [x + Math.cos(angle) * advance, y + Math.sin(angle) * advance], [x + Math.cos(angle) * advance - Math.sin(angle) * height, y + Math.sin(angle) * advance + Math.cos(angle) * height], [x - Math.sin(angle) * height, y + Math.cos(angle) * height]];
      const left = Math.min(...quad.map(point => point[0])), top = Math.min(...quad.map(point => point[1]));
      text += item.str + (item.hasEOL ? '\n' : ' ');
      return { from, to: from + item.str.length, x: left, y: top, width: Math.max(...quad.map(point => point[0])) - left, height: Math.max(...quad.map(point => point[1])) - top, quad, direction: item.dir };
    });
    return { page: index, pageCount: pdf.numPages, width: viewport.width, height: viewport.height, cropBox: page.view, rotation: viewport.rotation, text: text.slice(0, 16000), spans, truncated: items.length > spans.length || text.length > 16000, coordinateSpace: 'page-points-top-left', boundsAccuracy: 'font-metrics', readingOrder: 'content-stream-partial', parser: 'pdfjs-' + pdfjs.version };
  }
  const desired = Math.max(.25, Math.min(3, input.scale ?? 1.5)), scale = Math.min(desired, 4096 / viewport.width, 4096 / viewport.height, Math.sqrt(16000000 / (viewport.width * viewport.height))), rendered = page.getViewport({ scale });
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(rendered.width); canvas.height = Math.ceil(rendered.height);
  try {
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: rendered, background: '#ffffff' }).promise;
    return { page: index, pageCount: pdf.numPages, width: canvas.width, height: canvas.height, pageWidth: viewport.width, pageHeight: viewport.height, cropBox: page.view, rotation: rendered.rotation, scale, mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1], parser: 'pdfjs-' + pdfjs.version };
  } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
}
Object.defineProperty(globalThis, '__agentViewerPdfService', { value: { request }, writable: false, configurable: false });
