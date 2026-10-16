/** MathJax's lite adaptor has no DOM dependency. Parse and lay out TeX outside
 * the renderer thread; the main thread sanitizes the resulting SVG. */
let mathematics: Promise<(source: string, display: boolean) => string> | undefined;
const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<{ id: string; source: string; display: boolean }>) => void) | null; postMessage(message: unknown): void };
worker.onmessage = event => {
  const { id, source, display } = event.data;
  mathematics ??= Promise.all([
    import('mathjax-full/js/mathjax.js'), import('mathjax-full/js/input/tex.js'),
    import('mathjax-full/js/output/svg.js'), import('mathjax-full/js/adaptors/liteAdaptor.js'),
    import('mathjax-full/js/handlers/html.js'), import('mathjax-full/js/input/tex/AllPackages.js'),
  ]).then(([{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }]) => {
    const adaptor = liteAdaptor(); RegisterHTMLHandler(adaptor);
    const input = new TeX({ packages: AllPackages.filter(name => !['require', 'autoload', 'html'].includes(name)), maxBuffer: 100000, maxMacros: 1000 });
    const document = mathjax.document('', { InputJax: input, OutputJax: new SVG({ fontCache: 'none' }) });
    return (tex: string, block: boolean) => adaptor.outerHTML(document.convert(tex, { display: block }));
  }).catch(error => { mathematics = undefined; throw error; });
  void mathematics.then(render => worker.postMessage({ id, html: render(source, display) })).catch(error => worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) }));
};
export {};
