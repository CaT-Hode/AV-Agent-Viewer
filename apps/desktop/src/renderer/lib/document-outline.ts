import type { DocumentInfo } from '../../../../../packages/contracts/src/index';

export type DocumentOutlineItem = { index: number; title: string; id?: string; level?: number };
export type SharedOutlineItem = { id: string; title: string; level?: number };
/** Explicit format branches keep arrays out of conditional-expression precedence. */
export function documentOutlineItems(document: Pick<DocumentInfo, 'format' | 'model'> | undefined, html: readonly SharedOutlineItem[] = []): DocumentOutlineItem[] {
  if (!document) return [];
  const model = document.model;
  switch (document.format) {
    case 'html': return html.map((item, index) => ({ ...item, index }));
    case 'markdown': return (model.text ?? '').split('\n').filter(line => /^#{1,6} /.test(line)).map((line, index) => ({ index, title: line.replace(/^#+ /, ''), level: /^#+/.exec(line)![0].length }));
    case 'docx': return (model.blocks ?? []).flatMap((block, index) => /^Heading[1-6]$/.test(block.style ?? '') ? [{ index, id: block.id, title: block.text, level: Number(block.style!.slice(7)) }] : []);
    case 'pptx': return (model.slides ?? []).map((slide, index) => ({ index, id: slide.id, title: `第 ${index + 1} 页 · ${slide.blocks[0]?.text ?? ''}` }));
    case 'xlsx': return (model.sheets ?? []).map((sheet, index) => ({ index, id: sheet.id, title: sheet.name }));
    case 'pdf': return Array.from({ length: model.pageCount ?? 0 }, (_, index) => ({ index, title: `第 ${index + 1} 页` }));
    default: return [];
  }
}
