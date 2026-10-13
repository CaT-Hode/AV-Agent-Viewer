import test from 'node:test';
import assert from 'node:assert/strict';
import { watch, existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BabelDocAdapter } from '../packages/translation/src/babeldoc';
import type { EngineLaunch } from '../packages/engines/src/index';

const input = new TextEncoder().encode('%PDF' + ' '.repeat(124));
function fakeLaunch(marker: string, mode: 'complete' | 'bridge' = 'complete'): EngineLaunch {
  const prefix = `const fs=require('node:fs'),path=require('node:path');const arg=name=>process.argv[process.argv.indexOf(name)+1];fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));`;
  const complete = `const out=arg('--output');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'source.mono.pdf'),Buffer.from('%PDF'+' '.repeat(124)));`;
  const bridge = `const http=require('node:http');const request=http.request(arg('--openai-base-url')+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+arg('--openai-api-key'),'Content-Type':'application/json'}},r=>r.resume());request.on('error',()=>{});request.end(JSON.stringify({messages:[{role:'user',content:'test'}]}));setTimeout(()=>process.exit(0),3000);`;
  return { command: process.execPath, argsPrefix: ['-e', prefix + (mode === 'complete' ? complete : bridge), '--'], source: 'override' };
}
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'agentviewer-babeldoc-cancel-')); return { directory, marker: join(directory, 'engine-started') }; }

test('BabelDOC pre-cancelled request starts neither preparation nor engine', async () => {
  const { directory, marker } = await fixture(), controller = new AbortController(); controller.abort();
  const adapter = new BabelDocAdapter(directory, async () => 'unused', fakeLaunch(marker));
  await assert.rejects(adapter.translate(input, 'en', controller.signal), { code: 'CANCELLED' });
  assert.deepEqual(await readdir(directory), []); assert.equal(existsSync(marker), false);
});

test('BabelDOC cancellation during actual filesystem preparation never launches the engine', async () => {
  const { directory, marker } = await fixture(), controller = new AbortController(); let observedPreparation = false;
  const watcher = watch(directory, (_event, filename) => { if (filename && /^[0-9a-f-]{36}$/i.test(filename.toString())) { observedPreparation = true; controller.abort(); } });
  const largeInput = new Uint8Array(8 * 1024 * 1024); largeInput.set(input);
  try {
    const adapter = new BabelDocAdapter(directory, async () => 'unused', fakeLaunch(marker));
    await assert.rejects(adapter.translate(largeInput, 'en', controller.signal), { code: 'CANCELLED' });
    assert.equal(observedPreparation, true); assert.equal(existsSync(marker), false);
  } finally { watcher.close(); }
});

test('BabelDOC running cancellation kills its engine and closes an in-flight bridge despite ignored model signal', async () => {
  const { directory, marker } = await fixture(), controller = new AbortController(); let modelEntered!: () => void;
  const entered = new Promise<void>(done => { modelEntered = done; });
  const adapter = new BabelDocAdapter(directory, async () => { modelEntered(); return new Promise<string>(() => {}); }, fakeLaunch(marker, 'bridge'));
  const pending = adapter.translate(input, 'en', controller.signal), rejected = assert.rejects(pending, { code: 'CANCELLED' });
  try {
    await Promise.race([entered, new Promise<never>((_done, fail) => { const timer = setTimeout(() => fail(new Error('fake engine never reached bridge')), 1500); timer.unref(); })]);
    const pid = Number(await readFile(marker, 'utf8')), cancelledAt = Date.now(); controller.abort(); await rejected;
    assert.ok(Date.now() - cancelledAt < 1500, 'bridge cleanup must not wait for the ignored model or natural engine exit');
    assert.throws(() => process.kill(pid, 0), 'the adapter must terminate its own fake engine');
  } finally { controller.abort(); }
});

test('BabelDOC normal engine completion still returns the independently generated PDF', async () => {
  const { directory, marker } = await fixture(), adapter = new BabelDocAdapter(directory, async () => 'unused', fakeLaunch(marker));
  const result = await adapter.translate(input, 'en', new AbortController().signal);
  assert.equal(existsSync(marker), true); assert.deepEqual(result.bytes, input); assert.ok(result.warnings.length > 0);
});
