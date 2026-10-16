import { BrowserWindow, dialog, ipcMain, session, type SaveDialogOptions, type Session } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat, realpath, lstat, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import type { ViewerCore } from '../../../../packages/document-core/src/index';
import { ViewerError } from '../../../../packages/contracts/src/index';
import { readMarkdownPreferences } from '../../../../packages/markdown/src/preferences';
import { markdownLinks, replaceMarkdownLinks } from '../../../../packages/markdown/src/links';
import { imageDataUrl, markdownResource, markdownResourcePath } from '../../../../packages/markdown/src/resources';
import { pandocExecutable } from '../../../../packages/engines/src/index';
import { parseFragment } from 'parse5';
import { AtomicExportSet } from './atomic-export';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const execute = promisify(execFile);
const extensions: Record<string, string> = { html: 'html', pdf: 'pdf', png: 'png', docx: 'docx', odt: 'odt', rtf: 'rtf', epub: 'epub', latex: 'tex', markdown: 'md' };
const appRoot = resolve(__dirname, '../..');
export const markdownExportCapabilities = async () => ({ formats: Object.keys(extensions), pandoc: !!pandocExecutable(appRoot) });
const exportsInProgress = new Map<number, {core:ViewerCore;documentId:string;revision:number;imageBytes:number;media(path:string):Promise<{url:string}>}>();
let exportSession: Session | undefined;
function isolatedExportSession() {
  if(!exportSession) {
    exportSession=session.fromPartition('agentviewer-markdown-export',{cache:false});
    exportSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    exportSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{const path=new URL(details.url).pathname;callback({cancel:/^\/(?:api|v1)(?:\/|$)/.test(path)});});
  }
  return exportSession;
}
async function pandocSource(core: ViewerCore, documentId: string, source: string) {
  const edits: {from:number;to:number;text:string}[]=[];
  for (const link of markdownLinks(source).filter(link=>link.image)) {
    const path=/^(?:https?:|data:)/i.test(link.source)?link.source:(await markdownResourcePath(core,documentId,link.source)).split(sep).join('/');
    if(link.context==='html') {
      // Only convert AST-confirmed img tags. Code fences and literal examples
      // are excluded by markdownLinks. Pandoc drops raw HTML in DOCX/ODT.
      const start=source.lastIndexOf('<',link.from),tag=/^<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(source.slice(start));
      if(tag&&start+tag[0].length>=link.to) {
        const node=parseFragment(tag[0]).childNodes.find(node=>'tagName' in node&&node.tagName==='img');
        if(node&&'attrs' in node) {
          const attrs=new Map(node.attrs.map(attr=>[attr.name,attr.value])),style=attrs.get('style')??'';
          const size=['width','height'].flatMap(name=>{const value=attrs.get(name)??new RegExp('(?:^|;)\\s*'+name+'\\s*:\\s*([\\d.]+(?:px|%|em|cm|mm|in)?)','i').exec(style)?.[1];return value&&/^\d+(?:\.\d+)?(?:px|%|em|cm|mm|in)?$/.test(value)?[name+'='+value]:[];});
          edits.push({from:start,to:start+tag[0].length,text:'!['+(attrs.get('alt')??'').replace(/[\[\]\\]/g,'\\$&')+'](<'+path.replace(/[<>\s]/g,encodeURIComponent)+'>)'+(size.length?'{' + size.join(' ') + '}':'')});continue;
        }
      }
    }
    edits.push({from:link.from,to:link.to,text:replaceMarkdownLinks(source.slice(link.from,link.to),[{link:{...link,from:0,to:link.to-link.from},value:path}])});
  }
  let result=source;for(const edit of edits.sort((a,b)=>b.from-a.from))result=result.slice(0,edit.from)+edit.text+result.slice(edit.to);return result;
}
async function confinedImportImage(path: string, roots: string[]) {
  const target=resolve(path);
  for(const base of roots) {
    const root=resolve(base),local=relative(root,target);
    if(isAbsolute(local)||local==='..'||local.startsWith('..'+sep))continue;
    let current=root;
    for(const part of local.split(sep).filter(Boolean)) {
      current=join(current,part);const info=await lstat(current);
      if(info.isSymbolicLink())throw new ViewerError('INVALID_MARKDOWN_RESOURCE','导入图片不能经过符号链接或目录联接。');
    }
    const canonicalRoot=await realpath(root),canonical=await realpath(target),inside=relative(canonicalRoot,canonical),info=await stat(canonical);
    if(isAbsolute(inside)||inside==='..'||inside.startsWith('..'+sep)||!info.isFile())throw new ViewerError('INVALID_MARKDOWN_RESOURCE','导入图片超出所选文档的资源目录。');
    return canonical;
  }
  throw new ViewerError('INVALID_MARKDOWN_RESOURCE','导入图片超出所选文档或提取资源的目录。');
}
ipcMain.handle('agentviewer:export-resource', async (event, path: unknown, kind?:unknown) => {
  const job = exportsInProgress.get(event.sender.id);
  if (!job || event.senderFrame !== event.sender.mainFrame || typeof path !== 'string' || job.core.getDocument(job.documentId).info.revision !== job.revision) throw new ViewerError('AUTH_SCOPE_DENIED', '导出资源来源已失效。');
  if(kind==='media')return job.media(path);
  if(kind!==undefined&&kind!=='image')throw new ViewerError('INVALID_ARGUMENT','导出资源类型无效。');
  const expected=path.startsWith('data:')?path.length:Math.ceil((await stat(await markdownResourcePath(job.core,job.documentId,path))).size*4/3)+128;
  if(job.imageBytes+expected>64*1024*1024)throw new ViewerError('EXPORT_RESOURCE_LIMIT','内嵌导出图片超过64MiB，请使用外部资源或拆分文档。');
  job.imageBytes+=expected;
  return markdownResource(job.core, job.documentId, path);
});
async function renderInBackground(core: ViewerCore, owner: BrowserWindow, documentId: string, revision: number, source: string, media:(path:string)=>Promise<{url:string}>) {
  if(exportsInProgress.size>=2)throw new ViewerError('EXPORT_BUSY','已有两份文档正在生成，请等待后重试。');
  const worker = new BrowserWindow({show:false,webPreferences:{session:isolatedExportSession(),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,preload:join(__dirname,'markdown-export-preload.cjs')}});
  exportsInProgress.set(worker.webContents.id,{core,documentId,revision,media,imageBytes:0});
  const id = worker.webContents.id, close = () => { if(!worker.isDestroyed())worker.destroy(); };
  owner.once('closed',close); worker.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const timeout = setTimeout(close,120000);
  try {
    await worker.loadURL(owner.webContents.getURL().split('#')[0]+'#/export-worker');
    await worker.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(window.__markdownExport)resolve(true);else if(++n>600)reject(new Error('导出模块加载超时。'));else setTimeout(poll,50)};poll()})`);
    return await worker.webContents.executeJavaScript(`window.__markdownExport(${JSON.stringify(source)},${JSON.stringify(documentId)})`) as string;
  } finally { clearTimeout(timeout); owner.removeListener('closed',close); exportsInProgress.delete(id); close(); }
}

export async function exportMarkdown(core: ViewerCore, owner: BrowserWindow, input: { documentId: string; expectedRevision: number; format: string }) {
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
  const outputs = new AtomicExportSet(), outputPaths: string[] = [], ownedOutputFolders = new Set<string>();
  const normalizedPath = async (value: string) => { const full=resolve(value);try{return(await realpath(full)).toLowerCase();}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return full.toLowerCase();throw cause;} };
  const validate = async () => {
    if(core.getDocument(input.documentId).info.revision!==frozenRevision)throw new ViewerError('VERSION_CONFLICT','导出期间文档已变化，请重新导出。');
    const protectedPaths=await Promise.all([...core.documents.values()].filter(entry=>entry.info.path&&(entry.info.id===document.id||entry.info.dirty)).map(entry=>normalizedPath(entry.info.path!)));
    for(const target of [path,...outputPaths])if(protectedPaths.includes(await normalizedPath(target)))throw new ViewerError('FILE_CONFLICT','导出不能覆盖当前源码或仍有未保存编辑的文档，请选择其他路径。');
  };
  await validate();
  const singleTemporary = input.format==='png' ? undefined : await outputs.reserve(path);
  try {
  const { preferences } = await readMarkdownPreferences(core, document.id);
  if (input.format === 'markdown') { await writeFile(singleTemporary!, source, 'utf8'); return { paths: await outputs.commit(validate), revision: frozenRevision }; }
  if (conversion) {
    const directory = await mkdtemp(join(tmpdir(), 'agentviewer-pandoc-'));
    const assetsName=basename(path,extname(path))+'.assets-'+randomUUID().slice(0,8),assetsTarget=join(dirname(path),assetsName);
    let assetsCreated=false;
    try {
      const from = join(directory, 'source.md'); await writeFile(from, await pandocSource(core,document.id,source), 'utf8');
      const args = [from, '--from=markdown+tex_math_dollars+pipe_tables+task_lists+strikeout+yaml_metadata_block+footnotes', '--standalone', '--resource-path=' + (document.path ? dirname(document.path) : directory), '--to=' + input.format, '--output=' + singleTemporary!];
      if(input.format==='latex')args.push('--extract-media='+assetsName);
      if (preferences.export.templatePath) args.push('--template=' + preferences.export.templatePath);
      await execute(pandocExecutable(appRoot)!.path, args, { cwd:directory, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
      if(input.format==='latex') {
        const extracted=join(directory,assetsName);
        let resources: string[]=[];
        try{resources=await readdir(extracted,{recursive:true});}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause;}
        let total=0,count=0;
        for(const entry of resources){
          const local=String(entry),origin=resolve(extracted,local),within=relative(extracted,origin);
          if(isAbsolute(within)||within==='..'||within.startsWith('..'+sep))throw new ViewerError('INVALID_MARKDOWN_RESOURCE','转换资源路径无效。');
          const info=await lstat(origin);if(info.isSymbolicLink())throw new ViewerError('INVALID_MARKDOWN_RESOURCE','转换资源不能是链接。');if(!info.isFile())continue;
          if(++count>1024||(total+=info.size)>256*1024*1024||info.size>32*1024*1024)throw new ViewerError('INVALID_MARKDOWN_RESOURCE','转换资源超过数量或容量预算。');
          const bytes=await readFile(origin);imageDataUrl(bytes);
          if(!assetsCreated){await mkdir(assetsTarget);assetsCreated=true;ownedOutputFolders.add(assetsTarget);}
          const target=join(assetsTarget,within);await mkdir(dirname(target),{recursive:true});for(let folder=dirname(target);folder!==assetsTarget;folder=dirname(folder))ownedOutputFolders.add(folder);outputPaths.push(target);await outputs.write(target,bytes,false);
        }
      }
      return { paths: await outputs.commit(validate), revision: frozenRevision };
    } finally {
      if (!directory.startsWith(join(tmpdir(), 'agentviewer-pandoc-'))) throw new Error('INVALID_TEMP_PATH'); await rm(directory, { recursive: true, force: true });
    }
  }
  const mediaAssetsName=basename(path,extname(path))+'.assets-'+randomUUID().slice(0,8),mediaAssets=join(dirname(path),mediaAssetsName),mediaReferences=new Map<string,string>();let mediaBytes=0;
  const prepareMedia=async(source:string)=>{
    if(input.format!=='html')return {url:''};
    const existing=mediaReferences.get(source);if(existing)return {url:existing};
    const reference=source.startsWith('file:')?encodeURIComponent(fileURLToPath(source)):source,origin=await markdownResourcePath(core,document.id,reference),info=await stat(origin);
    if(!/\.(?:mp3|wav|ogg|oga|opus|m4a|mp4|m4v|webm|ogv|flac)$/i.test(origin)||!info.isFile()||info.size>2*1024**3||mediaBytes+info.size>2*1024**3||mediaReferences.size>=256)throw new ViewerError('INVALID_MARKDOWN_RESOURCE','媒体类型、数量或容量超出导出限制。');
    if(!ownedOutputFolders.has(mediaAssets)){await mkdir(mediaAssets);ownedOutputFolders.add(mediaAssets);}
    const name=String(mediaReferences.size+1).padStart(3,'0')+'-'+basename(origin).replace(/[^\p{L}\p{N}_.-]/gu,'-'),target=join(mediaAssets,name),temporary=await outputs.reserve(target,false);
    outputPaths.push(target);mediaBytes+=info.size;await pipeline(createReadStream(origin),createWriteStream(temporary));
    const after=await stat(origin);if(info.size!==after.size||info.mtimeMs!==after.mtimeMs)throw new ViewerError('FILE_CONFLICT','导出期间媒体源文件已变化。');
    const url=[mediaAssetsName,name].map(encodeURIComponent).join('/');mediaReferences.set(source,url);return {url};
  };
  const prepared = await renderInBackground(core,owner,document.id,frozenRevision,source,prepareMedia);
  if (core.getDocument(input.documentId).info.revision !== frozenRevision) throw new ViewerError('VERSION_CONFLICT','生成导出页面期间文档已变化，请重新导出。');
  if (prepared.length > 64 * 1024 * 1024) throw new ViewerError('INVALID_ARGUMENT', '导出页面超过64MiB，请拆分文档。');
  // No preload or local-service credential enters this isolated export page.
  // Only HTML jobs which copied validated resources need file-backed media.
  // The final DOM contains those owned relative paths; scripts remain denied.
  const portableMediaSources = input.format === 'html' && mediaReferences.size ? " 'self' file:" : '';
  const html = prepared.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:; media-src data: https: http:${portableMediaSources}"><style>${preferences.themeCss.replace(/<\/style/gi, '<\\/style')}</style>`);
  if (input.format === 'html') { await writeFile(singleTemporary!, html, 'utf8'); return { paths: await outputs.commit(validate), revision: frozenRevision }; }
  const window = new BrowserWindow({ show: false, width: 1100, height: 1200, useContentSize: true, webPreferences: { session:isolatedExportSession(),sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // Capture the document surface at its full content width; the window's
    // scroll controls are not part of the exported image. Apply before layout
    // measurement so removing the gutter cannot change pagination afterwards.
    if (input.format === 'png') await window.webContents.insertCSS('html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}', { cssOrigin: 'user' });
    await window.webContents.executeJavaScript('Promise.all([document.fonts.ready,...Array.from(document.images).map(i=>i.decode().catch(()=>{}))])');
    if (input.format === 'pdf') {
      await writeFile(singleTemporary!, await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4', generateDocumentOutline: true, generateTaggedPDF: true, displayHeaderFooter: !!(preferences.export.header || preferences.export.footer), headerTemplate: preferences.export.header || '<span></span>', footerTemplate: preferences.export.footer || '<span></span>' }));
      return { paths: await outputs.commit(validate), revision: frozenRevision };
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
      outputPaths.push(output);await validate();await outputs.write(output, image.toPNG(),height<=1200); paths.push(output);
    }
    await outputs.commit(validate);return { paths, revision: frozenRevision };
  } finally { window.destroy(); }
  } finally { await outputs.cleanup(); for(const folder of [...ownedOutputFolders].sort((a,b)=>b.length-a.length)){try{await rmdir(folder);}catch{/* Preserve published or concurrently created files. */}} }
}

export async function importMarkdown(core: ViewerCore, owner: BrowserWindow, windowId: string) {
  if (!(await markdownExportCapabilities()).pandoc) throw new ViewerError('ENGINE_UNAVAILABLE', '导入 Word、EPUB 等格式需要安装 Pandoc。');
  const chosen = await dialog.showOpenDialog(owner, { title: '导入为 Markdown', properties: ['openFile'], filters: [{ name: '可转换文档', extensions: ['docx', 'odt', 'rtf', 'epub', 'html', 'htm', 'tex'] }] });
  if (chosen.canceled || !chosen.filePaths[0]) return null;
  const destination = await dialog.showSaveDialog(owner, { title: '保存导入后的 Markdown', defaultPath: join(dirname(chosen.filePaths[0]), basename(chosen.filePaths[0], extname(chosen.filePaths[0])) + '.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
  if (destination.canceled || !destination.filePath) return null;
  if (!/\.(?:md|markdown)$/i.test(destination.filePath)) throw new ViewerError('FORMAT_MISMATCH', '导入后的文档需要保存为 .md。');
  const target = resolve(destination.filePath), assetDirectory = join(dirname(target), basename(target, extname(target)) + '.assets-' + randomUUID().slice(0, 8)), outputs = new AtomicExportSet();
  const normalizedPath = async (path: string) => { try { return (await realpath(path)).toLowerCase(); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path).toLowerCase(); throw cause; } };
  const openTargets = async () => { const key = await normalizedPath(target), entries = [...core.documents.values()].filter(entry => !!entry.info.path); return (await Promise.all(entries.map(async entry => ({entry,key:await normalizedPath(entry.info.path!)})))).filter(item => item.key === key).map(item => item.entry); };
  // Use the workspace's document-ID order whenever more than one document lane
  // is held, including multiple path aliases of the same file.
  const openedTargets = (await openTargets()).sort((a, b) => a.info.id.localeCompare(b.info.id)).map(entry => ({ entry, revision: entry.info.revision }));
  if (openedTargets.some(item => item.entry.info.dirty)) throw new ViewerError('UNSAVED_CHANGES', '导入目标仍有未保存编辑，请先保存或选择其他文件。');
  const validate = async () => { const current = await openTargets(); if (current.length !== openedTargets.length || current.some(entry => entry.info.dirty || !openedTargets.some(item => item.entry === entry && item.revision === entry.info.revision))) throw new ViewerError('FILE_CONFLICT', '导入期间目标文件已打开或变化，请重新导入或选择其他文件。'); };
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-import-'));
  let assetDirectoryCreated = false;
  try {
    await mkdir(dirname(target), { recursive: true });
    const temporary = await outputs.reserve(target);
    const output = join(directory, 'import.md'), extracted = join(directory, 'extracted');
    await execute(pandocExecutable(appRoot)!.path, [chosen.filePaths[0], '--sandbox', '--to=markdown+pipe_tables+tex_math_dollars+yaml_metadata_block+footnotes', '--extract-media=' + extracted, '--wrap=none', '--output=' + output], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    const source = await readFile(output, 'utf8'), replacements: { link: ReturnType<typeof markdownLinks>[number]; value: string }[] = [], copied = new Map<string, string>(), stagedResources = new Map<string, string>();
    const sourceDirectory=dirname(resolve(chosen.filePaths[0])),resourceRoots=[extracted,sourceDirectory];let totalImageBytes=0;
    for (const link of markdownLinks(source).filter(link => link.image && !/^(?:https?:|data:|#)/i.test(link.source))) {
      let original: string;
      try { original = link.source.startsWith('file:') ? fileURLToPath(link.source) : isAbsolute(link.source) ? resolve(link.source) : resolve(directory, decodeURIComponent(link.source)); }
      catch { throw new ViewerError('INVALID_MARKDOWN_RESOURCE', '导入文档中的图片路径无效。'); }
      try { await lstat(original); } catch(cause) {if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause;original = resolve(sourceDirectory, decodeURIComponent(link.source));}
      original=await confinedImportImage(original,resourceRoots);
      if (!copied.has(original)) {
        const size=(await stat(original)).size;totalImageBytes+=size;
        if (size > 32 * 1024 * 1024 || totalImageBytes>256*1024*1024 || copied.size>=1024) throw new ViewerError('INVALID_MARKDOWN_RESOURCE', '导入图片超过单图32MiB、整篇256MiB或1024张限制。');
        const bytes = await readFile(original); imageDataUrl(bytes);
        if (!assetDirectoryCreated) { await mkdir(dirname(target), { recursive: true }); await mkdir(assetDirectory); assetDirectoryCreated = true; }
        const digest = createHash('sha256').update(bytes).digest('hex');
        const file = basename(original, extname(original)).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 40) + '-' + digest.slice(0, 16) + extname(original).toLowerCase();
        const resourceTarget = join(assetDirectory, file);
        if (stagedResources.has(resourceTarget) && stagedResources.get(resourceTarget) !== digest) throw new ViewerError('FILE_CONFLICT', '导入图片的目标指纹冲突，未替换文件。');
        if (!stagedResources.has(resourceTarget)) { await outputs.write(resourceTarget, bytes, false); stagedResources.set(resourceTarget, digest); }
        copied.set(original, relative(dirname(target), resourceTarget).split(sep).join('/'));
      }
      replacements.push({ link, value: copied.get(original)! });
    }
    const converted = replaceMarkdownLinks(source, replacements);
    if (Buffer.byteLength(converted, 'utf8') > 100 * 1024 * 1024) throw new ViewerError('FILE_TOO_LARGE', '导入后的 Markdown 超过100MiB，未替换目标文件。');
    await writeFile(temporary, converted, 'utf8');
    if (await readFile(temporary, 'utf8') !== converted) throw new ViewerError('SAVE_VERIFY_FAILED', '导入文档临时文件校验失败。');
    // Publish and refresh every aliased open target while holding its real Core
    // lane. A queued edit then sees the imported revision and fails as stale.
    const publish = (index: number): Promise<unknown> => index < openedTargets.length ? core.runDocumentOperation(openedTargets[index].entry.info.id, () => publish(index + 1), { reloadFromDisk: true }) : outputs.commit(validate);
    await publish(0);
    if (openedTargets[0]) return core.addView(openedTargets[0].entry.info.id, windowId, false);
    return core.openFile(target, windowId, false);
  } finally {
    await outputs.cleanup();
    if (assetDirectoryCreated) { try { await rmdir(assetDirectory); } catch { /* Keep published or concurrently created files; never recursively remove user-side resources. */ } }
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'agentviewer-import-'))) throw new Error('INVALID_TEMP_PATH'); await rm(directory, { recursive: true, force: true });
  }
}
