import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { ViewerCore } from '../../document-core/src/index';
import { ViewerError } from '../../contracts/src/index';
import { readMarkdownPreferences } from './preferences';
import { markdownLinks, replaceMarkdownLinks } from './links';

const imageLimit = 32 * 1024 * 1024;
const temporaryDocumentLimit = 256 * 1024 * 1024, temporaryWorkspaceLimit = 1024 * 1024 * 1024;
const temporaryWrites = new WeakMap<ViewerCore, Promise<unknown>>();
async function temporaryWrite<T>(core: ViewerCore, action: () => Promise<T>): Promise<T> { const previous = temporaryWrites.get(core) ?? Promise.resolve(), next = previous.catch(() => {}).then(action); temporaryWrites.set(core, next); try { return await next; } finally { if (temporaryWrites.get(core) === next) temporaryWrites.delete(core); } }
const fail = (message: string): never => { throw new ViewerError('INVALID_MARKDOWN_RESOURCE', message); };
function imageType(bytes: Uint8Array) {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'];
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return ['image/jpeg', 'jpg'];
  if (head.toString('ascii', 0, 2) === 'BM') return ['image/bmp', 'bmp'];
  if (/^GIF8[79]a/.test(head.toString('ascii'))) return ['image/gif', 'gif'];
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', 'webp'];
  if (head.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(head.toString('ascii', 8, 32))) return ['image/avif', 'avif'];
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head.toString('utf8').replace(/^\uFEFF/, ''))) {
    const source = Buffer.from(bytes).toString('utf8');
    if (/<(?:!DOCTYPE|script\b|foreignObject\b)|\bon\w+\s*=|javascript\s*:/i.test(source)) return fail('SVG 含可执行内容，请使用静态图片。');
    return ['image/svg+xml', 'svg'];
  }
  return fail('图片内容不是受支持的 PNG、JPEG、GIF、WebP、BMP、AVIF 或 SVG。');
}
export function imageDataUrl(bytes: Uint8Array) { if (bytes.byteLength > imageLimit) return fail('图片超过 32 MiB。'); const [mime] = imageType(bytes); return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`; }
function markdownDocument(core: ViewerCore, id: string) {
  const document = core.getDocument(id);
  if (document.info.format !== 'markdown') throw new ViewerError('INVALID_TARGET', '此操作仅适用于 Markdown 文档。');
  return document;
}
function temporaryAssetsRoot(core: ViewerCore) {
  const path = (core.repository as { path?: string }).path;
  if (!path) return fail('当前环境未提供持久图片缓存目录，请先保存文档。');
  return join(dirname(path), 'markdown-assets');
}
const assetPrefix = (documentId: string) => 'agentviewer-asset://' + encodeURIComponent(documentId) + '/';
const resourceReference = (root: string, target: string) => relative(root, target).split(sep).map(encodeURIComponent).join('/');
async function temporaryAssetPath(core: ViewerCore, documentId: string, source: string) {
  if (!source.startsWith(assetPrefix(documentId))) return fail('临时图片不属于当前文档。');
  let file: string; try { file = decodeURIComponent(source.slice(assetPrefix(documentId).length)); } catch { return fail('临时图片名称无效。'); }
  if (!file || file.includes('\0') || basename(file) !== file || /[\\/]/.test(file)) return fail('临时图片名称无效。');
  return confinedPath(join(temporaryAssetsRoot(core), encodeURIComponent(documentId)), file);
}
async function temporaryAssetBudget(core: ViewerCore, documentId: string, additional: number) {
  const root = temporaryAssetsRoot(core); await mkdir(root, { recursive: true });
  let total = 0, own = 0, count = 0, totalCount = 0;
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    for (const file of await readdir(join(root, directory.name), { withFileTypes: true })) {
      if (!file.isFile() || file.isSymbolicLink()) continue; if (++totalCount >= 8192) return fail('临时图片数量已达到限制，请先整理图片缓存。'); const size = (await stat(join(root, directory.name, file.name))).size; total += size;
      if (directory.name === encodeURIComponent(documentId)) { own += size; count++; }
    }
  }
  if (count >= 1024 || own + additional > temporaryDocumentLimit || total + additional > temporaryWorkspaceLimit) return fail('临时图片缓存已达到限制，请保存文档并整理图片后再粘贴。');
}
async function confinedPath(base: string, path: string) {
  const root = await realpath(base), target = await realpath(resolve(root, path));
  const local = relative(root, target);
  if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) fail('图片路径超出了文档资源目录。');
  return target;
}
async function createResourceDirectory(root: string, path: string) {
  let current = root;
  for (const part of path.split(/[\\/]/).filter(Boolean)) {
    const target = resolve(current, part), local = relative(root, target);
    if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) return fail('图片复制目录超出资源根目录。');
    try { await mkdir(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    current = await confinedPath(root, relative(root, target));
  }
  return current;
}
function frontmatterOption(source: string, name: string) {
  const body = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(source.slice(0, 16000))?.[1];
  return body ? new RegExp('^' + name + ':[ \\t]*["\']?([^\\r\\n"\']+)["\']?[ \\t]*$', 'm').exec(body)?.[1]?.trim() : undefined;
}
async function resourceLocation(core: ViewerCore, documentId: string, targetPath?: string, create = false) {
  const document = markdownDocument(core, documentId), path = targetPath ?? document.info.path;
  if (!path) return fail('相对路径图片需要先保存文档；粘贴的图片可直接嵌入。');
  const { preferences } = await readMarkdownPreferences(core, documentId), directory = resolve(dirname(path));
  const configured = preferences.imageRoot || frontmatterOption(document.info.model.text ?? '', 'typora-root-url') || '', base = resolve(directory, configured);
  let authorizedRoot: string;
  if (preferences.imageRoot) {
    if (create) await mkdir(base, { recursive: true });
    authorizedRoot = await realpath(base);
  } else {
    const extension = core.extensions.get('markdown-workspace-root'), workspace = extension && document.info.path ? await extension({ documentId }, 'human') as { rootPath?: string } : undefined;
    const workspaceRoot = workspace?.rootPath ? resolve(workspace.rootPath) : directory, within = relative(workspaceRoot, directory);
    authorizedRoot = !isAbsolute(within) && within !== '..' && !within.startsWith('..' + sep) ? workspaceRoot : directory;
    const local = relative(authorizedRoot, base);
    if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) return fail('资源根目录超出工作文件夹，请在图片偏好中确认根目录。');
    if (create && authorizedRoot === directory) await mkdir(directory, { recursive: true });
    authorizedRoot = await realpath(authorizedRoot);
    if (create) await createResourceDirectory(authorizedRoot, local);
  }
  const root = await confinedPath(authorizedRoot, relative(authorizedRoot, base));
  const copyTo = frontmatterOption(document.info.model.text ?? '', 'typora-copy-images-to')?.replaceAll('${filename}', basename(path, extname(path))) || 'assets';
  return { root, authorizedRoot, copyTo };
}
export async function markdownResourcePath(core: ViewerCore, documentId: string, source: string) {
  const document = markdownDocument(core, documentId);
  if (source.startsWith('agentviewer-asset:')) return temporaryAssetPath(core, documentId, source);
  if (!document.info.path) return fail('相对路径图片需要先保存文档；粘贴的图片可直接嵌入。');
  let path: string; try { path = decodeURIComponent(source.split(/[?#]/)[0]); } catch { return fail('图片路径编码无效。'); }
  const { root, authorizedRoot } = await resourceLocation(core, documentId);
  const target = resolve(root, path.replace(/^\//, '')); return confinedPath(authorizedRoot, relative(authorizedRoot, target));
}
export async function markdownResource(core: ViewerCore, documentId: string, source: string) {
  markdownDocument(core, documentId);
  if (!source || source.includes('\0')) return fail('图片路径为空或无效。');
  if (/^https?:\/\//i.test(source)) return { url: source };
  if (/^data:image\/(?:png|jpeg|gif|webp|bmp|avif|svg\+xml);base64,/i.test(source)) {
    if (source.length > imageLimit * 1.4) return fail('图片超过 32 MiB。');
    imageType(Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')); return { url: source };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source) && !source.startsWith('agentviewer-asset:')) return fail('不支持此图片地址协议。');
  const target = await markdownResourcePath(core, documentId, source);
  if ((await stat(target)).size > imageLimit) return fail('图片超过 32 MiB。');
  const bytes = await readFile(target), [mime] = imageType(bytes);
  return { url: `data:${mime};base64,${bytes.toString('base64')}` };
}
export async function importMarkdownImage(core: ViewerCore, input: { documentId: string; name: string; mimeType: string; bytes?: number[] | Uint8Array; dataUrl?: string }) {
  const document = markdownDocument(core, input.documentId);
  let bytes: Buffer;
  if (typeof input.dataUrl === 'string') {
    if (input.dataUrl.length > imageLimit * 1.4 || !/^data:image\/[a-z+.-]+;base64,[a-z\d+/=\r\n]+$/i.test(input.dataUrl)) return fail('图片数据无效或超过32MiB。');
    bytes = Buffer.from(input.dataUrl.slice(input.dataUrl.indexOf(',') + 1), 'base64');
  } else {
    if (!(input.bytes instanceof Uint8Array) && !Array.isArray(input.bytes) || !input.bytes || input.bytes.length === 0 || input.bytes.length > imageLimit || !(input.bytes instanceof Uint8Array) && input.bytes.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return fail('图片内容为空、过大或格式无效。');
    bytes = Buffer.from(input.bytes);
  }
  if (bytes.byteLength > imageLimit) return fail('图片超过32MiB。');
  const [mime, extension] = imageType(bytes);
  if (input.mimeType && input.mimeType !== mime && !(input.mimeType === 'image/jpg' && mime === 'image/jpeg')) return fail('图片类型与内容不一致。');
  if (!document.info.path) {
    return temporaryWrite(core, async () => {
      const title = basename(input.name || 'image', extname(input.name || '')).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 48) || 'image', file = title + '-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.' + extension;
      const directory = join(temporaryAssetsRoot(core), encodeURIComponent(input.documentId)); await mkdir(directory, { recursive: true });
      const target = join(directory, file); let existing: Buffer | undefined; try { existing = await readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existing && !existing.equals(bytes)) return fail('临时图片名称冲突。');
      if (!existing) { await temporaryAssetBudget(core, input.documentId, bytes.byteLength); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
      return { path: assetPrefix(input.documentId) + encodeURIComponent(file) };
    });
  }
  const { root, copyTo } = await resourceLocation(core, input.documentId, undefined, true);
  const assetDirectory = resolve(root, copyTo), local = relative(root, assetDirectory);
  if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) return fail('图片复制目录超出资源根目录。');
  const safeAssets = await createResourceDirectory(root, local);
  const title = basename(input.name || 'image', extname(input.name || '')).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 48) || 'image';
  const file = `${title}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${extension}`;
  try { await writeFile(resolve(safeAssets, file), bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!(await readFile(resolve(safeAssets, file))).equals(bytes)) return fail('目标图片已经存在且内容不同，请选择其他资源目录。'); }
  return { path: resourceReference(root, resolve(safeAssets, file)) };
}

/** Prepare portable source without changing the live document. Core adopts this
 * source only after its verified atomic file save succeeds. Original profile
 * assets remain readable for recovery and undo; existing user files are never
 * overwritten. */
export async function materializeMarkdownAssetsForSave(core: ViewerCore, documentId: string, targetPath: string): Promise<{ source: string; changed: boolean }> {
  const document = markdownDocument(core, documentId), source = document.info.model.text ?? '', target = resolve(targetPath), relocating = !!document.info.path && resolve(dirname(document.info.path)) !== dirname(target);
  if (!relocating && !source.includes('agentviewer-asset:')) return { source, changed: false };
  const links = markdownLinks(source).filter(link => link.image && (link.source.startsWith('agentviewer-asset:') || relocating && !/^(?:https?:|data:|#)/i.test(link.source)));
  if (!links.length) return { source, changed: false };
  const managedRoot = resolve(temporaryAssetsRoot(core)), inside = relative(managedRoot, target);
  if (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep)) return fail('请选择普通文档保存位置，不能写入临时图片目录。');
  const { root, copyTo } = await resourceLocation(core, documentId, target, true);
  const assetDirectory = await createResourceDirectory(await realpath(root), copyTo), copied = new Map<string, string>();
  for (const link of links) {
    if (copied.has(link.source)) continue; const original = await markdownResourcePath(core, documentId, link.source), bytes = await readFile(original); if (bytes.byteLength > imageLimit) return fail('图片超过32MiB。'); const [, extension] = imageType(bytes);
    const name = basename(original, extname(original)).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 48) || 'image', file = name + '-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.' + extension;
    const output = join(assetDirectory, file);
    try { await writeFile(output, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!(await readFile(output)).equals(bytes)) return fail('目标资源文件已存在且内容不同，请使用其他资源目录。'); }
    copied.set(link.source, resourceReference(root, output));
  }
  const next = replaceMarkdownLinks(source, links.map(link => ({ link, value: copied.get(link.source)! })));
  return { source: next, changed: next !== source };
}
export function resolveMarkdownLink(core: ViewerCore, documentId: string, href: string) {
  const document = markdownDocument(core, documentId);
  if (/^https?:\/\//i.test(href)) return { uri: href };
  if (href.startsWith('#')) return { anchor: decodeURIComponent(href.slice(1)) };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return fail('不支持此链接协议。');
  if (!document.info.path) return fail('请先保存文档，再打开相对路径链接。');
  const [path, anchor] = href.split('#');
  return { uri: resolve(dirname(document.info.path), decodeURIComponent(path)), anchor };
}
