import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { Languages } from 'lucide-react';
import type { ReadingContext, Rect } from '../../../../../packages/contracts/src/index';
import { call, desktop } from '../lib/transport';
import { fitTranslationCapsule, placeTranslationPopover, shouldCollapseTranslation, translationDragShape, translationTextHeight, TRANSLATION_CAPSULE_METRICS } from '../lib/translation-popover';
import { stepGlassSpring, type SpringAxis } from '../lib/glass-elasticity';
import { animatedMotion, useMotionSnapshot } from '../lib/motion';
import { updateFloatingHitbox } from '../lib/floating-hitboxes';
import { useGlassSurface } from '../lib/useGlassSurface';
import { readNavigationTargetLane } from '../lib/navigation-lane';
import { SELECTION_NAVIGATION_EVENT } from '../lib/selection-position';
import { scheduleLayoutRead } from '../lib/layout-frame';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { MotionPresence } from './MotionPresence';
import { NativeTranslationPortal, type TranslationBackdrop } from './NativeTranslationPortal';
import type { TranslationCardState } from './TranslationCard';
import '../selection-translation.css';

type Props = { show: boolean; viewId: string; format?: string; context?: ReadingContext; card?: TranslationCardState; shortcut?: string; growthRatio: number; renderCard(card: TranslationCardState): ReactNode; onTranslate(): void; onCollapse(): void };
export function SelectionTranslationPopover(props: Props) {
  return <NativeTranslationPortal enabled={desktop && props.format === 'web'} viewId={props.viewId}>{(native, backdrop) => <MotionPresence show={props.show} surface="translation" duration={110} identity={props.viewId} keyboardImmediate={false}>
    {props.show && <TranslationBubble {...props} native={native} backdrop={backdrop} />}
  </MotionPresence>}</NativeTranslationPortal>;
}
function TranslationBubble({ card, context, format, shortcut, growthRatio, native, backdrop, renderCard, onTranslate, onCollapse, viewId, show: _show, ...presence }: Props & { native: boolean; backdrop: TranslationBackdrop; style?: CSSProperties }) {
  const host = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<'light' | 'dark'>(), [opticsReady, setOpticsReady] = useState(false), [placed, setPlaced] = useState(false), [localBounds, setLocalBounds] = useState<Rect>();
  const motion = useMotionSnapshot(), animate = animatedMotion(motion.split(':')[0] as Parameters<typeof animatedMotion>[0]);
  const current = useRef({ card, onCollapse, animate, growthRatio }); current.current = { card, onCollapse, animate, growthRatio };
  const textMetrics=useRef<{key:string;height:(width:number)=>number}|undefined>(undefined),fitted=useRef<{key:string;size:ReturnType<typeof fitTranslationCapsule>}|undefined>(undefined);
  const redraw = useRef<() => void>(() => {}), paintNow = useRef<() => void>(() => {}), refreshLayout = useRef<() => void>(() => {});
  const collisionOffset = useRef({x:0,y:0});
  const axes = useRef({ x: { value: 0, velocity: 0 } as SpringAxis, y: { value: 0, velocity: 0 } as SpringAxis });
  const sizes = useRef({ x: { value: 1, velocity: 0 } as SpringAxis, y: { value: 1, velocity: 0 } as SpringAxis }), previousSize = useRef<{ width: number; height: number } | undefined>(undefined);
  const gesture = useRef<{ id: number; x: number; y: number; lastX: number; lastY: number; time: number; moved: boolean } | undefined>(undefined);
  const frame = useRef(0), lastFrame = useRef(0);
  const source = card?.source ?? context?.selection.text ?? '';
  useLayoutEffect(() => {
    axes.current = { x: { value: 0, velocity: 0 }, y: { value: 0, velocity: 0 } }; gesture.current = undefined;
    collisionOffset.current = {x:0,y:0};
    redraw.current();
  }, [card?.id, source, viewId]);
  useLayoutEffect(() => { refreshLayout.current(); }, [motion, card?.result, card?.status, card?.error, growthRatio]);
  useLayoutEffect(() => {
    const node = host.current, body = content.current; if (!node || !body) return;
    let disposed = false, paintFrame = 0, cancelMeasure: (()=>void)|undefined, inflight = false, sent = '', desired: Rect | undefined, placedOnce = false;
    let painted:Rect|undefined, published:Rect|undefined, localBoundsSent:Rect|undefined, measured:{viewport:Rect;position:NonNullable<ReturnType<typeof placeTranslationPopover>>}|undefined;
    const sameRect=(a:Rect|undefined,b:Rect|undefined)=>a===b||!!a&&!!b&&(['x','y','width','height']as const).every(key=>Math.abs(a[key]-b[key])<.125);
    const style=(name:string,value:string)=>{if(node.style.getPropertyValue(name)!==value)node.style.setProperty(name,value);};
    const data=(name:string,value:string)=>{if(node.dataset[name]!==value)node.dataset[name]=value;};
    const publish = (bounds?: Rect) => {
      painted=bounds;if(sameRect(published,bounds))return;published=bounds;
      updateFloatingHitbox('translation:'+viewId,bounds?{group:'translation',bounds,canMove:true,canCollapse:true,yield:next=>{if(!next||!painted){current.current.onCollapse();return;}collisionOffset.current.x+=next.x-painted.x;collisionOffset.current.y+=next.y-painted.y;redraw.current();}}:undefined);
      window.dispatchEvent(new CustomEvent('agentviewer:translation-geometry', { detail: { viewId, bounds } }));
    };
    const send = () => {
      if (!native || inflight || disposed) return;
      const signature = JSON.stringify(desired); if (signature === sent) return;
      const bounds = desired; sent = signature; inflight = true;
      void call('translation-popover-layout', { viewId, visible: !!bounds, bounds }).then(()=>{delete node.dataset.layoutError;}).catch(error => { node.dataset.layoutError=String(error); }).finally(() => { inflight = false; if (!disposed && sent !== JSON.stringify(desired)) send(); });
    };
    const syncOptics=()=>{
      if(!measured)return;const width=Number(node.dataset.glassOpticsWidth),height=Number(node.dataset.glassOpticsHeight);
      if(width>0&&height>0){style('--liquid-glass-optics-scale-x',(measured.position.width/width).toFixed(6));style('--liquid-glass-optics-scale-y',(measured.position.height/height).toFixed(6));}
    };
    const paint = () => {
      if(disposed)return;
      if(!measured){style('visibility','hidden');desired=undefined;publish();send();return;}
      const {viewport,position}=measured,now=current.current;
      const x = Math.max(viewport.x + 4, Math.min(viewport.x + viewport.width - position.width - 4, position.x + axes.current.x.value+collisionOffset.current.x));
      const y = Math.max(viewport.y + 4, Math.min(viewport.y + viewport.height - position.height - 4, position.y + axes.current.y.value+collisionOffset.current.y));
      style('max-height',position.maxHeight+'px');style('visibility','');data('placement',position.edge);
      const previous = previousSize.current;
      if (previous && now.animate && (Math.abs(previous.width-position.width)>.5 || Math.abs(previous.height-position.height)>.5)) {
        sizes.current.x.value *= previous.width / Math.max(1,position.width); sizes.current.y.value *= previous.height / Math.max(1,position.height);
        if (!frame.current && !gesture.current) { lastFrame.current = performance.now(); frame.current = requestAnimationFrame(settle); }
      }
      previousSize.current = { width: position.width, height: position.height };
      if (!now.animate) sizes.current = { x: { value: 1, velocity: 0 }, y: { value: 1, velocity: 0 } };
      const shape = now.animate ? translationDragShape(axes.current.x.value, axes.current.y.value) : { scaleX: 1, scaleY: 1 };
      const scaleX=shape.scaleX*sizes.current.x.value,scaleY=shape.scaleY*sizes.current.y.value;
      style('--translation-stretch-x',scaleX.toFixed(6));style('--translation-stretch-y',scaleY.toFixed(6));data('dragging',String(!!gesture.current));
      data('glassResizing',String(now.animate&&(['x','y']as const).some(key=>Math.abs(sizes.current[key].value-1)>.001||Math.abs(sizes.current[key].velocity)>.008)));
      syncOptics();
      const paintWidth=Math.max(position.width,position.width*scaleX),paintHeight=Math.max(position.height,position.height*scaleY),bounds={x:x+(position.width-paintWidth)/2,y:y+position.height-paintHeight,width:paintWidth,height:paintHeight};
      const localX=TRANSLATION_CAPSULE_METRICS.shadowGutter+x-bounds.x,localY=TRANSLATION_CAPSULE_METRICS.shadowGutter+y-bounds.y;
      style('left','0px');style('top','0px');style('translate',(native?localX:x).toFixed(3)+'px '+(native?localY:y).toFixed(3)+'px');
      style('--liquid-glass-capsule-x',localX.toFixed(3)+'px');style('--liquid-glass-capsule-y',localY.toFixed(3)+'px');
      if(!placedOnce){placedOnce=true;setPlaced(true);}
      publish(bounds);
      if(native){
        const next={x:TRANSLATION_CAPSULE_METRICS.shadowGutter,y:TRANSLATION_CAPSULE_METRICS.shadowGutter,width:position.width,height:position.height};
        if(!sameRect(localBoundsSent,next)){localBoundsSent=next;setLocalBounds(next);}desired=bounds;send();
      }
    };
    const schedulePaint=()=>{if(!paintFrame)paintFrame=requestAnimationFrame(()=>{paintFrame=0;paint();});};
    const measure = () => {
      if(disposed)return;
      const now=current.current,readerNode=document.querySelector<HTMLElement>('.reader-panel'),reader=readerNode?.getBoundingClientRect();
      const lane=readerNode&&readNavigationTargetLane(readerNode);
      const viewport = reader && lane ? {x:reader.x+lane.left,y:reader.y+4,width:lane.width,height:reader.height-8} : {x:44,y:60,width:innerWidth-88,height:innerHeight-94};
      const left=readerNode&&Number.parseFloat(readerNode.style.getPropertyValue('--navigation-reservation-left')),right=readerNode&&Number.parseFloat(readerNode.style.getPropertyValue('--navigation-reservation-right'));
      const center=reader&&typeof left==='number'&&typeof right==='number'&&Number.isFinite(left)&&Number.isFinite(right)&&right>left?reader.x+(left+right)/2:reader&&lane?reader.x+lane.center:viewport.x+viewport.width/2;
      let size:{width:number;height:number};
      if(now.card){
        const text=now.card.status==='ready'?now.card.result:now.card.error??'正在翻译选中内容…',key=now.card.status+':'+text;
        if(textMetrics.current?.key!==key){
          const computed=getComputedStyle(node.querySelector('.translation-result,.translation-loading,.translation-error')??body),canvas=node.ownerDocument.createElement('canvas'),context=canvas.getContext('2d')!;
          context.font=computed.fontWeight+' '+computed.fontSize+' '+computed.fontFamily;const lineHeight=Number.parseFloat(computed.lineHeight)||Number.parseFloat(computed.fontSize)*1.65;
          textMetrics.current={key,height:translationTextHeight(text,value=>context.measureText(value).width,lineHeight)};
        }
        const fitKey=JSON.stringify([key,viewport.width,viewport.height,now.growthRatio]);
        if(fitted.current?.key!==fitKey){
          const next=fitTranslationCapsule(viewport,textMetrics.current.height,now.growthRatio);
          style('max-height',next.maxHeight+'px');
          // Correct a new text fit once; pointer/spring frames never read text layout.
          style('width',next.width+'px');style('height',next.height+'px');
          const result=node.querySelector<HTMLElement>('.translation-result'),overflow=result?result.scrollHeight-result.clientHeight:0;
          if(overflow>1){if(next.height<next.maxHeight){const delta=Math.min(next.maxHeight-next.height,overflow+2);next.height+=delta;next.width=Math.min(next.maxWidth,Math.ceil(next.width+next.growthRatio*delta));}else if(next.width<next.maxWidth)next.width=Math.min(next.maxWidth,Math.ceil(next.width+Math.max(8,(next.width-TRANSLATION_CAPSULE_METRICS.horizontalInset)*overflow/Math.max(1,result!.clientHeight))));}
          fitted.current={key:fitKey,size:next};
        }
        size=fitted.current.size;style('width',size.width+'px');style('height',size.height+'px');
      }else{style('width','max-content');style('height','auto');size={width:node.offsetWidth,height:body.scrollHeight};}
      const position=placeTranslationPopover(viewport,size,center);measured=position?{viewport,position}:undefined;paint();
    };
    const schedule=()=>{if(!cancelMeasure)cancelMeasure=scheduleLayoutRead(()=>{cancelMeasure=undefined;measure();});};
    redraw.current=schedulePaint;paintNow.current=paint;refreshLayout.current=schedule;
    const observer=new ResizeObserver(schedule);observer.observe(node);observer.observe(body);const reader=document.querySelector<HTMLElement>('.reader-panel');if(reader)observer.observe(reader);
    const reservation=()=>reader?.style.getPropertyValue('--navigation-reservation-left')+':'+reader?.style.getPropertyValue('--navigation-reservation-right');let laneKey=reservation();
    const navigation=new MutationObserver(()=>{const next=reservation();if(next!==laneKey){laneKey=next;schedule();}});if(reader)navigation.observe(reader,{attributes:true,attributeFilter:['style']});
    const yieldRoom=(event:Event)=>{const next=(event as CustomEvent<{bounds?:Rect}>).detail.bounds;if(!next||!painted){current.current.onCollapse();return;}collisionOffset.current.x+=next.x-painted.x;collisionOffset.current.y+=next.y-painted.y;schedulePaint();};
    node.addEventListener('agentviewer:floating-yield',yieldRoom);node.addEventListener('agentviewer:glass-optics',syncOptics);
    window.addEventListener('resize',schedule);window.addEventListener(SELECTION_NAVIGATION_EVENT,schedule);document.fonts.addEventListener('loadingdone',schedule);measure();
    return()=>{disposed=true;redraw.current=paintNow.current=refreshLayout.current=()=>{};observer.disconnect();navigation.disconnect();cancelMeasure?.();cancelAnimationFrame(paintFrame);publish();node.removeEventListener('agentviewer:floating-yield',yieldRoom);node.removeEventListener('agentviewer:glass-optics',syncOptics);window.removeEventListener('resize',schedule);window.removeEventListener(SELECTION_NAVIGATION_EVENT,schedule);document.fonts.removeEventListener('loadingdone',schedule);if(native)void call('translation-popover-layout',{viewId,visible:false}).catch(()=>{});};
  }, [native, viewId]);
  const settle = (time: number) => {
    frame.current = 0; const dt = Math.min(.064, (time - lastFrame.current) / 1000); lastFrame.current = time; let moving = false;
    for (const key of ['x','y'] as const) {
      const axis = current.current.animate ? stepGlassSpring(axes.current[key], 0, dt, { stiffness: 380, damping: 32 }) : { value: 0, velocity: 0 };
      if (Math.abs(axis.value) < .08 && Math.abs(axis.velocity) < .8) axes.current[key] = { value: 0, velocity: 0 }; else { axes.current[key] = axis; moving = true; }
      const size = current.current.animate ? stepGlassSpring(sizes.current[key], 1, dt, { stiffness: 420, damping: 34 }) : { value: 1, velocity: 0 };
      if (Math.abs(size.value-1)<.001 && Math.abs(size.velocity)<.008) sizes.current[key] = { value: 1, velocity: 0 }; else { sizes.current[key] = size; moving = true; }
    }
    paintNow.current(); if (moving) frame.current = requestAnimationFrame(settle);
  };
  const release = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = gesture.current; if (!drag || event.pointerId !== drag.id) return;
    gesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const velocityY = performance.now() - drag.time < 100 ? axes.current.y.velocity : 0;
    if (!cancelled && drag.moved && shouldCollapseTranslation({ x: axes.current.x.value, y: axes.current.y.value }, velocityY)) { current.current.onCollapse(); return; }
    lastFrame.current = performance.now(); frame.current = requestAnimationFrame(settle);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const rect = backdrop.rect, sampled = native && !!backdrop.image && !!rect;
  useGlassSurface(host, { backdropImage: sampled ? backdrop.image : undefined, capsuleBounds: localBounds, onSurface: setSurface });
  const preferences = document.documentElement.dataset, requiresSource = native && preferences.glass !== 'off' && preferences.contrast !== 'high' && preferences.reduceTransparency !== 'true';
  return <div {...presence} ref={host} className={'selection-translation-bubble material-host' + (!card ? ' translation-shortcut-bubble' : '')} data-floating-hitbox-managed="true" data-navigation-surface={surface} data-placed={placed} data-material-ready={opticsReady && (!requiresSource || sampled)} data-glass-control-owner="translation" role={card ? 'region' : 'status'} aria-label={card ? '选区翻译浮窗' : '选区翻译快捷键提示'} onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCollapse(); } }}>
    <LiquidGlassSurface stretch variant="panel" effect="refractive" bezelWidth={36} blur={TRANSLATION_CAPSULE_METRICS.blur} blurLimit={TRANSLATION_CAPSULE_METRICS.blur} strength={.65} specularOpacity={.13} interaction="none" onReady={setOpticsReady} backdropImage={sampled ? backdrop.image : undefined} backdropSample={sampled ? { origin: { x: TRANSLATION_CAPSULE_METRICS.shadowGutter + rect.x, y: TRANSLATION_CAPSULE_METRICS.shadowGutter + rect.y }, cssSize: { width: rect.width, height: rect.height } } : undefined} bounds={localBounds} />
    <div className="selection-translation-content" ref={content}>
      {card ? <><button className="translation-drag-handle" aria-label="拖动译文，向下拖动收起" title="拖动可拉伸玻璃，向下拖动收起；也可按 Esc" onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onCollapse(); } }} onPointerDown={event => {
        if (event.button !== 0 || gesture.current) return;
        event.preventDefault(); cancelAnimationFrame(frame.current);
        const x = event.screenX, y = event.screenY;
        gesture.current = { id: event.pointerId, x: x - axes.current.x.value, y: y - axes.current.y.value, lastX: x, lastY: y, time: performance.now(), moved: false };
        event.currentTarget.setPointerCapture(event.pointerId); redraw.current();
      }} onPointerMove={event => {
        const drag = gesture.current; if (!drag || drag.id !== event.pointerId) return;
        const time = performance.now(), dt = Math.max(8, time - drag.time) / 1000, x = event.screenX, y = event.screenY, dx = x - drag.x, dy = y - drag.y;
        drag.moved ||= Math.hypot(dx, dy) >= 4;
        axes.current.x = { value: dx, velocity: Math.max(-1800, Math.min(1800, (x - drag.lastX) / dt)) }; axes.current.y = { value: dy, velocity: Math.max(-1800, Math.min(1800, (y - drag.lastY) / dt)) };
        drag.lastX = x; drag.lastY = y; drag.time = time; redraw.current();
      }} onPointerUp={event => release(event)} onPointerCancel={event => release(event, true)} onLostPointerCapture={event => release(event, true)}><span /></button>{renderCard(card)}</> : <button className="translation-shortcut-prompt" onClick={onTranslate}><Languages size={15} /><span>翻译选中文字</span><kbd>{shortcut}</kbd></button>}
    </div>
  </div>;
}
