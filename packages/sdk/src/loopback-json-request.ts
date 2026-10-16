import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

interface RequestOptions {
  /** Internal test seam; production requests use the whole 30-second deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One authenticated local POST. Never retry mutations or follow redirects. */
export function requestLoopbackJson(url: URL, token: string, body: string, options: RequestOptions = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(new TypeError('本地发现文件只能指向 HTTP(S) loopback。'));
  if (url.username || url.password) return Promise.reject(new TypeError('本地服务地址不支持 URL 凭据。'));
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError('Request timeout must be positive.'));
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, settled = false;
    const chunks: string[] = [];
    const cleanup = () => { clearTimeout(deadline); options.signal?.removeEventListener('abort', abort); };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); chunks.length = 0;
      response?.destroy(); request?.destroy(error instanceof Error ? error : undefined); reject(error);
    };
    const abort = () => fail(options.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    // A socket inactivity timeout alone would allow a slowly streamed response
    // to run forever. This deadline includes connection, headers and the body.
    const deadline = setTimeout(() => fail(new DOMException('The operation was aborted due to timeout.', 'TimeoutError')), timeoutMs);
    deadline.unref();
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, incoming => {
        response = incoming;
        incoming.on('error', fail);
        incoming.on('aborted', () => fail(new Error('Local service response ended before the complete body.')));
        incoming.on('close', () => { if (!incoming.complete) fail(new Error('Local service response closed before completion.')); });
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) { fail(new Error('本地服务拒绝重定向（HTTP ' + status + '）。')); return; }
        // Node's stream decoder preserves UTF-8 characters split between TCP
        // chunks. Keep fragments, then parse once after a complete response.
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => { if (!settled) chunks.push(chunk); });
        incoming.on('end', () => {
          if (settled) return;
          try {
            const text = chunks.join('');
            // Response.json() also accepts the optional UTF-8 BOM.
            const data: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
            settled = true; cleanup(); chunks.length = 0;
            resolve({ ok: status >= 200 && status < 300, status, data });
          } catch (error) { fail(error); }
        });
      });
      request.on('error', fail);
      request.end(body);
    } catch (error) { fail(error); }
  });
}
