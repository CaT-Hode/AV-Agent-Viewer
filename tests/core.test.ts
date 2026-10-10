import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { blankBytes } from '../packages/document-core/src/fixtures';
import { dispatch } from '../packages/sdk/src/dispatch';
import { startServer } from '../apps/local-service/src/server';
import { browserRequestSchema, type EditOperation } from '../packages/contracts/src/index';
import { DocumentTranslationService, translateDocumentBytes } from '../packages/translation/src/index';
import { SettingsService } from '../packages/settings/src/index';

async function setup() { const directory = await mkdtemp(join(tmpdir(), 'agentviewer-test-')); const core = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))); return { directory, core }; }
async function modify(core: ViewerCore, id: string, operation: EditOperation, key = crypto.randomUUID()) { const patch = core.prepare(id, core.getDocument(id).info.revision, operation); return { patch, receipt: await core.commit(patch.id, key) }; }

test('快照固定未保存正文；多个视图有独立选择；版本冲突阻止过期提交', async () => {
  const { core } = await setup(); const first = await core.openBytes('test.md', new TextEncoder().encode('原文片段'), 'markdown'); const second = core.addView(first.documentId);
  core.updateContext(first.id, { selection: { kind: 'text', text: '原文' }, visibleText: '原文片段', locator: { kind: 'source', from: 0, to: 2 } });
  core.updateContext(second.id, { selection: { kind: 'text', text: '片段' } });
  core.activate(first.id, 'human'); core.activate(second.id, 'agent'); assert.equal((await core.context()).viewId, first.id);
  const snapshot = await core.snapshot(first.id), pending = core.prepare(first.documentId, 0, { kind: 'text.replace', from: 0, to: 2, expectedText: '原文', text: '替换' });
  const changed = await modify(core, first.documentId, { kind: 'text.replace', from: 4, to: 4, expectedText: '', text: '新增' });
  assert.equal(core.getDocument(first.documentId).info.model.text, '原文片段新增'); assert.equal(snapshot.document.model.text, '原文片段'); assert.equal(snapshot.context.selection.text, '原文');
  await assert.rejects(core.commit(pending.id, 'stale'), /内容已改变/);
  assert.equal((await core.context(first.id)).quality, 'not-ready');
  await core.undo(changed.receipt.transactionId); assert.equal(core.getDocument(first.documentId).info.model.text, '原文片段');
});

test('提交重试不重复插入；重启后的回执仍可识别', async () => {
  const { core, directory } = await setup(); const view = await core.openBytes('test.md', new TextEncoder().encode('a'), 'markdown'); const patch = core.prepare(view.documentId, 0, { kind: 'text.replace', from: 1, to: 1, expectedText: '', text: 'b' });
  const [first, second] = await Promise.all([core.commit(patch.id, 'same-key'), core.commit(patch.id, 'same-key')]); assert.deepEqual(first, second); assert.equal(core.getDocument(view.documentId).info.model.text, 'ab');
  const restored = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))); await restored.initialize(); assert.deepEqual(await restored.commit(patch.id, 'same-key'), first); assert.equal(restored.getDocument(view.documentId).info.model.text, 'ab');
  const other = core.prepare(view.documentId, 1, { kind: 'text.replace', from: 2, to: 2, expectedText: '', text: 'c' }); await assert.rejects(core.commit(other.id, 'same-key'), /幂等键/);
});

test('落盘与外部冲突使用真实文件，撤销不覆盖后续修改', async () => {
  const { core, directory } = await setup(); const path = join(directory, '原件.md'); await writeFile(path, 'abc'); const view = await core.openFile(path);
  const changed = await modify(core, view.documentId, { kind: 'text.replace', from: 1, to: 2, expectedText: 'b', text: 'B' }); await core.save(view.documentId); assert.equal(await readFile(path, 'utf8'), 'aBc');
  await modify(core, view.documentId, { kind: 'text.replace', from: 3, to: 3, expectedText: '', text: '!' }); await assert.rejects(core.undo(changed.receipt.transactionId), /其他编辑/);
  await writeFile(path, 'external'); await assert.rejects(core.save(view.documentId), /其他程序修改/); assert.equal(await readFile(path, 'utf8'), 'external');
  const copy = join(directory, '副本.md'); await core.save(view.documentId, copy); assert.equal(await readFile(copy, 'utf8'), 'aBc!');
  await assert.rejects(core.save(view.documentId, join(directory, '错误.pdf')), /不能通过改扩展名/);
});

