import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { ViewerCore } from '../../../../packages/document-core/src/index';
import { ViewerError } from '../../../../packages/contracts/src/index';
import { markdownResourcePath } from '../../../../packages/markdown/src/resources';

protocol.registerSchemesAsPrivileged([{ scheme: 'agentviewer-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const types: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.flac': 'audio/flac' };

/** Capabilities contain no filesystem paths. Recheck confinement on every read,
 * including byte-range seeks; never buffer an entire video in an IPC message. */
export class MarkdownMediaHost {
  private entries = new Map<string, { documentId: string; source: string; expires: number }>();
  private active(documentId: string) { return [...this.core.views.values()].some(view=>view.documentId===documentId); }
  constructor(private core: ViewerCore) { protocol.handle('agentviewer-media', request => this.read(request)); }
  async resolve(documentId: string, source: string) {
    if (/^https?:\/\//i.test(source)) return { url: source };
    if (/^file:/i.test(source)) { try { source=encodeURIComponent(fileURLToPath(source)); } catch { throw new ViewerError('INVALID_MARKDOWN_RESOURCE','媒体文件地址无效。'); } }
    if (!source || source.includes('\0') || /^[a-z][\w+.-]*:/i.test(source)&&!/^[a-z]:[\\/]/i.test(source)) throw new ViewerError('INVALID_MARKDOWN_RESOURCE', '媒体需要使用已授权文档资源目录中的路径。');
    const target = await markdownResourcePath(this.core, documentId, source);
    if (!types[extname(target).toLowerCase()] || !(await stat(target)).isFile()) throw new ViewerError('INVALID_MARKDOWN_RESOURCE', '不支持此音视频文件。');
    const now = Date.now();
    for (const [key, entry] of this.entries) { if (entry.expires < now&&!this.active(entry.documentId) || !this.core.documents.has(entry.documentId)) this.entries.delete(key); else if (entry.documentId === documentId && entry.source === source) { entry.expires = now + 3600000; return { url: 'agentviewer-media://local/' + key }; } }
    while (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    const token = randomUUID(); this.entries.set(token, { documentId, source, expires: now + 3600000 });
    return { url: 'agentviewer-media://local/' + token };
  }
  private async read(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), entry = url.host === 'local' ? this.entries.get(url.pathname.slice(1)) : undefined;
      if (!entry || entry.expires < Date.now()&&!this.active(entry.documentId) || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
      entry.expires=Date.now()+3600000;
      const target = await markdownResourcePath(this.core, entry.documentId, entry.source), info = await stat(target), type = types[extname(target).toLowerCase()];
      if (!type || !info.isFile() || info.size > 2 * 1024 * 1024 * 1024) return new Response(null, { status: 413 });
      // Reject mislabeled executable/HTML payloads without loading the media.
      const file = await open(target, 'r'); let head: Buffer;
      try { head = Buffer.alloc(32); await file.read(head, 0, head.length, 0); } finally { await file.close(); }
      const ascii = head.toString('latin1');
      if (!(/^(?:RIFF|OggS|fLaC|ID3)/.test(ascii) || head[0] === 0xff && (head[1] & 0xe0) === 0xe0 || ascii.slice(4, 8) === 'ftyp' || head.readUInt32BE(0) === 0x1a45dfa3)) return new Response(null, { status: 415 });
      let start = 0, end = info.size - 1; const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || !match[1] && !match[2]) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + info.size } });
        if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + info.size } });
      }
      const headers: Record<string, string> = { 'Content-Type': type, 'Content-Length': String(Math.max(0, end - start + 1)), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      const stream = request.method === 'HEAD' || info.size === 0 ? null : Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(stream, { status: range ? 206 : 200, headers });
    } catch { return new Response(null, { status: 404 }); }
  }
}
