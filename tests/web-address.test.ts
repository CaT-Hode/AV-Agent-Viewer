import assert from 'node:assert/strict';
import test from 'node:test';
import { documentSuffixes, normalizeWebAddress } from '../packages/contracts/src/web-address';

test('navigation accepts scheme-free domains, www and complete path/query/fragment', () => {
  for (const [input, expected] of [['example.com', 'https://example.com/'], ['www.example.com', 'https://www.example.com/'], ['example.com:8443/a/b?q=one#section', 'https://example.com:8443/a/b?q=one#section'], ['example.unknownsuffix/read', 'https://example.unknownsuffix/read'], ['example.x', 'https://example.x/'], ['//example.org/a?b=c#d', 'https://example.org/a?b=c#d'], ['  Example.COM.  ', 'https://example.com./']]) assert.equal(normalizeWebAddress(input), expected, input);
});

test('explicit HTTP(S) preserves its protocol and canonicalizes case, default ports and IDNs', () => {
  for (const [input, expected] of [['HTTP://Example.COM:80/a', 'http://example.com/a'], ['HTTPS://Example.COM:443/a', 'https://example.com/a'], ['https://localhost:3210', 'https://localhost:3210/'], ['http://internal-server:9000', 'http://internal-server:9000/'], ['例子.测试/文档', 'https://xn--fsqu00a.xn--0zwm56d/%E6%96%87%E6%A1%A3'], ['https://例子.测试/', 'https://xn--fsqu00a.xn--0zwm56d/']]) assert.equal(normalizeWebAddress(input), expected, input);
});

test('local names, complete IPv4 and IPv6 infer HTTP independently of public DNS policy', () => {
  for (const [input, expected] of [['localhost:3210/a?x=1#part', 'http://localhost:3210/a?x=1#part'], ['demo.localhost:9000', 'http://demo.localhost:9000/'], ['reader.local', 'http://reader.local/'], ['127.0.0.1:3210', 'http://127.0.0.1:3210/'], ['192.168.1.2/a', 'http://192.168.1.2/a'], ['8.8.8.8', 'http://8.8.8.8/'], ['[::1]:3210/a', 'http://[::1]:3210/a'], ['::1', 'http://[::1]/'], ['2001:db8::1/a?q=x#f', 'http://[2001:db8::1]/a?q=x#f']]) {
    assert.equal(normalizeWebAddress(input), expected, input); assert.equal(normalizeWebAddress(input, 'omnibox'), expected, input);
  }
});

test('omnibox preserves document filenames and unknown suffixes as searches while navigation uses explicit intent', () => {
  for (const input of ['report.md', 'report.pdf', 'report.docx', 'deck.pptx', 'book.xlsx', 'notes.txt', 'project.unknownsuffix']) { assert.equal(normalizeWebAddress(input, 'omnibox'), undefined, input); assert.ok(normalizeWebAddress(input), input); }
  assert.equal(normalizeWebAddress('www.example.unknownsuffix', 'omnibox'), 'https://www.example.unknownsuffix/');
  assert.equal(normalizeWebAddress('www.example.md', 'omnibox'), 'https://www.example.md/', 'www is an explicit domain cue');
  assert.equal(normalizeWebAddress('example.com/docs/readme.md', 'omnibox'), 'https://example.com/docs/readme.md');
  assert.equal(normalizeWebAddress('https://example.unknownsuffix', 'omnibox'), 'https://example.unknownsuffix/');
  assert.equal(normalizeWebAddress('例子.测试', 'omnibox'), undefined); assert.equal(normalizeWebAddress('例子.中国', 'omnibox'), 'https://xn--fsqu00a.xn--fiqs8s/');
  assert.ok(documentSuffixes.has('md') && documentSuffixes.has('pdf') && documentSuffixes.has('docx'));
});

test('every mode rejects other protocols, credentials, control characters, backslashes and internal whitespace', () => {
  const invalid = ['javascript:alert(1)', 'javascript://example.com', 'data:text/html,<script>1</script>', 'file:///C:/report.md', 'ftp://example.com', 'mailto:reader@example.com', 'chrome://settings', 'custom://example.com', 'https://user:password@example.com', 'https://@example.com', 'reader@example.com', 'example.com\\path', 'https://example.com/a b', 'example.com related documents', '\thttps://example.com', 'https://example.com\n', 'https://example.com/\u0000', 'https://example.com/\u0090'];
  for (const input of invalid) for (const mode of ['navigation', 'omnibox'] as const) assert.equal(normalizeWebAddress(input, mode), undefined, input);
});

test('local paths are not converted into remote URLs in either mode', () => {
  for (const input of ['C:\\Documents\\report.md', 'D:/Documents/report.pdf', '\\\\server\\share\\file.docx', '/tmp/notes.md', './notes.md', '../notes.md', '~/notes.md', 'folder/notes.md', 'folder\\notes.md']) for (const mode of ['navigation', 'omnibox'] as const) assert.equal(normalizeWebAddress(input, mode), undefined, input);
});

test('ports must be decimal URL ports in range and cannot be absent after a colon', () => {
  assert.equal(normalizeWebAddress('example.com:65535'), 'https://example.com:65535/');
  assert.equal(normalizeWebAddress('example.com:000443'), 'https://example.com/', 'leading zeroes do not change a valid decimal port');
  assert.equal(normalizeWebAddress('localhost:0'), 'http://localhost:0/');
  for (const input of ['example.com:65536', 'example.com:-1', 'example.com:port', 'example.com:', 'example.com:999999999999999', '[::1]:65536', '[::1]:', 'https://example.com:65536', 'https://example.com:', 'https://[::1]:abc']) assert.equal(normalizeWebAddress(input), undefined, input);
});

test('short, hexadecimal and octal numeric hosts are rejected even inside explicit HTTP URLs', () => {
  for (const host of ['127.1', '127.0.1', '2130706433', '0x7f000001', '0x7f.0.0.1', '0177.0.0.1', '127.000.0.1', '256.0.0.1', '999.1.1.1']) for (const input of [host, 'http://' + host, 'https://' + host + ':443/a']) assert.equal(normalizeWebAddress(input), undefined, input);
});

test('malformed authorities, labels and IPv6 never become surprising repaired addresses', () => {
  for (const input of ['', '   ', 'https:example.com', 'https:/example.com', 'https:///example.com', 'https:////example.com', '///example.com', 'http://', '//', 'http://::1', '[:::1]', '[::1]extra', 'example..com', '-example.com', 'example-.com', 'example_underscore.com', 'example.123', 'intranet', '.example.com']) assert.equal(normalizeWebAddress(input), undefined, input);
});

test('percent-escaped whitespace and legitimate URL delimiters remain encoded and unexecuted', () => {
  const input = 'example.com/a%20b?next=https%3A%2F%2Fother.example%2F#section';
  assert.equal(normalizeWebAddress(input), 'https://' + input); assert.equal(normalizeWebAddress(normalizeWebAddress(input)!), 'https://' + input, 'canonicalization is idempotent');
});
