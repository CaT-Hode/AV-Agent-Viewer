import { BrowserWindow, session } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createWorker, type Worker } from 'tesseract.js';
import type { ViewerCore } from '../../../../packages/document-core/src/index';
import { ViewerError } from '../../../../packages/contracts/src/index';
import { ocrLanguageDir } from '../../../../packages/engines/src/index';
import { readPdfStructure } from '../../../../packages/sdk/src/pdf-content';

export interface PdfContentRequest {
  documentId: string; action: 'pages' | 'text' | 'render' | 'ocr' | 'annotations' | 'forms' | 'search';
  page?: number; index?: number; image?: boolean; language?: string; query?: string; cursor?: string; limit?: number; scale?: number; signal?: AbortSignal;
}
type PageImage = { data: string; mimeType: 'image/png'; width: number; height: number; scale: number; pageWidth: number; pageHeight: number; rotation: number; parser: string };
type PdfPageText = { text: string; spans: unknown[]; truncated: boolean; parser: string; [key: string]: unknown };
type SearchCursor = { documentId: string; hash: string; query: string; page: number; offset: number };

/** PDF work has an owned sandbox and frozen bytes, never a reader's canvas. */
export class PdfContentService {
  private window?: BrowserWindow;
  private starting?: Promise<BrowserWindow>;
  private rendererTail: Promise<unknown> = Promise.resolve();
  private rendererQueued = 0;
  private loaded = new Map<string, { parser: string; pageCount: number }>();
  private cursors = new Map<string, SearchCursor>();
  private ocrWorker?: Worker;
  private ocrLanguage?: string;
  private ocrTail: Promise<unknown> = Promise.resolve();
  private ocrQueued = 0;
  private ocrCache = new Map<string, Record<string, unknown>>();
  private disposed = false;
  constructor(private core: ViewerCore, private root: string, private directory: string) {}
  private assertSignal(signal?: AbortSignal) { if (signal?.aborted || this.disposed) throw new ViewerError('CANCELLED', 'PDF operation was cancelled.'); }
  private async renderer() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const partition = session.fromPartition('agentviewer-pdf-content-' + randomUUID(), { cache: false });
      partition.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
      partition.setPermissionCheckHandler(() => false);
      const script = pathToFileURL(join(this.root, 'dist/main/pdf-service-renderer.mjs')).href, worker = pathToFileURL(join(this.root, 'dist/main/pdf-service-worker.mjs')).href;
      const htmlPath = join(this.directory, 'runtime', 'pdf-content-service.html');
      await mkdir(join(this.directory, 'runtime'), { recursive: true });
      await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src file:; worker-src file: blob:; font-src blob: data:; img-src data: blob:; connect-src file: blob:;"><script type="module" src="' + script + '"></script>');
      const html = pathToFileURL(htmlPath).href;
      partition.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, answer) => answer({ cancel: ![html, script, worker].includes(details.url.split('?')[0]) && !details.url.startsWith('blob:') && !details.url.startsWith('data:') }));
      const win = new BrowserWindow({ show: false, width: 8, height: 8, skipTaskbar: true, focusable: false, webPreferences: { session: partition, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
      this.window = win; this.loaded.clear();
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('will-attach-webview', event => event.preventDefault());
      win.on('closed', () => { if (this.window === win) { this.window = undefined; this.loaded.clear(); } });
      try {
        await win.loadFile(htmlPath);
        const until = Date.now() + 15000;
        while (!await win.webContents.executeJavaScript('typeof globalThis.__agentViewerPdfService?.request === "function"')) {
          if (Date.now() >= until) throw new ViewerError('ENGINE_REQUIRED', 'The isolated PDF service did not initialize.');
          await new Promise(done => setTimeout(done, 20));
        }
        return win;
      } catch (cause) { if (!win.isDestroyed()) win.destroy(); throw cause; }
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async serialized<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.rendererQueued >= 8) throw new ViewerError('SERVICE_BUSY', 'The PDF renderer queue is full.');
    this.rendererQueued++;
    const result = this.rendererTail.catch(() => {}).then(async () => {
      this.assertSignal(signal);
      const cancel = () => { if (this.window && !this.window.isDestroyed()) this.window.destroy(); };
      signal?.addEventListener('abort', cancel, { once: true });
      try { const value = await operation(); this.assertSignal(signal); return value; }
      finally { signal?.removeEventListener('abort', cancel); }
    });
    this.rendererTail = result;
    try { return await result; } finally { this.rendererQueued--; }
  }
  private async invoke<T>(input: Record<string, unknown>): Promise<T> {
    const win = await this.renderer();
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        win.webContents.executeJavaScript('globalThis.__agentViewerPdfService.request(' + JSON.stringify(input) + ')') as Promise<T>,
        new Promise<never>((_done, fail) => { timeout = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); fail(new ViewerError('ENGINE_TIMEOUT', 'The isolated PDF operation timed out.')); }, 30000); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
  private async ensureLoaded(hash: string, bytes: Uint8Array) {
    if (this.loaded.has(hash) && this.window && !this.window.isDestroyed()) return this.loaded.get(hash)!;
    const result = await this.invoke<{ parser: string; pageCount: number }>({ action: 'load', key: hash, data: Buffer.from(bytes).toString('base64') });
    while (this.loaded.size >= 2) this.loaded.delete(this.loaded.keys().next().value!);
    this.loaded.set(hash, result); return result;
  }
  async request(input: PdfContentRequest) {
    this.assertSignal(input.signal);
    const source = await this.core.freezeDocumentSource(input.documentId);
    if (source.document.format !== 'pdf') throw new ViewerError('INVALID_TARGET', 'The target is not a PDF.');
    const page = input.page ?? 0;
    if (!Number.isSafeInteger(page) || page < 0 || page >= (source.document.model.pageCount ?? 0)) throw new ViewerError('INVALID_ARGUMENT', 'PDF page index is out of range.');
    const provenance = { documentId: source.document.id, revision: source.document.revision, sha256: source.sha256, page, frozen: true, background: true };
    if (input.action === 'annotations' || input.action === 'forms') {
      const structure = await readPdfStructure(source.bytes, page, input.index ?? 0);
      return { ...provenance, pageCount: structure.pageCount, ...(input.action === 'forms' ? { forms: structure.forms, total: structure.formsTotal, truncated: structure.formsTruncated } : { annotations: structure.annotations, total: structure.annotationsTotal, offset: structure.annotationOffset, truncated: structure.annotationsTruncated, ...(structure.annotationsTruncated ? { nextIndex: structure.annotationOffset + structure.annotations.length } : {}) }), parser: 'pdf-lib' };
    }
    if (input.action === 'search') {
      const query = input.query ?? '';
      if (!query || query.length > 500) throw new ViewerError('INVALID_ARGUMENT', 'A search query of 1–500 characters is required.');
      const cursor = input.cursor ? this.cursors.get(input.cursor) : undefined;
      if (input.cursor && (!cursor || cursor.documentId !== input.documentId || cursor.hash !== source.sha256 || cursor.query !== query)) throw new ViewerError('STALE_CURSOR', 'The PDF search source or query changed.');
      const start = cursor?.page ?? 0, pageCount = source.document.model.pageCount!, hits: { page: number; from: number; to: number; text: string }[] = [];
      // Every call scans at most eight complete pages. Continuation reports
      // coverage even if those pages contain no match.
      const end = Math.min(pageCount, start + Math.min(8, Math.max(1, input.limit ?? 8)));
      const partialPages: number[] = [];
      let nextPage = end, nextOffset = 0, completeTo = start;
      for (let current = start; current < end; current++) {
        this.assertSignal(input.signal);
        const content = await this.serialized(async () => { await this.ensureLoaded(source.sha256, source.bytes); return this.invoke<PdfPageText>({ action: 'text', key: source.sha256, page: current }); }, input.signal);
        if (content.truncated) partialPages.push(current);
        let from = current === start ? cursor?.offset ?? 0 : 0;
        while ((from = content.text.indexOf(query, from)) >= 0) {
          hits.push({ page: current, from, to: from + query.length, text: content.text.slice(Math.max(0, from - 80), from + query.length + 80) }); from += query.length;
          if (hits.length >= 100) { nextPage = current; nextOffset = from; break; }
        }
        if (hits.length >= 100) break;
        completeTo = current + 1;
      }
      const next = nextPage < pageCount ? 'pc' + randomUUID().replaceAll('-', '').slice(0, 16) : undefined;
      if (next) { while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!); this.cursors.set(next, { documentId: input.documentId, hash: source.sha256, query, page: nextPage, offset: nextOffset }); }
      return { ...provenance, hits, coverage: { fromPage: start, toPageExclusive: completeTo, pageCount, partialPages, scope: 'embedded-text' }, cursor: next, truncated: hits.length >= 100 || partialPages.length > 0 };
    }
    const image = input.action === 'ocr' || input.action === 'render' || input.image === true;
    const result = await this.serialized(async () => {
      await this.ensureLoaded(source.sha256, source.bytes);
      return image ? this.invoke<PageImage>({ action: 'render', key: source.sha256, page, scale: input.scale ?? (input.action === 'ocr' ? 2 : 1.5) }) : this.invoke<PdfPageText>({ action: 'text', key: source.sha256, page });
    }, input.signal);
    this.assertSignal(input.signal);
    if (input.action !== 'ocr') return { ...provenance, ...result, source: image ? 'page-raster' : 'embedded-text', coverage: { page, complete: !('truncated' in result && result.truncated) } };
    return { ...provenance, ...await this.recognize(result as PageImage, source.sha256, page, input.language ?? 'eng', input.signal) };
  }
  private async recognize(image: PageImage, hash: string, page: number, language: string, signal?: AbortSignal) {
    if (!['eng', 'chi_sim', 'eng+chi_sim', 'chi_sim+eng'].includes(language)) throw new ViewerError('CAPABILITY_UNSUPPORTED', 'Only installed English and Simplified Chinese OCR languages are supported.');
    const langPath = ocrLanguageDir(this.root);
    if (!langPath) throw new ViewerError('ENGINE_REQUIRED', 'The installed OCR language files are unavailable.');
    const key = createHash('sha256').update(JSON.stringify([hash, page, image.scale, image.rotation, image.parser, language, 'tesseract-blocks-v1'])).digest('hex');
    const cached = this.ocrCache.get(key); if (cached) return cached;
    if (this.ocrQueued >= 8) throw new ViewerError('SERVICE_BUSY', 'The OCR queue is full.');
    this.ocrQueued++;
    const result = this.ocrTail.catch(() => {}).then(async () => {
      this.assertSignal(signal);
      if (!this.ocrWorker || this.ocrLanguage !== language) { await this.ocrWorker?.terminate().catch(() => {}); this.ocrWorker = await createWorker(language, 1, { langPath, gzip: true, cacheMethod: 'readOnly' }); this.ocrLanguage = language; }
      const worker = this.ocrWorker;
      const cancel = () => { if (this.ocrWorker === worker) { this.ocrWorker = undefined; this.ocrLanguage = undefined; } void worker.terminate().catch(() => {}); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        this.assertSignal(signal);
        const recognized = await worker.recognize(Buffer.from(image.data, 'base64'), {}, { text: true, blocks: true });
        this.assertSignal(signal);
        const all = (recognized.data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words)));
        const words = all.slice(0, 2000).map(word => ({ text: word.text, confidence: word.confidence, x: word.bbox.x0 / image.scale, y: word.bbox.y0 / image.scale, width: (word.bbox.x1 - word.bbox.x0) / image.scale, height: (word.bbox.y1 - word.bbox.y0) / image.scale }));
        const value = { text: recognized.data.text.trim().slice(0, 16000), words, confidence: recognized.data.confidence, language, source: 'ocr', parser: image.parser, ocrVersion: recognized.data.version, coordinateSpace: 'page-points-top-left', pageWidth: image.pageWidth, pageHeight: image.pageHeight, rotation: image.rotation, truncated: all.length > words.length || recognized.data.text.trim().length > 16000, cacheKey: key };
        while (this.ocrCache.size >= 16) this.ocrCache.delete(this.ocrCache.keys().next().value!);
        this.ocrCache.set(key, value); return value;
      } finally { signal?.removeEventListener('abort', cancel); }
    });
    this.ocrTail = result;
    try { return await result; } finally { this.ocrQueued--; }
  }
  async dispose() { this.disposed = true; if (this.window && !this.window.isDestroyed()) this.window.destroy(); await this.ocrWorker?.terminate().catch(() => {}); this.ocrWorker = undefined; this.loaded.clear(); this.cursors.clear(); this.ocrCache.clear(); }
}
