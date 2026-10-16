import { BrowserWindow, dialog, type SaveDialogOptions } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import type { ViewerCore } from '../../../../packages/document-core/src/index';
import { ViewerError } from '../../../../packages/contracts/src/index';
import { readMarkdownPreferences } from '../../../../packages/markdown/src/preferences';
import { markdownLinks, replaceMarkdownLinks } from '../../../../packages/markdown/src/links';
import { imageDataUrl } from '../../../../packages/markdown/src/resources';

const execute = promisify(execFile);
const extensions: Record<string, string> = { html: 'html', pdf: 'pdf', png: 'png', docx: 'docx', odt: 'odt', rtf: 'rtf', epub: 'epub', latex: 'tex', markdown: 'md' };
let pandoc: Promise<boolean> | undefined;
export const markdownExportCapabilities = async () => ({ formats: Object.keys(extensions), pandoc: await (pandoc ??= execute('pandoc', ['--version'], { windowsHide: true, timeout: 10000 }).then(() => true, () => false)) });

export async function exportMarkdown(core: ViewerCore, owner: BrowserWindow, input: { documentId: string; expectedRevision: number; format: string; html?: string }) {
  const document = core.getDocument(input.documentId).info;
  if (document.format !== 'markdown' || document.revision !== input.expectedRevision) throw new ViewerError('VERSION_CONFLICT', '导出来源已变化，请重新导出。');
  const frozenRevision = document.revision, source = document.model.text ?? '';
  const extension = extensions[input.format]; if (!extension) throw new ViewerError('INVALID_ARGUMENT', '不支持此导出格式。');
  const conversion = !['html', 'pdf', 'png', 'markdown'].includes(input.format);
  if (conversion && !(await markdownExportCapabilities()).pandoc) throw new ViewerError('ENGINE_UNAVAILABLE', '此格式需要安装 Pandoc；HTML、PDF 和图片可以直接导出。');
  const options: SaveDialogOptions = { title: '导出 Markdown', defaultPath: join(document.path ? dirname(document.path) : '.', basename(document.title, extname(document.title)) + '.' + extension), filters: [{ name: extension.toUpperCase(), extensions: [extension] }] };
  const chosen = await dialog.showSaveDialog(owner, options); if (chosen.canceled || !chosen.filePath) return null;
  if (core.getDocument(input.documentId).info.revision !== frozenRevision) throw new ViewerError('VERSION_CONFLICT', '选择导出位置期间文档已变化，请重新导出。');
  const path = chosen.filePath;
  const { preferences } = await readMarkdownPreferences(core, document.id);
  if (input.format === 'markdown') { await writeFile(path, source, 'utf8'); return { paths: [path], revision: frozenRevision }; }
  if (conversion) {
    const directory = await mkdtemp(join(tmpdir(), 'agentviewer-pandoc-'));
    try {
      const from = join(directory, 'source.md'); await writeFile(from, source, 'utf8');
      const args = [from, '--from=markdown+tex_math_dollars+pipe_tables+task_lists+strikeout+yaml_metadata_block+footnotes', '--standalone', '--resource-path=' + (document.path ? dirname(document.path) : directory), '--to=' + input.format, '--output=' + path];
      if (preferences.export.templatePath) args.push('--template=' + preferences.export.templatePath);
      await execute('pandoc', args, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
      return { paths: [path], revision: frozenRevision };
    } finally { if (!directory.startsWith(join(tmpdir(), 'agentviewer-pandoc-'))) throw new Error('INVALID_TEMP_PATH'); await rm(directory, { recursive: true, force: true }); }
  }
  if (typeof input.html !== 'string' || input.html.length > 32 * 1024 * 1024) throw new ViewerError('INVALID_ARGUMENT', '导出页面内容为空或过大。');
  // No preload or local-service credential enters this isolated export page.
  const html = input.html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:; media-src data: https: http:"><style>${preferences.themeCss.replace(/<\/style/gi, '<\\/style')}</style>`);
  if (input.format === 'html') { await writeFile(path, html, 'utf8'); return { paths: [path], revision: frozenRevision }; }
  const window = new BrowserWindow({ show: false, width: 1100, height: 1200, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // Capture the document surface at its full content width; the window's
    // scroll controls are not part of the exported image. Apply before layout
    // measurement so removing the gutter cannot change pagination afterwards.
    if (input.format === 'png') await window.webContents.insertCSS('html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}', { cssOrigin: 'user' });
    await window.webContents.executeJavaScript('Promise.all([document.fonts.ready,...Array.from(document.images).map(i=>i.decode().catch(()=>{}))])');
    if (input.format === 'pdf') {
      await writeFile(path, await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4', generateDocumentOutline: true, generateTaggedPDF: true, displayHeaderFooter: !!(preferences.export.header || preferences.export.footer), headerTemplate: preferences.export.header || '<span></span>', footerTemplate: preferences.export.footer || '<span></span>' }));
      return { paths: [path], revision: frozenRevision };
    }
    const height = await window.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)') as number;
    const paths: string[] = [];
    // Chromium image dimensions are bounded. Tall documents become numbered
    // complete images rather than silently exporting only the visible editor.
    for (let offset = 0, index = 0; offset < height; offset += 1200, index++) {
      await window.webContents.executeJavaScript(`new Promise(r=>{window.scrollTo(0,${offset});requestAnimationFrame(()=>requestAnimationFrame(r))})`);
      const actualOffset = await window.webContents.executeJavaScript('window.scrollY') as number;
      const cropTop = Math.max(0, offset - actualOffset), remaining = Math.min(1200 - cropTop, height - offset);
      const image = await window.webContents.capturePage({ x: 0, y: cropTop, width: 1100, height: remaining });
      const output = height <= 1200 ? path : path.slice(0, path.length - extname(path).length) + '-' + String(index + 1).padStart(3, '0') + '.png';
      await writeFile(output, image.toPNG()); paths.push(output);
    }
    return { paths, revision: frozenRevision };
  } finally { window.destroy(); }
}

export async function importMarkdown(core: ViewerCore, owner: BrowserWindow, windowId: string) {
  if (!(await markdownExportCapabilities()).pandoc) throw new ViewerError('ENGINE_UNAVAILABLE', '导入 Word、EPUB 等格式需要安装 Pandoc。');
  const chosen = await dialog.showOpenDialog(owner, { title: '导入为 Markdown', properties: ['openFile'], filters: [{ name: '可转换文档', extensions: ['docx', 'odt', 'rtf', 'epub', 'html', 'htm', 'tex'] }] });
  if (chosen.canceled || !chosen.filePaths[0]) return null;
  const destination = await dialog.showSaveDialog(owner, { title: '保存导入后的 Markdown', defaultPath: join(dirname(chosen.filePaths[0]), basename(chosen.filePaths[0], extname(chosen.filePaths[0])) + '.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
  if (destination.canceled || !destination.filePath) return null;
  if (!/\.(?:md|markdown)$/i.test(destination.filePath)) throw new ViewerError('FORMAT_MISMATCH', '导入后的文档需要保存为 .md。');
  const target = resolve(destination.filePath), assetDirectory = join(dirname(target), basename(target, extname(target)) + '.assets-' + randomUUID().slice(0, 8)), temporary = target + '.agentviewer-import-' + randomUUID() + '.tmp';
  const openTarget = [...core.documents.values()].find(entry => entry.info.path && resolve(entry.info.path).toLowerCase() === target.toLowerCase());
  if (openTarget?.info.dirty) throw new ViewerError('UNSAVED_CHANGES', '导入目标仍有未保存编辑，请先保存或选择其他文件。');
  const openedRevision = openTarget?.info.revision;
  const diskHash = async () => { try { return createHash('sha256').update(await readFile(target)).digest('hex'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } };
  const originalHash = await diskHash();
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-import-'));
  let assetDirectoryCreated = false, committed = false;
  try {
    const output = join(directory, 'import.md'), extracted = join(directory, 'extracted');
    await execute('pandoc', [chosen.filePaths[0], '--to=markdown+pipe_tables+tex_math_dollars+yaml_metadata_block+footnotes', '--extract-media=' + extracted, '--wrap=none', '--output=' + output], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    const source = await readFile(output, 'utf8'), replacements: { link: ReturnType<typeof markdownLinks>[number]; value: string }[] = [], copied = new Map<string, string>();
    for (const link of markdownLinks(source).filter(link => link.image && !/^(?:https?:|data:|#)/i.test(link.source))) {
      let original: string;
      try { original = link.source.startsWith('file:') ? fileURLToPath(link.source) : isAbsolute(link.source) ? resolve(link.source) : resolve(directory, decodeURIComponent(link.source)); }
      catch { throw new ViewerError('INVALID_MARKDOWN_RESOURCE', '导入文档中的图片路径无效。'); }
      try { await stat(original); } catch { original = resolve(dirname(chosen.filePaths[0]), decodeURIComponent(link.source)); }
      if (!copied.has(original)) {
        if ((await stat(original)).size > 32 * 1024 * 1024) throw new ViewerError('INVALID_MARKDOWN_RESOURCE', '导入图片超过32MiB。');
        const bytes = await readFile(original); imageDataUrl(bytes);
        if (!assetDirectoryCreated) { await mkdir(dirname(target), { recursive: true }); await mkdir(assetDirectory); assetDirectoryCreated = true; }
        const file = basename(original, extname(original)).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 40) + '-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + extname(original).toLowerCase();
        const resourceTarget = join(assetDirectory, file);
        try { await writeFile(resourceTarget, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(resourceTarget)).equals(bytes)) throw error; }
        copied.set(original, relative(dirname(target), resourceTarget).split(sep).join('/'));
      }
      replacements.push({ link, value: copied.get(original)! });
    }
    const converted = replaceMarkdownLinks(source, replacements); await mkdir(dirname(target), { recursive: true }); await writeFile(temporary, converted, { flag: 'wx', mode: 0o600 });
    if (await readFile(temporary, 'utf8') !== converted) throw new ViewerError('SAVE_VERIFY_FAILED', '导入文档临时文件校验失败。');
    const currentTarget = [...core.documents.values()].find(entry => entry.info.path && resolve(entry.info.path).toLowerCase() === target.toLowerCase());
    if (currentTarget?.info.dirty || currentTarget && (currentTarget !== openTarget || currentTarget.info.revision !== openedRevision) || await diskHash() !== originalHash) throw new ViewerError('FILE_CONFLICT', '导入期间目标文件已变化，请重新导入或选择其他文件。');
    await rename(temporary, target); committed = true;
    if (openTarget) { await core.reloadFromDisk(openTarget.info.id); return core.addView(openTarget.info.id, windowId, false); }
    return core.openFile(target, windowId, false);
  } finally {
    await rm(temporary, { force: true });
    if (assetDirectoryCreated && !committed) { if (dirname(resolve(assetDirectory)) !== dirname(target) || !basename(assetDirectory).startsWith(basename(target, extname(target)) + '.assets-')) throw new Error('INVALID_RESOURCE_CLEANUP_PATH'); await rm(assetDirectory, { recursive: true, force: true }); }
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'agentviewer-import-'))) throw new Error('INVALID_TEMP_PATH'); await rm(directory, { recursive: true, force: true });
  }
}
