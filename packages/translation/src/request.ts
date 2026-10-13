import { ViewerError } from '../../contracts/src/index';

export function assertTranslationActive(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof ViewerError ? signal.reason : new ViewerError('CANCELLED', '翻译请求已取消。');
}

/** Abort is enforced even for a harness which resolves late or ignores its signal. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); try { assertTranslationActive(signal); } catch (error) { reject(error); } };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); if (signal.aborted) abort(); else resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

export function translationLanguage(input: string): string {
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(input) || input.length > 80) throw new ViewerError('INVALID_ARGUMENT', '请输入有效的目标语言标签。');
  try { return Intl.getCanonicalLocales(input)[0]; }
  catch { throw new ViewerError('INVALID_ARGUMENT', '请输入有效的目标语言标签。'); }
}
