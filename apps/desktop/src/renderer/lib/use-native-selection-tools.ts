import { useEffect, useRef } from 'react';
import type { ReadingContext, Rect } from '../../../../../packages/contracts/src/index';
import type { SettingsSnapshot } from '../../../../../packages/settings/src/index';
import { call } from './transport';
import { humanNativeSelection, nativeSelectionAnchor, nativeSelectionKey, nativeSelectionLayout } from './native-selection';
import { readSelectionPanelBounds } from './selection-position';
import { SelectionToolbarMotion } from './selection-toolbar-motion';
import { animatedMotion, resolveMotionMode } from './motion';
import { glassSpringParameters } from './glass-elasticity';
import { KUBE_GLASS_SPRINGS } from './glass-presets';
import { FLOATING_HITBOX_EVENT } from './floating-hitboxes';

type SelectionTools = { snapshot: { id: string }; actions: unknown[] };
/** Fetch once per source selection. Scroll/resize only moves the trusted surface. */
export function useNativeSelectionTools(enabled: boolean, context: ReadingContext | undefined, settings: SettingsSnapshot | undefined, report: (error: unknown) => void, navigationVisible = true) {
  const current = useRef({ enabled, context, settings, report, navigationVisible }); current.current = { enabled, context, settings, report, navigationVisible };
  const cache = useRef<{ key: string; value?: SelectionTools; pending?: Promise<SelectionTools> } | undefined>(undefined);
  const dismissed = useRef<string | undefined>(undefined);
  const navigation = useRef<{viewId:string;bounds?:Rect}|undefined>(undefined),navigationFlight=useRef<{viewId:string;revision:number}|undefined>(undefined),navigationRevision=useRef(0),published = useRef<string|undefined>(undefined);
  const motion=useRef(new SelectionToolbarMotion()),frame=useRef(0),lastFrameAt=useRef(0),fullPublication=useRef<string|undefined>(undefined),publishFrame=useRef<(seconds?:number)=>void>(()=>{});
  const stopMotion=()=>{cancelAnimationFrame(frame.current);frame.current=0;motion.current.reset();};
  const tick=(now:number)=>{frame.current=0;const seconds=(now-lastFrameAt.current)/1000;lastFrameAt.current=now;publishFrame.current(seconds);if(motion.current.moving&&!frame.current)frame.current=requestAnimationFrame(tick);};
  const schedule=()=>{if(frame.current)return;lastFrameAt.current=performance.now();frame.current=requestAnimationFrame(tick);};
  const publish = (seconds=0) => {
    const now = current.current, c = now.context;
    if (!now.enabled || !c || !humanNativeSelection(c)) {
      cache.current = undefined; dismissed.current = undefined; published.current=undefined;fullPublication.current=undefined;motion.current.reset();cancelAnimationFrame(frame.current);frame.current=0; void call('selection-layout', { visible: false }); return;
    }
    const key = nativeSelectionKey(c);
    if (dismissed.current === key) { stopMotion(); return; }
    const present = (selection: SelectionTools) => {
      const latest = current.current, context = latest.context;
      if (!latest.enabled || !context || !humanNativeSelection(context) || cache.current?.key !== key || nativeSelectionKey(context) !== key || dismissed.current === key) return;
      if(latest.navigationVisible&&navigation.current?.viewId!==context.viewId){
        if(navigationFlight.current?.viewId===context.viewId)return;
        const ticket={viewId:context.viewId,revision:navigationRevision.current};navigationFlight.current=ticket;
        void call<{visible:boolean;bounds?:Rect}>('navigation-bounds',{viewId:context.viewId}).then(geometry=>{
          if(navigationFlight.current!==ticket)return;
          navigationFlight.current=undefined;
          if(current.current.context?.viewId!==ticket.viewId)return;
          if(ticket.revision!==navigationRevision.current){publish();return;}
          // A just-created navigation must publish its real capsule before a
          // selection can be shown. Never invent a full-width occlusion band.
          if(geometry.visible&&!geometry.bounds)return;
          navigation.current={viewId:ticket.viewId,bounds:geometry.bounds};
          // Navigation geometry belongs to the view, independently of which
          // selection is current when the IPC receipt arrives.
          if(cache.current?.key!==key){publish();return;}present(selection);
        }).catch(error=>{if(navigationFlight.current===ticket){navigationFlight.current=undefined;current.current.report(error);}});return;
      }
      const reader = document.querySelector('.reader-panel')?.getBoundingClientRect(); if (!reader) return;
      const obstacle=latest.navigationVisible&&navigation.current?.viewId===context.viewId?navigation.current.bounds:undefined;
      const obstacles=[...(obstacle?[obstacle]:[]),...readSelectionPanelBounds()],desired=nativeSelectionLayout(context,reader,selection.actions.length,obstacles);
      const mode=resolveMotionMode(document.documentElement.dataset.motion,matchMedia('(prefers-reduced-motion: reduce)').matches);
      const semanticIdentity=JSON.stringify([context.viewId,context.contentRevision,context.viewport?.navigationId,context.selection.kind,context.selection.text,context.selection.locator]);
      let pose=motion.current.retarget(desired?{x:desired.x+8,y:desired.y+8,width:desired.width-16}:undefined,{viewport:reader,height:46,obstacles,selection:nativeSelectionAnchor(context,reader),gap:10},semanticIdentity,animatedMotion(mode));
      if(seconds>0)pose=motion.current.step(seconds,glassSpringParameters(KUBE_GLASS_SPRINGS.lensShape,mode));
      const bounds=pose?{x:pose.x-8,y:pose.y-8,width:pose.width+16,height:62}:undefined;
      if(motion.current.moving&&seconds===0)schedule();
      const signature=JSON.stringify([context.viewId,selection.snapshot.id,bounds,latest.settings?.revision]);if(published.current===signature)return;published.current=signature;
      const fullKey=JSON.stringify([context.viewId,selection.snapshot.id,latest.settings?.revision]),geometryOnly=!!bounds&&fullPublication.current===fullKey;
      fullPublication.current=bounds?fullKey:undefined;
      // No legal lane is a safety withdrawal, not a voluntary animated exit:
      // omit viewId so the native host removes its old hit target immediately.
      void call('selection-layout',!bounds?{visible:false}:geometryOnly?{viewId:context.viewId,visible:true,geometryOnly:true,snapshotId:selection.snapshot.id,bounds}:{ viewId: context.viewId, visible:true, selection, settings: latest.settings, bounds }).catch(error=>{if(published.current===signature){published.current=undefined;fullPublication.current=undefined;}latest.report(error);});
    };
    if (cache.current?.key === key) { if (cache.current.value) present(cache.current.value); return; }
    const entry = { key, pending: call<SelectionTools>('selection-tools', { viewId: c.viewId }) } as NonNullable<typeof cache.current>;
    cache.current = entry;
    // A pending replacement has no presented geometry to animate. In
    // particular, never keep an obsolete selection's rAF alive while awaiting
    // its successor's (potentially slow) snapshot request.
    stopMotion();published.current=undefined;fullPublication.current=undefined;
    // An obsolete async request must never display a previous selection.
    void call('selection-layout', { visible: false });
    void entry.pending!.then(value => { if (cache.current !== entry) return; entry.value = value; entry.pending = undefined; present(value); }).catch(error => { if (cache.current === entry) { cache.current = undefined; current.current.report(error); } });
  };
  publishFrame.current=publish;
  const key = context && nativeSelectionKey(context), r = context?.selection.rect;
  useEffect(publish, [enabled, key, context?.actor, r?.x, r?.y, r?.width, r?.height, context?.viewport?.width, context?.viewport?.height, settings?.revision,navigationVisible]);
  useEffect(() => {
    // DOM readers own their own selection and sidebars. Do not subscribe to
    // every pane animation merely to send repeated hidden native layouts.
    if(!enabled)return;
    const resize = new ResizeObserver(() => publish()), reader = document.querySelector('.reader-panel'),workbench=document.querySelector('.workbench'); if (reader) resize.observe(reader);
    const observed=new Set<Element>(),panels=new MutationObserver(records=>{if(records.some(record=>record.type==='childList'))observe();publish();});
    const observe=()=>{panels.disconnect();for(const pane of observed)resize.unobserve(pane);observed.clear();if(workbench)panels.observe(workbench,{childList:true,attributes:true,attributeFilter:['style']});for(const pane of workbench?.querySelectorAll(':scope > .floating-side-panel,:scope > .activity-rail,:scope > .ai-rail')??[]){observed.add(pane);resize.observe(pane);panels.observe(pane,{attributes:true,attributeFilter:['class','style','data-motion-phase']});}};
    observe();
    const off = window.agentViewer?.onSelectionTool(event => { if (event.action === 'dismiss') { const c = current.current.context; dismissed.current = c && nativeSelectionKey(c);stopMotion();published.current=undefined;fullPublication.current=undefined; void call('selection-layout', { visible: false, animate: true }); } });
    const offNavigation=window.agentViewer?.onToolbar(event=>{if(event.action!=='geometry'||event.viewId!==current.current.context?.viewId)return;const bounds=event.bounds as Rect|undefined;if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite))return;navigationRevision.current++;navigation.current={viewId:String(event.viewId),bounds};publish();});
    const onResize=()=>publish();window.addEventListener('resize',onResize);
    window.addEventListener(FLOATING_HITBOX_EVENT,onResize);
    return () => { resize.disconnect();panels.disconnect();cancelAnimationFrame(frame.current);frame.current=0;motion.current.reset();off?.();offNavigation?.();published.current=undefined;fullPublication.current=undefined;window.removeEventListener('resize',onResize);window.removeEventListener(FLOATING_HITBOX_EVENT,onResize);void call('selection-layout', { visible: false }); };
  }, [enabled]);
}
