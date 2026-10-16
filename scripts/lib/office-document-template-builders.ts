import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import type { OfficeTemplateKind } from '../../packages/document-core/src/office-template-types';

/** Build-time only. Keep demo contents distinct from empty user documents. */
export async function generateOfficeTemplate(kind: OfficeTemplateKind): Promise<Uint8Array> {
  if (kind === 'demo.pptx' || kind === 'empty.pptx') {
    const presentation = new PptxGenJS(); presentation.layout = 'LAYOUT_WIDE';
    const slide = presentation.addSlide();
    if (kind === 'demo.pptx') {
      slide.background = { color: 'F7F7FB' };
      slide.addText('阅读与协作', { x: 0.9, y: 1.1, w: 10.5, h: 0.8, fontSize: 32, color: '403469', fontFace: 'Microsoft YaHei' });
      slide.addText('选中内容 · 固定上下文 · 局部修改', { x: 0.9, y: 2.3, w: 10.5, h: 0.7, fontSize: 21, color: '62657B', fontFace: 'Microsoft YaHei' });
    }
    return new Uint8Array(await presentation.write({ outputType: 'arraybuffer' }) as ArrayBuffer);
  }
  const workbook = new ExcelJS.Workbook();
  if (kind === 'demo.xlsx') {
    const sheet = workbook.addWorksheet('功能清单');
    sheet.addRows([['格式', '基础编辑', '引擎'], ['Markdown', '源码', 'CodeMirror'], ['PDF', '文字 / 页面', 'PDF.js + pdf-lib'], ['Word', '段落', 'OOXML'], ['网页', '鼠标 / 键盘', 'Chromium']]);
    sheet.getRow(1).font = { bold: true }; sheet.columns.forEach(column => { column.width = 24; });
  } else if (kind === 'empty.xlsx') workbook.addWorksheet('工作表1');
  else throw new Error('Unknown Office template: ' + kind);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
