import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { documentOutlineItems } from '../apps/desktop/src/renderer/lib/document-outline';
import { htmlNavigationScript } from '../apps/desktop/src/renderer/lib/html-navigation';
import type { DocumentInfo } from '../packages/contracts/src/index';
const outline = (format: DocumentInfo['format'], model: Omit<DocumentInfo['model'], 'format'>) => documentOutlineItems({ format, model: { ...model, format } });

test('presentation and spreadsheet arrays are titles, never conditions for the PDF branch', () => {
  assert.deepEqual(outline('pptx', { pageCount: 99, slides: [{ id: 'slide1', blocks: [{ id: 's1', text: '潮灯' }] }, { id: 'slide2', blocks: [] }] }), [{ index: 0, id: 'slide1', title: '第 1 页 · 潮灯' }, { index: 1, id: 'slide2', title: '第 2 页 · ' }]);
  assert.deepEqual(outline('xlsx', { pageCount: 99, sheets: [{ id: 'sheet1', name: '编年', rows: [] }] }), [{ index: 0, id: 'sheet1', title: '编年' }]);
  assert.deepEqual(outline('pdf', { pageCount: 2 }), [{ index: 0, title: '第 1 页' }, { index: 1, title: '第 2 页' }]);
});

test('Word headings retain actual paragraph indices and Markdown includes level six', () => {
  assert.deepEqual(outline('docx', { blocks: [{ id: 'p0', text: '题记' }, { id: 'p1', text: '第一章', style: 'Heading1' }, { id: 'p2', text: '正文' }, { id: 'p3', text: '第二章', style: 'Heading2' }] }), [{ index: 1, id: 'p1', title: '第一章', level: 1 }, { index: 3, id: 'p3', title: '第二章', level: 2 }]);
  assert.deepEqual(outline('markdown', { text: '正文\n###### 微小标题\n# 大标题' }).map(item => [item.index, item.title, item.level]), [[0, '微小标题', 6], [1, '大标题', 1]]);
});

test('HTML consumes the shared outline identity and source order without parsing in the renderer', () => {
  assert.deepEqual(documentOutlineItems({ format: 'html', model: { format: 'html', text: '<h1>不会直接解析</h1>' } }, [{ id: 'chapter5', title: '新的初见', level: 2 }, { id: 'html/0/1', title: '潮灯', level: 3 }]), [{ id: 'chapter5', title: '新的初见', level: 2, index: 0 }, { id: 'html/0/1', title: '潮灯', level: 3, index: 1 }]);
});

function navigationFixture(deferFrames = false) {
  let selectionClears = 0, sends = 0;
  const messages: unknown[] = [], scrolls: unknown[] = [], details = { tagName: 'DETAILS', open: false, parentElement: null };
  const heading = (value: string) => ({ nodeName: 'H2', tagName: 'H2', nodeType: 1, childNodes: [{ nodeName: '#text', nodeType: 3, textContent: value }], parentElement: details, style: { display: 'block', visibility: 'visible', opacity: '1' }, checkVisibility: () => true, scrollIntoView: (options: unknown) => scrolls.push(options), getBoundingClientRect: () => ({ top: 25, bottom: 75, left: 20, right: 350 }) });
  const headings = [heading(''), heading('雨中归灯'), heading('新的初见')];
  const parent = { postMessage: (message: unknown) => messages.push(message) };
  const frames: (() => void)[] = [], observations: { actor: string; blockId?: string; quote?: string; requestId?: string }[] = [];
  const context = { parent, document: { body: { querySelectorAll: () => headings } }, postReadingMessage: (message: unknown) => messages.push(message), getSelection: () => ({ removeAllRanges: () => selectionClears++ }), requestAnimationFrame: (callback: () => void) => deferFrames ? frames.push(callback) : callback(), getComputedStyle: (node: typeof headings[number]) => node.style, innerWidth: 800, innerHeight: 600, send: (request?: {requestId?: string}): void => { sends++; observations.push({ actor: context.readingActor, blockId: context.readingBlockId, quote: context.readingQuote, requestId: request?.requestId }); }, readingActor: 'human', readingBlockId: undefined as string | undefined, readingQuote: undefined as string | undefined, navigate: (_request: unknown) => {} };
  runInNewContext(htmlNavigationScript() + '\nglobalThis.navigate=navigateHtml;', context);
  return { parent, headings, observations, flushFrames: () => { for (const callback of frames.splice(0)) callback(); }, handler: (data: Record<string, unknown>) => context.navigate({ type: 'agentviewer-html-navigate', index: 1, title: '新的初见', actor: 'agent', blockId: 'chapter5', requestId: 'request', ...data }), details, messages, scrolls, context, clears: () => selectionClears, sends: () => sends };
}