test('DOCX 与 PPTX 实际 ZIP 内容修改，未修改部件保留', async () => {
  const { core } = await setup();
  for (const format of ['docx', 'pptx'] as const) {
    const input = await blankBytes(format), zip = await JSZip.loadAsync(input); zip.file('custom-preserved.xml', '<untouched>原样内容</untouched>');
    const view = await core.openBytes('test.' + format, await zip.generateAsync({ type: 'uint8array' }), format); const d = core.getDocument(view.documentId);
    const op: EditOperation = format === 'docx' ? { kind: 'word.setBlock', blockId: d.info.model.blocks![0].id, text: '已修改中文' } : { kind: 'slides.setText', slideId: d.info.model.slides![0].id, shapeId: d.info.model.slides![0].blocks[0].id, text: '已修改中文' };
    await modify(core, d.info.id, op); const output = await JSZip.loadAsync(d.bytes); assert.equal(await output.file('custom-preserved.xml')!.async('string'), '<untouched>原样内容</untouched>');
    const model = await core.registry.resolve(format).open(d.bytes, format); assert.equal(format === 'docx' ? model.blocks![0].text : model.slides![0].blocks[0].text, '已修改中文');
  }
});

test('Office 工具修改结构与格式后可保存重开，外部修改只在无草稿时载入', async () => {
  const { core, directory } = await setup();
  const wordView = await core.openBytes('word.docx', await blankBytes('docx'), 'docx');
  const wordId = wordView.documentId, firstBlock = core.getDocument(wordId).info.model.blocks![0].id;
  await modify(core, wordId, { kind: 'word.setParagraphFormat', blockId: firstBlock, style: 'Heading2', alignment: 'center' });
  await modify(core, wordId, { kind: 'word.insertParagraph', afterBlockId: firstBlock, text: '新增段落', style: 'Normal' });
  const wordPath = join(directory, 'word.docx'); await core.save(wordId, wordPath);
  const reopenedWord = await core.registry.resolve('docx').open(new Uint8Array(await readFile(wordPath)), 'docx');
  assert.equal(reopenedWord.blocks![0].style, 'Heading2'); assert.equal(reopenedWord.blocks![0].alignment, 'center'); assert.equal(reopenedWord.blocks![1].text, '新增段落');

  const slideView = await core.openBytes('slides.pptx', await blankBytes('pptx'), 'pptx');
  const slideId = slideView.documentId, slide = core.getDocument(slideId).info.model.slides![0];
  await modify(core, slideId, { kind: 'slides.setShapeBounds', slideId: slide.id, shapeId: slide.blocks[0].id, x: .2, y: .1, width: .6, height: .2 });
  const slidePath = join(directory, 'slides.pptx'); await core.save(slideId, slidePath);
  const reopenedSlide = await core.registry.resolve('pptx').open(new Uint8Array(await readFile(slidePath)), 'pptx');
  assert.ok(Math.abs(reopenedSlide.slides![0].blocks[0].x! - .2) < .0001);
  assert.ok(Math.abs(reopenedSlide.slides![0].blocks[0].width! - .6) < .0001);

  const sheetView = await core.openBytes('book.xlsx', await blankBytes('xlsx'), 'xlsx');
  const bookId = sheetView.documentId, sheetId = core.getDocument(bookId).info.model.sheets![0].id;
  await modify(core, bookId, { kind: 'sheets.setCell', sheetId, address: 'B2', value: '42.5', valueType: 'number' });
  await modify(core, bookId, { kind: 'sheets.setCellFormat', sheetId, address: 'B2', bold: true, horizontal: 'right', numberFormat: '0.00', fill: 'E8F2FF' });
  await modify(core, bookId, { kind: 'sheets.renameWorksheet', sheetId, name: '财务' });
  await modify(core, bookId, { kind: 'sheets.addWorksheet', name: '附录' });
  const bookPath = join(directory, 'book.xlsx'); await core.save(bookId, bookPath);
  const reopenedBook = await core.registry.resolve('xlsx').open(new Uint8Array(await readFile(bookPath)), 'xlsx');
  assert.deepEqual(reopenedBook.sheets?.map(sheet => sheet.name), ['财务', '附录']);
  assert.equal(reopenedBook.sheets![0].rows[1][1].bold, true);
  assert.equal(reopenedBook.sheets![0].rows[1][1].fill, 'E8F2FF');
  assert.equal(reopenedBook.sheets![0].rows[1][1].value, '42.5');

  await modify(core, wordId, { kind: 'word.setBlock', blockId: firstBlock, text: '本地草稿' });
  await assert.rejects(core.reloadFromDisk(wordId), /先保存或另存/);
  const externalZip = await JSZip.loadAsync(await readFile(wordPath));
  const externalXml = await externalZip.file('word/document.xml')!.async('string');
  externalZip.file('word/document.xml', externalXml.replace('新增段落', '外部修改'));
  await core.save(wordId);
  await writeFile(wordPath, await externalZip.generateAsync({ type: 'uint8array' }));
  const beforeRevision = core.getDocument(wordId).info.revision;
  await core.reloadFromDisk(wordId);
  assert.equal(core.getDocument(wordId).info.revision, beforeRevision + 1);
  assert.equal(core.getDocument(wordId).info.model.blocks![1].text, '外部修改');
  assert.equal(core.getDocument(wordId).info.dirty, false);
});

