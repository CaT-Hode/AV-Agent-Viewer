import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { DocumentInfo } from '../../../../../packages/contracts/src/index';
import { findInView, type FindBatch } from '../lib/reader-find';
import './reader-find.css';

export function ReaderFind({file,viewId,intent,initialQuery,onQuery,onClose}:{file:DocumentInfo;viewId:string;intent:{sequence:number;replace:boolean;viewId?:string;query?:string};initialQuery:string;onQuery(text:string):void;onClose():void}) {
  const [text,setText]=useState(initialQuery),[replacement,setReplacement]=useState(''),[showReplace,setShowReplace]=useState(intent.viewId===viewId&&intent.replace);
  const [caseSensitive,setCase]=useState(false),[wholeWord,setWord]=useState(false),[regexp,setRegex]=useState(false);
  const [generation,refresh]=useState(0),[batch,setBatch]=useState<FindBatch>(),[active,setActive]=useState(-1),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const input=useRef<HTMLInputElement>(null),latest=useRef(file); latest.current=file;
  const markdown=file.format==='markdown';
  const lastIntent=useRef(intent.sequence);
  useEffect(()=>{if(intent.viewId===viewId){setShowReplace(intent.replace);if(lastIntent.current!==intent.sequence&&intent.query!==undefined)setText(intent.query);}lastIntent.current=intent.sequence;input.current?.focus();input.current?.select();},[intent,viewId]);
  useEffect(()=>{const update=(event:Event)=>{if((event as CustomEvent).detail===viewId)refresh(g=>g+1);};window.addEventListener('reader-find-changed',update);return()=>window.removeEventListener('reader-find-changed',update);},[viewId]);
  useEffect(()=>{
    const controller=new AbortController();let found:FindBatch|undefined;
    setBatch(undefined);setActive(-1);setError('');setBusy(!!text);
    if(!text)return;
    const timer=setTimeout(async()=>{try{
      found=await findInView(latest.current,viewId,{text,caseSensitive,wholeWord:markdown&&wholeWord,regexp:markdown&&regexp},controller.signal);
      if(!controller.signal.aborted)setBatch(found);else found.clear?.();
    }catch(e){if(!controller.signal.aborted)setError(String(e instanceof Error?e.message:e));}finally{if(!controller.signal.aborted)setBusy(false);}},120);
    return()=>{clearTimeout(timer);controller.abort();found?.clear?.();};
  },[text,caseSensitive,wholeWord,regexp,generation,viewId,markdown,file.revision,file.nativeOffice?.engineRevision]);
  const reveal=(index:number)=>{if(!batch?.hits.length)return;const i=(index+batch.hits.length)%batch.hits.length;setActive(i);void Promise.resolve().then(()=>batch.reveal(i)).catch(e=>setError(String(e)));};
  const step=(back:boolean)=>reveal(active<0?(back?(batch?.hits.length??1)-1:0):active+(back?-1:1));
  const close=()=>{onClose();};
  // The web sidebar is a portal in a separate document. Listen in its window as well.
  useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(e.isComposing||e.defaultPrevented||(e.target as Element|null)?.closest?.('[role=dialog],dialog'))return;if(e.key==='F3'){e.preventDefault();e.stopPropagation();step(e.shiftKey);}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'&&!e.shiftKey&&e.currentTarget!==window){e.preventDefault();input.current?.select();}};const forwarded=(event:Event)=>{const d=(event as CustomEvent).detail;if(d.viewId===viewId)step(!!d.back);};window.addEventListener('reader-find-step',forwarded);const owners=new Set([window,input.current?.ownerDocument.defaultView]);for(const owner of owners)owner?.addEventListener('keydown',handler,true);return()=>{window.removeEventListener('reader-find-step',forwarded);for(const owner of owners)owner?.removeEventListener('keydown',handler,true);};});
  const replace=(which:number|'all')=>{try{batch?.replace?.(which,replacement);refresh(g=>g+1);}catch(e){setError(String(e));}};
  const count = text && batch ? (active >= 0 ? (active + 1) + ' / ' : '共 ') + batch.hits.length + (batch.limited ? ' 处以上' : ' 处') : '';
  return <section className="reader-find" aria-label="查找当前文档">
    <input ref={input} type="search" aria-label="查找当前文档" placeholder="查找当前文档" value={text}
      onChange={e=>{setText(e.target.value);onQuery(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();step(e.shiftKey);}}}/>
    <div className="find-navigation">
      <span role="status">{busy ? '正在查找…' : count}</span>
      <button aria-label="上一处" onClick={()=>step(true)} disabled={!batch?.hits.length}><ChevronUp size={15}/></button>
      <button aria-label="下一处" onClick={()=>step(false)} disabled={!batch?.hits.length}><ChevronDown size={15}/></button>
      <button aria-label="关闭查找" onClick={close}><X size={15}/></button>
    </div>
    <div className="find-options"><button aria-pressed={caseSensitive} onClick={()=>setCase(!caseSensitive)}>区分大小写</button>{markdown&&<><button aria-pressed={wholeWord} onClick={()=>setWord(!wholeWord)}>整词</button><button aria-pressed={regexp} onClick={()=>setRegex(!regexp)}>正则</button><button aria-pressed={showReplace} onClick={()=>setShowReplace(!showReplace)}>替换</button></>}</div>
    {showReplace&&markdown&&<div className="find-replace">
      <input type="text" aria-label="替换为" placeholder="替换为" value={replacement} onChange={e=>setReplacement(e.target.value)}/>
      <button disabled={!batch?.replace||!batch.hits.length} onClick={()=>replace(Math.max(0,active))}>替换当前</button>
      <button disabled={!batch?.replace||!batch.hits.length} onClick={()=>replace('all')}>全部替换</button>
    </div>}
    {(error || batch?.note || batch?.limited) && <p role="status">{error || batch?.note || '已达显示上限'}</p>}
  <ol>{batch?.hits.map((h,i)=><li key={i}><button aria-current={active===i?'true':undefined} onClick={()=>reveal(i)}><small>{h.label}</small><span>{h.before}<mark>{h.match||'▏'}</mark>{h.after}</span></button></li>)}</ol></section>;
}
