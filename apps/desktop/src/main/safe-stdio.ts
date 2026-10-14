import type { Writable } from 'node:stream';

export type StdioPipeGuard = { readonly broken: boolean };
type WriteCallback = (error?: Error | null) => void;
const installed = new WeakMap<Writable, StdioPipeGuard>();
const isBrokenPipe = (error: unknown): error is NodeJS.ErrnoException =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'EPIPE';

/** A detached launcher may close one logging pipe while the desktop is alive. */
export function guardStdioPipe(stream: Writable): StdioPipeGuard {
  const existing = installed.get(stream);
  if (existing) return existing;
  let broken = false;
  const state = { get broken() { return broken; } };
  const write = stream.write.bind(stream);

  stream.on('error', error => {
    if (isBrokenPipe(error)) { broken = true; return; }
    // Do not turn unrelated I/O failures into successful logging.
    throw error;
  });
  stream.write = function (chunk: unknown, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback) {
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (broken) { if (done) queueMicrotask(() => done()); return true; }
    let completed = false;
    const complete: WriteCallback = error => {
      if (completed) return;
      completed = true;
      if (isBrokenPipe(error)) { broken = true; done?.(); }
      else done?.(error);
    };
    try {
      return typeof encodingOrCallback === 'string'
        ? write(chunk, encodingOrCallback, complete)
        : write(chunk, complete);
    } catch (error) {
      if (!isBrokenPipe(error)) throw error;
      broken = true;
      queueMicrotask(() => complete());
      return true;
    }
  } as Writable['write'];
  installed.set(stream, state);
  return state;
}

export function guardStandardPipes() {
  return { stdout: guardStdioPipe(process.stdout), stderr: guardStdioPipe(process.stderr) };
}
