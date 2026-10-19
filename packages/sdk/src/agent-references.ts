import { createHash, randomBytes } from 'node:crypto';
import { ViewerError, type Format } from '../../contracts/src/index';
import { agentRetainedBytes } from './agent-memory';

export interface AgentTarget {
  documentId: string; viewId: string; format: Format; kind: 'document'|'text'|'native'|'pdf'|'web';
  revision?: number; from?: number; to?: number; text?: string; hash?: string;
  engineEpoch?: string; engineRevision?: number; selectionEpoch?: number;
  native?: Record<string, unknown>; page?: number; frameRef?: string; elementRef?: string;
}
interface Cursor { source: string; offset: number; query: string; value?:unknown; bytes:number }
/** Connection-owned targets never follow whichever tab happens to be active. */
export class AgentReferences {
  private readonly prefix=randomBytes(6).toString('base64url');
  private sequence = 0;
  private bytes=0;
  private readonly targets = new Map<string,{target:AgentTarget;time:number;bytes:number}>();
  private readonly cursors = new Map<string,Cursor>();
  private readonly documents = new Map<string,string>();
  constructor(private readonly retained:(delta:number)=>void=()=>{}){}
  private remove(ref:string) {const entry=this.targets.get(ref);if(entry){this.bytes-=entry.bytes;this.retained(-entry.bytes);this.targets.delete(ref);}}
  private removeCursor(ref:string) {const entry=this.cursors.get(ref);if(entry){this.bytes-=entry.bytes;this.retained(-entry.bytes);this.cursors.delete(ref);}}
  clear(){this.retained(-this.bytes);this.bytes=0;this.targets.clear();this.cursors.clear();this.documents.clear();}
  put(target: AgentTarget) {
    const copy=structuredClone(target),bytes=agentRetainedBytes(copy)+256;
    while (this.targets.size >= 8192||this.bytes+bytes>16*1024*1024) {
      const expired = [...this.targets].find(([,value])=>value.target.kind!=='document');
      if (!expired) throw new ViewerError('REF_QUOTA_EXCEEDED','目标引用配额已满。');
      this.remove(expired[0]);
    }
    this.retained(bytes);this.bytes+=bytes;
    const ref = 'r' + this.prefix + (++this.sequence).toString(36); this.targets.set(ref,{target:copy,time:Date.now(),bytes}); return ref;
  }
  document(target: AgentTarget) {
    const key=target.documentId+':'+target.viewId, prior=this.documents.get(key);
    if(prior && this.targets.has(prior))return prior;
    const ref=this.put({...target,kind:'document'});this.documents.set(key,ref);return ref;
  }
  get(ref: string) {
    const entry=this.targets.get(ref);
    if(!entry || entry.target.kind!=='document' && Date.now()-entry.time>30*60*1000){this.remove(ref);throw new ViewerError('STALE_REF','引用已过期，请重新读取目标。');}
    return structuredClone(entry.target);
  }
  page(source: string, query: string, cursor?: string) {
    if(!cursor)return 0;
    const entry=this.cursors.get(cursor);
    if(!entry || entry.source!==source || entry.query!==query)throw new ViewerError('STALE_CURSOR','来源或查询已变化，请从第一页重新读取。');
    return entry.offset;
  }
  next(source: string, query: string, offset: number) {
    if(this.cursors.size>=1024)this.removeCursor(this.cursors.keys().next().value!);
    const cursor='c'+this.prefix+(++this.sequence).toString(36),bytes=agentRetainedBytes({source,query,offset})+128;
    if(this.bytes+bytes>16*1024*1024)throw new ViewerError('REF_QUOTA_EXCEEDED','分页引用配额已满。');
    this.retained(bytes);this.bytes+=bytes;this.cursors.set(cursor,{source,query,offset,bytes});return cursor;
  }
  resume<T>(source:string,query:string,cursor?:string):T|undefined {
    if(!cursor)return;this.page(source,query,cursor);return this.cursors.get(cursor)?.value as T|undefined;
  }
  continue(source:string,query:string,value:unknown) {
    const copy=structuredClone(value),bytes=agentRetainedBytes(copy);if(this.bytes+bytes>16*1024*1024)throw new ViewerError('REF_QUOTA_EXCEEDED','分页引用配额已满。');
    const cursor=this.next(source,query,0);try{this.retained(bytes);this.bytes+=bytes;const entry=this.cursors.get(cursor)!;entry.bytes+=bytes;entry.value=copy;return cursor;}catch(error){this.removeCursor(cursor);throw error;}
  }
}
export function agentHash(value: string | Uint8Array) { return createHash('sha256').update(value).digest('hex'); }
