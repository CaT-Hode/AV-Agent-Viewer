import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHomeSearchCandidates, classifyHomeQuery, homeSearchResults, rankHomeSearchCandidates, type HomeSearchSources } from '../apps/desktop/src/renderer/lib/home-search';

test('explicit URLs remain http(s), normalize safely and reject credentials or browser protocol tricks', () => {
  assert.deepEqual(classifyHomeQuery(' HTTPS://Example.COM/docs?q=one#part '), { kind: 'url', text: 'HTTPS://Example.COM/docs?q=one#part', url: 'https://example.com/docs?q=one#part' });
  assert.equal(classifyHomeQuery('http://internal-server:9000').kind, 'url');
  for (const input of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///C:/report.md', 'ftp://example.com', 'custom://launch', 'https://user:password@example.com', 'https:\\example.com', 'https:example.com', 'https://example.com one', 'https://example.com\u0009@evil.com']) assert.equal(classifyHomeQuery(input).kind, 'invalid', input);
  assert.equal(classifyHomeQuery('https://example.pdf').kind, 'url', 'an explicit URL expresses navigation intent despite its suffix');
});

test('bare known domains, localhost, IPv4 and IPv6 have unambiguous URL output', () => {
  for (const [input, url] of [['example.com', 'https://example.com/'], ['example.com/docs/report.md', 'https://example.com/docs/report.md'], ['localhost:3210', 'http://localhost:3210/'], ['127.0.0.1:3210/fixture', 'http://127.0.0.1:3210/fixture'], ['[::1]:3210', 'http://[::1]:3210/'], ['::1', 'http://[::1]/'], ['2001:db8::1', 'http://[2001:db8::1]/'], ['//example.org/docs', 'https://example.org/docs'], ['例子.中国', 'https://xn--fsqu00a.xn--fiqs8s/']]) assert.equal((classifyHomeQuery(input) as { url?: string }).url, url, input);
});

test('filenames, unknown suffixes, email addresses and natural sentences are searches', () => {
  for (const input of ['report.md', 'REPORT.PDF', 'report.docx', 'deck.pptx', 'book.xlsx', 'notes.txt', 'notes.unknown', '127.1', '0x7f000001', 'user@example.com', 'example.com related documents', '阅读 example.org 的文档', 'TODO:fix', 'AI: reading notes', '[not-an-ip]']) assert.equal(classifyHomeQuery(input).kind, 'search', input);
  assert.equal(classifyHomeQuery('   ').kind, 'empty');
});

test('local paths retain their exact value without inventing a file:// navigation', () => {
  for (const input of ['C:\\Documents\\Report.MD', 'D:/资料/文档.pdf', '\\\\server\\share\\report.docx', './notes.md', '../notes.md', '/tmp/notes.md', 'folder\\notes.md', 'folder/notes.md']) assert.deepEqual(classifyHomeQuery(input), { kind: 'file', text: input, path: input });
  assert.deepEqual(classifyHomeQuery('"C:\\My Documents\\notes.md"'), { kind: 'file', text: '"C:\\My Documents\\notes.md"', path: 'C:\\My Documents\\notes.md' });
  assert.equal(classifyHomeQuery('C:\\notes.md\u0000').kind, 'invalid');
});

function sources(): HomeSearchSources {
  return {
    documents: [{ id: 'loaded', title: 'Project Report.md', format: 'markdown', path: 'D:\\Docs\\Project Report.md' }, { id: 'draft', title: '未保存计划.md', format: 'markdown' }, { id: 'other', title: 'Project Report.md', format: 'markdown', path: 'D:/Other/Project Report.md' }, { id: 'web', title: 'Project webpage', format: 'web' }],
    samples: [{ name: 'PROJECT REPORT.MD', format: 'markdown', path: 'd:/docs/./project report.md' }, { name: 'Example.pdf', format: 'pdf', path: 'D:/Samples/Example.pdf' }],
    artifacts: [{ id: 'translation', sourceTitle: 'Foreign Original', targetLanguage: 'zh-CN', path: 'D:/Docs/Project Report.md', format: 'markdown', documentId: 'loaded' }, { id: 'other-translation', sourceTitle: '原文计划', targetLanguage: 'en', path: 'D:/Translations/计划.en.docx', format: 'docx' }],
  };
}

test('the same library/sample/translation file deduplicates and preserves loaded-document identity', () => {
  const input = sources(), before = JSON.stringify(input), candidates = buildHomeSearchCandidates(input);
  assert.equal(candidates.length, 5);
  const loaded = candidates.find(candidate => candidate.documentId === 'loaded')!;
  assert.equal(loaded.source, 'document'); assert.equal(loaded.artifactId, 'translation'); assert.equal(loaded.title, 'Project Report.md');
  assert.deepEqual(loaded.sources, ['document', 'sample', 'translation']); assert.equal(loaded.path, 'D:\\Docs\\Project Report.md');
  assert.equal(candidates.filter(candidate => candidate.title === 'Project Report.md').length, 2, 'same filename in different directories remains two files');
  assert.equal(candidates.find(candidate => candidate.documentId === 'draft')?.path, undefined, 'unsaved drafts reopen by identity');
  assert.equal(JSON.stringify(input), before, 'building candidates does not mutate workspace or artifact records');
});

test('ranking uses case-insensitive title, filename and path terms without reading document bodies', () => {
  const candidates = buildHomeSearchCandidates(sources()), before = JSON.stringify(candidates);
  assert.equal(rankHomeSearchCandidates('PROJECT REPORT', candidates)[0].documentId, 'loaded');
  assert.equal(rankHomeSearchCandidates('other report', candidates)[0].documentId, 'other', 'all words may match different metadata fields');
  assert.equal(rankHomeSearchCandidates('d:\\docs\\project report.md', candidates)[0].documentId, 'loaded');
  assert.equal(rankHomeSearchCandidates('foreign zh-cn', candidates)[0].artifactId, 'translation', 'generated file aliases remain searchable after merging');
  assert.equal(rankHomeSearchCandidates('计划 en', candidates)[0].artifactId, 'other-translation');
  assert.equal(rankHomeSearchCandidates('unrelated private body', candidates).length, 0);
  assert.equal(JSON.stringify(candidates), before, 'ranking leaves input order and values intact');
});

test('exact title and filename matches precede loose path matches and ties remain deterministic', () => {
  const candidates = buildHomeSearchCandidates({ samples: [{ name: 'Target.pdf', format: 'pdf', path: 'D:/Files/Target.pdf' }, { name: 'Different.pdf', format: 'pdf', path: 'D:/Target/Different.pdf' }, { name: 'Target-extra.pdf', format: 'pdf', path: 'D:/Files/Target-extra.pdf' }] });
  assert.deepEqual(rankHomeSearchCandidates('target', candidates).map(candidate => candidate.title), ['Target.pdf', 'Target-extra.pdf', 'Different.pdf']);
  assert.equal(rankHomeSearchCandidates('TARGET.PDF', candidates)[0].title, 'Target.pdf');
  assert.equal(rankHomeSearchCandidates('', candidates, 1).length, 1); assert.equal(rankHomeSearchCandidates('', candidates, 0).length, 0);
  assert.equal(homeSearchResults('example', sources())[0].source, 'sample');
});

test('candidate scope excludes live webpages and protocol-bearing paths instead of expanding the search', () => {
  const candidates = buildHomeSearchCandidates({ documents: [{ id: 'web', title: 'Site', format: 'web' }, { id: 'bad', title: 'Bad.md', format: 'markdown', path: 'javascript:alert(1)' }], samples: [{ name: 'Remote.md', format: 'markdown', path: 'https://example.com/remote.md' }], artifacts: [{ id: 'bad-artifact', sourceTitle: 'Bad', targetLanguage: 'en', format: 'markdown', path: 'file:///private.md' }] });
  assert.deepEqual(candidates, []);
});

test('matching documentId and path aliases can join two existing candidates without losing a draft', () => {
  const candidates = buildHomeSearchCandidates({ documents: [{ id: 'draft', title: 'Draft.md', format: 'markdown' }], samples: [{ name: 'Generated.md', format: 'markdown', path: 'D:/Generated.md' }], artifacts: [{ id: 'generated', sourceTitle: 'Source', targetLanguage: 'en', format: 'markdown', path: 'D:/Generated.md', documentId: 'draft' }] });
  assert.equal(candidates.length, 1); assert.equal(candidates[0].documentId, 'draft'); assert.equal(candidates[0].artifactId, 'generated'); assert.equal(candidates[0].path, 'D:/Generated.md');
});

test('a saved-as document does not swallow the original generated file or provide its stale open target', () => {
  const candidates = buildHomeSearchCandidates({ documents: [{ id: 'translated', title: 'Edited copy.md', format: 'markdown', path: 'D:/Edited copy.md' }], artifacts: [{ id: 'original-artifact', sourceTitle: 'Source', targetLanguage: 'en', format: 'markdown', path: 'D:/Generated.md', documentId: 'translated' }, { id: 'unloaded-artifact', sourceTitle: 'Other source', targetLanguage: 'en', format: 'markdown', path: 'D:/Other generated.md', documentId: 'no-longer-in-library' }] });
  assert.equal(candidates.length, 3);
  assert.equal(candidates.find(candidate => candidate.artifactId === 'original-artifact')?.documentId, undefined);
  assert.equal(candidates.find(candidate => candidate.artifactId === 'original-artifact')?.path, 'D:/Generated.md');
  assert.equal(candidates.find(candidate => candidate.artifactId === 'unloaded-artifact')?.documentId, undefined);
  assert.equal(candidates.find(candidate => candidate.documentId === 'translated')?.path, 'D:/Edited copy.md');
});
