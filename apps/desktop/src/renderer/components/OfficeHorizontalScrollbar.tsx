import {useLayoutEffect,useRef,useState,type RefObject} from 'react';

/** A real scroll controller in the unobstructed tools lane; it changes the DOM
 * scrollLeft rather than applying a visual transform to document pixels. */
export function OfficeHorizontalScrollbar({host,identity,version,active}:{host:RefObject<HTMLDivElement|null>;identity:string;version:number|string;active:boolean}){
  const track=useRef<HTMLDivElement>(null),drag=useRef<{id:number;x:number;scroll:number;ratio:number}|undefined>(undefined),updateRef=useRef<(()=>void)|undefined>(undefined);
  const [metrics,setMetrics]=useState({width:1,viewport:1,maximum:0,position:0});
  useLayoutEffect(()=>{
    if(!active){drag.current=undefined;return;}
    const content=host.current,bar=track.current;if(!content||!bar)return;
    const update=()=>{const next={width:bar.clientWidth,viewport:content.clientWidth,maximum:Math.max(0,content.scrollWidth-content.clientWidth),position:content.scrollLeft};setMetrics(old=>Object.keys(next).every(key=>old[key as keyof typeof old]===next[key as keyof typeof next])?old:next);};
    const resize=new ResizeObserver(update);resize.observe(content);resize.observe(bar);if(content.firstElementChild)resize.observe(content.firstElementChild);
    updateRef.current=update;content.addEventListener('scroll',update);update();return()=>{resize.disconnect();content.removeEventListener('scroll',update);drag.current=undefined;updateRef.current=undefined;};
  },[host,identity,active]);
  useLayoutEffect(()=>{updateRef.current?.();},[version]);
  if(!active)return null;
  const thumb=Math.min(metrics.width,Math.max(32,metrics.width*metrics.viewport/(metrics.viewport+metrics.maximum))),travel=Math.max(1,metrics.width-thumb);
  const move=(value:number)=>{if(host.current)host.current.scrollLeft=Math.max(0,Math.min(metrics.maximum,value));};
  return <div className="office-horizontal-scrollbar" ref={track} role="scrollbar" aria-label="幻灯片横向滚动" aria-orientation="horizontal" aria-controls={'office-scroll-'+identity} aria-valuemin={0} aria-valuemax={Math.round(metrics.maximum)} aria-valuenow={Math.round(metrics.position)} aria-disabled={!metrics.maximum} tabIndex={metrics.maximum?0:-1} onPointerDown={event=>{
    if(event.button!==0||!metrics.maximum)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
    const box=event.currentTarget.getBoundingClientRect();if(!(event.target as HTMLElement).closest('.office-horizontal-scrollbar-thumb'))move((event.clientX-box.left-thumb/2)*metrics.maximum/travel);
    drag.current={id:event.pointerId,x:event.clientX,scroll:host.current?.scrollLeft??0,ratio:metrics.maximum/travel};
  }} onPointerMove={event=>{const current=drag.current;if(current?.id===event.pointerId)move(current.scroll+(event.clientX-current.x)*current.ratio);}} onPointerUp={event=>{if(drag.current?.id===event.pointerId){drag.current=undefined;event.currentTarget.releasePointerCapture(event.pointerId);}}} onPointerCancel={()=>{drag.current=undefined;}} onKeyDown={event=>{
    const changes:Record<string,number>={ArrowLeft:metrics.position-40,ArrowRight:metrics.position+40,PageUp:metrics.position-metrics.viewport*.8,PageDown:metrics.position+metrics.viewport*.8,Home:0,End:metrics.maximum};
    if(event.key in changes){event.preventDefault();move(changes[event.key]);}
  }}><span className="office-horizontal-scrollbar-thumb" style={{width:thumb,left:metrics.maximum?metrics.position/metrics.maximum*travel:0}} /></div>;
}
