import { MotionPresence, usePresence } from './MotionPresence';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { useEffect, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, Bold, Code, Copy, FilePlus2, Heading2, Highlighter, Italic, Languages, MessageSquare, MoveHorizontal, Pencil, Quote, Send, Sparkles, Strikethrough, Underline, X } from 'lucide-react';
import { call } from '../lib/transport';
import { applyAppearance } from '../lib/appearance';
import type { ReadingSnapshot, ReadingContext, Rect } from '../../../../../packages/contracts/src/index';
import type { SettingsSnapshot } from '../../../../../packages/settings/src/index';
type Tool = { id: string; label: string; input: boolean };
type State = { snapshot: ReadingSnapshot; actions: Tool[] };
const icons:Record<string,typeof Copy>={copy:Copy,citation:Quote,extract:FilePlus2,note:MessageSquare,highlight:Highlighter,underline:Underline,strike:Strikethrough,bold:Bold,italic:Italic,code:Code,replace:Pencil,heading:Heading2,'align-left':AlignLeft,'align-center':AlignCenter,'center-object':MoveHorizontal,translate:Languages,ask:Sparkles};
export function SelectionTools({native=false}:{native?:boolean}) {
  const [state,setState]=useState<State>(),[rect,setRect]=useState<Rect>(),[input,setInput]=useState<Tool>(),[value,setValue]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const sequence=useRef(0),toolbar=useRef<HTMLDivElement>(null);
  const inputMotion=usePresence(!!input,{duration:160}),errorMotion=usePresence(!!error&&!input,{duration:150});
  const clear=()=>{sequence.current++;setState(undefined);setInput(undefined);setError('');if(native)void call('toolbar-action',{action:'dismiss'});};
  useEffect(()=>{
    if(native){document.documentElement.classList.add('native-toolbar-root');const receive=(data:Record<string,unknown>)=>{if(data.visible===false){setState(undefined);setInput(undefined);return;}const incoming=data.selection as State|undefined;if(incoming){setState(incoming);setRect({x:8,y:8,width:1,height:1});}applyAppearance(data.settings as SettingsSnapshot|undefined);};void call<Record<string,unknown>>('toolbar-state').then(receive);return window.agentViewer?.onSelectionTool(receive);}
    const selected=async(event:Event)=>{const data=(event as CustomEvent<{viewId:string;revision:number;selection:ReadingContext['selection']}>).detail;
      if(!data?.selection.rect || data.selection.kind==='none'){clear();return;}
      const seq=++sequence.current;setInput(undefined);setError('');
      try {await call('report-context',{viewId:data.viewId,context:{contentRevision:data.revision,selection:data.selection}});const result=await call<State>('selection-tools',{viewId:data.viewId});if(seq!==sequence.current)return;setState(result);setRect(data.selection.rect);}catch(e){setError(String(e));}
    };
    const dismiss=(event:Event)=>{if(toolbar.current?.contains(event.target as Node))return;clear();};
    window.addEventListener('agentviewer:selection-tools',selected);window.addEventListener('agentviewer:selection-clear',clear);document.addEventListener('pointerdown',dismiss);document.addEventListener('scroll',dismiss,true);
    return()=>{window.removeEventListener('agentviewer:selection-tools',selected);window.removeEventListener('agentviewer:selection-clear',clear);document.removeEventListener('pointerdown',dismiss);document.removeEventListener('scroll',dismiss,true);};
  },[native]);
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')clear();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[]);
  useEffect(()=>{if(native)void call('toolbar-panel',{expanded:inputMotion.present||errorMotion.present});},[native,inputMotion.present,errorMotion.present]);
  const run=async(tool:Tool,submit=false)=>{
    if(!state||busy)return;if(tool.input&&!submit){setError('');setInput(input?.id===tool.id?undefined:tool);setValue(tool.id==='replace'?state.snapshot.context.selection.text:'');return;}
    setBusy(true);setError('');try{
      const requestId = crypto.randomUUID();
      if (!native) window.dispatchEvent(new CustomEvent('agentviewer:selection-start', { detail: { action: tool.id, requestId, snapshot: state.snapshot } }));
      const result=await call<any>('selection-action',{snapshotId:state.snapshot.id,action:tool.id,value:tool.input?value:undefined,idempotencyKey:requestId});
      if(result.text&&(tool.id==='copy'||tool.id==='citation'))await navigator.clipboard.writeText(result.text);
      const detail={action:tool.id,result,snapshot:state.snapshot};if(native)await call('toolbar-action',{action:'result',detail});else window.dispatchEvent(new CustomEvent('agentviewer:selection-result',{detail}));
      clear();
    }catch(e){setError(String(e));}finally{setBusy(false);}
  };
  const show=!!state&&!!rect;
  const width=Math.min(600,((state?.actions.length??0)+1)*32+16),left=native?8:Math.max(12,Math.min(innerWidth-width-12,(rect?.x??0)+(rect?.width??0)/2-width/2));
  const top=native?8:Math.max(64,Math.min(innerHeight-(inputMotion.present?240:65),(rect?.y??0)>130?(rect?.y??0)-54:(rect?.y??0)+(rect?.height??0)+10));
  return <MotionPresence show={show} surface="selection" duration={140}>{state&&rect&&<div ref={toolbar} className="selection-tools" data-paper={!native&&['pdf','docx','pptx','html'].includes(state.snapshot.document.format)||undefined} role="toolbar" aria-label="选区工具" style={{left,top,maxWidth:native?'calc(100vw - 16px)':width}}>
    <div className="selection-tool-icons material-host"><LiquidGlassSurface variant="capsule" fallback={native} />{state.actions.map(tool=>{const Icon=icons[tool.id]??Pencil;return <button key={tool.id} className={'icon-button '+(input?.id===tool.id?'selected':'')} aria-label={tool.label} aria-expanded={tool.input?input?.id===tool.id:undefined} aria-controls={tool.input?'selection-editor':undefined} title={tool.label} disabled={busy} onMouseDown={e=>e.preventDefault()} onClick={()=>void run(tool)}><Icon size={16}/></button>;})}<button className="icon-button" title="关闭选区工具" aria-label="关闭选区工具" onMouseDown={e=>e.preventDefault()} onClick={clear}><X size={14}/></button></div>
    <MotionPresence show={!!input} duration={160}>{input&&<form id="selection-editor" className="selection-input material-host" onSubmit={e=>{e.preventDefault();void run(input,true);}}><LiquidGlassSurface variant="panel" fallback={native} /><label>{input.label}<textarea autoFocus aria-label={input.label} value={value} onChange={e=>setValue(e.target.value)}/></label><button className="button primary" disabled={busy||!value.trim()}><Send size={14}/>{busy?'处理中…':'应用'}</button>{error&&<p role="alert" className="selection-inline-error">{error}</p>}</form>}</MotionPresence>
    <MotionPresence show={!!error&&!input} duration={150}>{error&&!input&&<p className="selection-error material-host" role="alert"><LiquidGlassSurface variant="panel" fallback={native} />{error}</p>}</MotionPresence>
  </div>}</MotionPresence>;
}
