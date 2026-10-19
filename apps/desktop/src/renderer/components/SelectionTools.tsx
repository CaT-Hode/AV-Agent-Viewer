import { MotionPresence, usePresence } from './MotionPresence';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { NavigationGlass } from './NavigationGlass';
import { clippedReaderViewport, placeSelectionToolbar, readSelectionNavigationBounds, readSelectionPanelBounds, SELECTION_NAVIGATION_EVENT, type SelectionNavigationBounds } from '../lib/selection-position';
import { useSelectionToolbarMotion } from '../lib/use-selection-toolbar-motion';
import type { NavigationBackdropSample, NavigationBounds } from '../lib/navigation-optics';
import { AlignCenter, AlignLeft, Bold, Code, Copy, FilePlus2, Heading2, Highlighter, Italic, Languages, MessageSquare, MoveHorizontal, Pencil, Quote, Send, Sparkles, Strikethrough, Underline, X } from 'lucide-react';
import { call } from '../lib/transport';
import { applyAppearance } from '../lib/appearance';
import type { ReadingSnapshot, ReadingContext, SelectionContext, Rect } from '../../../../../packages/contracts/src/index';
import type { SettingsSnapshot } from '../../../../../packages/settings/src/index';
import { OFFICE_SELECTION_EVENTS, type OfficeSelectionToolsEvent } from '../lib/office-surface-selection';
import { useGlassSpringValue } from '../lib/glass-elasticity';
import { KUBE_GLASS_SPRINGS } from '../lib/glass-presets';
type Tool = { id: string; label: string; input: boolean };
type State = { snapshot: ReadingSnapshot | SelectionContext; actions: Tool[] };
const icons:Record<string,typeof Copy>={copy:Copy,citation:Quote,extract:FilePlus2,note:MessageSquare,highlight:Highlighter,underline:Underline,strike:Strikethrough,bold:Bold,italic:Italic,code:Code,replace:Pencil,heading:Heading2,'align-left':AlignLeft,'align-center':AlignCenter,'center-object':MoveHorizontal,translate:Languages,ask:Sparkles};
export function SelectionTools({native=false}:{native?:boolean}) {
  const [state,setState]=useState<State>(),[rect,setRect]=useState<Rect>(),[input,setInput]=useState<Tool>(),[value,setValue]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [viewport,setViewport]=useState<Rect>(),[backdrop,setBackdrop]=useState<{image?:string;sample?:NavigationBackdropSample}>({}),[glassBounds,setGlassBounds]=useState<NavigationBounds>(),[surface,setSurface]=useState<'light'|'dark'>();
  const navigationBounds=useRef<Rect|undefined>(undefined);
  const [,refreshNavigationPlacement]=useState(0),navigationPlacement=useRef(true),canPlaceAroundNavigation=useRef<(bounds:Rect|undefined)=>boolean>(()=>true);
  const [panelBounds,setPanelBounds]=useState<Rect[]>([]);
  const motionRefresh=useRef<()=>void>(()=>{});
  const [opticsReady,setOpticsReady]=useState(false),[backdropReady,setBackdropReady]=useState(!native);
  const preferences=window.document.documentElement.dataset,sourceRequired=native&&preferences.glass!=='off'&&preferences.contrast!=='high'&&preferences.reduceTransparency!=='true';
  useEffect(()=>{if(!sourceRequired){setBackdropReady(true);return;}if(!backdrop.image){setBackdropReady(false);return;}if(backdropReady)return;let active=true;const image=new Image();image.src=backdrop.image;void image.decode().then(()=>{if(active)setBackdropReady(true);}).catch(()=>{});return()=>{active=false;};},[sourceRequired,backdrop.image,backdropReady]);
  const sequence=useRef(0),toolbar=useRef<HTMLDivElement>(null),glass=useRef<HTMLDivElement>(null),identity=useRef(''),nativePresentation=useRef('');
  const tracked=useRef<{viewId:string;revision:number;text:string;range?:Range;element?:Element}|undefined>(undefined);
  const engineSelection=useRef<{viewId:string;lease:string;state:State;rect:Rect;viewport:Rect}|undefined>(undefined);
  const inputMotion=usePresence(!!input,{duration:160}),errorMotion=usePresence(!!error&&!input,{duration:150});
  useLayoutEffect(()=>{
    if(native||!state||!rect){navigationBounds.current=undefined;return;}
    let frame=0;
    const update=(next:Rect|undefined)=>{
      navigationBounds.current=next;
      const possible=canPlaceAroundNavigation.current(next);
      // The motion controller follows every actual capsule coordinate. React
      // only needs a commit when an impossible placement appears/disappears.
      if(possible!==navigationPlacement.current){navigationPlacement.current=possible;refreshNavigationPlacement(version=>version+1);}
      // Navigation publishes from the shared layout write phase. Defer the
      // motion controller's live Range/panel reads to the next frame.
      if(!frame)frame=requestAnimationFrame(()=>{frame=0;motionRefresh.current();});
    };
    const receive=(event:Event)=>{const detail=(event as CustomEvent<SelectionNavigationBounds>).detail;update(detail.visible?detail.bounds:undefined);};
    update(readSelectionNavigationBounds());
    window.addEventListener(SELECTION_NAVIGATION_EVENT,receive);return()=>{cancelAnimationFrame(frame);window.removeEventListener(SELECTION_NAVIGATION_EVENT,receive);};
  },[native,!!state,!!rect]);
  useLayoutEffect(()=>{
    if(native||!state)return;
    const workbench=document.querySelector('.workbench');if(!workbench)return;
    let frame=0;
    const read=()=>{const next=readSelectionPanelBounds(workbench);setPanelBounds(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);motionRefresh.current();};
    const measure=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(read);};
    const sizes=new ResizeObserver(read),changes=new MutationObserver(records=>{if(records.some(record=>record.type==='childList'))observe();motionRefresh.current();measure();});
    const observe=()=>{sizes.disconnect();changes.disconnect();changes.observe(workbench,{childList:true,attributes:true,attributeFilter:['style']});for(const pane of workbench.querySelectorAll(':scope > .floating-side-panel,:scope > .activity-rail,:scope > .ai-rail')){sizes.observe(pane);changes.observe(pane,{attributes:true,attributeFilter:['class','style','data-motion-phase']});}};
    observe();read();return()=>{cancelAnimationFrame(frame);sizes.disconnect();changes.disconnect();};
  },[native,!!state]);
  const clear=(notifyEngine=true)=>{const engine=engineSelection.current;engineSelection.current=undefined;sequence.current++;identity.current='';tracked.current=undefined;setState(undefined);setRect(undefined);setInput(undefined);setError('');if(engine&&notifyEngine)window.dispatchEvent(new CustomEvent(OFFICE_SELECTION_EVENTS.dismiss,{detail:{viewId:engine.viewId,lease:engine.lease}}));if(native)void call('toolbar-action',{action:'dismiss'});};
  const geometry=useCallback((bounds:NavigationBounds)=>{setGlassBounds(old=>old&&['x','y','width','height'].every(key=>Math.abs(old[key as keyof NavigationBounds]-bounds[key as keyof NavigationBounds])<.125)?old:bounds);if(native)void call('toolbar-action',{action:'geometry',capsuleBounds:bounds}).catch(()=>{});},[native]);
  useLayoutEffect(()=>{const node=glass.current;if(!native||!node)return;const measure=()=>{const box=node.getBoundingClientRect();geometry({x:box.x,y:box.y,width:box.width,height:box.height});};const observer=new ResizeObserver(measure);observer.observe(node);measure();return()=>observer.disconnect();},[native,!!state,geometry,rect?.x,rect?.y]);
  useEffect(()=>{
    if(native){
      document.documentElement.classList.add('native-toolbar-root');
      const receive=(data:Record<string,unknown>)=>{
        if(data.action==='backdrop'){if(!data.backdropSample&&typeof data.backdropImage!=='string')setBackdropReady(false);setBackdrop(old=>({image:typeof data.backdropImage==='string'?data.backdropImage:data.backdropSample?old.image:undefined,sample:data.backdropSample as NavigationBackdropSample|undefined}));return;}
        if(data.visible===false){sequence.current++;nativePresentation.current='';setBackdropReady(false);setBackdrop({});setState(undefined);setInput(undefined);return;}
        const incoming=data.selection as State|undefined;
        if(incoming){
          if(nativePresentation.current!==incoming.snapshot.id){nativePresentation.current=incoming.snapshot.id;sequence.current++;setBackdropReady(false);setSurface(undefined);setInput(undefined);setError('');}
          setState(incoming);setRect({x:8,y:8,width:1,height:1});
        }
        if('backdropImage'in data)setBackdrop({image:data.backdropImage as string|undefined,sample:data.backdropSample as NavigationBackdropSample|undefined});
        applyAppearance(data.settings as SettingsSnapshot|undefined);
      };
      void call<Record<string,unknown>>('toolbar-state',{backdropPatches:true}).then(receive);return window.agentViewer?.onSelectionTool(receive);
    }
    const selected=async(event:Event)=>{const data=(event as CustomEvent<{viewId:string;revision:number;selection:ReadingContext['selection']}>).detail;
      engineSelection.current=undefined;
      if(!data?.selection.rect || data.selection.kind==='none'){clear();return;}
      const key=JSON.stringify([data.viewId,data.revision,data.selection.kind,data.selection.text,data.selection.locator]);
      setRect(data.selection.rect);const reader=document.querySelector('.document-content');if(reader){const b=reader.getBoundingClientRect();setViewport({x:b.x,y:b.y,width:b.width,height:b.height});}
      if(identity.current===key)return;
      identity.current=key;setState(undefined);
      const live=window.getSelection(),range=live?.rangeCount&&live.toString()===data.selection.text?live.getRangeAt(0).cloneRange():undefined;
      const locator=data.selection.locator,cell=locator?.cell?.split(':')[0],element=range?(range.startContainer instanceof Element?range.startContainer:range.startContainer.parentElement):locator?.shapeId?reader?.querySelector(`[data-shape-id="${CSS.escape(locator.shapeId)}"]`):cell?reader?.querySelector(`td[data-address="${CSS.escape(cell)}"]`):undefined;
      tracked.current={viewId:data.viewId,revision:data.revision,text:data.selection.text,range,element:element??undefined};
      const seq=++sequence.current;setInput(undefined);setError('');
      try {await call('report-context',{viewId:data.viewId,context:{contentRevision:data.revision,selection:data.selection}});if(seq!==sequence.current)return;const result=await call<State>('selection-tools',{viewId:data.viewId,lightweight:true,expected:{kind:'text-selection',revision:data.revision,selection:{kind:data.selection.kind,text:data.selection.text,locator:data.selection.locator}}});if(seq!==sequence.current)return;setState(result);}catch(e){if(seq===sequence.current)setError(String(e));}
    };
    const open=async(event:Event)=>{
      const data=(event as CustomEvent<{viewId:string;action:string}>).detail;if(!data?.viewId)return;
      const seq=++sequence.current,engine=engineSelection.current?.viewId===data.viewId?engineSelection.current:undefined;
      try{
        // The Office bridge already owns a confirmed bounded context and its
        // real projected rectangle. Opening a note uses that same lease;
        // action execution still validates it against the live native source.
        const result=engine?.state??await call<State>('selection-tools',{viewId:data.viewId,lightweight:true}),selectionRect=engine?.rect??result.snapshot.context.selection.rect;
        if(seq!==sequence.current||!selectionRect||engine&&engineSelection.current!==engine)return;
        const tool=result.actions.find(item=>item.id===data.action);if(!tool)return;
        setState(result);setRect(selectionRect);setInput(tool.input?tool:undefined);setValue('');setError('');
        if(engine)setViewport(engine.viewport);else{const reader=document.querySelector('.document-content')?.getBoundingClientRect();if(reader)setViewport({x:reader.x,y:reader.y,width:reader.width,height:reader.height});}
      }catch(cause){if(seq===sequence.current)setError(String(cause));}
    };
    const engineReady=(event:Event)=>{const data=(event as CustomEvent<OfficeSelectionToolsEvent>).detail;if(!data)return;if(!data.visible){if(engineSelection.current?.viewId===data.viewId)clear(false);return;}if(!data.state||!data.rect||!data.viewport)return;const same=engineSelection.current?.viewId===data.viewId&&engineSelection.current.lease===data.lease;engineSelection.current={viewId:data.viewId,lease:data.lease,state:data.state,rect:data.rect,viewport:data.viewport};tracked.current=undefined;setRect(data.rect);setViewport(data.viewport);setState(data.state);if(!same){sequence.current++;identity.current=data.lease;setInput(undefined);setError('');}};
    const dismiss=(event:Event)=>{if(toolbar.current?.contains(event.target as Node)||(event.target instanceof Element&&event.target.closest('.reader-panel-resize,.activity-rail,.ai-rail')))return;clear();};
    const preserveChromeSelection=(event:MouseEvent)=>{if((tracked.current||engineSelection.current)&&event.target instanceof Element&&event.target.closest('.activity-rail,.ai-rail'))event.preventDefault();};
    let frame=0;
    const follow=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;const target=tracked.current;if(!target||!target.range&&!target.element)return;const node=target.range?.startContainer??target.element;if(!node?.isConnected){clear();return;}const b=target.range?.getBoundingClientRect()??target.element?.getBoundingClientRect();if(!b)return;const next={x:b.x,y:b.y,width:b.width,height:b.height};setRect(next);if(target.element){const clip=clippedReaderViewport(target.element);if(clip)setViewport(clip);}window.dispatchEvent(new CustomEvent('agentviewer:selection-position',{detail:{viewId:target.viewId,revision:target.revision,text:target.text,rect:next}}));});};
    const changed=()=>{const target=tracked.current;if(!target?.range||toolbar.current?.contains(document.activeElement))return;const live=window.getSelection();if(!live?.rangeCount||!live.toString()){clear();return;}const current=live.getRangeAt(0),saved=target.range;if(live.toString()!==target.text||current.startContainer!==saved.startContainer||current.startOffset!==saved.startOffset||current.endContainer!==saved.endContainer||current.endOffset!==saved.endOffset)clear();};
    // Clear the previous selection before React publishes the selection made
    // by this pointerdown. Bubbling here would cancel a cell's new request.
    const size=new ResizeObserver(follow),watchReader=()=>{const reader=document.querySelector('.document-content');size.disconnect();if(reader)size.observe(reader);};
    const clearEvent=()=>clear();
    window.addEventListener(OFFICE_SELECTION_EVENTS.ready,engineReady);window.addEventListener('agentviewer:selection-tools',selected);window.addEventListener('agentviewer:selection-tools',watchReader);window.addEventListener('agentviewer:selection-open',open);window.addEventListener('agentviewer:selection-clear',clearEvent);document.addEventListener('pointerdown',dismiss,true);document.addEventListener('mousedown',preserveChromeSelection,true);document.addEventListener('scroll',follow,true);document.addEventListener('selectionchange',changed);window.addEventListener('resize',follow);
    return()=>{size.disconnect();cancelAnimationFrame(frame);window.removeEventListener(OFFICE_SELECTION_EVENTS.ready,engineReady);window.removeEventListener('agentviewer:selection-tools',selected);window.removeEventListener('agentviewer:selection-tools',watchReader);window.removeEventListener('agentviewer:selection-open',open);window.removeEventListener('agentviewer:selection-clear',clearEvent);document.removeEventListener('pointerdown',dismiss,true);document.removeEventListener('mousedown',preserveChromeSelection,true);document.removeEventListener('scroll',follow,true);document.removeEventListener('selectionchange',changed);window.removeEventListener('resize',follow);};
  },[native]);
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')clear();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[]);
  useEffect(()=>{if(native)void call('toolbar-panel',{expanded:inputMotion.present||errorMotion.present});},[native,inputMotion.present,errorMotion.present]);
  const run=async(tool:Tool,submit=false)=>{
    if(!state||busy)return;if(tool.input&&!submit){setError('');setInput(input?.id===tool.id?undefined:tool);setValue(tool.id==='replace'?state.snapshot.context.selection.text:'');return;}
    const generation=sequence.current,requestId=crypto.randomUUID();
    setBusy(true);setError('');try{
      if (!native) window.dispatchEvent(new CustomEvent('agentviewer:selection-start', { detail: { action: tool.id, requestId, snapshot: state.snapshot } }));
      const result=await call<any>('selection-action',{...('kind' in state.snapshot && state.snapshot.kind==='selection-context'?{selectionContextId:state.snapshot.id}:{snapshotId:state.snapshot.id}),action:tool.id,value:tool.input?value:undefined,idempotencyKey:requestId});
      if(result.text&&(tool.id==='copy'||tool.id==='citation'))await navigator.clipboard.writeText(result.text);
      const detail={action:tool.id,requestId,result,snapshot:state.snapshot};if(native)await call('toolbar-action',{action:'result',detail});else window.dispatchEvent(new CustomEvent('agentviewer:selection-result',{detail}));
      if(sequence.current===generation)clear();
    }catch(e){if(!native)window.dispatchEvent(new CustomEvent('agentviewer:selection-failed',{detail:{action:tool.id,requestId,snapshot:state.snapshot}}));if(sequence.current===generation)setError(String(e));}finally{setBusy(false);}
  };
  const width=Math.min(600,((state?.actions.length??0)+1)*32+16),readingViewport=viewport??{x:0,y:64,width:innerWidth,height:innerHeight-64};
  const safeLeft=Math.max(0,readingViewport.x),safeTop=Math.max(0,readingViewport.y),safeViewport={x:safeLeft,y:safeTop,width:Math.max(0,Math.min(innerWidth,readingViewport.x+readingViewport.width)-safeLeft),height:Math.max(0,Math.min(innerHeight,readingViewport.y+readingViewport.height)-safeTop)};
  const position=rect&&placeSelectionToolbar(rect,safeViewport,{width,height:46},10,[...(navigationBounds.current?[navigationBounds.current]:[]),...panelBounds]);
  canPlaceAroundNavigation.current=bounds=>!!rect&&!!placeSelectionToolbar(rect,safeViewport,{width,height:46},10,[...(bounds?[bounds]:[]),...panelBounds]);
  navigationPlacement.current=!!position;
  const materialWidth=useGlassSpringValue(width,KUBE_GLASS_SPRINGS.lensShape,!state);
  const show=!!state&&!!rect&&(native||!!position),left=native?8:undefined,top=native?8:undefined;
  const refreshMotion=useSelectionToolbarMotion(toolbar,!native&&show,identity.current,()=>{
    const element=tracked.current?.element,liveClip=element?.isConnected?clippedReaderViewport(element):undefined,clip=liveClip??safeViewport;
    // Scroll and a running spring can share a frame before React commits the
    // follow callback's new rect. The actual Range must already be a blocker
    // in that frame; engine selections continue using their projected rect.
    const range=tracked.current?.range,liveBox=range?.startContainer.isConnected?range.getBoundingClientRect():!range&&element?.isConnected?element.getBoundingClientRect():undefined;
    const currentRect=liveBox?{x:liveBox.x,y:liveBox.y,width:liveBox.width,height:liveBox.height}:range?undefined:rect;
    const actualViewport={x:Math.max(0,clip.x),y:Math.max(0,clip.y),width:Math.max(0,Math.min(innerWidth,clip.x+clip.width)-Math.max(0,clip.x)),height:Math.max(0,Math.min(innerHeight,clip.y+clip.height)-Math.max(0,clip.y))};
    const nav=readSelectionNavigationBounds(),obstacles=[...(nav?[nav]:[]),...readSelectionPanelBounds()],target=currentRect&&placeSelectionToolbar(currentRect,actualViewport,{width,height:46},10,obstacles);
    return {target:target||undefined,scene:{viewport:actualViewport,height:46,obstacles,selection:currentRect,gap:10}};
  },pose=>window.dispatchEvent(new CustomEvent('agentviewer:selection-material-position',{detail:{...pose,height:46}})));
  motionRefresh.current=()=>refreshMotion.current();
  // A now-impossible placement must disappear immediately, rather than leave
  // MotionPresence's old retained hit target underneath an expanding sidebar.
  if(!native&&state&&rect&&!position)return null;
  return <MotionPresence show={show} surface="selection" duration={300} keyboardImmediate>{state&&rect&&<div ref={toolbar} className="selection-tools" data-selection-snapshot={state.snapshot.id} data-selection-material-ready={opticsReady&&backdropReady} data-paper={!native&&['pdf','docx','pptx','html'].includes(state.snapshot.document.format)||undefined} role="toolbar" aria-label="选区工具" style={{left,top,maxWidth:native?'calc(100vw - 16px)':position?.width ?? width}}>
    <div ref={glass} data-navigation-surface={surface} className="selection-tool-icons material-host floating-capsule navigation-capsule" onMouseDown={event=>event.preventDefault()} style={{'--navigation-hide-progress':'var(--selection-glass-hidden,0)','--navigation-hide-duration':'var(--motion-duration,300ms)','--navigation-motion-easing':'var(--ease-spring)','--glass-material-selection-scale-x':Math.min(1,Math.max(.9,materialWidth/width)),width,maxWidth:'100%'} as CSSProperties}><NavigationGlass key={native?width:position?.width??width} softness="selection" onReady={setOpticsReady} backdropImage={backdrop.image} backdropSample={backdrop.sample} capsuleBounds={glassBounds} onSurface={setSurface} /><div className="selection-tool-row">{state.actions.map(tool=>{const Icon=icons[tool.id]??Pencil;return <button key={tool.id} className={'icon-button '+(input?.id===tool.id?'selected':'')} aria-label={tool.label} aria-expanded={tool.input?input?.id===tool.id:undefined} aria-controls={tool.input?'selection-editor':undefined} title={tool.label} disabled={busy} onMouseDown={e=>e.preventDefault()} onClick={()=>void run(tool)}><Icon size={16}/></button>;})}<button className="icon-button" title="关闭选区工具" aria-label="关闭选区工具" onMouseDown={e=>e.preventDefault()} onClick={()=>clear()}><X size={14}/></button></div></div>
    <MotionPresence show={!!input} duration={160}>{input&&<form id="selection-editor" className="selection-input material-host" onSubmit={e=>{e.preventDefault();void run(input,true);}}><LiquidGlassSurface variant="panel" fallback={native} /><label>{input.label}<textarea autoFocus aria-label={input.label} value={value} onChange={e=>setValue(e.target.value)}/></label><button className="button primary" disabled={busy||!value.trim()}><Send size={14}/>{busy?'处理中…':'应用'}</button>{error&&<p role="alert" className="selection-inline-error">{error}</p>}</form>}</MotionPresence>
    <MotionPresence show={!!error&&!input} duration={150}>{error&&!input&&<p className="selection-error material-host" role="alert"><LiquidGlassSurface variant="panel" fallback={native} />{error}</p>}</MotionPresence>
  </div>}</MotionPresence>;
}
