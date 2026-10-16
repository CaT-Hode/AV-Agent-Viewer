import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { LiquidGlassSurface } from './LiquidGlassSurface';

type Option={id:string;text:string;sourceText?:string;selected?:boolean};
/** Searchable native choices use the reader's own menu, including in dark mode. */
export function OfficeDialogChoice({dialogInstanceId,selectedOptionId,label,value,options,editable,disabled,onSelect,onText,onDraft}:{dialogInstanceId:string;selectedOptionId?:string;label:string;value:string;options:Option[];editable:boolean;disabled:boolean;onSelect(id:string):void;onText(value:string):void;onDraft(value:string):void}){
  const id=useId(),anchor=useRef<HTMLDivElement>(null),popup=useRef<HTMLDivElement>(null),focused=useRef(false);
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(value),[filter,setFilter]=useState(''),[active,setActive]=useState(0),[placement,setPlacement]=useState({left:0,top:0,width:200,height:240});
  const dirty=useRef(false),draftValue=useRef(value);draftValue.current=draft;
  useEffect(()=>{if(!focused.current)setDraft(value);},[value]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const box=anchor.current?.getBoundingClientRect();if(!box)return;const below=innerHeight-box.bottom-16,above=box.top-16,height=Math.max(72,Math.min(260,Math.max(below,above))),width=Math.min(Math.max(220,box.width),innerWidth-16);setPlacement({left:Math.max(8,Math.min(innerWidth-width-8,box.left)),top:below>=Math.min(180,height)?box.bottom+6:Math.max(8,box.top-height-6),width,height});};
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!anchor.current?.contains(event.target)&&!popup.current?.contains(event.target))setOpen(false);};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('scroll',place,true);window.addEventListener('resize',place);place();
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',place,true);window.removeEventListener('resize',place);};
  },[open]);
  const choices=options.filter(option=>!filter||option.text.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const currentOption=options.find(option=>option.id===selectedOptionId)??options.find(option=>option.sourceText===value||option.text===value);
  const reveal=()=>{setFilter('');setActive(Math.max(0,currentOption?options.indexOf(currentOption):0));setOpen(true);};
  useEffect(()=>{if(open)popup.current?.querySelector<HTMLElement>('[role="option"].active')?.scrollIntoView({block:'nearest'});},[open,active,filter]);
  const choose=(option:Option)=>{dirty.current=false;draftValue.current=option.text;setDraft(option.text);setFilter('');setOpen(false);onSelect(option.id);};
  const commit=()=>{if(editable&&dirty.current){dirty.current=false;onText(draftValue.current);}};
  const keyboard=(event:React.KeyboardEvent)=>{
    if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;
    if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);setFilter('');return;}
    if(event.key==='Tab'&&open){setOpen(false);setFilter('');return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();if(!open){reveal();return;}setActive(index=>Math.max(0,Math.min(choices.length-1,index+(event.key==='ArrowDown'?1:-1))));return;}
    if(open&&!editable&&(event.key==='Home'||event.key==='End')){event.preventDefault();event.stopPropagation();setActive(event.key==='Home'?0:Math.max(0,choices.length-1));return;}
    if(event.key==='Enter'){event.preventDefault();event.stopPropagation();if(open&&choices[active])choose(choices[active]);else if(!editable)reveal();else commit();}
  };
  const activeId=open&&choices[active]?id+'-'+choices[active].id:undefined;
  return <div ref={anchor} className="office-dialog-choice" onKeyDown={keyboard}>
    {editable?<input role="combobox" aria-label={label} aria-controls={open?id:undefined} aria-expanded={open} aria-activedescendant={activeId} aria-autocomplete="list" value={draft} disabled={disabled} onFocus={()=>{focused.current=true;}} onChange={event=>{dirty.current=true;draftValue.current=event.target.value;setDraft(event.target.value);onDraft(event.target.value);setFilter(event.target.value);setActive(0);setOpen(true);}} onBlur={()=>{focused.current=false;commit();}}/>:<button type="button" role="combobox" aria-label={label} aria-controls={open?id:undefined} aria-expanded={open} aria-activedescendant={activeId} disabled={disabled} onClick={()=>{if(open)setOpen(false);else reveal();}}><span>{currentOption?.text??value}</span></button>}
    <button type="button" className="office-dialog-choice-arrow" aria-label={'展开'+label} disabled={disabled} onMouseDown={event=>event.preventDefault()} onClick={()=>{if(open)setOpen(false);else{reveal();anchor.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus({preventScroll:true});}}}><ChevronDown size={13}/></button>
    {open&&createPortal(<div ref={popup} className="office-dialog-choice-menu material-host" data-office-dialog-portal={dialogInstanceId} style={{left:placement.left,top:placement.top,width:placement.width,maxHeight:placement.height}} onKeyDown={keyboard}><LiquidGlassSurface variant="panel"/><div id={id} role="listbox" aria-label={label} style={{maxHeight:placement.height-10}}>{choices.map((option,index)=><button key={option.id} id={id+'-'+option.id} type="button" role="option" tabIndex={-1} aria-selected={option.id===selectedOptionId} className={active===index?'active':''} onMouseDown={event=>event.preventDefault()} onMouseEnter={()=>setActive(index)} onClick={()=>choose(option)}><span>{option.text}</span>{option.id===selectedOptionId&&<Check size={13}/>}</button>)}{!choices.length&&<span className="office-dialog-choice-empty">没有匹配的选项</span>}</div></div>,document.body)}
  </div>;
}
