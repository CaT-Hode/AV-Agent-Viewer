import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import type { Capabilities, DocumentModel, EditOperation, Format, FormatAdapter, TextBlock } from '../../contracts/src/index';
import { ViewerError, PROTOCOL_VERSION } from '../../contracts/src/index';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function cap(engine: string, editKinds: string[], format: Format, limitations: string[] = []): Capabilities {
  return { engine, protocolVersion: PROTOCOL_VERSION, readText: format !== 'pdf', readSelection: true, readViewport: true, editKinds, saveFormats: [format], limitations };
}
function unsupported(): never { throw new ViewerError('CAPABILITY_UNSUPPORTED', '此引擎不支持该修改操作。'); }
function assertRange(condition: boolean, message: string): asserts condition { if (!condition) throw new ViewerError('INVALID_TARGET', message); }

export class TextAdapter implements FormatAdapter {
  id = 'text-v1'; formats: Format[] = ['markdown', 'html'];
  async open(bytes: Uint8Array, format: Format): Promise<DocumentModel> { return { format, text: decoder.decode(bytes) }; }
  capabilities(format: Format) { return cap(this.id, ['text.replace'], format, format === 'html' ? ['富文本结构编辑尚未接入；源码完整保存，预览净化脚本。'] : []); }
  preview(model: DocumentModel, op: EditOperation) {
    if (op.kind !== 'text.replace') return unsupported();
    const text = model.text ?? '';
    assertRange(op.to >= op.from && op.to <= text.length, '源码范围超出文档。');
    assertRange(text.slice(op.from, op.to) === op.expectedText, '目标文字已变化。请重新读取后准备修改。');
    return { before: text.slice(op.from, op.to), after: op.text, warnings: [] };
  }
  async apply(_bytes: Uint8Array, model: DocumentModel, op: EditOperation) {
    this.preview(model, op);
    if (op.kind !== 'text.replace') return unsupported();
    const text = (model.text ?? '').slice(0, op.from) + op.text + (model.text ?? '').slice(op.to);
    return { bytes: encoder.encode(text), model: { ...model, text }, warnings: [] };
  }
}

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DRAW_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PPT_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const parser = new DOMParser();
const serializer = new XMLSerializer();
const asArray = <T>(items: ArrayLike<T>) => Array.from(items);
async function xml(zip: JSZip, path: string) { const file = zip.file(path); if (!file) throw new ViewerError('INVALID_DOCUMENT', `缺少 ${path}`); return parser.parseFromString(await file.async('string'), 'text/xml'); }
function textOf(node: import('@xmldom/xmldom').Element, ns: string) { return asArray(node.getElementsByTagNameNS(ns, 't')).map(item => item.textContent ?? '').join(''); }

