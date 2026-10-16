import type { DocumentInfo } from '../../../../../packages/contracts/src/index';

export type DocumentOutlineItem = { index: number; title: string; id?: string; level?: number; from?: number };
export type SharedOutlineItem = { id: string; title: string; level?: number };
/** Explicit format branches keep arrays out of conditional-expression precedence. */
export function documentOutlineItems(document: Pick<DocumentInfo, 'format' | 'model'> | undefined, html: readonly SharedOutlineItem[] = []): DocumentOutlineItem[] {
  if (!document) return [];
  const model = document.model;
  switch (document.format) {
    case 'html': return html.map((item, index) => ({ ...item, index }));
    case 'markdown': return markdownOutlineFallback(model.text ?? '');
    case 'docx': return (model.blocks ?? []).flatMap((block, index) => /^Heading[1-6]$/.test(block.style ?? '') ? [{ index, id: block.id, title: block.text, level: Number(block.style!.slice(7)) }] : []);
    case 'pptx': return (model.slides ?? []).map((slide, index) => ({ index, id: slide.id, title: `第 ${index + 1} 页 · ${slide.blocks[0]?.text ?? ''}` }));
    case 'xlsx': return (model.sheets ?? []).map((sheet, index) => ({ index, id: sheet.id, title: sheet.name }));
    case 'pdf': return Array.from({ length: model.pageCount ?? 0 }, (_, index) => ({ index, title: `第 ${index + 1} 页` }));
    default: return [];
  }
}

/** Initial fallback while the lazy editor supplies its incremental Lezer index.
 * Stream lines without allocating a complete split array, and ignore code,
 * metadata and TeX blocks. Cursor/input updates use the editor index instead. */
function markdownOutlineFallback(source: string): DocumentOutlineItem[] {
  const items: DocumentOutlineItem[] = []; let fence: { marker: string; length: number } | undefined, math = false, metadata = /^(?:\uFEFF)?---\r?\n/.test(source), previous: { text: string; from: number } | undefined;
  for (const match of source.matchAll(/([^\n]*)(?:\n|$)/g)) {
    const line = match[1].replace(/\r$/, ''), from = match.index!;
    if (!from && metadata) continue;
    if (metadata) { if (/^(?:---|\.\.\.)\s*$/.test(line)) metadata = false; continue; }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) { if (fence) { if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined; } else fence = { marker: marker[1][0], length: marker[1].length }; previous = undefined; continue; }
    if (fence) continue;
    if (/^ {0,3}\$\$\s*$/.test(line)) { math = !math; previous = undefined; continue; }
    if (math) continue;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    if (heading) items.push({ index: items.length, title: heading[2].slice(0, 240), level: heading[1].length, from });
    else if (previous && /^ {0,3}(=+|-+)[ \t]*$/.test(line)) items.push({ index: items.length, title: previous.text.trim().slice(0, 240), level: line.trim()[0] === '=' ? 1 : 2, from: previous.from });
    previous = line.trim() && !/^ {4}|^\t/.test(line) ? { text: line, from } : undefined;
  }
  return items;
}
