import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexDriver } from '../packages/harness-adapters/src/codex';
import { scopedReadingSnapshot } from '../packages/ai-reading-tools/src/index';
import type { ReadingSnapshot } from '../packages/contracts/src/index';

const source = (text: string): ReadingSnapshot => ({
  id: 'fixed-source', schemaVersion: '1.0', createdAt: new Date().toISOString(),
  document: { id: 'doc', title: 'Reading.md', format: 'markdown', revision: 0, diskRevision: 0, dirty: false, path: 'PRIVATE_PATH', warnings: [], model: { format: 'markdown', text: 'SECRET_FULL_DOCUMENT' }, capabilities: { engine: 'test', protocolVersion: '1.0', readText: true, readSelection: true, readViewport: true, editKinds: ['text.replace'], saveFormats: ['markdown'], limitations: [] } },
  context: { documentId: 'doc', viewId: 'view', contentRevision: 0, viewRevision: 0, capturedAt: new Date().toISOString(), quality: 'confirmed', actor: 'human', locator: { kind: 'text', quote: 'SECRET_QUOTE' }, visibleText: 'VISIBLE_OTHER', selection: { kind: 'text', text } },
});

// An actual spawned app-server protocol peer, with no model, credentials or UI.
async function probe(snapshot: ReadingSnapshot) {
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-codex-reading-'));
  await mkdir(join(directory, 'dist/mcp'), { recursive: true }); await writeFile(join(directory, 'dist/mcp/index.mjs'), '// fake bridge');
  await writeFile(join(directory, 'app-server'), `
const fs = require('node:fs');
const input = require('node:readline').createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') reply(request.id, {});
  if (request.method === 'thread/start') { global.start = request.params; reply(request.id, { thread: { id: 'thread' } }); }
  if (request.method === 'turn/start') {
    fs.writeFileSync('probe.json', JSON.stringify({ args: process.argv.slice(2), start: global.start, turn: request.params }));
    reply(request.id, { turn: { id: 'turn' } });
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'OK' } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }) + '\\n');
  }
});
`);
  let answer = ''; await new CodexDriver(process.execPath, directory).submit('Analyze only this source.', snapshot, delta => { answer += delta; }, new AbortController().signal);
  assert.equal(answer, 'OK');
  return JSON.parse(await readFile(join(directory, 'probe.json'), 'utf8')) as { args: string[]; start: { sandbox: string }; turn: { input: { text: string }[] } };
}

test('scoped Codex source does not inject the full workspace MCP or an expansion hint', async () => {
  const result = await probe(scopedReadingSnapshot(source('ONLY_SELECTION'), 'selection'));
  assert.deepEqual(result.args, []); assert.equal(result.start.sandbox, 'read-only');
  const text = result.turn.input[0].text; assert.ok(text.includes('ONLY_SELECTION'));
  for (const secret of ['SECRET_FULL_DOCUMENT', 'SECRET_QUOTE', 'VISIBLE_OTHER', 'PRIVATE_PATH', 'contentTruncated', 'document_read']) assert.equal(text.includes(secret), false, secret);
});
test('a large valid reading source is serialized once without broadening to a full snapshot', async () => {
  const passage = 'ONLY_SELECTION_'.repeat(2100), result = await probe(scopedReadingSnapshot(source(passage), 'selection'));
  const text = result.turn.input[0].text; assert.ok(text.includes(passage)); assert.equal(text.split(passage).length, 2);
  assert.equal(text.includes('contentTruncated'), false); assert.deepEqual(result.args, []);
});
test('ordinary explicit harness sessions retain their existing MCP integration', async () => {
  const result = await probe(source('SELECTION'));
  assert.ok(result.args.some(value => value.includes('mcp_servers.agent_viewer.command')));
});