function runsOf(node: import('@xmldom/xmldom').Element, ns: string) {
  return asArray(node.getElementsByTagNameNS(ns, 't')).map(t => {
    const props = (t.parentNode as import('@xmldom/xmldom').Element).getElementsByTagNameNS(ns, 'rPr')[0];
    const enabled = (name: string) => ns === WORD_NS ? !!props?.getElementsByTagNameNS(ns,name)[0] && !['0','false','none'].includes(props.getElementsByTagNameNS(ns,name)[0]?.getAttribute('w:val') ?? '') : ['1','true','sng'].includes(props?.getAttribute(name) ?? '');
    return { text: t.textContent ?? '', bold: enabled('b'), italic: enabled('i'), underline: enabled('u') };
  });
}
function formatRuns(target: import('@xmldom/xmldom').Element, ns: string, op: Extract<EditOperation,{kind:'office.formatText'}>) {
  const doc=target.ownerDocument!, prefix=ns===WORD_NS?'w:':'a:'; let offset=0;
  for (const t of asArray(target.getElementsByTagNameNS(ns,'t'))) {
    const text=t.textContent??'', start=offset; offset+=text.length;
    if (offset<=op.from || start>=op.to) continue;
    const run=t.parentNode as import('@xmldom/xmldom').Element;
    assertRange(run.localName==='r' && asArray(run.childNodes).filter(n=>n.nodeType===1).every(n=>n.localName==='rPr'||n===t),'此复杂文字对象暂不支持选区格式，请使用完整 Office 编辑器。');
    const from=Math.max(0,op.from-start),to=Math.min(text.length,op.to-start);
    for(const [part,selected] of [[text.slice(0,from),false],[text.slice(from,to),true],[text.slice(to),false]] as const) {
      if(!part)continue;const copy=run.cloneNode(true) as import('@xmldom/xmldom').Element;const value=copy.getElementsByTagNameNS(ns,'t')[0];value.textContent=part;value.setAttribute('xml:space','preserve');
      if(selected){let props=copy.getElementsByTagNameNS(ns,'rPr')[0];if(!props){props=doc.createElementNS(ns,prefix+'rPr');copy.insertBefore(props,copy.firstChild)} const name={bold:'b',italic:'i',underline:'u'}[op.style];
        if(ns===WORD_NS){for(const old of asArray(props.getElementsByTagNameNS(ns,name)))props.removeChild(old);const attr=doc.createElementNS(ns,prefix+name);attr.setAttribute('w:val',op.style==='underline'?(op.enabled?'single':'none'):(op.enabled?'1':'0'));props.appendChild(attr)}
        else props.setAttribute(name,op.style==='underline'?(op.enabled?'sng':'none'):(op.enabled?'1':'0'));
      }run.parentNode!.insertBefore(copy,run);
    }run.parentNode!.removeChild(run);
  }
}

