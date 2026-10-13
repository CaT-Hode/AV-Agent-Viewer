import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel as NodeMessageChannel, type MessagePort as NodeMessagePort } from 'node:worker_threads';
import { runInNewContext } from 'node:vm';
import { createHtmlReadingChannel, htmlReadingChannelScript } from '../apps/desktop/src/renderer/lib/html-reading-channel';

const asPort = (port: NodeMessagePort) => port as unknown as MessagePort;
const source = {} as Window;
const handshake = (port: NodeMessagePort, token = 'trusted-nonce', owner: MessageEventSource | null = source, type = 'agentviewer-html-channel') => ({ data: { type, token }, ports: [asPort(port)], source: owner } as unknown as MessageEvent);
async function until(check: () => boolean) {
  const end = Date.now() + 1500;
  while (!check()) { if (Date.now() > end) throw new Error('MessagePort did not deliver the expected message'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('only nonce/source authenticated handshakes can establish a port; window context and commands never authenticate', t => {
  const delivered: unknown[] = [], accepted: NodeMessageChannel[] = [];
  const channel = createHtmlReadingChannel({ token: 'trusted-nonce', source: () => source, onMessage: message => delivered.push(message) });
  t.after(() => { channel.close(); accepted.forEach(pair => { pair.port1.close(); pair.port2.close(); }); });
  for (const [token, owner, type] of [
    ['wrong-nonce', source, 'agentviewer-html-channel'],
    ['trusted-nonce', {} as Window, 'agentviewer-html-channel'],
    ['trusted-nonce', source, 'agentviewer-html-context'],
    ['trusted-nonce', source, 'agentviewer-html-navigate'],
  ] as const) {
    const pair = new NodeMessageChannel(); accepted.push(pair);
    assert.equal(channel.receiveHandshake(handshake(pair.port2, token, owner, type)), false);
    assert.equal(channel.post({ type: 'agentviewer-html-navigate', requestId: 'private-request' }), false);
  }
  const pair = new NodeMessageChannel(); accepted.push(pair);
  assert.equal(channel.receiveHandshake({ ...handshake(pair.port2), ports: [] } as unknown as MessageEvent), false);
  assert.equal(channel.receiveHandshake({ ...handshake(pair.port2), ports: [asPort(pair.port1), asPort(pair.port2)] } as unknown as MessageEvent), false);
  assert.equal(delivered.length, 0);
  const absent = createHtmlReadingChannel({ token: 'trusted-nonce', source: () => null, onMessage: message => delivered.push(message) });
  assert.equal(absent.receiveHandshake(handshake(pair.port2, 'trusted-nonce', null)), false); absent.close();
});

test('navigation and reading context travel on the established real port without token or WindowProxy traffic', async t => {
  const pair = new NodeMessageChannel(), received: Record<string, unknown>[] = [], context: Record<string, unknown>[] = [];
  pair.port1.on('message', message => received.push(message));
  const channel = createHtmlReadingChannel({ token: 'trusted-nonce', source: () => source, onMessage: message => context.push(message) });
  t.after(() => { channel.close(); pair.port1.close(); pair.port2.close(); });
  assert.equal(channel.receiveHandshake(handshake(pair.port2)), true);
  const command = { type: 'agentviewer-html-navigate', requestId: 'request', blockId: 'chapter5', index: 2, title: '新的初见' };
  assert.equal(channel.post(command), true);
  await until(() => received.length === 2);
  assert.deepEqual(received, [{ type: 'agentviewer-html-channel-ready' }, command]);
  assert.equal(received.some(message => 'token' in message), false);
  pair.port1.postMessage({ type: 'agentviewer-html-context', text: '实际正文', actor: 'agent', requestId: 'request' });
  await until(() => context.length === 1);
  assert.equal(context[0].text, '实际正文');
  pair.port1.postMessage({ type: 'unrecognized-context', text: '错误来源' });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(context.length, 1);
});

test('reset, replacement, disconnect and disposal invalidate queued callbacks from old ports', async t => {
  const pairs = Array.from({ length: 3 }, () => new NodeMessageChannel()), contexts: unknown[] = [];
  let disconnected = 0;
  const channel = createHtmlReadingChannel({ token: 'trusted-nonce', source: () => source, onMessage: message => contexts.push(message), onDisconnect: () => disconnected++ });
  t.after(() => { channel.close(); pairs.forEach(pair => { pair.port1.close(); pair.port2.close(); }); });
  channel.receiveHandshake(handshake(pairs[0].port2));
  const stale = asPort(pairs[0].port2).onmessage!;
  channel.reset(); stale.call(asPort(pairs[0].port2), { data: { type: 'agentviewer-html-context', actor: 'agent', requestId: 'old' } } as MessageEvent);
  assert.deepEqual(contexts, []); assert.equal(channel.post({ type: 'agentviewer-html-navigate' }), false);
  assert.equal(channel.receiveHandshake(handshake(pairs[1].port2)), true);
  const replaced = asPort(pairs[1].port2).onmessage!;
  assert.equal(channel.receiveHandshake(handshake(pairs[2].port2)), true);
  replaced.call(asPort(pairs[1].port2), { data: { type: 'agentviewer-html-context', actor: 'agent', requestId: 'replaced' } } as MessageEvent);
  assert.deepEqual(contexts, []);
  pairs[2].port1.postMessage({ type: 'agentviewer-html-channel-close' });
  await until(() => disconnected === 1);
  assert.equal(channel.post({ type: 'agentviewer-html-navigate' }), false);
  assert.equal(channel.receiveHandshake(handshake(pairs[2].port2)), true);
  const disposed = asPort(pairs[2].port2).onmessage!; channel.close();
  disposed.call(asPort(pairs[2].port2), { data: { type: 'agentviewer-html-context', actor: 'agent', requestId: 'disposed' } } as MessageEvent);
  assert.deepEqual(contexts, []); assert.equal(channel.receiveHandshake(handshake(pairs[0].port2)), false);
});

test('injected bootstrap transfers its own port, accepts navigation there only, and closes on pagehide', async t => {
  const listeners = new Map<string, (event: any) => void>(), windowMessages: Record<string, unknown>[] = [], navigations: unknown[] = [], contexts: unknown[] = [];
  const pairs: NodeMessageChannel[] = [], timers = new Set<ReturnType<typeof setTimeout>>();
  let bridge: ReturnType<typeof createHtmlReadingChannel>;
  const parent = { postMessage: (data: Record<string, unknown>, origin: string, transfer: NodeMessagePort[]) => {
    assert.equal(origin, '*'); windowMessages.push(data);
    const payload = structuredClone({ data, ports: transfer }, { transfer });
    bridge.receiveHandshake({ data: payload.data, ports: payload.ports.map(asPort), source } as unknown as MessageEvent);
  } };
  const scope = { parent, MessageChannel: class extends NodeMessageChannel { constructor() { super(); pairs.push(this); } }, addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener), setTimeout: (callback: () => void, milliseconds: number) => { const timer = setTimeout(callback, milliseconds); timers.add(timer); return timer; }, clearTimeout, send: () => { scope.post({ type: 'agentviewer-html-context', text: '可信正文' }); }, navigateHtml: (request: unknown) => navigations.push(request), post: (_message: unknown) => false };
  bridge = createHtmlReadingChannel({ token: 'trusted-nonce', source: () => source, onMessage: message => contexts.push(message) });
  t.after(() => { bridge.close(); timers.forEach(clearTimeout); pairs.forEach(pair => { pair.port1.close(); pair.port2.close(); }); });
  runInNewContext(htmlReadingChannelScript('trusted-nonce') + '\nglobalThis.post=postReadingMessage;', scope);
  await until(() => contexts.length === 1);
  assert.equal(windowMessages.length, 1); assert.equal(windowMessages[0].type, 'agentviewer-html-channel');
  const command = { type: 'agentviewer-html-navigate', requestId: 'through-port' };
  listeners.get('message')!({ source: parent, data: command });
  listeners.get('message')!({ source: parent, data: { ...command, token: 'trusted-nonce' } });
  assert.deepEqual(navigations, [], 'even correct-looking window commands are ignored by the real injected script');
  bridge.post(command); await until(() => navigations.length === 1); assert.deepEqual(navigations, [command]);
  listeners.get('pagehide')!({}); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(bridge.post(command), false); assert.equal(scope.post({ type: 'agentviewer-html-context', text: '旧正文' }), false);
});

test('an initial missed handshake retries safely and later window rehandshake exposes no navigation request', async t => {
  const listeners = new Map<string, (event: any) => void>(), windows: Record<string, unknown>[] = [], contexts: unknown[] = [], timers = new Set<ReturnType<typeof setTimeout>>(), ports: NodeMessagePort[] = [];
  let bridge: ReturnType<typeof createHtmlReadingChannel>, attempts = 0;
  const parent = { postMessage: (data: Record<string, unknown>, _origin: string, transfer: NodeMessagePort[]) => {
    attempts++; windows.push(data);
    const payload = structuredClone({ data, ports: transfer }, { transfer }); ports.push(...payload.ports);
    if (attempts > 1) bridge.receiveHandshake({ data: payload.data, ports: payload.ports.map(asPort), source } as unknown as MessageEvent);
  } };
  const scope = { parent, MessageChannel: NodeMessageChannel, addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener), setTimeout: (callback: () => void, _milliseconds: number) => { const timer = setTimeout(callback, 10); timers.add(timer); return timer; }, clearTimeout, send: () => scope.post({ type: 'agentviewer-html-context', text: '握手重试正文' }), navigateHtml: () => {}, post: (_message: unknown) => false };
  bridge = createHtmlReadingChannel({ token: 'trusted-nonce', source: () => source, onMessage: message => contexts.push(message) });
  t.after(() => { listeners.get('pagehide')?.({}); bridge.close(); timers.forEach(clearTimeout); ports.forEach(port => port.close()); });
  runInNewContext(htmlReadingChannelScript('trusted-nonce') + '\nglobalThis.post=postReadingMessage;', scope);
  await until(() => contexts.length === 1); assert.equal(attempts, 2);
  bridge.reset(); assert.equal(bridge.post({ type: 'agentviewer-html-navigate', requestId: 'must-not-leak' }), false);
  listeners.get('message')!({ source: {}, data: { type: 'agentviewer-html-channel-request' } }); assert.equal(attempts, 2);
  listeners.get('message')!({ source: parent, data: { type: 'agentviewer-html-channel-request' } });
  await until(() => contexts.length === 2);
  assert.ok(windows.every(message => message.type === 'agentviewer-html-channel' && !('requestId' in message)));
});
