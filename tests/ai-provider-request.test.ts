import test from 'node:test';
import assert from 'node:assert/strict';
import { requestProviderJson, assertCompleteProviderOutput } from '../packages/ai-providers/src/request';

test('provider request abort propagates and an ignored transport cannot return a late result', async () => {
  const controller = new AbortController(); let used!: AbortSignal, finish!: (response: Response) => void;
  const transport = (async (_url, options) => { used = options!.signal!; return new Promise<Response>(done => { finish = done; }); }) as typeof fetch;
  const pending = requestProviderJson('https://example.invalid', {}, controller.signal, 1000, transport), rejected = assert.rejects(pending, { code: 'CANCELLED' });
  controller.abort(); await rejected; assert.equal(used.aborted, true); finish(Response.json({ late: true }));
});

test('provider timeout also covers response-body reads and never calls a pre-cancelled request', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const transport = (async () => { calls++; return Response.json({ ok: true }); }) as typeof fetch;
  await assert.rejects(requestProviderJson('https://example.invalid', {}, controller.signal, 100, transport), { code: 'CANCELLED' }); assert.equal(calls, 0);
  const stalledBody = (async () => ({ ok: true, text: () => new Promise<string>(() => {}) })) as unknown as typeof fetch;
  await assert.rejects(requestProviderJson('https://example.invalid', {}, undefined, 10, stalledBody), { code: 'REQUEST_TIMEOUT' });
});

test('provider JSON, HTTP errors and non-JSON response remain distinct', async () => {
  assert.deepEqual(await requestProviderJson('https://example.invalid', {}, undefined, 100, (async () => Response.json({ value: 'answer' })) as typeof fetch), { value: 'answer' });
  await assert.rejects(requestProviderJson('https://example.invalid', {}, undefined, 100, (async () => new Response('denied', { status: 401 })) as typeof fetch), /401: denied/);
  await assert.rejects(requestProviderJson('https://example.invalid', {}, undefined, 100, (async () => new Response('<html>error</html>')) as typeof fetch), { code: 'PROVIDER_ERROR' });
});

test('all supported protocols reject truncated output instead of publishing an incomplete translation', () => {
  for (const [protocol, data] of [['chat-completions', { choices: [{ finish_reason: 'length' }] }], ['anthropic-messages', { stop_reason: 'max_tokens' }], ['openai-responses', { status: 'incomplete', output_text: 'partial' }]] as const) assert.throws(() => assertCompleteProviderOutput(data, protocol), { code: 'MODEL_OUTPUT_TRUNCATED' });
  for (const [protocol, data] of [['chat-completions', { choices: [{ finish_reason: 'stop' }] }], ['anthropic-messages', { stop_reason: 'end_turn' }], ['openai-responses', { status: 'completed' }]] as const) assert.doesNotThrow(() => assertCompleteProviderOutput(data, protocol));
});
