import { MotionPresence, usePresence } from './MotionPresence';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { NavigationGlass } from './NavigationGlass';
import { clippedReaderViewport, placeSelectionToolbar } from '../lib/selection-position';
import type { NavigationBackdropSample, NavigationBounds } from '../lib/navigation-optics';
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
  const [viewport,setViewport]=useState<Rect>(),[backdrop,setBackdrop]=useState<{image?:string;sample?:NavigationBackdropSample}>({}),[glassBounds,setGlassBounds]=useState<NavigationBounds>(),[surface,setSurface]=useState<'light'|'dark'>();
  const sequence=useRef(0),toolbar=useRef<HTMLDivElement>(null),glass=useRef<HTMLDivElement>(null),identity=useRef('');
  const tracked=useRef<{viewId:string;revision:number;text:string;range?:Range;element?:Element}|undefined>(undefined);
  const inputMotion=usePresence(!!input,{duration:160}),errorMotion=usePresence(!!error&&!input,{duration:150});
  const clear=()=>{sequence.current++;identity.current='';tracked.current=undefined;setState(undefined);setRect(undefined);setInput(undefined);setError('');if(native)void call('toolbar-action',{action:'dismiss'});};
  const geometry=useCallback((bounds:NavigationBounds)=>{setGlassBounds(old=>old&&['x','y','width','height'].every(key=>Math.abs(old[key as keyof NavigationBounds]-bounds[key as keyof NavigationBounds])<.125)?old:bounds);if(native)void call('toolbar-action',{action:'geometry',capsuleBounds:bounds}).catch(()=>{});},[native]);
  useLayoutEffect(()=>{const node=glass.current;if(!node)return;const measure=()=>{const box=node.getBoundingClientRect();geometry({x:box.x,y:box.y,width:box.width,height:box.height});};const observer=new ResizeObserver(measure);observer.observe(node);measure();return()=>observer.disconnect();},[!!state,geometry,rect?.x,rect?.y]);
  useEffect(()=>{
    if(native){document.documentElement.classList.add('native-toolbar-root');const receive=(data:Record<string,unknown>)=>{if(data.action==='backdrop'){setBackdrop(old=>({image:typeof data.backdropImage==='string'?data.backdropImage:data.backdropSample?old.image:undefined,sample:data.backdropSample as NavigationBackdropSample|undefined}));return;}if(data.visible===false){setState(undefined);setInput(undefined);return;}const incoming=data.selection as State|undefined;if(incoming){setState(incoming);setRect({x:8,y:8,width:1,height:1});}if('backdropImage'in data)setBackdrop({image:data.backdropImage as string|undefined,sample:data.backdropSample as NavigationBackdropSample|undefined});applyAppearance(data.settings as SettingsSnapshot|undefined);};void call<Record<string,unknown>>('toolbar-state',{backdropPatches:true}).then(receive);return window.agentViewer?.onSelectionTool(receive);}
    const selected=async(event:Event)=>{const data=(event as CustomEvent<{viewId:string;revision:number;selection:ReadingContext['selection']}>).detail;
      if(!data?.selection.rect || data.selection.kind==='none'){clear();return;}
      const key=JSON.stringify([data.viewId,data.revision,data.selection.kind,data.selection.text,data.selection.locator]);
      setRect(data.selection.rect);const reader=document.querySelector('.document-content');if(reader){const b=reader.getBoundingClientRect();setViewport({x:b.x,y:b.y,width:b.width,height:b.height});}
      if(identity.current===key)return;
      identity.current=key;setState(undefined);
      const live=window.getSelection(),range=live?.rangeCount&&live.toString()===data.selection.text?live.getRangeAt(0).cloneRange():undefined;
      const locator=data.selection.locator,cell=locator?.cell?.split(':')[0],element=range?(range.startContainer instanceof Element?range.startContainer:range.startContainer.parentElement):locator?.shapeId?reader?.querySelector(`[data-shape-id="${CSS.escape(locator.shapeId)}"]`):cell?reader?.querySelector(`td[data-address="${CSS.escape(cell)}"]`):undefined;
      tracked.current={viewId:data.viewId,revision:data.revision,text:data.selection.text,range,element:element??undefined};
      const seq=++sequence.current;setInput(undefined);setError('');
      try {await call('report-context',{viewId:data.viewId,context:{contentRevision:data.revision,selection:data.selection}});const result=await call<State>('selection-tools',{viewId:data.viewId});if(seq!==sequence.current)return;setState(result);}catch(e){if(seq===sequence.current)setError(String(e));}
    };
    const open=async(event:Event)=>{const data=(event as CustomEvent<{viewId:string;action:string}>).detail;if(!data?.viewId)return;const seq=++sequence.current;try{const result=await call<State>('selection-tools',{viewId:data.viewId});if(seq!==sequence.current||!result.snapshot.context.selection.rect)return;const tool=result.actions.find(item=>item.id===data.action);if(!tool)return;setState(result);setRect(result.snapshot.context.selection.rect);setInput(tool.input?tool:undefined);setValue('');setError('');const reader=document.querySelector('.document-content')?.getBoundingClientRect();if(reader)setViewport({x:reader.x,y:reader.y,width:reader.width,height:reader.height});}catch(cause){if(seq===sequence.current)setError(String(cause));}};
    const dismiss=(event:Event)=>{if(toolbar.current?.contains(event.target as Node))return;clear();};
    let frame=0;
    const follow=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;const target=tracked.current;if(!target||!target.range&&!target.element)return;const node=target.range?.startContainer??target.element;if(!node?.isConnected){clear();return;}const b=target.range?.getBoundingClientRect()??target.element?.getBoundingClientRect();if(!b)return;const next={x:b.x,y:b.y,width:b.width,height:b.height};setRect(next);if(target.element){const clip=clippedReaderViewport(target.element);if(clip)setViewport(clip);}window.dispatchEvent(new CustomEvent('agentviewer:selection-position',{detail:{viewId:target.viewId,revision:target.revision,text:target.text,rect:next}}));});};
    const changed=()=>{const target=tracked.current;if(!target?.range||toolbar.current?.contains(document.activeElement))return;const live=window.getSelection();if(!live?.rangeCount||!live.toString()){clear();return;}const current=live.getRangeAt(0),saved=target.range;if(live.toString()!==target.text||current.startContainer!==saved.startContainer||current.startOffset!==saved.startOffset||current.endContainer!==saved.endContainer||current.endOffset!==saved.endOffset)clear();};
    // Clear the previous selection before React publishes the selection made
    // by this pointerdown. Bubbling here would cancel a cell's new request.
    const size=new ResizeObserver(follow),watchReader=()=>{const reader=document.querySelector('.document-content');size.disconnect();if(reader)size.observe(reader);};
    window.addEventListener('agentviewer:selection-tools',selected);window.addEventListener('agentviewer:selection-tools',watchReader);window.addEventListener('agentviewer:selection-open',open);window.addEventListener('agentviewer:selection-clear',clear);document.addEventListener('pointerdown',dismiss,true);document.addEventListener('scroll',follow,true);document.addEventListener('selectionchange',changed);window.addEventListener('resize',follow);
    return()=>{size.disconnect();cancelAnimationFrame(frame);window.removeEventListener('agentviewer:selection-tools',selected);window.removeEventListener('agentviewer:selection-tools',watchReader);window.removeEventListener('agentviewer:selection-open',open);window.removeEventListener('agentviewer:selection-clear',clear);document.removeEventListener('pointerdown',dismiss,true);document.removeEventListener('scroll',follow,true);document.removeEventListener('selectionchange',changed);window.removeEventListener('resize',follow);};
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
  const width=Math.min(600,((state?.actions.length??0)+1)*32+16),position=rect&&placeSelectionToolbar(rect,viewport??{x:0,y:64,width:innerWidth,height:innerHeight-64},{width,height:42});
  const show=!!state&&!!rect&&(native||!!position),left=native?8:position?.x??0,top=native?8:position?.y??0;
  return <MotionPresence show={show} surface="selection" duration={140}>{state&&rect&&<div ref={toolbar} className="selection-tools" data-paper={!native&&['pdf','docx','pptx','html'].includes(state.snapshot.document.format)||undefined} role="toolbar" aria-label="选区工具" style={{left,top,maxWidth:native?'calc(100vw - 16px)':position?.width ?? width}}>
    <div ref={glass} data-navigation-surface={surface} className="selection-tool-icons material-host floating-capsule navigation-capsule" style={{'--navigation-hide-progress':0} as CSSProperties}><NavigationGlass backdropImage={backdrop.image} backdropSample={backdrop.sample} capsuleBounds={glassBounds} onSurface={setSurface} /><div className="selection-tool-row">{state.actions.map(tool=>{const Icon=icons[tool.id]??Pencil;return <button key={tool.id} className={'icon-button '+(input?.id===tool.id?'selected':'')} aria-label={tool.label} aria-expanded={tool.input?input?.id===tool.id:undefined} aria-controls={tool.input?'selection-editor':undefined} title={tool.label} disabled={busy} onMouseDown={e=>e.preventDefault()} onClick={()=>void run(tool)}><Icon size={16}/></button>;})}<button className="icon-button" title="关闭选区工具" aria-label="关闭选区工具" onMouseDown={e=>e.preventDefault()} onClick={clear}><X size={14}/></button></div></div>
    <MotionPresence show={!!input} duration={160}>{input&&<form id="selection-editor" className="selection-input material-host" onSubmit={e=>{e.preventDefault();void run(input,true);}}><LiquidGlassSurface variant="panel" fallback={native} /><label>{input.label}<textarea autoFocus aria-label={input.label} value={value} onChange={e=>setValue(e.target.value)}/></label><button className="button primary" disabled={busy||!value.trim()}><Send size={14}/>{busy?'处理中…':'应用'}</button>{error&&<p role="alert" className="selection-inline-error">{error}</p>}</form>}</MotionPresence>
    <MotionPresence show={!!error&&!input} duration={150}>{error&&!input&&<p className="selection-error material-host" role="alert"><LiquidGlassSurface variant="panel" fallback={native} />{error}</p>}</MotionPresence>
  </div>}</MotionPresence>;
}
