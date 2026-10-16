import DOMPurify from 'dompurify';

let mathematics: Worker | undefined;
let diagrams: Promise<typeof import('mermaid')['default']> | undefined;
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>(), mathRequests = new Map<string, { resolve(html: string): void; reject(error: unknown): void }>();
let cacheBytes = 0;
const byteBudget = 8 * 1024 * 1024;
type DiagramLanguage = 'mermaid' | 'sequence' | 'flow';
let legacy: Promise<{ sequence: { parse(source: string): { drawSVG(container: HTMLElement, options: { theme: string }): void } }; flow: { parse(source: string): { drawSVG(container: HTMLElement, options?: Record<string, unknown>): void } }; Raphael: unknown; underscore: unknown }> | undefined;

function withLegacyGlobals<T>(Raphael: unknown, underscore: unknown, action: () => T): T {
  const globals = globalThis as unknown as Record<string, unknown>, oldRaphael = globals.Raphael, oldUnderscore = globals._;
  globals.Raphael = Raphael; globals._ = underscore;
  try { return action(); } finally { if (oldRaphael === undefined) delete globals.Raphael; else globals.Raphael = oldRaphael; if (oldUnderscore === undefined) delete globals._; else globals._ = oldUnderscore; }
}
async function legacyDiagram(source: string, language: 'sequence' | 'flow') {
  legacy ??= Promise.all([import('raphael'), import('underscore')]).then(async ([{ default: Raphael }, { default: underscore }]) => {
    const globals = globalThis as unknown as Record<string, unknown>, oldRaphael = globals.Raphael, oldUnderscore = globals._;
    globals.Raphael = Raphael; globals._ = underscore;
    try { const [{ default: sequence }, { default: flow }] = await Promise.all([import('@rokt33r/js-sequence-diagrams'), import('flowchart.js')]); return { sequence, flow, Raphael, underscore }; }
    finally { if (oldRaphael === undefined) delete globals.Raphael; else globals.Raphael = oldRaphael; if (oldUnderscore === undefined) delete globals._; else globals._ = oldUnderscore; }
  }).catch(error => { legacy = undefined; throw error; });
  const runtime = await legacy, host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-100000px;top:0;width:1000px;visibility:hidden;pointer-events:none'; document.body.append(host);
  try { withLegacyGlobals(runtime.Raphael, runtime.underscore, () => { if (language === 'sequence') runtime.sequence.parse(source).drawSVG(host, { theme: 'simple' }); else runtime.flow.parse(source).drawSVG(host, { 'font-family': 'system-ui', 'font-size': 14, 'line-width': 2 }); }); const svg = host.querySelector('svg'); if (!svg) throw new Error('图表未生成 SVG。'); return svg.outerHTML; }
  finally { host.remove(); }
}

function read(key: string) { const value = cache.get(key); if (value !== undefined) { cache.delete(key); cache.set(key, value); } return value; }
function math(source: string, display: boolean) {
  if (!mathematics) {
    mathematics = new Worker(new URL('./markdown-math-worker.ts', import.meta.url), { type: 'module' });
    mathematics.onmessage = (event: MessageEvent<{ id: string; html?: string; error?: string }>) => { const request = mathRequests.get(event.data.id); if (!request) return; mathRequests.delete(event.data.id); if (event.data.error) request.reject(new Error(event.data.error)); else request.resolve(event.data.html ?? ''); };
    mathematics.onerror = event => { const error = new Error(event.message || '公式工作线程异常。'); for (const request of mathRequests.values()) request.reject(error); mathRequests.clear(); mathematics?.terminate(); mathematics = undefined; };
  }
  const id = crypto.randomUUID(); return new Promise<string>((resolve, reject) => { mathRequests.set(id, { resolve, reject }); mathematics!.postMessage({ id, source, display }); });
}

/** Rendering is offline and lazy; neither Markdown nor a model may run scripts. */
export async function renderMarkdownFormula(source: string, display: boolean) {
  const key = 'math:' + display + ':' + source;
  const cached = read(key); if (cached !== undefined) return cached;
  if (source.length > 100000) throw new Error('单个公式超过 100000 字符，请拆分公式。');
  if (inFlight.has(key)) return inFlight.get(key)!;
  const result = math(source, display).then(svg => { const html = DOMPurify.sanitize(svg, { USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ['mjx-container'] }); remember(key, html); return html; }).finally(() => inFlight.delete(key));
  inFlight.set(key, result); return result;
}

export async function renderMarkdownDiagram(source: string, language: DiagramLanguage = 'mermaid') {
  const dark = document.documentElement.dataset.theme === 'dark';
  const key = 'diagram:' + language + ':' + dark + ':' + source;
  const cached = read(key); if (cached !== undefined) return cached;
  if (inFlight.has(key)) return inFlight.get(key)!;
  if (source.length > 100000) throw new Error('单个图表超过 100000 字符，请拆分图表。');
  if (language !== 'mermaid') { const result = legacyDiagram(source, language).then(svg => { const html = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }); remember(key, html); return html; }).finally(() => inFlight.delete(key)); inFlight.set(key, result); return result; }
  diagrams ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'neutral', fontFamily: 'system-ui', flowchart: { htmlLabels: false } });
    return mermaid;
  }).catch(error => { diagrams = undefined; throw error; });
  const result = (async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); const result = await (await diagrams!).render('av-md-' + crypto.randomUUID().replaceAll('-', ''), source); const html = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } }); remember(key, html); return html; })().finally(() => inFlight.delete(key));
  inFlight.set(key, result); return result;
}

function remember(key: string, html: string) {
  // A bounded render cache belongs to the editor, never to a saved document.
  const bytes = 2 * (key.length + html.length); if (bytes > byteBudget / 2) return;
  const existing = cache.get(key); if (existing !== undefined) cacheBytes -= 2 * (key.length + existing.length);
  cache.delete(key);
  while (cache.size && (cache.size >= 64 || cacheBytes + bytes > byteBudget)) { const oldest = cache.keys().next().value!, value = cache.get(oldest)!; cacheBytes -= 2 * (oldest.length + value.length); cache.delete(oldest); }
  cache.set(key, html); cacheBytes += bytes;
}
