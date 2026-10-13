import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { dispatch } from '../packages/sdk/src/dispatch';
import { blankBytes } from '../packages/document-core/src/fixtures';

async function setup() { const directory = await mkdtemp(join(tmpdir(), 'av-authoring-')); return { core: new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))), directory }; }

test('MCP creation yields empty independent files and concurrent identical requests share one view', async () => {
  const { core, directory } = await setup();
  for (const format of ['markdown','html','docx','pptx','xlsx','pdf'] as const) {
    const args = { format, title: '空白验收', activate: false, idempotencyKey: format };
    const [first, second] = await Promise.all([dispatch(core, 'new-document', args), dispatch(core, 'new-document', args)]) as { id: string; documentId: string }[];
    assert.equal(first.id, second.id); assert.equal(first.documentId, second.documentId);
    const doc = core.getDocument(first.documentId).info;
    assert.equal(doc.dirty, true); assert.equal(doc.path, undefined);
    assert.equal(doc.model.blocks?.map(b => b.text).join('') ?? '', '');
    assert.equal(doc.model.slides?.length ?? 1, 1); assert.equal(doc.model.slides?.[0].blocks.length ?? 0, 0);
    assert.equal(doc.model.sheets?.[0].rows.flat().filter(c => c.value).length ?? 0, 0);
    assert.doesNotMatch(doc.model.text ?? '', /欢迎|开始写作|功能清单/);
    const output = join(directory, doc.title); await dispatch(core, 'save', { documentId: doc.id, path: output });
    assert.equal((await readFile(output)).length > 0 || format === 'markdown', true);
    const reopened = await core.openFile(output); assert.equal(reopened.documentId, doc.id);
    await assert.rejects(dispatch(core, 'new-document', { ...args, title: '不同标题' }), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  assert.equal(core.documents.size, 6);
});

test('creation refuses mismatched filename/content and requires an agent request key', async () => {
  const { core } = await setup();
  await assert.rejects(dispatch(core, 'new-document', { format: 'xlsx', title: 'notes.docx', idempotencyKey: 'bad' }), { code: 'FORMAT_MISMATCH' });
  await assert.rejects(dispatch(core, 'new-document', { format: 'docx', text: 'body', idempotencyKey: 'bad-content' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(dispatch(core, 'new-document', { format: 'markdown', title: '../outside.md', idempotencyKey: 'bad-title' }));
  await assert.rejects(dispatch(core, 'new-document', { format: 'markdown' })); assert.equal(core.documents.size, 0);
  const human = await dispatch(core, 'new-document', { format: 'markdown' }, 'human') as { id: string };
  assert.equal(core.lastHumanViewId, human.id);
});

test('Office search returns actual cell/object identities, HTML outline excludes scripts and style text', async () => {
  const { core } = await setup();
  const excel = await core.openBytes('source.xlsx', await blankBytes('xlsx'), 'xlsx');
  const sheetResult = await dispatch(core, 'search', { documentId: excel.documentId, query: 'Markdown' }) as any;
  assert.equal(sheetResult.results[0].locator.sheetId, '1'); assert.equal(sheetResult.results[0].locator.cell, 'A2');
  assert.equal(sheetResult.coverage.formulaResultsCalculated, false);
  const slides = await core.openBytes('source.pptx', await blankBytes('pptx'), 'pptx');
  const result = await dispatch(core, 'search', { documentId: slides.documentId, query: '阅读' }) as any;
  assert.equal(result.results.length, 1); assert.equal(result.results[0].locator.slideId, 'ppt/slides/slide1.xml'); assert.equal(result.results[0].locator.shapeId, '2');
  const html = await core.openBytes('source.html', new TextEncoder().encode('<style>.secret{color:red}</style><h1 id="novel">潮灯<span>町</span></h1><p>澪 &amp; 莲</p><script>secret()</script>'), 'html');
  assert.deepEqual(await dispatch(core, 'outline', { documentId: html.documentId }), [{ id: 'novel', title: '潮灯町', level: 1 }]);
  assert.equal((await dispatch(core, 'search', { documentId: html.documentId, query: 'secret' }) as any).results.length, 0);
  assert.equal((await dispatch(core, 'search', { documentId: html.documentId, query: '澪 & 莲' }) as any).results.length, 1);
});

test('navigation validates version/target/limits, preserves document bytes and does not manufacture context', async () => {
  const { core } = await setup(); const view = await core.openBytes('deck.pptx', await blankBytes('pptx'), 'pptx');
  const before = core.getDocument(view.documentId).bytes.slice();
  const args = { viewId: view.id, expectedRevision: 0, target: { kind: 'slide', slideId: 'ppt/slides/slide1.xml' }, idempotencyKey: 'nav' };
  const receipt = await dispatch(core, 'reader-navigate', args) as any;
  assert.equal(receipt.status, 'requested'); assert.deepEqual(await dispatch(core, 'reader-navigate', args), receipt);
  assert.equal(core.eventLog.filter(e => e.type === 'reader.navigate').length, 1);
  assert.equal(core.getView(view.id).context, undefined); assert.deepEqual(core.getDocument(view.documentId).bytes, before);
  await assert.rejects(dispatch(core, 'reader-navigate', { ...args, expectedRevision: 8, idempotencyKey: 'stale' }), { code: 'VERSION_CONFLICT' });
  await assert.rejects(dispatch(core, 'reader-navigate', { ...args, target: { kind: 'slide', slideId: 'missing' }, idempotencyKey: 'missing' }), { code: 'INVALID_TARGET' });
  core.setAgentControl(view.id, 'paused'); await assert.rejects(dispatch(core, 'reader-navigate', { ...args, idempotencyKey: 'paused' }), { code: 'AGENT_PAUSED' });
  const excel = await core.openBytes('sheet.xlsx', await blankBytes('xlsx'), 'xlsx');
  await assert.rejects(dispatch(core, 'reader-navigate', { viewId: excel.id, expectedRevision: 0, target: { kind: 'cell', sheetId: '1', address: 'AY1' }, idempotencyKey: 'outside' }), { code: 'CAPABILITY_UNSUPPORTED' });
  await assert.rejects(dispatch(core, 'report-context', { viewId: excel.id, context: { actor: 'human', visibleText: 'fake' } }), { code: 'AUTH_SCOPE_DENIED' });
});

test('HTML navigation resolves shared heading identities, rejects ambiguous or stale targets, and stays read-only', async () => {
  const { core } = await setup();
  const view = await core.openBytes('story.html', new TextEncoder().encode('<h1 id="title">潮灯町</h1><details><summary>第五章</summary><h2 id="ending">新的初见</h2><p id="body">正文</p></details><h2 id="duplicate">一</h2><h2 id="duplicate">二</h2>'), 'html');
  const before = core.getDocument(view.documentId).bytes.slice();
  const args = { viewId: view.id, expectedRevision: 0, target: { kind: 'html-heading', blockId: 'ending' }, idempotencyKey: 'html-navigation' };
  const receipt = await dispatch(core, 'reader-navigate', args) as any;
  assert.equal(receipt.status, 'requested'); assert.deepEqual(await dispatch(core, 'reader-navigate', args), receipt);
  assert.equal(core.getView(view.id).context, undefined); assert.deepEqual(core.getDocument(view.documentId).bytes, before);
  for (const blockId of ['body', 'missing', 'duplicate']) await assert.rejects(dispatch(core, 'reader-navigate', { ...args, target: { kind: 'html-heading', blockId }, idempotencyKey: 'bad-' + blockId }), { code: 'INVALID_TARGET' });
  await assert.rejects(dispatch(core, 'reader-navigate', { ...args, expectedRevision: 1, idempotencyKey: 'html-stale' }), { code: 'VERSION_CONFLICT' });
  const markdown = await core.openBytes('notes.md', new TextEncoder().encode('# 标题'), 'markdown');
  await assert.rejects(dispatch(core, 'reader-navigate', { ...args, viewId: markdown.id, idempotencyKey: 'html-format' }), { code: 'INVALID_TARGET' });
});