export class OfficeXmlAdapter implements FormatAdapter {
  id = 'ooxml-local-v1'; formats: Format[] = ['docx', 'pptx'];
  capabilities(format: Format) { return cap(this.id, format === 'docx' ? ['word.setBlock', 'word.setParagraphFormat', 'word.insertParagraph', 'office.formatText'] : ['slides.setText', 'slides.setShapeBounds', 'office.formatText'], format, ['本地编辑器保留未修改的 ZIP 部件；直接改写文字块可能合并块内字体样式。', '复杂排版、修订和完整对象编辑可使用随应用内置的 LibreOffice。']); }
  async open(bytes: Uint8Array, format: Format): Promise<DocumentModel> {
    const zip = await JSZip.loadAsync(bytes);
    if (format === 'docx') {
      const doc = await xml(zip, 'word/document.xml');
      const blocks: TextBlock[] = asArray(doc.getElementsByTagNameNS(WORD_NS, 'p')).map((p, index) => ({ id: `paragraph-${index}`, text: textOf(p, WORD_NS), runs: runsOf(p, WORD_NS), style: p.getElementsByTagNameNS(WORD_NS, 'pStyle')[0]?.getAttribute('w:val') ?? undefined, alignment: p.getElementsByTagNameNS(WORD_NS, 'jc')[0]?.getAttribute('w:val') ?? undefined }));
      return { format, blocks };
    }
    const pres = await xml(zip, 'ppt/presentation.xml');
    const size = pres.getElementsByTagNameNS(PPT_NS, 'sldSz')[0];
    const width = Number(size?.getAttribute('cx') ?? 12192000), height = Number(size?.getAttribute('cy') ?? 6858000);
    const relationships = await xml(zip, 'ppt/_rels/presentation.xml.rels');
    const targets = new Map(asArray(relationships.getElementsByTagName('Relationship')).map(item => [item.getAttribute('Id'), item.getAttribute('Target')]));
    const paths = asArray(pres.getElementsByTagNameNS(PPT_NS, 'sldId')).map(item => {
      const target = targets.get(item.getAttribute('r:id'));
      assertRange(!!target, '幻灯片顺序引用缺少目标。');
      const path = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('ppt', target));
      assertRange(/^ppt\/slides\/[^/]+\.xml$/.test(path) && !!zip.file(path), '幻灯片顺序引用无效。');
      return path;
    });
    const slides = [];
    for (const path of paths) {
      const doc = await xml(zip, path);
      const blocks = asArray(doc.getElementsByTagNameNS(PPT_NS, 'sp')).map((shape, index) => {
        const props = shape.getElementsByTagNameNS(PPT_NS, 'cNvPr')[0];
        const off = shape.getElementsByTagNameNS(DRAW_NS, 'off')[0], ext = shape.getElementsByTagNameNS(DRAW_NS, 'ext')[0];
        return { id: props?.getAttribute('id') ?? String(index), text: textOf(shape, DRAW_NS), runs: runsOf(shape, DRAW_NS), x: Number(off?.getAttribute('x') ?? 0) / width, y: Number(off?.getAttribute('y') ?? 0) / height, width: Number(ext?.getAttribute('cx') ?? width) / width, height: Number(ext?.getAttribute('cy') ?? height) / height };
      });
      slides.push({ id: path, blocks });
    }
    return { format, slides, width, height };
  }
  preview(model: DocumentModel, op: EditOperation) {
    let block: TextBlock | undefined;
    if (op.kind === 'office.formatText') block = model.format === 'docx' ? model.blocks?.find(b => b.id === op.blockId) : model.slides?.find(s => s.id === op.slideId)?.blocks.find(b => b.id === op.blockId);
    else if ((op.kind === 'word.setBlock' || op.kind === 'word.setParagraphFormat') && model.format === 'docx') block = model.blocks?.find(b => b.id === op.blockId);
    else if (op.kind === 'word.insertParagraph' && model.format === 'docx') block = model.blocks?.find(b => b.id === op.afterBlockId);
    else if ((op.kind === 'slides.setText' || op.kind === 'slides.setShapeBounds') && model.format === 'pptx') block = model.slides?.find(s => s.id === op.slideId)?.blocks.find(b => b.id === op.shapeId);
    else return unsupported();
    assertRange(!!block, '文字对象不存在。');
    if (op.kind === 'office.formatText') { assertRange(op.to > op.from && block.text.slice(op.from, op.to) === op.expectedText, '选区文字或范围已变化。'); return { before: op.expectedText, after: op.style, warnings: [] }; }
    if (op.kind === 'word.setParagraphFormat') { assertRange(!!op.style || !!op.alignment, '请选择段落样式或对齐方式。'); return { before: `${block.style ?? 'Normal'} · ${block.alignment ?? 'left'}`, after: `${op.style ?? block.style ?? 'Normal'} · ${op.alignment ?? block.alignment ?? 'left'}`, warnings: [] }; }
    if (op.kind === 'word.insertParagraph') return { before: block.text, after: op.text, warnings: [] };
    if (op.kind === 'slides.setShapeBounds') { assertRange(op.x + op.width <= 1 && op.y + op.height <= 1, '对象范围超出幻灯片。'); return { before: [block.x, block.y, block.width, block.height].join(', '), after: [op.x, op.y, op.width, op.height].join(', '), warnings: [] }; }
    return { before: block.text, after: op.text, warnings: ['该文字块内的混合字体格式可能合并；其他 ZIP 部件保留。'] };
  }
  async apply(bytes: Uint8Array, model: DocumentModel, op: EditOperation) {
    const preview = this.preview(model, op);
    const zip = await JSZip.loadAsync(bytes);
    if (op.kind === 'office.formatText') {
      const path = model.format === 'docx' ? 'word/document.xml' : op.slideId!;
      const doc = await xml(zip, path), ns = model.format === 'docx' ? WORD_NS : DRAW_NS;
      const target = model.format === 'docx' ? doc.getElementsByTagNameNS(WORD_NS, 'p')[model.blocks!.findIndex(b => b.id === op.blockId)] : asArray(doc.getElementsByTagNameNS(PPT_NS, 'sp')).find(s => s.getElementsByTagNameNS(PPT_NS, 'cNvPr')[0]?.getAttribute('id') === op.blockId);
      assertRange(!!target, '文字对象不存在。'); formatRuns(target, ns, op); zip.file(path, serializer.serializeToString(doc));
    } else if (op.kind === 'word.setBlock') {
      const doc = await xml(zip, 'word/document.xml');
      const index = model.blocks!.findIndex(b => b.id === op.blockId);
      const p = doc.getElementsByTagNameNS(WORD_NS, 'p')[index];
      const texts = asArray(p.getElementsByTagNameNS(WORD_NS, 't'));
      if (texts.length) texts.forEach((t, index) => { t.textContent = index === 0 ? op.text : ''; t.setAttribute('xml:space', 'preserve'); });
      else { const run = doc.createElementNS(WORD_NS, 'w:r'), t = doc.createElementNS(WORD_NS, 'w:t'); t.setAttribute('xml:space', 'preserve'); t.appendChild(doc.createTextNode(op.text)); run.appendChild(t); p.appendChild(run); }
      zip.file('word/document.xml', serializer.serializeToString(doc));
    } else if (op.kind === 'word.setParagraphFormat' || op.kind === 'word.insertParagraph') {
      const doc = await xml(zip, 'word/document.xml');
      const blockId = op.kind === 'word.insertParagraph' ? op.afterBlockId : op.blockId;
      const index = model.blocks!.findIndex(b => b.id === blockId);
      const p = doc.getElementsByTagNameNS(WORD_NS, 'p')[index];
      assertRange(!!p, '段落不存在。');
      if (op.kind === 'word.insertParagraph') {
        const next = doc.createElementNS(WORD_NS, 'w:p');
        const pPr = doc.createElementNS(WORD_NS, 'w:pPr');
        const style = doc.createElementNS(WORD_NS, 'w:pStyle'); style.setAttribute('w:val', op.style); pPr.appendChild(style); next.appendChild(pPr);
        const run = doc.createElementNS(WORD_NS, 'w:r'), text = doc.createElementNS(WORD_NS, 'w:t');
        text.setAttribute('xml:space', 'preserve'); text.appendChild(doc.createTextNode(op.text)); run.appendChild(text); next.appendChild(run);
        p.parentNode!.insertBefore(next, p.nextSibling);
      } else {
        let pPr = asArray(p.childNodes).find(node => node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === 'pPr') as import('@xmldom/xmldom').Element | undefined;
        if (!pPr) { pPr = doc.createElementNS(WORD_NS, 'w:pPr'); p.insertBefore(pPr, p.firstChild); }
        for (const [name, value] of [['pStyle', op.style], ['jc', op.alignment]] as const) if (value) {
          let child = asArray(pPr.childNodes).find(node => node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === name) as import('@xmldom/xmldom').Element | undefined;
          if (!child) { child = doc.createElementNS(WORD_NS, 'w:' + name); pPr.appendChild(child); }
          child.setAttribute('w:val', value);
        }
      }
      zip.file('word/document.xml', serializer.serializeToString(doc));
    } else if (op.kind === 'slides.setText') {
      const doc = await xml(zip, op.slideId);
      const shape = asArray(doc.getElementsByTagNameNS(PPT_NS, 'sp')).find(s => s.getElementsByTagNameNS(PPT_NS, 'cNvPr')[0]?.getAttribute('id') === op.shapeId);
      assertRange(!!shape, '幻灯片文字对象不存在。');
      const texts = asArray(shape.getElementsByTagNameNS(DRAW_NS, 't'));
      assertRange(texts.length > 0, '该对象没有可编辑文字。');
      texts.forEach((t, i) => { t.textContent = i === 0 ? op.text : ''; });
      zip.file(op.slideId, serializer.serializeToString(doc));
    } else if (op.kind === 'slides.setShapeBounds') {
      const doc = await xml(zip, op.slideId);
      const shape = asArray(doc.getElementsByTagNameNS(PPT_NS, 'sp')).find(s => s.getElementsByTagNameNS(PPT_NS, 'cNvPr')[0]?.getAttribute('id') === op.shapeId);
      assertRange(!!shape, '幻灯片对象不存在。');
      const spPr = asArray(shape.childNodes).find(node => node.nodeType === 1 && node.namespaceURI === PPT_NS && node.localName === 'spPr') as import('@xmldom/xmldom').Element | undefined;
      const xfrm = spPr?.getElementsByTagNameNS(DRAW_NS, 'xfrm')[0];
      const off = xfrm?.getElementsByTagNameNS(DRAW_NS, 'off')[0], ext = xfrm?.getElementsByTagNameNS(DRAW_NS, 'ext')[0];
      assertRange(!!off && !!ext, '该对象缺少可编辑的位置尺寸。');
      const width = model.width ?? 12192000, height = model.height ?? 6858000;
      off.setAttribute('x', String(Math.round(op.x * width))); off.setAttribute('y', String(Math.round(op.y * height)));
      ext.setAttribute('cx', String(Math.round(op.width * width))); ext.setAttribute('cy', String(Math.round(op.height * height)));
      zip.file(op.slideId, serializer.serializeToString(doc));
    }
    const output = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    return { bytes: output, model: await this.open(output, model.format), warnings: preview.warnings };
  }
}