test('trusted HTML navigation opens closed details, clears old selection and reports after actual target geometry', () => {
  const fixture = navigationFixture(); fixture.handler({});
  assert.equal(fixture.details.open, true); assert.equal(fixture.clears(), 1); assert.equal(fixture.sends(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.scrolls)), [{ block: 'center', inline: 'nearest', behavior: 'instant' }]);
  assert.equal(fixture.context.readingActor, 'agent'); assert.equal(fixture.context.readingBlockId, 'chapter5');
  assert.equal(fixture.context.readingQuote, '新的初见');
});

test('HTML navigation rejects wrong message type, title and invalid index without fabricated completion', () => {
  const fixture = navigationFixture();
  fixture.handler({ type: 'untrusted-message' }); fixture.handler({ index: -1 }); fixture.handler({ index: 1.5 }); fixture.handler({ title: '旧标题' });
  assert.equal(fixture.scrolls.length, 0); assert.equal(fixture.details.open, false); assert.equal(fixture.clears(), 0); assert.equal(fixture.sends(), 0);
  assert.equal(fixture.messages.length, 1);
});

test('HTML navigation does not report completion when CSS leaves its heading outside the viewport', () => {
  const fixture = navigationFixture(); fixture.headings[2].getBoundingClientRect = () => ({ top: 900, bottom: 950, left: 20, right: 350 });
  fixture.handler({});
  assert.equal(fixture.sends(), 0); assert.equal(fixture.messages.length, 1);
});

test('HTML heading line breaks match the shared outline whitespace without merging distinct titles', () => {
  const fixture = navigationFixture();
  fixture.headings[2].childNodes = [{ nodeName: '#text', nodeType: 3, textContent: '新的' }, { nodeName: 'BR', nodeType: 1, textContent: '' }, { nodeName: '#text', nodeType: 3, textContent: '初见' }];
  fixture.handler({ title: '新的 初见' }); assert.equal(fixture.sends(), 1); assert.equal(fixture.context.readingQuote, '新的 初见');
  fixture.handler({ title: '新的初见' }); assert.equal(fixture.sends(), 1); assert.equal(fixture.messages.length, 1);
});

test('timer and scroll context remain human until the target passes its deferred geometry check', () => {
  const fixture = navigationFixture(true);
  fixture.context.readingActor = 'agent'; fixture.context.readingBlockId = 'old-heading'; fixture.context.readingQuote = '旧位置';
  fixture.handler({}); fixture.context.send(); fixture.context.send();
  assert.deepEqual(fixture.observations.map(item => [item.actor, item.blockId, item.requestId]), [['human', undefined, undefined], ['human', undefined, undefined]]);
  fixture.flushFrames();
  assert.deepEqual(fixture.observations.at(-1), { actor: 'agent', blockId: 'chapter5', quote: '新的初见', requestId: 'request' });
});

test('hidden, zero-size and transparent targets clear agent metadata and subsequent passive context', () => {
  const hide = [
    (node: ReturnType<typeof navigationFixture>['headings'][number]) => { node.style.display = 'none'; },
    (node: ReturnType<typeof navigationFixture>['headings'][number]) => { node.style.visibility = 'hidden'; },
    (node: ReturnType<typeof navigationFixture>['headings'][number]) => { node.style.visibility = 'collapse'; },
    (node: ReturnType<typeof navigationFixture>['headings'][number]) => { node.style.opacity = '0'; },
    (node: ReturnType<typeof navigationFixture>['headings'][number]) => { node.checkVisibility = () => false; },
    (node: ReturnType<typeof navigationFixture>['headings'][number]) => { node.getBoundingClientRect = () => ({ top: 25, bottom: 25, left: 20, right: 350 }); },
    (node: ReturnType<typeof navigationFixture>['headings'][number]) => { node.getBoundingClientRect = () => ({ top: 25, bottom: 75, left: 20, right: 20 }); },
  ];
  for (const apply of hide) {
    const fixture = navigationFixture(true); fixture.handler({}); apply(fixture.headings[2]); fixture.context.send(); fixture.flushFrames();
    assert.equal(fixture.messages.length, 1); assert.equal(fixture.observations.some(item => item.requestId === 'request'), false);
    fixture.context.send(); fixture.context.send();
    assert.ok(fixture.observations.every(item => item.actor === 'human' && item.blockId === undefined && item.quote === undefined));
  }
});

test('a superseded deferred target cannot restore an old agent location after the newer navigation fails', () => {
  const fixture = navigationFixture(true); fixture.handler({ requestId: 'old-request' }); fixture.handler({ requestId: 'new-request', title: '旧标题' });
  fixture.flushFrames(); fixture.context.send();
  assert.equal(fixture.messages.length, 1); assert.equal(fixture.observations.length, 1);
  assert.equal(fixture.observations[0].actor, 'human'); assert.equal(fixture.observations[0].blockId, undefined);
});
