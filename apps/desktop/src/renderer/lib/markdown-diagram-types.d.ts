declare module 'raphael' { const Raphael: unknown; export default Raphael; }
declare module 'underscore' { const underscore: unknown; export default underscore; }
declare module '@rokt33r/js-sequence-diagrams' { const Diagram: { parse(source: string): { drawSVG(container: HTMLElement, options: { theme: string }): void } }; export default Diagram; }
declare module 'flowchart.js' { const flowchart: { parse(source: string): { drawSVG(container: HTMLElement, options?: Record<string, unknown>): void } }; export default flowchart; }