export class SheetAdapter implements FormatAdapter {
  id = 'exceljs-v1'; formats: Format[] = ['xlsx'];
  capabilities(format: Format) { return cap(this.id, ['sheets.setCell', 'sheets.setCellFormat', 'sheets.addWorksheet', 'sheets.renameWorksheet'], format, ['ExcelJS 编辑不保证透视表、复杂扩展与外部链接往返保真，建议另存副本。', '不提供公式计算引擎；修改公式后由外部表格引擎重算。', '界面和当前内容模型最多 1000 行 / 50 列；超出内容保留在文件中。']); }
  async open(bytes: Uint8Array, format: Format): Promise<DocumentModel> {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as never);
    const sheets = workbook.worksheets.map(sheet => ({
      id: String(sheet.id), name: sheet.name,
      rows: Array.from({ length: Math.min(Math.max(sheet.rowCount, 20), 1000) }, (_, ri) => Array.from({ length: Math.min(Math.max(sheet.columnCount, 8), 50) }, (_, ci) => {
        const cell = sheet.getCell(ri + 1, ci + 1);
        const formula = cell.type === ExcelJS.ValueType.Formula ? (cell.value as { formula: string }).formula : undefined;
        const fill = cell.fill?.type === 'pattern' ? cell.fill.fgColor?.argb?.slice(-6) : undefined;
        return { address: cell.address, value: cell.text, formula, bold: cell.font?.bold, italic: cell.font?.italic, horizontal: cell.alignment?.horizontal, numberFormat: cell.numFmt, fill };
      })),
    }));
    return { format, sheets };
  }
  preview(model: DocumentModel, op: EditOperation) {
    if (op.kind !== 'sheets.setCell' && op.kind !== 'sheets.setCellFormat' && op.kind !== 'sheets.addWorksheet' && op.kind !== 'sheets.renameWorksheet') return unsupported();
    if (op.kind === 'sheets.addWorksheet') {
      assertRange(!model.sheets?.some(sheet => sheet.name.toLocaleLowerCase() === op.name.toLocaleLowerCase()), '同名工作表已存在。');
      return { before: '', after: op.name, warnings: this.capabilities('xlsx').limitations };
    }
    const sheet = model.sheets?.find(s => s.id === op.sheetId); assertRange(!!sheet, '工作表不存在。');
    if (op.kind === 'sheets.renameWorksheet') {
      assertRange(!model.sheets?.some(other => other.id !== sheet.id && other.name.toLocaleLowerCase() === op.name.toLocaleLowerCase()), '同名工作表已存在。');
      return { before: sheet.name, after: op.name, warnings: this.capabilities('xlsx').limitations };
    }
    const old = sheet.rows.flat().find(c => c.address === op.address);
    if (op.kind === 'sheets.setCellFormat') { assertRange(op.bold !== undefined || op.italic !== undefined || !!op.horizontal || !!op.numberFormat || !!op.fill, '请选择要更改的单元格格式。'); return { before: JSON.stringify(old ?? {}), after: JSON.stringify(op), warnings: this.capabilities('xlsx').limitations }; }
    if (op.kind === 'sheets.setCell') return { before: old?.formula ? '=' + old.formula : old?.value ?? '', after: op.formula ? '=' + op.formula : op.value, warnings: this.capabilities('xlsx').limitations };
    return unsupported();
  }
  async apply(bytes: Uint8Array, model: DocumentModel, op: EditOperation) {
    const preview = this.preview(model, op);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as never);
    if (op.kind === 'sheets.addWorksheet') workbook.addWorksheet(op.name);
    else if (op.kind === 'sheets.setCell' || op.kind === 'sheets.setCellFormat' || op.kind === 'sheets.renameWorksheet') {
      const sheet = workbook.getWorksheet(Number(op.sheetId)); assertRange(!!sheet, '工作表不存在。');
      if (op.kind === 'sheets.renameWorksheet') sheet.name = op.name;
      else if (op.kind === 'sheets.setCell') {
        const cell = sheet.getCell(op.address);
        if (op.formula) { cell.value = { formula: op.formula, result: undefined }; workbook.calcProperties.fullCalcOnLoad = true; }
        else if (op.valueType === 'number') { const number = Number(op.value); assertRange(op.value.trim() !== '' && Number.isFinite(number), '数值格式要求有效数字。'); cell.value = number; }
        else if (op.valueType === 'boolean') { assertRange(op.value === 'true' || op.value === 'false', '布尔值只能为 true 或 false。'); cell.value = op.value === 'true'; }
        else cell.value = op.value;
      } else if (op.kind === 'sheets.setCellFormat') {
        const cell = sheet.getCell(op.address);
        if (op.bold !== undefined || op.italic !== undefined) cell.font = { ...cell.font, ...(op.bold !== undefined ? { bold: op.bold } : {}), ...(op.italic !== undefined ? { italic: op.italic } : {}) };
        if (op.horizontal) cell.alignment = { ...cell.alignment, horizontal: op.horizontal };
        if (op.numberFormat) cell.numFmt = op.numberFormat;
        if (op.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + op.fill.toUpperCase() } };
      } else return unsupported();
    }
    const output = new Uint8Array(await workbook.xlsx.writeBuffer());
    return { bytes: output, model: await this.open(output, 'xlsx'), warnings: preview.warnings };
  }
}

