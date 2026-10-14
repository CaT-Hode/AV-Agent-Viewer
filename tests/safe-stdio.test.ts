import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { build } from 'esbuild';
import { guardStdioPipe } from '../apps/desktop/src/main/safe-stdio';

let fixture: Promise<string> | undefined;
function pipeFixture() {
  return fixture ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentviewer-stdio-'));
    const outfile = join(directory, 'stdio-fixture.cjs');
    await build({ stdin: { resolveDir: resolve('.'), contents: `
      import './apps/desktop/src/main/safe-stdio-init';
      import { guardStandardPipes } from './apps/desktop/src/main/safe-stdio';
      import { Console } from 'node:console';
      const guards = guardStandardPipes(), channel = process.argv[2], observed = [];
      if (channel === 'fatal') {
        process.stderr.emit('error', Object.assign(new Error('UNRELATED_STDIO_FAILURE'), { code: 'EIO' }));
      } else {
        const stream = process[channel], other = channel === 'stdout' ? process.stderr : process.stdout;
        const logger = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: false });
        const send = message => process.send(message);
        stream.on('error', error => observed.push(error.code));
        let timer;
        process.on('message', async message => {
          if (message === 'write') {
            const deadline = Date.now() + 4000;
            timer = setInterval(() => {
              (channel === 'stdout' ? logger.log : logger.error).call(logger, 'x'.repeat(16384));
              if (!guards[channel].broken) { if (Date.now() > deadline) throw new Error('REAL_PIPE_DID_NOT_BREAK'); return; }
              clearInterval(timer);
              setImmediate(async () => {
                // A real EPIPE is required, not simply a mocked successful write.
                assertObserved();
                let callbacks = 0;
                await Promise.all(Array.from({ length: 12 }, () => new Promise((done, fail) => {
                  stream.write('discard after EPIPE', error => error ? fail(error) : (callbacks++, done()));
                })));
                (channel === 'stdout' ? logger.log : logger.error).call(logger, 'console after disconnect');
                other.write('OTHER_CHANNEL_STILL_WORKS\\n');
                send({ type: 'alive', broken: guards[channel].broken, otherBroken: guards[channel === 'stdout' ? 'stderr' : 'stdout'].broken, observed, callbacks });
              });
            }, 5);
          } else if (message === 'ping') send({ type: 'pong' });
          else if (message === 'stop') { clearInterval(timer); process.disconnect(); }
        });
        function assertObserved() { if (!observed.includes('EPIPE')) throw new Error('MISSING_REAL_EPIPE'); }
        send({ type: 'ready' });
      }
    ` }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
    return outfile;
  })();
}

test('stdio guard preserves callbacks and encoding on healthy pipes and installs once', async () => {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  const state = guardStdioPipe(stream), guardedWrite = stream.write;
  assert.equal(guardStdioPipe(stream), state); assert.equal(stream.write, guardedWrite);
  await new Promise<void>((done, fail) => stream.write('正常日志', 'utf8', error => error ? fail(error) : done()));
  await new Promise<void>((done, fail) => stream.write(Buffer.from(' buffered'), error => error ? fail(error) : done()));
  assert.equal(text, '正常日志 buffered'); assert.equal(state.broken, false);
});

test('synchronous EPIPE closes only its logging channel while other errors still throw', async () => {
  const pipe = new Writable({ write(_chunk, _encoding, done) { done(); } });
  pipe.write = (() => { throw Object.assign(new Error('disconnected'), { code: 'EPIPE' }); }) as typeof pipe.write;
  const state = guardStdioPipe(pipe);
  await new Promise<void>((done, fail) => pipe.write('log', error => error ? fail(error) : done()));
  assert.equal(state.broken, true);
  const other = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const io = Object.assign(new Error('real I/O failure'), { code: 'EIO' });
  other.write = (() => { throw io; }) as typeof other.write;
  guardStdioPipe(other); assert.throws(() => other.write('log'), error => error === io);
});

for (const channel of ['stdout', 'stderr'] as const) test(`actual closed ${channel} pipe keeps process alive, acknowledges writes and remains controllable`, { timeout: 12000 }, async () => {
  const child = spawn(process.execPath, [await pipeFixture(), channel], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = once(child, 'exit'), messages: unknown[] = [], output: string[] = [];
  let waiter: ((value: any) => void) | undefined;
  child.on('message', value => { messages.push(value); waiter?.(value); });
  const next = (type: string) => new Promise<any>((done, fail) => {
    const found = messages.find(value => (value as any)?.type === type); if (found) { done(found); return; }
    const timer = setTimeout(() => { waiter = undefined; fail(new Error('No ' + type + ' message: ' + JSON.stringify(messages))); }, 6000);
    waiter = value => { if (value?.type === type) { clearTimeout(timer); waiter = undefined; done(value); } };
  });
  const active = channel === 'stdout' ? child.stderr : child.stdout;
  const detached = child[channel]; assert.ok(active); assert.ok(detached);
  active.on('data', chunk => output.push(String(chunk)));
  try {
    await next('ready');
    detached.destroy(); // Close the OS read endpoint, not a mocked write.
    child.send('write');
    const alive = await next('alive');
    assert.equal(alive.broken, true); assert.equal(alive.otherBroken, false);
    assert.ok(alive.observed.includes('EPIPE')); assert.equal(alive.callbacks, 12);
    assert.equal(child.exitCode, null); child.send('ping'); await next('pong');
    child.send('stop'); const [code, signal] = await closed;
    assert.equal(code, 0, output.join('')); assert.equal(signal, null);
    assert.match(output.join(''), /OTHER_CHANNEL_STILL_WORKS/);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test('unrelated real stdio error remains a reported process failure', { timeout: 12000 }, async () => {
  const child = spawn(process.execPath, [await pipeFixture(), 'fatal'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => output += String(chunk)); child.stderr.on('data', chunk => output += String(chunk));
  const [code, signal] = await once(child, 'exit');
  assert.notEqual(code, 0); assert.equal(signal, null); assert.match(output, /UNRELATED_STDIO_FAILURE/); assert.match(output, /EIO/);
});
