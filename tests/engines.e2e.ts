import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { blankBytes } from '../packages/document-core/src/fixtures';
import { BabelDocAdapter } from '../packages/translation/src/babeldoc';
import { babelDocLaunch, engineHealth, libreOfficeExecutable } from '../packages/engines/src/index';
import { convertLegacy } from '../apps/office-gateway/src/conversion';
import { createRegistry } from '../packages/format-adapters/src/index';

const root = resolve('.'), health = engineHealth(root);
assert.ok(health.babeldoc.available && health.babeldoc.offlineReady, 'BabelDOC 内置资源缺失');
assert.ok(health.libreoffice.available && health.libreoffice.offlineReady, 'LibreOffice 内置程序缺失');
assert.ok(health.ocr.available && health.ocr.offlineReady, 'OCR 内置字库缺失');
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-engines-'));

const pdf = await PDFDocument.create(), page = pdf.addPage([400, 300]), font = await pdf.embedFont(StandardFonts.Helvetica);
page.drawText('Hello Agent Viewer ' + randomUUID().slice(0, 8), { x: 40, y: 200, size: 18, font });
let requests = 0;
const translator = new BabelDocAdapter(join(directory, 'babeldoc'), async () => { requests++; return '你好 AgentViewer'; }, babelDocLaunch(root));
const translated = await translator.translate(await pdf.save(), 'zh-CN', new AbortController().signal);
assert.ok(requests > 0, 'PDF 版面翻译未调用模型桥');
assert.equal((await PDFDocument.load(translated.bytes)).getPageCount(), 1);

const office = libreOfficeExecutable(root)!;
const modern = join(directory, 'modern'), legacy = join(directory, 'legacy');
await mkdir(modern); await mkdir(legacy);
const registry = createRegistry();
for (const [original, old, filter] of [['docx', 'doc', 'MS Word 97'], ['pptx', 'ppt', 'MS PowerPoint 97'], ['xlsx', 'xls', 'MS Excel 97']] as const) {
  const source = join(modern, 'sample.' + original);
  await writeFile(source, await blankBytes(original));
  const profile = pathToFileURL(join(directory, 'profile-' + old)).href;
  await promisify(execFile)(office.path, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', `${old}:${filter}`, '--outdir', legacy, source], { timeout: 120_000, windowsHide: true });
  const oldPath = join(legacy, 'sample.' + old);
  assert.ok((await readFile(oldPath)).length > 100);
  const result = await convertLegacy(oldPath, old);
  assert.equal(result.format, original);
  assert.equal(await registry.resolve(original).open(result.bytes, original).then(model => model.format), original);
}
console.log(JSON.stringify({ passed: true, babeldoc: { requests, pdfBytes: translated.bytes.length }, libreoffice: 'doc/ppt/xls -> docx/pptx/xlsx', ocr: health.ocr.version, artifacts: directory }, null, 2));
