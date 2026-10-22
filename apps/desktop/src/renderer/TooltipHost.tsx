import { MotionPresence } from './components/MotionPresence';
import { LiquidGlassSurface } from './components/LiquidGlassSurface';
import { motionDuration } from './lib/motion';
import { isNativeTooltipRelocation, placeTooltip, type NativeTooltipPointer, type TooltipPlacement } from './lib/tooltip-placement';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { call } from './lib/transport';
import { floatingOwnerGroup } from './lib/floating-hitboxes';
import './tooltip.css';

type Tip = TooltipPlacement & { text: string; target: HTMLElement; sequence: number; ready: boolean };
type NativeLayout = { ticket: number; offsetY: number; viewId?: unknown; placement?: TooltipPlacement };
const native = location.hash.includes('-toolbar') && !location.hash.includes('ai-result-toolbar');
async function commitNativeLayout(layout: NativeLayout) {
  document.documentElement.style.setProperty('--native-tooltip-offset-y', layout.offsetY + 'px');
  // Position-only CSS changes do not notify ResizeObserver. Refresh the
  // shared capsule's DOM geometry and sampled-image origin after the inset.
  window.dispatchEvent(new Event('resize'));
  const capsule = document.querySelector('.navigation-capsule,.agent-operation-capsule'), rect = capsule?.getBoundingClientRect();
  await call('toolbar-tooltip', { ready: layout.ticket, viewId:layout.viewId, capsuleBounds: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined });
}

export function TooltipHost() {
  const [tip, setTip] = useState<Tip>(), bubble = useRef<HTMLDivElement>(null), sequence = useRef(0), nativeOpen = useRef(false);
  useEffect(() => {
    let target: HTMLElement | null = null, original = '', titleBefore: string|null = null, describedBefore: string|null = null, timer: ReturnType<typeof setTimeout>, pointer: NativeTooltipPointer | undefined;
    const point = (event: Event): NativeTooltipPointer | undefined => native && event instanceof MouseEvent ? { x:event.clientX,y:event.clientY,screenX:event.screenX,screenY:event.screenY,offsetY:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-tooltip-offset-y'))||0 } : undefined;
    const relocation = (event: Event) => { const current=point(event); if(!current||!target?.isConnected)return false; const rect=target.getBoundingClientRect();return isNativeTooltipRelocation(current,pointer,{x:rect.x,y:rect.y,width:rect.width,height:rect.height}); };
    const move = (event: Event) => { const current=point(event);if(current&&!relocation(event))pointer=current; };
    const hide = () => { clearTimeout(timer); pointer=undefined; const current = ++sequence.current; if (target) { if(titleBefore===null)target.removeAttribute('title');else target.setAttribute('title',titleBefore); if(describedBefore===null)target.removeAttribute('aria-describedby');else target.setAttribute('aria-describedby',describedBefore); } target = null; setTip(undefined); if (native && nativeOpen.current) { nativeOpen.current=false; void call<NativeLayout>('toolbar-tooltip', { open: false, duration: motionDuration(160) }).then(layout=>{if(sequence.current===current)return commitNativeLayout(layout);}).catch(()=>{}); } };
    const show = (event: Event) => {
      if (event.type === 'pointerover' && relocation(event)) return;
      const next = event.target instanceof Element ? event.target.closest<HTMLElement>('[title],button[aria-label]') : null;
      if (next === target) return;
      hide(); if (!next || !(next.getAttribute('title') || next.getAttribute('aria-label'))?.trim()) return;
      target = next; pointer=point(event);titleBefore=next.getAttribute('title'); describedBefore=next.getAttribute('aria-describedby'); original = next.getAttribute('title') || next.getAttribute('aria-label') || ''; if (!next.hasAttribute('aria-label') && !next.textContent?.trim()) next.setAttribute('aria-label', original); next.setAttribute('title','');
      const current=sequence.current;
      timer = setTimeout(() => { if (!target?.isConnected || sequence.current!==current) return; target.setAttribute('aria-describedby', [describedBefore,'app-tooltip'].filter(Boolean).join(' ')); setTip({ text: original, target, sequence:current, ready:false, x:0, y:0, above:false }); }, event.type === 'focusin' ? 150 : 420);
    };
    const leave = (event: Event) => { if(relocation(event))return;const related=(event as MouseEvent).relatedTarget; if(target&&(!(related instanceof Node)||!target.contains(related)))hide(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    const receive=(value:Record<string,unknown>)=>{if(typeof value.tooltipOffsetY==='number')document.documentElement.style.setProperty('--native-tooltip-offset-y',value.tooltipOffsetY+'px');if(value.visible===false)hide();};
    const unsubscribe=native?(location.hash.includes('selection-toolbar')?window.agentViewer?.onSelectionTool(receive):window.agentViewer?.onToolbar(receive)):undefined;
    document.addEventListener('pointerover', show); document.addEventListener('pointermove', move); document.addEventListener('focusin', show);
    document.addEventListener('pointerout', leave); document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide); document.addEventListener('scroll', hide, true); document.addEventListener('keydown', escape);
    return () => { hide();unsubscribe?.(); document.removeEventListener('pointerover', show); document.removeEventListener('pointermove', move); document.removeEventListener('focusin', show); document.removeEventListener('pointerout', leave); document.removeEventListener('focusout', hide); document.removeEventListener('pointerdown', hide); document.removeEventListener('scroll', hide, true); document.removeEventListener('keydown', escape); };
  }, []);
  useLayoutEffect(()=>{
    if(!tip||tip.ready||!bubble.current||!tip.target.isConnected)return;
    const anchor=tip.target.getBoundingClientRect(), size=bubble.current.getBoundingClientRect(),current=tip.sequence;
    const rect={x:anchor.x,y:anchor.y,width:anchor.width,height:anchor.height},measured={width:size.width,height:size.height};
    if(!native){const position=placeTooltip(rect,measured,{width:innerWidth,height:innerHeight});setTip(previous=>previous?.sequence===current?{...previous,...position,ready:true}:previous);return;}
    nativeOpen.current=true;
    void call<NativeLayout>('toolbar-tooltip',{open:true,anchor:rect,size:measured}).then(async layout=>{if(sequence.current!==current||!tip.target.isConnected||!layout.placement)return;await commitNativeLayout(layout);if(sequence.current===current)setTip(previous=>previous?.sequence===current?{...previous,...layout.placement!,ready:true}:previous);}).catch(()=>{if(sequence.current===current)setTip(undefined);});
  },[tip?.sequence,tip?.ready]);
  return <MotionPresence show={!!tip} surface="tooltip" duration={160}>{tip && <div ref={bubble} id="app-tooltip" role="tooltip" className={'app-tooltip material-host ' + (tip.above ? 'above' : '')} data-floating-owner={floatingOwnerGroup(tip.target)} data-tooltip-ready={tip.ready} style={{ left: tip.x, top: tip.y, maxWidth:Math.max(24,Math.min(280,innerWidth-12)),visibility:tip.ready?'visible':'hidden' } as CSSProperties}><LiquidGlassSurface variant="tooltip" effect="frosted" /><span className="app-tooltip-content">{tip.text}</span></div>}</MotionPresence>;
}