export class PdfAdapter implements FormatAdapter {
  id = 'pdf-lib-v1'; formats: Format[] = ['pdf'];
  fontPath = [process.env.AGENTVIEWER_PDF_FONT, 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/arial.ttf'].find(p => p && existsSync(p));
  capabilities(format: Format) { return cap(this.id, ['pdf.addText', 'pdf.highlight', 'pdf.markup', 'pdf.rotate', 'pdf.addPage'], format, ['增补内容与页面操作；不支持原有正文重写、真正脱敏及签名维护。', '中文增补需要可嵌入的字体；添加前会校验字符支持。']); }
  async open(bytes: Uint8Array, format: Format): Promise<DocumentModel> { const pdf = await PDFDocument.load(bytes); return { format, pageCount: pdf.getPageCount() }; }
  preview(model: DocumentModel, op: EditOperation) {
    if (!op.kind.startsWith('pdf.')) return unsupported();
    if ('pageIndex' in op) assertRange(op.pageIndex < (model.pageCount ?? 0), 'PDF 页码超出范围。');
    if (op.kind === 'pdf.markup') for (const rect of op.rects) assertRange(rect.pageIndex < (model.pageCount ?? 0) && rect.x + rect.width <= 1.001 && rect.y + rect.height <= 1.001, '选区坐标超出 PDF 页面。');
    if (op.kind === 'pdf.highlight') assertRange(op.x + op.width <= 1 && op.y + op.height <= 1, '高亮范围超出页面。');
    return { before: `${model.pageCount} 页 PDF`, after: op.kind === 'pdf.addText' ? op.text : op.kind, warnings: this.capabilities('pdf').limitations };
  }
  async apply(bytes: Uint8Array, model: DocumentModel, op: EditOperation) {
    const preview = this.preview(model, op); const pdf = await PDFDocument.load(bytes);
    if (op.kind === 'pdf.addPage') pdf.addPage();
    else if (op.kind === 'pdf.markup') {
      for (const rect of op.rects) {
        const page = pdf.getPage(rect.pageIndex), crop = page.getCropBox(), rotation = ((page.getRotation().angle % 360) + 360) % 360;
        const toPdf = (x: number, y: number) => rotation === 90 ? { x: crop.x + y * crop.width, y: crop.y + x * crop.height } : rotation === 180 ? { x: crop.x + (1-x)*crop.width, y: crop.y + y*crop.height } : rotation === 270 ? { x: crop.x + (1-y)*crop.width, y: crop.y + (1-x)*crop.height } : { x: crop.x+x*crop.width, y: crop.y+(1-y)*crop.height };
        if (op.style === 'highlight') { const a=toPdf(rect.x,rect.y),b=toPdf(rect.x+rect.width,rect.y+rect.height); page.drawRectangle({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y),color:rgb(1,.8,.18),opacity:.3}); }
        else { const y=rect.y+rect.height*(op.style==='underline'?.92:.5);page.drawLine({start:toPdf(rect.x,y),end:toPdf(rect.x+rect.width,y),thickness:1.2,color:rgb(.2,.4,.8)}); }
      }
    }
    else if (op.kind === 'pdf.rotate') { const page = pdf.getPage(op.pageIndex); page.setRotation(degrees((page.getRotation().angle + op.degrees) % 360)); }
    else if (op.kind === 'pdf.addText' || op.kind === 'pdf.highlight') {
      const page = pdf.getPage(op.pageIndex), { width, height } = page.getSize();
      assertRange(page.getRotation().angle === 0 && page.getCropBox().x === 0 && page.getCropBox().y === 0, '当前增补坐标仅支持未旋转且 CropBox 原点为零的页面；先使用原方向或等待坐标适配升级。');
      if (op.kind === 'pdf.addText') {
        pdf.registerFontkit(fontkit);
        const font = this.fontPath ? await pdf.embedFont(await readFile(this.fontPath), { subset: true }) : await pdf.embedFont(StandardFonts.Helvetica);
        const charset = new Set(font.getCharacterSet());
        assertRange([...op.text].every(c => charset.has(c.codePointAt(0)!)), '当前 PDF 字体不支持所输入字符，请配置 AGENTVIEWER_PDF_FONT。');
        page.drawText(op.text, { x: op.x * width, y: (1 - op.y) * height - op.size, size: op.size, font, color: rgb(0.2, 0.15, 0.55) });
      } else page.drawRectangle({ x: op.x * width, y: (1 - op.y - op.height) * height, width: op.width * width, height: op.height * height, color: rgb(1, 0.86, 0.2), opacity: 0.35 });
    } else return unsupported();
    const output = await pdf.save();
    return { bytes: output, model: await this.open(output, 'pdf'), warnings: preview.warnings };
  }
}

export class AdapterRegistry {
  private adapters = new Map<Format, FormatAdapter>();
  register(adapter: FormatAdapter, replace = false) {
    for (const format of adapter.formats) { if (this.adapters.has(format) && !replace) throw new Error(`重复格式适配器 ${format}`); this.adapters.set(format, adapter); }
  }
  resolve(format: Format) { const adapter = this.adapters.get(format); if (!adapter) throw new ViewerError('CAPABILITY_UNSUPPORTED', `格式 ${format} 尚无可用引擎。`); return adapter; }
  describe() { return [...this.adapters.entries()].map(([format, adapter]) => ({ format, ...adapter.capabilities(format) })); }
}
export function createRegistry() { const registry = new AdapterRegistry(); [new TextAdapter(), new OfficeXmlAdapter(), new SheetAdapter(), new PdfAdapter()].forEach(a => registry.register(a)); return registry; }
