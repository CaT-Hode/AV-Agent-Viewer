import { readdir, readFile, realpath, stat, mkdir, rename, writeFile, unlink, link } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { ViewerCore } from '../../document-core/src/index';
import { ViewerError } from '../../contracts/src/index';
import { markdownLinks, replaceMarkdownLinks } from './links';

const hidden = new Set(['.git', 'node_modules', '.agentviewer-trash', 'dist', 'release', '.engines']);
const editable = /\.(?:md|markdown|mdown|txt|html?|docx|pptx|xlsx|pdf)$/i;
type FileMove = { root: string; from: string; to: string };
const invalid = (message: string): never => { throw new ViewerError('INVALID_WORKSPACE_PATH', message); };
const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const inside = (root: string, path: string) => pathKey(path) === pathKey(root) || pathKey(path).startsWith(pathKey(root) + sep);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class MarkdownWorkspace {
  private readonly roots = new Map<string, string>();
  private readonly undo = new Map<string, FileMove>();
  private initialized?: Promise<void>;
  private persistence: Promise<void> = Promise.resolve();
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private readonly core: ViewerCore, private readonly directory: string) {}
  private initialize() {
    return this.initialized ??= (async () => {
      try { const saved = JSON.parse(await readFile(join(this.directory, 'markdown-workspaces.json'), 'utf8')); for (const [id, path] of saved.roots ?? []) if (typeof id === 'string' && typeof path === 'string') this.roots.set(id, path); for (const [id, entry] of saved.undo ?? []) this.undo.set(id, entry); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    })();
  }
  private persist() {
    const payload = JSON.stringify({ roots: [...this.roots], undo: [...this.undo] });
    const next = this.persistence.catch(() => {}).then(async () => { await mkdir(this.directory, { recursive: true }); const target = join(this.directory, 'markdown-workspaces.json'); await writeFile(target + '.tmp', payload, { mode: 0o600 }); await rename(target + '.tmp', target); });
    this.persistence = next; return next;
  }
  private async root(documentId: string) {
    await this.initialize(); const document = this.core.getDocument(documentId);
    if (document.info.format !== 'markdown') return invalid('请选择 Markdown 文档。');
    const path = this.roots.get(documentId) ?? (document.info.path ? dirname(document.info.path) : undefined);
    if (!path) return invalid('请先选择工作文件夹。');
    return realpath(path);
  }
  async setRoot(documentId: string, path: string) {
    await this.initialize(); this.core.getDocument(documentId);
    const rootPath = await realpath(path); if (!(await stat(rootPath)).isDirectory()) return invalid('请选择文件夹。');
    this.roots.set(documentId, rootPath); await this.persist(); return { rootPath };
  }
  async resourceRoot(documentId: string) {
    await this.initialize();
    const document=this.core.getDocument(documentId).info;
    const shared=document.path ? [...this.roots.values()].filter(root=>inside(root,document.path!)).sort((a,b)=>b.length-a.length)[0] : undefined;
    const selected=this.roots.get(documentId), own=selected && (!document.path || inside(selected,document.path)) ? selected : undefined;
    // Save As can leave the file-tree browsing root elsewhere. Resource access
    // follows the saved document or another explicitly selected containing root.
    return { rootPath: await realpath(own ?? shared ?? (document.path ? dirname(document.path) : await this.root(documentId))) };
  }
  private async path(root: string, path: string, existing = true) {
    if (typeof path !== 'string' || path.includes('\0')) return invalid('路径无效。');
    const target = resolve(root, path), local = relative(root, target);
    if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) return invalid('路径超出了当前工作文件夹。');
    const actual = existing ? await realpath(target) : resolve(await realpath(dirname(target)), basename(target));
    const checked = relative(root, actual);
    if (isAbsolute(checked) || checked === '..' || checked.startsWith('..' + sep)) return invalid('链接路径超出了当前工作文件夹。');
    return actual;
  }
  async list(documentId: string, directory = '') {
    const rootPath = await this.root(documentId), target = await this.path(rootPath, directory);
    const entries = (await readdir(target, { withFileTypes: true })).filter(entry => !hidden.has(entry.name) && !entry.isSymbolicLink()).map(entry => ({ path: relative(rootPath, join(target, entry.name)).split(sep).join('/'), name: entry.name, kind: entry.isDirectory() ? 'directory' as const : 'file' as const })).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.kind === 'directory' ? -1 : 1);
    return { rootPath, relativePath: relative(rootPath, target).split(sep).join('/'), entries: entries.slice(0, 5000), limitReached: entries.length > 5000 };
  }
  async search(documentId: string, query: string, caseSensitive = false, mode = 'content') {
    if (typeof query !== 'string' || query.length > 500) return invalid('搜索内容最多 500 字符。');
    const root = await this.root(documentId), needle = caseSensitive ? query : query.toLocaleLowerCase();
    const results: { path: string; uri: string; line: number; preview: string }[] = [];
    const pending = [root]; let examined = 0, limitReached = false;
    while (pending.length && !limitReached) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (hidden.has(entry.name) || entry.isSymbolicLink()) continue;
        const uri = join(directory, entry.name);
        if (entry.isDirectory()) { pending.push(uri); continue; }
        if (!editable.test(entry.name)) continue;
        if (++examined > 5000) { limitReached = true; break; }
        const path = relative(root, uri).split(sep).join('/');
        if (mode === 'filename') {
          if ((caseSensitive ? path : path.toLocaleLowerCase()).includes(needle)) results.push({ path, uri, line: 0, preview: path });
        } else if (query && /\.(?:md|markdown|mdown|txt|html?)$/i.test(entry.name)) {
          // Scan every byte with bounded line state, including very long data URI
          // lines. UTF-8 decoding and query matches span stream chunk boundaries.
          let line = 1, preview = '', tail = '', matched = false, nonempty = false;
          const finish = () => { if (matched) results.push({path, uri, line, preview:preview.replace(/\r$/, '')}); line++; preview = ''; tail = ''; matched = false; nonempty = false; };
          for await (const chunk of createReadStream(uri, {encoding:'utf8', highWaterMark:64 * 1024})) {
            const parts = chunk.split('\n');
            for (let index = 0; index < parts.length; index++) {
              const part = parts[index]; nonempty ||= !!part.length;
              if (preview.length < 240) preview += part.slice(0, 240 - preview.length);
              const content = tail + (caseSensitive ? part : part.toLocaleLowerCase());
              matched ||= content.includes(needle); tail = content.slice(-Math.max(1, needle.length - 1));
              if (index < parts.length - 1) finish();
              if (results.length >= 500) { limitReached = true; break; }
            }
            if (limitReached) break;
          }
          if (!limitReached && nonempty) finish();
        }
        if (results.length >= 500) { limitReached = true; break; }
        if (examined % 20 === 0) await new Promise<void>(done => setImmediate(done));
      }
    }
    return { results, limitReached };
  }
  private async move(root: string, from: string, to: string) {
    const source = await this.path(root, from), destination = await this.path(root, to, false);
    if (pathKey(source) === pathKey(root) || pathKey(source) === pathKey(destination)) return invalid('不能移动工作文件夹本身或使用相同路径。');
    if (inside(source, destination)) return invalid('不能把文件夹移动到自身内部。');
    try { await stat(destination); return invalid('目标已经存在，请使用其他名称。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const moved = [...this.core.documents.values()].filter(entry => entry.info.path && inside(source, entry.info.path)).sort((a,b)=>a.info.id.localeCompare(b.info.id));
    const originalPaths=new Map(moved.map(entry=>[entry.info.id,pathKey(entry.info.path!)]));
    const unchanged=()=>{const current=[...this.core.documents.values()].filter(entry=>entry.info.path&&inside(source,entry.info.path));return current.length===moved.length&&current.every(entry=>originalPaths.get(entry.info.id)===pathKey(entry.info.path!));};
    await this.core.extensions.get('before-file-move')?.({documentIds:moved.map(entry=>entry.info.id)},'human');
    const lock = <T>(index: number, action: () => Promise<T>): Promise<T> => index < moved.length ? this.core.runDocumentOperation(moved[index].info.id, () => lock(index + 1, action)) : action();
    return lock(0, async () => {
      if (!unchanged()) return invalid('文件关联在等待期间发生变化，请重新执行移动。');
      if (moved.some(entry => entry.info.dirty)) return invalid('文件仍有未保存编辑，请先保存后再移动或重命名。');
      const sourceInfo=await stat(source);
      if (!sourceInfo.isDirectory() && !sourceInfo.isFile()) return invalid('请选择普通文件或文件夹。');
      const changed: {from:string;to:string;before:Buffer;after:Buffer;text:string}[] = [], pending = [source];
      while (pending.length) {
        const path = pending.pop()!, info = await stat(path);
        if (info.isDirectory()) { for (const item of await readdir(path,{withFileTypes:true})) if (!item.isSymbolicLink() && !hidden.has(item.name)) pending.push(join(path,item.name)); continue; }
        if (!/\.(?:md|markdown|mdown|txt)$/i.test(path)) continue;
        const target = resolve(destination,relative(source,path)), before = await readFile(path), content = new TextDecoder('utf-8',{fatal:true}).decode(before);
        const replacements = markdownLinks(content).flatMap(link => {
          if (!link.source || /^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(link.source)) return [];
          const split = link.source.search(/[?#]/), raw = split < 0 ? link.source : link.source.slice(0,split), suffix = split < 0 ? '' : link.source.slice(split);
          let decoded: string; try { decoded=decodeURIComponent(raw); } catch { return []; }
          const original = resolve(dirname(path),decoded), relocated = inside(source,original) ? resolve(destination,relative(source,original)) : original;
          const next = relative(dirname(target),relocated).split(sep).map(part=>encodeURIComponent(part)).join('/') + suffix;
          return next === link.source ? [] : [{link,value:next}];
        });
        const text = replaceMarkdownLinks(content,replacements);
        if (text !== content) { const encoded=Buffer.from(text,'utf8'), after=before.subarray(0,3).equals(Buffer.from([239,187,191])) ? Buffer.concat([Buffer.from([239,187,191]),encoded]) : encoded; changed.push({from:path,to:target,before,after,text}); }
      }
      for (const entry of moved) if (entry.sourceHash && hash(await readFile(entry.info.path!)) !== entry.sourceHash) return invalid('源文件已被其他程序修改，请重新载入后再移动。');
      if (!unchanged()) return invalid('文件关联在准备期间发生变化，请重新执行移动。');
      if (sourceInfo.isDirectory()) {
        try { await stat(destination); return invalid('目标已经存在，请使用其他名称。'); } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        await rename(source,destination);
      } else {
        try { await link(source,destination); } catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')return invalid('目标已经存在，请使用其他名称。');throw error;}
        try { await unlink(source); } catch(error) {await unlink(destination).catch(()=>{});throw error;}
      }
      const written: typeof changed = [];
      try {
        for (const file of changed) {
          if (hash(await readFile(file.to)) !== hash(file.before)) throw new ViewerError('FILE_CONFLICT','移动过程中文件已变化，已停止资源路径更新。');
          const temporary=file.to+'.agentviewer-'+randomUUID()+'.tmp';
          try { await writeFile(temporary,file.after,{flag:'wx'}); await rename(temporary,file.to); } finally { await unlink(temporary).catch(()=>{}); }
          written.push(file);
        }
      } catch (error) {
        const retained: string[]=[];
        for (const file of written) {
          const current=await readFile(file.to).catch(()=>undefined);
          if (current && hash(current)===hash(file.after)) {
            const temporary=file.to+'.agentviewer-'+randomUUID()+'.tmp';
            try{await writeFile(temporary,file.before,{flag:'wx'});await rename(temporary,file.to);}finally{await unlink(temporary).catch(()=>{});}
          } else { const recovery=file.to+'.agentviewer-recovery-'+randomUUID();await writeFile(recovery,file.before,{flag:'wx'});retained.push(recovery); }
        }
        let blocked=false;try{await stat(source);blocked=true;}catch(check){if((check as NodeJS.ErrnoException).code!=='ENOENT')throw check;}
        if (!blocked) {
          if (sourceInfo.isDirectory()) await rename(destination,source);
          else {await link(destination,source);await unlink(destination);}
          for(let index=0;index<retained.length;index++)retained[index]=resolve(source,relative(destination,retained[index]));
        }
        if (blocked || retained.length) throw new ViewerError('FILE_CONFLICT','移动期间文件变化，已保留现有内容及恢复副本。',{source,destination,recoveryPaths:retained,reason:String(error)});
        throw error;
      }
      for (const entry of moved) {
        const old=entry.info.path!, next=resolve(destination,relative(source,old)), update=changed.find(file=>pathKey(file.from)===pathKey(old));
        entry.info.path=next; entry.info.title=basename(next);
        if (entry.info.format==='markdown' && !this.roots.has(entry.info.id)) this.roots.set(entry.info.id,root);
        if (update) {
          entry.bytes=new Uint8Array(update.after); entry.info.model={...entry.info.model,text:update.text}; entry.sourceHash=hash(entry.bytes); entry.info.revision++; entry.info.diskRevision=entry.info.revision;
          for (const view of this.core.views.values()) if (view.documentId===entry.info.id && view.context) view.context={...view.context,contentRevision:entry.info.revision,quality:'not-ready',visibleText:'',selection:{kind:'none',text:''}};
        }
      }
      for(const [documentId,selected] of this.roots)if(inside(source,selected))this.roots.set(documentId,resolve(destination,relative(source,selected)));
      this.core.event('workspace.files', { from: source, to: destination }); await this.core.persist();
      return { source, destination };
    });
  }
  change(input: { documentId: string; action: string; path?: string; destination?: string; transactionId?: string }) {
    const operation=this.operations.catch(()=>{}).then(()=>this.changeInside(input)); this.operations=operation; return operation;
  }
  private async changeInside(input: { documentId: string; action: string; path?: string; destination?: string; transactionId?: string }) {
    const root = await this.root(input.documentId);
    this.roots.set(input.documentId,root);
    if (input.action === 'undo') {
      const previous = input.transactionId ? this.undo.get(input.transactionId) : [...this.undo.values()].reverse().find(entry => entry.root === root);
      if (!previous || previous.root !== root) return invalid('没有可恢复的文件操作。');
      const result = await this.move(root, previous.to, previous.from);
      for (const [id, entry] of this.undo) if (entry === previous) this.undo.delete(id);
      await this.persist(); return { uri: result.destination };
    }
    let from: string, to: string;
    if (input.action === 'new-file' || input.action === 'new-folder') {
      const target = await this.path(root, input.path || input.destination || '', false);
      if (target === root) return invalid('请输入名称。');
      if (input.action === 'new-folder') await mkdir(target);
      else { if (!editable.test(target)) return invalid('新建文件需要支持的文档扩展名。'); await writeFile(target, '', { flag: 'wx' }); }
      await mkdir(join(root, '.agentviewer-trash'), { recursive: true });
      from = relative(root, join(root, '.agentviewer-trash', randomUUID() + '-' + basename(target))); to = relative(root, target);
    } else if (['rename', 'move', 'trash'].includes(input.action)) {
      if (!input.path) return invalid('请选择文件或文件夹。');
      from = input.path;
      if (input.action === 'trash') { await mkdir(join(root, '.agentviewer-trash'), { recursive: true }); to = '.agentviewer-trash/' + randomUUID() + '-' + basename(from); }
      else to = input.destination || '';
      await this.move(root, from, to);
    } else return invalid('未知文件操作。');
    const transactionId = randomUUID(); this.undo.set(transactionId, { root, from, to });
    while (this.undo.size > 100) this.undo.delete(this.undo.keys().next().value!);
    await this.persist(); return { transactionId, uri: resolve(root, to) };
  }
}