test('PPTX 阅读和编辑遵循演示文稿的页序，而非 ZIP 文件名', async () => {
  const { core } = await setup(), zip = await JSZip.loadAsync(await blankBytes('pptx'));
  const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
  zip.file('ppt/slides/slide2.xml', slide1.replace('阅读与协作', '第二页内容'));
  zip.file('ppt/presentation.xml', (await zip.file('ppt/presentation.xml')!.async('string')).replace('<p:sldIdLst>', '<p:sldIdLst><p:sldId id="1024" r:id="rIdReordered"/>'));
  zip.file('ppt/_rels/presentation.xml.rels', (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace('</Relationships>', '<Relationship Id="rIdReordered" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'));
  const view = await core.openBytes('reordered.pptx', await zip.generateAsync({ type: 'uint8array' }), 'pptx'), document = core.getDocument(view.documentId);
  assert.equal(document.info.model.slides![0].id, 'ppt/slides/slide2.xml');
  await modify(core, view.documentId, { kind: 'slides.setText', slideId: document.info.model.slides![0].id, shapeId: document.info.model.slides![0].blocks[0].id, text: '实际第一页已编辑' });
  const saved = await JSZip.loadAsync(document.bytes);
  assert.equal(await saved.file('ppt/slides/slide1.xml')!.async('string'), slide1);
  assert.equal(document.info.model.slides![0].blocks[0].text, '实际第一页已编辑');
});

test('任务使用用户固定的快照，继续编辑不会改变提问内容', async () => {
  const { core } = await setup(), view = await core.openBytes('question.md', new TextEncoder().encode('提问时正文'), 'markdown');
  core.updateContext(view.id, { visibleText: '提问时正文', selection: { kind: 'text', text: '提问时' } });
  const snapshot = await core.snapshot(view.id);
  await modify(core, view.documentId, { kind: 'text.replace', from: 0, to: 5, expectedText: '提问时正文', text: '后续修改' });
  let supplied: string | undefined;
  core.drivers.set('test-driver', { id: 'test-driver', capabilities: { streaming: true, cancellation: true, attachExistingSession: false }, async submit(_prompt, frozen, emit) { supplied = frozen.document.model.text; emit('依据固定内容回答'); } });
  const task = await core.submitTask('test-driver', '解释选择', view.id, snapshot.id);
  assert.equal(task.snapshotId, snapshot.id); assert.equal(supplied, '提问时正文');
  const other = core.addView(view.documentId);
  await assert.rejects(core.submitTask('test-driver', '错误目标', other.id, snapshot.id), /其他阅读视图/);
});

test('XLSX 公式往返与 PDF 页面/增补保存', async () => {
  const { core, directory } = await setup(); const sheetView = await core.openBytes('test.xlsx', await blankBytes('xlsx'), 'xlsx'); const workbook = core.getDocument(sheetView.documentId);
  await modify(core, workbook.info.id, { kind: 'sheets.setCell', sheetId: workbook.info.model.sheets![0].id, address: 'C8', value: '', formula: 'SUM(1,2)' });
  await core.save(workbook.info.id, join(directory, 'test.xlsx')); const reopened = await core.registry.resolve('xlsx').open(new Uint8Array(await readFile(join(directory, 'test.xlsx'))), 'xlsx'); assert.equal(reopened.sheets![0].rows[7][2].formula, 'SUM(1,2)');
  const pdfView = await core.openBytes('test.pdf', await blankBytes('pdf'), 'pdf'); const pdf = core.getDocument(pdfView.documentId);
  const original = pdf.bytes.slice(); await modify(core, pdf.info.id, { kind: 'pdf.addText', pageIndex: 0, x: 0.2, y: 0.4, text: 'Persistent note', size: 16 }); await modify(core, pdf.info.id, { kind: 'pdf.addPage' });
  await core.save(pdf.info.id, join(directory, 'test.pdf')); const saved = new Uint8Array(await readFile(join(directory, 'test.pdf'))); assert.equal((await PDFDocument.load(saved)).getPageCount(), 4); assert.notDeepEqual(saved, original);
  await modify(core, pdf.info.id, { kind: 'pdf.rotate', pageIndex: 0, degrees: 90 }); await assert.rejects(modify(core, pdf.info.id, { kind: 'pdf.addText', pageIndex: 0, x: 0.1, y: 0.1, text: 'bad', size: 16 }), /未旋转/);
});

test('外部接口不能伪造界面上下文；不支持能力显式失败', async () => {
  const { core } = await setup(); await assert.rejects(dispatch(core, 'report-context', { viewId: 'x', actor: 'human' }, 'agent'), /伪造/);
  await assert.rejects(dispatch(core, 'browser-input', { viewId: 'x', expectedNavigationId: 'nav', idempotencyKey: 'key', action: { kind: 'click', x: 0, y: 0 } }), /桌面应用/);
  assert.throws(() => browserRequestSchema.parse({ viewId: 'x', expectedNavigationId: 'n', idempotencyKey: 'key', action: { kind: 'click', x: -1, y: 0 } }));
});

test('HTTP 拒绝错误凭据、外部网页 Origin 与角色伪造', async () => {
  const { core, directory } = await setup(); const port = 3299; const runtime = await startServer(core, process.cwd(), directory, port);
  try {
    assert.equal((await fetch(runtime.endpoint + '/api/state')).status, 401);
    assert.equal((await fetch(runtime.endpoint + '/api/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(runtime.endpoint + '/api/state', { headers: { Authorization: 'Bearer ' + runtime.token, Origin: 'https://untrusted.example' } })).status, 403);
    const response = await fetch(runtime.endpoint + '/api/command', { method: 'POST', headers: { Authorization: 'Bearer ' + runtime.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'report-context', args: { viewId: 'x', actor: 'human' } }) }); assert.equal(response.status, 400); assert.match(await response.text(), /AUTH_SCOPE_DENIED/);
    core.browser = {} as never;
    const invalidInput = await fetch(runtime.endpoint + '/v1/browser/input', { method: 'POST', headers: { Authorization: 'Bearer ' + runtime.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ viewId: 'invalid', action: { kind: 'click', x: -1, y: 0 } }) });
    assert.equal(invalidInput.status, 400); assert.match(await invalidInput.text(), /INVALID_ARGUMENT/);
  } finally { await new Promise<void>(resolve => runtime.server.close(() => resolve())); }
});

test('设置验证、持久化和版本号', async () => {
  const { directory } = await setup(), path = join(directory, 'settings.json');
  const settings = new SettingsService(path); await settings.load();
  assert.equal(settings.get('translation.selectionDelayMs'), 500);
  await assert.rejects(settings.set('translation.selectionDelayMs', 50));
  await settings.set('translation.selectionDelayMs', 700);
  const restored = new SettingsService(path); await restored.load();
  assert.equal(restored.get('translation.selectionDelayMs'), 700);
  assert.equal(restored.snapshot().revision, 1);
});

test('结构译文生成独立文件，原始字节与公式保持不变', async () => {
  const { core, directory } = await setup();
  const translator = async (text: string) => '译文:' + text;
  for (const format of ['markdown', 'html', 'docx', 'pptx', 'xlsx'] as const) {
    const bytes = format === 'markdown' ? new TextEncoder().encode('# Heading\n\nBody text\n') : format === 'html' ? new TextEncoder().encode('<h1>Heading</h1><script>doNotTranslate()</script><p>Body text</p>') : await blankBytes(format);
    const source = bytes.slice();
    const result = await translateDocumentBytes(format, bytes, 'zh-CN', translator, new AbortController().signal);
    assert.deepEqual(bytes, source);
    assert.ok(result.units > 0);
    assert.notDeepEqual(result.bytes, source);
    const original = await core.registry.resolve(format).open(source, format), translated = await core.registry.resolve(format).open(result.bytes, format);
    if (format === 'markdown') { assert.match(translated.text!, /^# 译文:Heading/); assert.equal(original.text, '# Heading\n\nBody text\n'); }
    if (format === 'html') { assert.match(translated.text!, /译文:Heading/); assert.match(translated.text!, /doNotTranslate\(\)/); }
    if (format === 'docx') assert.notDeepEqual(translated.blocks?.map(b => b.text), original.blocks?.map(b => b.text));
    if (format === 'pptx') assert.notDeepEqual(translated.slides?.map(s => s.blocks.map(b => b.text)), original.slides?.map(s => s.blocks.map(b => b.text)));
    if (format === 'xlsx') { assert.equal(translated.sheets?.[0].rows[7][2].formula, original.sheets?.[0].rows[7][2].formula); assert.notEqual(translated.sheets?.[0].rows[0][0].value, original.sheets?.[0].rows[0][0].value); }
  }
  const view = await core.openBytes('source.md', new TextEncoder().encode('# Source\nText'), 'markdown');
  const sourceId = view.documentId, before = core.getDocument(sourceId).bytes.slice(), active = core.activeViewId;
  const service = new DocumentTranslationService(core, join(directory, 'translations'), async text => '译文:' + text, 'test');
  const job = await service.start(sourceId, 'zh-CN');
  for (let i = 0; i < 100 && service.jobs.get(job.id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.jobs.get(job.id)?.status, 'completed');
  const artifact = service.jobs.get(job.id)!.artifact!;
  assert.notEqual(artifact.documentId, sourceId); assert.equal(core.activeViewId, active);
  assert.deepEqual(core.getDocument(sourceId).bytes, before);
  assert.match(await readFile(artifact.path, 'utf8'), /译文:/);
  const restored = new DocumentTranslationService(core, join(directory, 'translations'), async text => text); await restored.load();
  assert.equal(restored.artifacts.size, 1);
});

test('全文翻译从冻结快照和已完成片段继续，不读取之后的原文修改', async () => {
  const { core, directory } = await setup(), root = join(directory, 'translations');
  const view = await core.openBytes('resume.md', new TextEncoder().encode('First line\nSecond line'), 'markdown');
  let calls = 0;
  const first = new DocumentTranslationService(core, root, async (_text, _language, signal) => { calls++; if (calls === 1) return '第一行'; await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); return ''; });
  const job = await first.start(view.documentId, 'zh-CN');
  const checkpoint = join(root, 'checkpoints', job.id + '.json');
  for (let i = 0; i < 100; i++) { const saved = JSON.parse(await readFile(checkpoint, 'utf8')) as { segments: string[] }; if (saved.segments.length === 1) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  first.cancel(job.id);
  for (let i = 0; i < 100 && first.jobs.get(job.id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(first.jobs.get(job.id)?.status, 'cancelled');
  await modify(core, view.documentId, { kind: 'text.replace', from: 0, to: 5, expectedText: 'First', text: 'Changed' });
  const mismatched = new DocumentTranslationService(core, root, async text => text, 'codex', undefined, () => ({ fingerprint: 'another-model', model: 'another-model', translate: async text => text }));
  await mismatched.load();
  await assert.rejects(mismatched.resume(job.id), /模型配置已变化/);
  let resumedCalls = 0;
  const second = new DocumentTranslationService(core, root, async text => { resumedCalls++; return '译:' + text; }); await second.load();
  assert.equal(second.jobs.get(job.id)?.status, 'paused'); await second.resume(job.id);
  for (let i = 0; i < 100 && second.jobs.get(job.id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(second.jobs.get(job.id)?.status, 'completed'); assert.equal(resumedCalls, 1);
  const result = await readFile(second.jobs.get(job.id)!.artifact!.path, 'utf8');
  assert.match(result, /第一行/); assert.match(result, /译:Second line/); assert.doesNotMatch(result, /Changed/);
});

test('运行中的全文翻译固定发起时的模型配置', async () => {
  const { core, directory } = await setup();
  const view = await core.openBytes('profile.md', new TextEncoder().encode('Alpha\nBeta'), 'markdown');
  let selected = 'model-a';
  const used: string[] = [];
  const service = new DocumentTranslationService(core, join(directory, 'translations'), async text => text, 'test', undefined, () => {
    const fixed = selected;
    return { fingerprint: fixed, model: fixed, translate: async text => { used.push(fixed); selected = 'model-b'; return fixed + ':' + text; } };
  });
  const job = await service.start(view.documentId, 'zh-CN');
  for (let i = 0; i < 100 && service.jobs.get(job.id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.jobs.get(job.id)?.status, 'completed');
  assert.deepEqual(used, ['model-a', 'model-a']);
  assert.equal(service.jobs.get(job.id)?.artifact?.model, 'model-a');
});

test('用户可按视图暂停或停止 Agent，用户编辑仍可继续', async () => {
  const { core } = await setup(); const view = await core.openBytes('control.md', new TextEncoder().encode('hello'), 'markdown');
  const patch = core.prepare(view.documentId, 0, { kind: 'text.replace', from: 0, to: 5, expectedText: 'hello', text: 'world' });
  core.setAgentControl(view.id, 'paused');
  await assert.rejects(core.commit(patch.id, 'agent-attempt', 'agent'), /暂停或停止/);
  await assert.rejects(dispatch(core, 'agent-control', { viewId: view.id, status: 'running' }, 'agent'), /仅用户/);
  const human = await core.commit(patch.id, 'human-edit', 'human'); assert.equal(human.status, 'applied');
  core.setAgentControl(view.id, 'running');
  const next = core.prepare(view.documentId, 1, { kind: 'text.replace', from: 0, to: 5, expectedText: 'world', text: 'again' });
  assert.equal((await core.commit(next.id, 'agent-resumed', 'agent')).status, 'applied');
});

test('选区工具保留快照与幂等：Markdown/HTML 格式、批注持久化且不写原文', async () => {
  const {core,directory}=await setup();const view=await core.openBytes('selection.md',new TextEncoder().encode('one target two'),'markdown');
  core.updateContext(view.id,{selection:{kind:'text',text:'target',locator:{kind:'source-range',from:4,to:10}}});
  const tools=await dispatch(core,'selection-tools',{viewId:view.id}) as any;
  const bytes=core.getDocument(view.documentId).bytes.slice();
  const note=await dispatch(core,'selection-action',{snapshotId:tools.snapshot.id,action:'note',value:'test note',idempotencyKey:'note-1'}) as any;
  assert.deepEqual(core.getDocument(view.documentId).bytes,bytes);
  const args={snapshotId:tools.snapshot.id,action:'bold',idempotencyKey:'bold-1'};
  const [a,b]=await Promise.all([dispatch(core,'selection-action',args),dispatch(core,'selection-action',args)]);assert.deepEqual(a,b);
  assert.equal(core.getDocument(view.documentId).info.model.text,'one **target** two');
  await assert.rejects(dispatch(core,'selection-action',{...args,idempotencyKey:'stale'}),/选区所属内容已变化/);
  const restarted=new ViewerCore(new JsonWorkspaceRepository(join(directory,'workspace.json')));await restarted.initialize();assert.equal(restarted.annotations.get(note.annotation.id)?.text,'test note');
  const html=await core.openBytes('safe.html',new TextEncoder().encode('<p title="target">safe text</p>'),'html');
  core.updateContext(html.id,{selection:{kind:'text',text:'target',locator:{kind:'source-range',from:10,to:16}}});
  const unsafe=await core.snapshot(html.id);await assert.rejects(dispatch(core,'selection-action',{snapshotId:unsafe.id,action:'bold',idempotencyKey:'html-attr'}),/HTML 标签或属性/);
  core.updateContext(html.id,{selection:{kind:'text',text:'safe text'}});const safe=await core.snapshot(html.id);await dispatch(core,'selection-action',{snapshotId:safe.id,action:'italic',idempotencyKey:'html-safe'});assert.match(core.getDocument(html.documentId).info.model.text!,/<em>safe text<\/em>/);
});

test('Word 和 PPT 选区字体格式拆分文字 run，保留其他文字并可保存重开', async()=>{
  const {core}=await setup();for(const format of ['docx','pptx'] as const){
    const view=await core.openBytes('sample.'+format,await blankBytes(format),format);let doc=core.getDocument(view.documentId).info;
    const block=format==='docx'?doc.model.blocks![0]:doc.model.slides![0].blocks[0],slide=doc.model.slides?.[0];
    await modify(core,doc.id,format==='docx'?{kind:'word.setBlock',blockId:block.id,text:'before target after'}:{kind:'slides.setText',slideId:slide!.id,shapeId:block.id,text:'before target after'});
    core.updateContext(view.id,{selection:{kind:'text',text:'target',locator:{kind:'text',blockId:format==='docx'?block.id:undefined,shapeId:format==='pptx'?block.id:undefined,slideId:slide?.id,from:7,to:13}}});const snapshot=await core.snapshot(view.id);
    await dispatch(core,'selection-action',{snapshotId:snapshot.id,action:'bold',idempotencyKey:format+'-bold'});doc=core.getDocument(view.documentId).info;
    const updated=format==='docx'?doc.model.blocks![0]:doc.model.slides![0].blocks[0];assert.equal(updated.text,'before target after');assert.deepEqual(updated.runs?.map(r=>[r.text,!!r.bold]),[['before ',false],['target',true],[' after',false]]);
  }
});

test('PDF 逐行标记包含旋转页；Excel 格式工具保留公式', async()=>{
  const {core}=await setup();const pdf=await core.openBytes('selection.pdf',await blankBytes('pdf'),'pdf');await modify(core,pdf.documentId,{kind:'pdf.rotate',pageIndex:0,degrees:90});
  core.updateContext(pdf.id,{selection:{kind:'text',text:'sample',pageRects:[{pageIndex:0,x:.1,y:.2,width:.3,height:.02},{pageIndex:0,x:.1,y:.23,width:.2,height:.02}]}});const snapshot=await core.snapshot(pdf.id);
  await dispatch(core,'selection-action',{snapshotId:snapshot.id,action:'underline',idempotencyKey:'pdf-lines'});const reopened=await PDFDocument.load(core.getDocument(pdf.documentId).bytes);assert.equal(reopened.getPages()[0].getRotation().angle,90);
  const xlsx=await core.openBytes('cells.xlsx',await blankBytes('xlsx'),'xlsx');const sheet=core.getDocument(xlsx.documentId).info.model.sheets![0];await modify(core,xlsx.documentId,{kind:'sheets.setCell',sheetId:sheet.id,address:'A1',value:'',formula:'SUM(B1:B2)'});
  core.updateContext(xlsx.id,{selection:{kind:'cells',text:'=SUM(B1:B2)',locator:{kind:'cell',sheetId:sheet.id,cell:'A1'}}});const wasBold=!!core.getDocument(xlsx.documentId).info.model.sheets![0].rows[0][0].bold;const cellSnapshot=await core.snapshot(xlsx.id);await dispatch(core,'selection-action',{snapshotId:cellSnapshot.id,action:'bold',idempotencyKey:'cell-bold'});
  const cell=core.getDocument(xlsx.documentId).info.model.sheets![0].rows[0][0];assert.equal(!!cell.bold,!wasBold);assert.equal(cell.formula,'SUM(B1:B2)');
});
