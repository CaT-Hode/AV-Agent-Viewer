import { writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ViewerCore } from '../../document-core/src/index';
import { ViewerError } from '../../contracts/src/index';
import { readMarkdownPreferences } from './preferences';
import { markdownResource, importMarkdownImage, imageDataUrl, markdownResourcePath } from './resources';
import { markdownLinks, encodeMarkdownLink } from './links';

const imageLimit = 32 * 1024 * 1024, execute = promisify(execFile);
function resources(source: string) {
  return markdownLinks(source).filter(link => link.image);
}
async function localImagePath(core: ViewerCore, documentId: string, source: string) {
  return markdownResourcePath(core, documentId, source);
}
export async function listMarkdownResources(core: ViewerCore, documentId: string) {
  const document = core.getDocument(documentId).info;
  const unique = [...new Set(resources(document.model.text ?? '').map(entry => entry.source))], unresolved: string[] = [];
  const items = await Promise.all(unique.map(async source => {
    if (/^https?:\/\//i.test(source)) return { source, remote: true };
    if (source.startsWith('data:')) return { source, embedded: true, bytes: Math.floor((source.length - source.indexOf(',') - 1) * 3 / 4) };
    try { const path = await localImagePath(core, documentId, source); return { source, path, bytes: (await stat(path)).size }; }
    catch { unresolved.push(source); return { source }; }
  }));
  return { revision: document.revision, resources: items, unresolved };
}
async function downloadImage(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error('图片下载失败：' + response.status);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > imageLimit) throw new Error('图片超过32MiB。'); chunks.push(result.value); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, size);
}
export async function applyMarkdownResources(core: ViewerCore, input: { documentId: string; expectedRevision: number; action: string; sources: string[] }) {
  const document = core.getDocument(input.documentId).info, revision = document.revision, source = document.model.text ?? '';
  if (document.format !== 'markdown' || revision !== input.expectedRevision) throw new ViewerError('VERSION_CONFLICT', '资源列表已经过期，请重新读取。');
  if (!['copy-local', 'embed', 'upload'].includes(input.action) || !Array.isArray(input.sources) || input.sources.length > 1000) throw new ViewerError('INVALID_ARGUMENT', '资源操作无效。');
  const { preferences } = await readMarkdownPreferences(core, input.documentId), selected = new Set(input.sources), mapped = new Map<string, string>();
  for (const image of resources(source)) {
    if (!selected.has(image.source) || mapped.has(image.source)) continue;
    let data: Buffer;
    if (/^https?:\/\//i.test(image.source)) data = await downloadImage(image.source);
    else { const result = await markdownResource(core, input.documentId, image.source); data = Buffer.from(result.url.slice(result.url.indexOf(',') + 1), 'base64'); }
    const dataUrl = imageDataUrl(data);
    if (input.action === 'copy-local') mapped.set(image.source, (await importMarkdownImage(core, { documentId: input.documentId, name: basename(image.source.split(/[?#]/)[0]).slice(0, 80) || 'image', mimeType: '', dataUrl })).path);
    else if (input.action === 'embed') mapped.set(image.source, dataUrl);
    else {
      if (!preferences.upload?.command) throw new ViewerError('ENGINE_UNAVAILABLE', '请先在 Markdown 偏好中配置图片上传命令。');
      const directory = await mkdtemp(join(tmpdir(), 'agentviewer-image-upload-'));
      try {
        const file = join(directory, 'image'); await writeFile(file, data);
        const args = preferences.upload.args.map(argument => argument.replaceAll('{file}', file).replaceAll('{filename}', basename(image.source)));
        const result = await execute(preferences.upload.command, args, { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
        const output = result.stdout.trim(); let url = output.split(/\r?\n/).find(line => /^https?:\/\//i.test(line));
        try { const parsed = JSON.parse(output); if (typeof parsed.url === 'string') url = parsed.url; } catch { /* Plain URL output is supported. */ }
      if (!url || !/^https?:\/\//i.test(url) || /[\u0000-\u001f\u007f]/.test(url)) throw new Error('上传命令需要输出图片的 HTTP(S) URL 或 {"url":"..."}。');
      const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('图片上传结果不是有效的 HTTP(S) URL。'); mapped.set(image.source, parsed.href);
      } finally { if (!resolve(directory).startsWith(resolve(tmpdir(), 'agentviewer-image-upload-'))) throw new Error('INVALID_TEMP_PATH'); await rm(directory, { recursive: true, force: true }); }
    }
  }
  const changes = resources(source).filter(image => mapped.has(image.source) && mapped.get(image.source) !== image.source);
  if (!changes.length) return { revision };
  const from = changes[0].from, to = changes.at(-1)!.to; let replacement = source.slice(from, to);
  for (const change of changes.slice().reverse()) replacement = replacement.slice(0, change.from - from) + encodeMarkdownLink(mapped.get(change.source)!, change) + replacement.slice(change.to - from);
  const patch = core.prepare(input.documentId, revision, { kind: 'text.replace', from, to, expectedText: source.slice(from, to), text: replacement });
  const receipt = await core.commit(patch.id, randomUUID(), 'human');
  return { revision: receipt.revision };
}
