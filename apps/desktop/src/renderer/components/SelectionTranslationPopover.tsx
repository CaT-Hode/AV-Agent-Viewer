import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { Languages } from 'lucide-react';
import type { ReadingContext, Rect } from '../../../../../packages/contracts/src/index';
import { call, desktop } from '../lib/transport';
import { fitTranslationCapsule, placeTranslationPopover, shouldCollapseTranslation, translationDragShape, translationTextHeight, TRANSLATION_CAPSULE_METRICS } from '../lib/translation-popover';
import { stepGlassSpring, type SpringAxis } from '../lib/glass-elasticity';
import { animatedMotion, useMotionSnapshot } from '../lib/motion';
import { updateFloatingHitbox } from '../lib/floating-hitboxes';
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
  const [opticsReady, setOpticsReady] = useState(false), [placed, setPlaced] = useState(false), [localBounds, setLocalBounds] = useState<Rect>();
  const motion = useMotionSnapshot(), animate = animatedMotion(motion.split(':')[0] as Parameters<typeof animatedMotion>[0]);
  const current = useRef({ card, onCollapse, animate, growthRatio }); current.current = { card, onCollapse, animate, growthRatio };
  const textMetrics=useRef<{key:string;height:(width:number)=>number}|undefined>(undefined),fitted=useRef<{key:string;size:ReturnType<typeof fitTranslationCapsule>}|undefined>(undefined);
  const redraw = useRef<() => void>(() => {});
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
  useLayoutEffect(() => { redraw.current(); }, [motion, card?.result, card?.status, card?.error, growthRatio]);
  useLayoutEffect(() => {
    const node = host.current, body = content.current; if (!node || !body) return;
    let disposed = false, layoutFrame = 0, inflight = false, sent = '', published = '', desired: Rect | undefined;
    let painted:Rect|undefined;
    const publish = (bounds?: Rect) => {
      painted=bounds;
      updateFloatingHitbox('translation:'+viewId,bounds?{group:'translation',bounds,canMove:true,canCollapse:true,yield:next=>{if(!next||!painted){current.current.onCollapse();return;}collisionOffset.current.x+=next.x-painted.x;collisionOffset.current.y+=next.y-painted.y;draw();}}:undefined);
      const key = JSON.stringify(bounds); if (key === published) return; published = key; window.dispatchEvent(new CustomEvent('agentviewer:translation-geometry', { detail: { viewId, bounds } }));
    };
    const send = () => {
      if (!native || inflight || disposed) return;
      const signature = JSON.stringify(desired); if (signature === sent) return;
      const bounds = desired; sent = signature; inflight = true;
      void call('translation-popover-layout', { viewId, visible: !!bounds, bounds }).then(()=>{delete node.dataset.layoutError;}).catch(error => { node.dataset.layoutError=String(error); }).finally(() => { inflight = false; if (!disposed && sent !== JSON.stringify(desired)) send(); });
    };
    const draw = () => {
      if (disposed) return;
      const now = current.current, reader = document.querySelector('.reader-panel')?.getBoundingClientRect();
      const viewport = reader ? { x: reader.x + 4, y: reader.y + 4, width: reader.width - 8, height: reader.height - 8 } : { x: 44, y: 60, width: innerWidth - 88, height: innerHeight - 94 };
      let size:{width:number;height:number};
      if(now.card){
        const text=now.card.status==='ready'?now.card.result:now.card.error??'正在翻译选中内容…',key=now.card.status+':'+text;
        if(textMetrics.current?.key!==key){
          const style=getComputedStyle(node.querySelector('.translation-result,.translation-loading,.translation-error')??body),canvas=node.ownerDocument.createElement('canvas'),context=canvas.getContext('2d')!;
          context.font=style.fontWeight+' '+style.fontSize+' '+style.fontFamily;const lineHeight=Number.parseFloat(style.lineHeight)||Number.parseFloat(style.fontSize)*1.65;
          textMetrics.current={key,height:translationTextHeight(text,value=>context.measureText(value).width,lineHeight)};
        }
        const fitKey=JSON.stringify([key,viewport.width,viewport.height,now.growthRatio]);
        if(fitted.current?.key!==fitKey){
          const next=fitTranslationCapsule(viewport,textMetrics.current.height,now.growthRatio);
          node.style.maxHeight=next.maxHeight+'px';
          // Canvas wrapping is an estimate. Correct actual font/scrollbar
          // differences only for a new fit, never during gesture/spring frames.
          for(let attempt=0;attempt<4;attempt++){
            node.style.width=next.width+'px';node.style.height=next.height+'px';
            const result=node.querySelector<HTMLElement>('.translation-result');if(!result)break;
            const overflow=result.scrollHeight-result.clientHeight;if(overflow<=1)break;
            if(next.height<next.maxHeight){const delta=Math.min(next.maxHeight-next.height,overflow+2);next.height+=delta;next.width=Math.min(next.maxWidth,Math.ceil(next.width+next.growthRatio*delta));}
            else if(next.width<next.maxWidth)next.width=Math.min(next.maxWidth,Math.ceil(next.width+Math.max(8,(next.width-TRANSLATION_CAPSULE_METRICS.horizontalInset)*overflow/Math.max(1,result.clientHeight))));
            else break;
          }
          fitted.current={key:fitKey,size:next};
        }
        size=fitted.current.size;
        if(node.style.width!==size.width+'px')node.style.width=size.width+'px';if(node.style.height!==size.height+'px')node.style.height=size.height+'px';
      }else{node.style.width='max-content';node.style.height='auto';size={width:node.offsetWidth,height:body.scrollHeight};}
      const position = placeTranslationPopover(viewport,size);
      if (!position) { node.style.visibility = 'hidden'; desired = undefined; publish(); send(); return; }
      const x = Math.max(viewport.x + 4, Math.min(viewport.x + viewport.width - position.width - 4, position.x + axes.current.x.value+collisionOffset.current.x));
      const y = Math.max(viewport.y + 4, Math.min(viewport.y + viewport.height - position.height - 4, position.y + axes.current.y.value+collisionOffset.current.y));
      node.style.maxHeight = position.maxHeight + 'px'; node.style.visibility = ''; node.dataset.placement = position.edge;
      const previous = previousSize.current;
      if (previous && now.animate && (Math.abs(previous.width-position.width)>.5 || Math.abs(previous.height-position.height)>.5)) {
        sizes.current.x.value *= previous.width / Math.max(1,position.width); sizes.current.y.value *= previous.height / Math.max(1,position.height);
        if (!frame.current && !gesture.current) { lastFrame.current = performance.now(); frame.current = requestAnimationFrame(settle); }
      }
      previousSize.current = { width: position.width, height: position.height };
      if (!now.animate) sizes.current = { x: { value: 1, velocity: 0 }, y: { value: 1, velocity: 0 } };
      const shape = now.animate ? translationDragShape(axes.current.x.value, axes.current.y.value) : { scaleX: 1, scaleY: 1 };
      const scaleX=shape.scaleX*sizes.current.x.value,scaleY=shape.scaleY*sizes.current.y.value;
      node.style.setProperty('--translation-stretch-x', String(scaleX)); node.style.setProperty('--translation-stretch-y', String(scaleY)); node.dataset.dragging = String(!!gesture.current);
      const paintWidth=Math.max(position.width,position.width*scaleX),paintHeight=Math.max(position.height,position.height*scaleY),paint={x:x+(position.width-paintWidth)/2,y:y+position.height-paintHeight,width:paintWidth,height:paintHeight};
      node.style.left = native ? 12+x-paint.x+'px' : x + 'px'; node.style.top = native ? 12+y-paint.y+'px' : y + 'px';
      setPlaced(true);
      publish(paint);
      if (native) {
        const next = { x: 12+x-paint.x, y: 12+y-paint.y, width: position.width, height: position.height };
        setLocalBounds(previous => previous && ['x','y','width','height'].every(key=>Math.abs(previous[key as keyof Rect]-next[key as keyof Rect])<.25) ? previous : next);
        desired = paint; send();
      }
    };
    const schedule = () => { if (!layoutFrame) layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; draw(); }); };
    redraw.current = draw;
    const observer = new ResizeObserver(schedule); observer.observe(node); observer.observe(body);
    const yieldRoom=(event:Event)=>{const next=(event as CustomEvent<{bounds?:Rect}>).detail.bounds;if(!next){current.current.onCollapse();return;}const box=node.getBoundingClientRect();collisionOffset.current.x+=next.x-box.x;collisionOffset.current.y+=next.y-box.y;draw();};
    node.addEventListener('agentviewer:floating-yield',yieldRoom);
    window.addEventListener('resize', schedule);
    draw();
    return () => { disposed = true; redraw.current = () => {}; observer.disconnect(); cancelAnimationFrame(layoutFrame); publish();node.removeEventListener('agentviewer:floating-yield',yieldRoom); window.removeEventListener('resize', schedule); if (native) void call('translation-popover-layout', { viewId, visible: false }).catch(() => {}); };
  }, [native, viewId]);
  const settle = (time: number) => {
    frame.current = 0; const dt = Math.min(.064, (time - lastFrame.current) / 1000); lastFrame.current = time; let moving = false;
    for (const key of ['x','y'] as const) {
      const axis = current.current.animate ? stepGlassSpring(axes.current[key], 0, dt, { stiffness: 380, damping: 32 }) : { value: 0, velocity: 0 };
      if (Math.abs(axis.value) < .08 && Math.abs(axis.velocity) < .8) axes.current[key] = { value: 0, velocity: 0 }; else { axes.current[key] = axis; moving = true; }
      const size = current.current.animate ? stepGlassSpring(sizes.current[key], 1, dt, { stiffness: 420, damping: 34 }) : { value: 1, velocity: 0 };
      if (Math.abs(size.value-1)<.001 && Math.abs(size.velocity)<.008) sizes.current[key] = { value: 1, velocity: 0 }; else { sizes.current[key] = size; moving = true; }
    }
    redraw.current(); if (moving) frame.current = requestAnimationFrame(settle);
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
  const preferences = document.documentElement.dataset, requiresSource = native && preferences.glass !== 'off' && preferences.contrast !== 'high' && preferences.reduceTransparency !== 'true';
  return <div {...presence} ref={host} className={'selection-translation-bubble material-host' + (!card ? ' translation-shortcut-bubble' : '')} data-floating-hitbox-managed="true" data-material-ready={placed && opticsReady && (!requiresSource || sampled)} data-glass-control-owner="translation" role={card ? 'region' : 'status'} aria-label={card ? '选区翻译浮窗' : '选区翻译快捷键提示'} onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCollapse(); } }}>
    <LiquidGlassSurface variant="panel" effect="refractive" bezelWidth={36} blur={1} blurLimit={1} strength={.65} specularOpacity={.13} interaction="none" onReady={setOpticsReady} backdropImage={sampled ? backdrop.image : undefined} backdropSample={sampled ? { origin: { x: 12 + rect.x, y: 12 + rect.y }, cssSize: { width: rect.width, height: rect.height } } : undefined} bounds={localBounds} />
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
