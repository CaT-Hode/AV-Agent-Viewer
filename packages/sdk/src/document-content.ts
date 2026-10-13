import { parse } from 'parse5';
import type { DocumentInfo, Locator } from '../../contracts/src/index';

type HtmlNode = { tagName?: string; nodeName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[] };
type Unit = { text: string; locator: Locator; level?: number; id?: string };
const excluded = new Set(['head', 'script', 'style', 'template', 'noscript']);
const htmlBlocks = new Set(['h1','h2','h3','h4','h5','h6','p','li','summary','td','th','figcaption','blockquote','pre','div','section','article','main','aside','nav','header','footer','body','ul','ol','table','thead','tbody','tfoot','tr','dl','dt','dd','figure','form','fieldset','details','address','hgroup']);
const textOf = (node: HtmlNode): string => excluded.has(node.tagName ?? '') ? '' : node.nodeName === '#text' ? node.value ?? '' : node.tagName === 'br' ? ' ' : (node.childNodes ?? []).map(textOf).join('');

function htmlUnits(source: string): Unit[] {
  const result: Unit[] = [];
  const nestedBlocks = new WeakMap<HtmlNode, boolean>();
  const hasNestedBlock = (node: HtmlNode): boolean => {
    if (excluded.has(node.tagName ?? '')) return false;
    const known = nestedBlocks.get(node); if (known !== undefined) return known;
    const result = (node.childNodes ?? []).some(child => !excluded.has(child.tagName ?? '') && (htmlBlocks.has(child.tagName ?? '') || hasNestedBlock(child)));
    nestedBlocks.set(node, result); return result;
  };
  const emit = (nodes: HtmlNode[], id: string, level?: number) => {
    const text = nodes.map(textOf).join('').replace(/\s+/g, ' ').trim();
    if (text) result.push({ text, id, level, locator: { kind: 'html-block', blockId: id } });
  };
  const visit = (node: HtmlNode, path: string) => {
    if (excluded.has(node.tagName ?? '')) return;
    const level = /^h[1-6]$/.test(node.tagName ?? '') ? Number(node.tagName![1]) : undefined;
    if (level || !hasNestedBlock(node)) {
      emit([node], node.attrs?.find(a => a.name === 'id')?.value ?? path, level);
      return;
    }
    // Preserve source order while splitting mixed containers around their child blocks.
    // Only the intervening inline/text runs belong to this container; child blocks
    // are visited separately, so ancestor text is never indexed a second time.
    let pending: HtmlNode[] = [], firstIndex = 0;
    const flush = () => { if (pending.length) emit(pending, path + '/' + firstIndex); pending = []; };
    (node.childNodes ?? []).forEach((child, index) => {
      if (excluded.has(child.tagName ?? '')) return;
      if (htmlBlocks.has(child.tagName ?? '') || hasNestedBlock(child)) { flush(); visit(child, path + '/' + index); }
      else { if (!pending.length) firstIndex = index; pending.push(child); }
    });
    flush();
  };
  visit(parse(source) as HtmlNode, 'html'); return result;
}

function units(document: DocumentInfo): Unit[] {
  const model = document.model;
  if (document.format === 'html') return htmlUnits(model.text ?? '');
  if (model.slides) return model.slides.flatMap(slide => slide.blocks.map(block => ({ text: block.text, locator: { kind: 'slide-object', slideId: slide.id, shapeId: block.id } })));
  if (model.sheets) return model.sheets.flatMap(sheet => sheet.rows.flatMap(row => row.filter(cell => cell.value || cell.formula).map(cell => ({ text: cell.value || '=' + cell.formula, locator: { kind: 'cell', sheetId: sheet.id, cell: cell.address } }))));
  if (model.blocks) return model.blocks.map(block => ({ text: block.text, locator: { kind: 'paragraph', blockId: block.id } }));
  if (model.text !== undefined) return [{ text: model.text, locator: { kind: 'source' } }];
  return [];
}

export function searchDocument(document: DocumentInfo, query: string) {
  const source = units(document), results: { from: number; to: number; quote: string; revision: number; locator: Locator }[] = [];
  for (const unit of source) {
    let offset = 0;
    while ((offset = unit.text.indexOf(query, offset)) !== -1 && results.length < 200) {
      results.push({ from: offset, to: offset + query.length, quote: unit.text.slice(Math.max(0, offset - 60), offset + query.length + 60), revision: document.revision, locator: { ...unit.locator, from: offset, to: offset + query.length } });
      offset += query.length;
    }
    if (results.length === 200) break;
  }
  const scope = document.format === 'markdown' || document.format === 'docx' || document.model.text !== undefined && document.format !== 'html' ? 'text' : source.length || ['html','pptx','xlsx'].includes(document.format) ? 'content-model' : 'unsupported';
  return { results, scope, revision: document.revision,
    ...(document.format === 'xlsx' ? { coverage: { rowLimit: 1000, columnLimit: 50, formulaResultsCalculated: false } } : {}) };
}

export function outlineDocument(document: DocumentInfo) {
  const model = document.model;
  if (model.slides) return model.slides.map(slide => ({ id: slide.id, title: slide.blocks[0]?.text ?? '' }));
  if (model.sheets) return model.sheets.map(sheet => ({ id: sheet.id, title: sheet.name }));
  if (model.blocks) return model.blocks.filter(block => /^Heading[1-6]$/.test(block.style ?? '')).map(block => ({ id: block.id, title: block.text, level: Number(block.style!.slice(7)) }));
  if (document.format === 'html') return htmlUnits(model.text ?? '').filter(unit => unit.level).map(unit => ({ id: unit.id!, title: unit.text, level: unit.level! }));
  return (model.text ?? '').split('\n').filter(line => /^#{1,6} /.test(line));
}
