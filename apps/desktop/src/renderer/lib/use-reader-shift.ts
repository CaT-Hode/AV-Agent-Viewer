import {useLayoutEffect, type RefObject} from 'react';

export function readerShift(left:number,right:number){return Math.round(Math.max(-48,Math.min(48,(left-right)*.14)));}
export function useReaderShift(ref:RefObject<HTMLDivElement|null>,left:boolean,right:boolean,viewId?:string){
  useLayoutEffect(()=>{
    const root=ref.current;if(!root)return;
    const update=()=>{
      const width=(side:string)=>root.querySelector<HTMLElement>(':scope > .floating-side-panel[data-side="'+side+'"]')?.offsetWidth??0;
      const shift=readerShift(left?width('left'):0,right?width('right'):0)+'px';
      if(root.style.getPropertyValue('--reader-shift')===shift)return;
      root.style.setProperty('--reader-shift',shift);window.dispatchEvent(new Event('reader-geometry'));
    };
    const resize=new ResizeObserver(update);
    const observe=()=>{resize.disconnect();resize.observe(root);root.querySelectorAll(':scope > .floating-side-panel').forEach(p=>resize.observe(p));update();};
    const mount=new MutationObserver(observe);mount.observe(root,{childList:true});observe();
    return()=>{mount.disconnect();resize.disconnect();};
  },[ref,left,right,viewId]);
}
