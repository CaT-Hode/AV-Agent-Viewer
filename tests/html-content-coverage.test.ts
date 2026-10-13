import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ViewerCore } from '../packages/document-core/src/index';
import { dispatch } from '../packages/sdk/src/dispatch';
import { outlineDocument, searchDocument } from '../packages/sdk/src/document-content';

const repository = () => ({ load: async <T>() => undefined as T | undefined, save: async (_value: unknown) => {} });
async function document(source: string) {
  const core = new ViewerCore(repository()); await core.initialize();
  const view = await core.openBytes('正文.html', new TextEncoder().encode(source), 'html');
  return { core, view, info: core.getDocument(view.documentId).info };
}

test('HTML search covers bare body text, generic divs, and inline-only content through actual dispatch', async () => {
  for (const source of ['<div>澪</div>', '<body>澪</body>', '<body><span>澪</span><em>与莲</em></body>', '澪']) {
    const t = await document(source);
    const result = await dispatch(t.core, 'search', { documentId: t.view.documentId, query: '澪' }) as ReturnType<typeof searchDocument>;
    assert.equal(result.scope, 'content-model'); assert.equal(result.results.length, 1, source);
    assert.equal(result.results[0].revision, 0);
    assert.equal(result.results[0].locator.kind, 'html-block'); assert.ok(result.results[0].locator.blockId);
    assert.equal(result.results[0].from, 0); assert.equal(result.results[0].to, 1);
  }
  const t = await document('<div id="prose">澪<span>与莲</span></div>');
  assert.equal(searchDocument(t.info, '澪与莲').results[0].locator.blockId, 'prose');
});

test('mixed containers index direct text before and after child blocks without ancestor duplication', async () => {
  const t = await document('<main><div id="mixed">澪之前<span>与莲</span><p id="paragraph">澪段落<strong>文字</strong></p>澪之后<div id="nested">澪内层</div>澪末尾</div></main>');
  const results = searchDocument(t.info, '澪').results;
  assert.equal(results.length, 5);
  assert.deepEqual(results.map(result => result.quote), ['澪之前与莲', '澪段落文字', '澪之后', '澪内层', '澪末尾']);
  assert.equal(new Set(results.map(result => result.locator.blockId)).size, 5);
  assert.equal(results[1].locator.blockId, 'paragraph'); assert.equal(results[3].locator.blockId, 'nested');
  assert.equal(searchDocument(t.info, '澪之前与莲').results.length, 1, 'inline text stays contiguous inside its own run');
  assert.equal(searchDocument(t.info, '文字澪之后').results.length, 0, 'separate blocks do not invent a joined search hit');
});

test('HTML body extraction excludes metadata and executable/inert subtrees even inside mixed containers', async () => {
  const t = await document('<!doctype html><html><head><title>澪隐藏</title><meta name="description" content="澪隐藏"><style>.澪隐藏{}</style></head><body>澪可见<script>澪隐藏</script><div>澪可见<style>澪隐藏</style><template><h2>澪隐藏</h2></template><noscript>澪隐藏</noscript><p>澪可见</p></div></body></html>');
  assert.equal(searchDocument(t.info, '澪隐藏').results.length, 0);
  assert.equal(searchDocument(t.info, '澪可见').results.length, 3);
  assert.deepEqual(outlineDocument(t.info), []);
});

test('nested lists/tables are indexed once, and inline line breaks do not merge words', async () => {
  const t = await document('<div><ul><li>澪列表<ol><li>澪子列表</li></ol>澪尾声</li></ul><table><tr><td>澪单元格<p>澪内段</p>澪格尾</td><td>澪第二格</td></tr></table><p id="line">澪<br>莲</p></div>');
  const results = searchDocument(t.info, '澪').results;
  assert.equal(results.length, 8);
  assert.deepEqual(results.map(result => result.quote), ['澪列表', '澪子列表', '澪尾声', '澪单元格', '澪内段', '澪格尾', '澪第二格', '澪 莲']);
  assert.equal(searchDocument(t.info, '澪莲').results.length, 0);
  assert.equal(searchDocument(t.info, '澪 莲').results[0].locator.blockId, 'line');
});

test('existing named heading/paragraph locators and parse-tree fallback locators stay stable', async () => {
  const source = '<!doctype html><html><body><section>导言<span>行内</span><h2 id="chapter">第十三夜 <em>潮灯</em></h2>澪<p id="paragraph">澪正文</p>结尾</section></body></html>';
  const first = await document(source), second = await document(source);
  const search = searchDocument(first.info, '澪');
  assert.deepEqual(search, searchDocument(second.info, '澪'));
  assert.equal(search.results.length, 2); assert.equal(search.results[1].locator.blockId, 'paragraph');
  assert.deepEqual(outlineDocument(first.info), [{ id: 'chapter', title: '第十三夜 潮灯', level: 2 }]);
  assert.deepEqual(outlineDocument(first.info), outlineDocument(second.info));
  assert.deepEqual(await dispatch(first.core, 'outline', { documentId: first.view.documentId }), outlineDocument(first.info));
});

test('heading text survives generic inline wrappers and has a single search hit', async () => {
  const t = await document('<main>前文<h1 id="title"><span>澪的</span><b>潮灯</b></h1><div><section><span>澪的后记</span></section></div>尾文</main>');
  assert.deepEqual(outlineDocument(t.info), [{ id: 'title', title: '澪的潮灯', level: 1 }]);
  assert.equal(searchDocument(t.info, '澪').results.length, 2);
  assert.equal(searchDocument(t.info, '澪的潮灯').results[0].locator.blockId, 'title');
  assert.equal(searchDocument(t.info, '前文').results.length, 1); assert.equal(searchDocument(t.info, '尾文').results.length, 1);
});
