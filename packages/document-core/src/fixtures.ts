import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { officeDocumentTemplateBytes } from './office-templates';
import type { Format } from '../../contracts/src/index';

export const welcomeText = `# 欢迎使用 AgentViewer

把文档、网页和阅读上下文放在同一个工作台。

> 选中一段文字，开始共同阅读。

## 共同阅读

AgentViewer 让你与 AI Agent 在同一份文档上阅读、思考和创作。

你可以随时选中感兴趣的内容，基于当前上下文进行讨论、提问或编辑，在保持专注的同时，获得可追溯的协作体验。

- **当前阅读位置**：记录文档中的可见范围，支持持续跟进。
- **选中片段**：保留原文和位置，展开针对性的讨论。
- **发问快照**：固定本次问题指向的内容和版本。

## 编辑与保存

切换到源码模式可以编辑本文。Office 和 PDF 按当前引擎能力提供基础编辑；功能限制在文档状态中显示。

| 格式 | 编辑方式 |
| --- | --- |
| Markdown | 源码与预览 |
| PDF | 文字增补与页面 |

## 开始使用

打开文件或网页，选择文字，在右侧查看上下文。可以用本地 MCP 接口把阅读器连接到支持 MCP 的 harness。
`;

export async function blankBytes(format: Format): Promise<Uint8Array> {
  if (format === 'markdown') return new TextEncoder().encode('# 新文档\n\n开始写作。\n');
  if (format === 'html') return new TextEncoder().encode('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>新文档</title></head><body><h1>新文档</h1><p>开始写作。</p></body></html>');
  if (format === 'docx') {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>欢迎使用 AgentViewer</w:t></w:r></w:p><w:p><w:r><w:t>这是可编辑的 Word 文字块。编辑后另存文件，再重新打开检查。</w:t></w:r></w:p><w:p><w:r><w:t>未修改的 OOXML 部件保留，复杂排版需要完整 Office 引擎。</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>');
    return zip.generateAsync({ type: 'uint8array' });
  }
  if (format === 'pptx' || format === 'xlsx') return officeDocumentTemplateBytes('demo.' + format as 'demo.pptx' | 'demo.xlsx');
  if (format === 'pdf') {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++) { const page = pdf.addPage([595, 842]); page.drawText('AgentViewer / Reading & Editing', { x: 50, y: 755, size: 23, font, color: rgb(0.25, 0.2, 0.5) }); page.drawText(`Page ${i + 1}: select text, add a note, save and reopen.`, { x: 50, y: 700, size: 14, font }); }
    return pdf.save();
  }
  throw new Error('无法新建该格式');
}
export async function ensureSamples(root: string) {
  await mkdir(root, { recursive: true });
  const files = [['欢迎.md', 'markdown'], ['示例.docx', 'docx'], ['示例.pptx', 'pptx'], ['示例.xlsx', 'xlsx'], ['示例.pdf', 'pdf']] as const;
  for (const [name, format] of files) { const path = join(root, name); if (!existsSync(path)) await writeFile(path, format === 'markdown' ? new TextEncoder().encode(welcomeText) : await blankBytes(format)); }
  return files.map(([name, format]) => ({ name, format, path: join(root, name) }));
}
