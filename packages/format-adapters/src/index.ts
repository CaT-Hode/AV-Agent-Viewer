import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Capabilities, DocumentModel, EditOperation, Format, FormatAdapter } from '../../contracts/src/index';
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

export { OfficeXmlAdapter } from "./ooxml-editing";
export { SheetAdapter } from "./sheet-editing";
import { OfficeXmlAdapter } from "./ooxml-editing";
import { SheetAdapter } from "./sheet-editing";

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
