import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { PDFDocument } from 'pdf-lib';
import type { Format } from '../../contracts/src/index';
import { ensureWordParagraphStyles } from '../../format-adapters/src/word-styles';

/** User documents start empty. Demonstration samples remain in fixtures.ts. */
export async function emptyDocumentBytes(format: Exclude<Format, 'web'>): Promise<Uint8Array> {
  if (format === 'markdown') return new Uint8Array();
  if (format === 'html') return new TextEncoder().encode('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>新文档</title></head><body></body></html>');
  if (format === 'docx') {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>');
    await ensureWordParagraphStyles(zip, ['Normal']);
    return zip.generateAsync({ type: 'uint8array' });
  }
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('工作表1');
    return new Uint8Array(await workbook.xlsx.writeBuffer());
  }
  if (format === 'pptx') {
    const presentation = new PptxGenJS(); presentation.layout = 'LAYOUT_WIDE'; presentation.addSlide();
    return new Uint8Array(await presentation.write({ outputType: 'arraybuffer' }) as ArrayBuffer);
  }
  const pdf = await PDFDocument.create(); pdf.addPage([595, 842]); return pdf.save();
}
