import { open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ViewerError } from '../../contracts/src/index';
import type { ViewerCore } from '../../document-core/src/index';

const key=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
const inside=(root:string,path:string)=>{const local=relative(key(root),key(path));return local===''||!isAbsolute(local)&&local!=='..'&&!local.startsWith('..'+sep);};
/** Only explicitly configured roots and already opened individual files grant access. */
export class AgentFiles {
  constructor(private readonly core:ViewerCore,private readonly directory:string){}
  async roots() {
    const paths=new Set<string>();
    for(const path of (process.env.AGENTVIEWER_WORKSPACE_ROOTS??'').split(';').filter(Boolean))paths.add(await realpath(path));
    try {
      const saved=JSON.parse(await readFile(join(this.directory,'markdown-workspaces.json'),'utf8')) as {roots?:[string,string][]};
      for(const [,path] of saved.roots??[])paths.add(await realpath(path));
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return [...paths].sort();
  }
  async path(path:string,mode:'file'|'directory'|'create'='file') {
    if(!isAbsolute(path)||path.includes('\0'))throw new ViewerError('AUTH_SCOPE_DENIED','需要授权范围内的绝对路径。');
    let actual:string;
    if(mode==='create')actual=resolve(await realpath(dirname(path)),basename(path));
    else actual=await realpath(path);
    if((await this.roots()).some(root=>inside(root,actual)))return actual;
    if(mode==='file')for(const {info} of this.core.documents.values()) {
      if(info.path && [...this.core.views.values()].some(view=>view.documentId===info.id)) {
        try {if(key(await realpath(info.path))===key(actual))return actual;}catch{}
      }
    }
    throw new ViewerError('AUTH_SCOPE_DENIED','路径未被工作区或已打开单文件授权；未扩大到父目录。');
  }
  async list(path:string) {
    const target=await this.path(path,'directory');
    return (await readdir(target,{withFileTypes:true})).filter(entry=>!entry.isSymbolicLink()&&!['.git','node_modules','.agentviewer-trash'].includes(entry.name)).map(entry=>({name:entry.name,path:join(target,entry.name),kind:entry.isDirectory()?'directory':'file'})).sort((a,b)=>a.name.localeCompare(b.name));
  }
  async source(path:string) {
    const target=await this.path(path),before=await stat(target),maximum=1024*1024;
    if(!before.isFile()||before.size>maximum)throw new ViewerError('READ_LIMIT','只读取不超过1MiB的文本文件；文档请先打开后按范围读取。');
    const handle=await open(target,'r');
    try {
      const opened=await handle.stat();
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)throw new ViewerError('REVISION_CONFLICT','读取期间文件已被替换。');
      const bytes=Buffer.alloc(Math.min(maximum+1,opened.size+1));let length=0;
      while(length<bytes.length) {const read=await handle.read(bytes,length,bytes.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
      const after=await handle.stat();
      if(length!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||key(await this.path(target))!==key(target))throw new ViewerError('REVISION_CONFLICT','读取期间文件已变化，请重试。');
      const content=bytes.subarray(0,length);
      return {path:target,text:new TextDecoder('utf-8',{fatal:true}).decode(content),sha256:createHash('sha256').update(content).digest('hex'),byteLength:length};
    } finally {await handle.close();}
  }
  async read(path:string) {return (await this.source(path)).text;}
  async create(path:string,text:string) {const target=await this.path(path,'create');await writeFile(target,text,{flag:'wx'});return {path:target};}
  async change(action:string,path:string,destination?:string,transactionId?:string) {
    const source=await this.path(path,action==='restore'?'directory':'file'),roots=await this.roots(),root=roots.filter(root=>inside(root,source)).sort((a,b)=>b.length-a.length)[0];
    if(!root)throw new ViewerError('AUTH_SCOPE_DENIED','文件移动与回收需要明确配置的工作区。');
    const target=action==='move'?await this.path(destination??'','create'):undefined;
    if(target&&!inside(root,target))throw new ViewerError('CAPABILITY_UNSUPPORTED','跨工作区移动尚未支持。');
    if(action==='restore'&&!transactionId)throw new ViewerError('INVALID_ARGUMENT','恢复需要明确transaction。');
    const execute=this.core.extensions.get('agent-files-change');if(!execute)throw new ViewerError('CAPABILITY_UNSUPPORTED','文件事务服务未连接。');
    return execute({root,action:action==='restore'?'undo':action==='recycle'?'trash':'move',path:relative(root,source),destination:target?relative(root,target):undefined,transactionId},'agent');
  }
  async savePath(path:string,current?:string) {
    if(current&&key(resolve(current))===key(resolve(path)))return this.path(path,'file');
    return this.path(path,'create');
  }
}
