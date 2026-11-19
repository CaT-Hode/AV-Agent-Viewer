import type { DocumentInfo } from '../../../../../packages/contracts/src/index';
import { call } from './transport';

export type FindOptions = { text: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean };
export type FindHit = { label: string; before: string; match: string; after: string };
export type FindBatch = { hits: FindHit[]; limited?: boolean; note?: string; reveal(index: number): void | Promise<void>; replace?(index: number | 'all', text: string): void; clear?(): void };
type Provider = (options: FindOptions, signal: AbortSignal) => Promise<FindBatch> | FindBatch;
const providers = new Map<string, Set<Provider>>();
export function findChanged(viewId?: string) { window.dispatchEvent(new CustomEvent('reader-find-changed',{detail:viewId})); }
export function registerFind(viewId: string, provider: Provider) {
  const set = providers.get(viewId) ?? new Set(); set.add(provider); providers.set(viewId,set); findChanged(viewId);
  return () => { set.delete(provider); if (!set.size) providers.delete(viewId); };
}
export function findPattern(options: FindOptions) {
  const literal = options.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern = options.regexp ? options.text : literal;
  if (options.wholeWord) pattern = '(?<![\\p{L}\\p{N}_])(?:'+pattern+')(?![\\p{L}\\p{N}_])';
  return new RegExp(pattern,options.caseSensitive?'gmu':'gimu');
}
export function snippet(source: string, from: number, to: number, label: string): FindHit {
  return { label, before:source.slice(Math.max(0,from-36),from), match:source.slice(from,Math.min(to,from+120)), after:source.slice(to,to+60) };
}
export async function findInView(doc:DocumentInfo, viewId:string, options:FindOptions, signal:AbortSignal):Promise<FindBatch> {
  const set = providers.get(viewId);
  if (set?.size) return [...set].at(-1)!(options,signal);
  if (!['web','docx','xlsx','pptx'].includes(doc.format)) throw new Error('阅读视图正在加载。');
  const token=crypto.randomUUID();
  const send=(action:string,index?:number)=>call<{hits:FindHit[];limited?:boolean;note?:string}>('reader-find',{viewId,action,token,index,text:options.text,caseSensitive:options.caseSensitive});
  const cleanup=()=>{void send('clear').catch(()=>{});};
  signal.addEventListener('abort',cleanup,{once:true});
  const result=await send('search');
  return {...result,reveal:async i=>{await send('reveal',i);}};
}
