import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { DocumentInfo, Rect, ViewInfo } from '../../../../../packages/contracts/src/index';
import { OFFICE_SURFACE_METHODS, isOfficeSurfaceState, type OfficeInputModifiers, type OfficeSurfaceEvent, type OfficeSurfaceInputEvent, type OfficeSurfaceLayoutRequest, type OfficeSurfaceSelectionProjection, type OfficeSurfaceState, type OfficeSurfaceTilesReply } from '../../../../../packages/contracts/src/office-surface';
import type { OfficeDraftController } from './OfficeDocument';
import { NativeOfficeFormulaBar } from './NativeOfficeFormulaBar';
import { EmbeddedOfficeDialogHost } from './EmbeddedOfficeDialogHost';
import { OfficeHorizontalScrollbar } from './OfficeHorizontalScrollbar';
import { call } from '../lib/transport';
import { OfficeSurfaceInputController } from '../lib/office-surface-controller';
import { OfficeSurfaceDispatchQueue } from '../lib/office-surface-dispatch';
import { OfficeTileCache } from '../lib/office-tile-cache';
import { officeTileRgba } from '../lib/office-surface-pixels';
import { OfficePointerClickTracker, type OfficePointerCapture } from '../lib/office-surface-pointer';
import { officeSurfaceStaleRead } from '../lib/office-surface-errors';
import { useEmbeddedOfficeSelectionTools } from '../lib/useEmbeddedOfficeSelectionTools';
import { OfficePendingScroll } from '../lib/office-pending-scroll';
import { observeNavigationLane, readNavigationLane } from '../lib/navigation-lane';
import { officePresentationFitForView, officePresentationManualLayout } from '../lib/office-presentation-fit';
import {OfficeFramePresenter,drawOfficeFrameTile} from '../lib/office-frame-presenter';
import { useOfficeFormulaNavigationHost } from '../lib/useOfficeFormulaNavigationHost';
import { intersectOfficeRect, officeCssScale, officeCurrentPage, officeDocumentPoint, officeSheetCanvasLayout, officeSurfaceClipRects, officeSurfaceSize, officeTileBatches, officeViewportRect, officeVisibleTiles, officeVisibleTwips, type OfficeSurfaceGeometry } from '../lib/office-surface-geometry';
import '../embedded-office.css';

export type EmbeddedOfficeDocumentProps = {
  document: DocumentInfo; view: ViewInfo; obscured?: boolean; reportError(error: unknown): void;
  onOfficeDraftController?(controller: OfficeDraftController | undefined): void;
  onOfficeDraftChange?(value: { viewId: string; dirty: boolean }): void;
  onReaderScroll?(y: number): void; onZoomChange?(factor: number): void;
};
const modifiers = (event: Pick<KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): OfficeInputModifiers => ({ shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey });
const sameIdentity = (a: OfficeSurfaceState, b: OfficeSurfaceState) => a.sessionId === b.sessionId && a.engineEpoch === b.engineEpoch && a.viewId === b.viewId && a.documentId === b.documentId;
/** LibreOffice owns the document, layout and editing; DOM owns tiles, focus and accessible input. */
export function EmbeddedOfficeDocument(props: EmbeddedOfficeDocumentProps) {
  const { document: file, view } = props, identity = file.id + ':' + view.id;
  useEmbeddedOfficeSelectionTools(view.id, !props.obscured);
  const latest = useRef(props); latest.current = props;
  const scroll = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), input = useRef<HTMLTextAreaElement>(null), formulaDraft = useRef<OfficeDraftController | undefined>(undefined);
  const formulaHost = useOfficeFormulaNavigationHost(scroll);
  const [surface, setSurface] = useState<OfficeSurfaceState>(), [failure, setFailure] = useState(''), [viewportVersion, setViewportVersion] = useState(0), [, inputChanged] = useState(0);
  const current = useRef(surface), mounted = useRef(false), generation = useRef(0), frame = useRef(0), tileFlight = useRef(false), tileQueued = useRef(false), layoutRevision = useRef(0), lastLayout = useRef(''), zoom = useRef(view.zoom ?? 1);
  const dispatchQueue = useMemo(() => new OfficeSurfaceDispatchQueue(), [identity]);
  const presentationFit=useMemo(()=>file.format==='pptx'?officePresentationFitForView(identity):undefined,[identity,file.format]);
  presentationFit?.observeZoom(view.zoom??1);
  const fitTiming=useRef({timer:0,started:0});
  const presentationLane=useRef({left:12,right:12});
  const presenter=useMemo(()=>new OfficeFramePresenter(),[identity]);
  zoom.current = view.zoom ?? 1;
  const composition = useRef<{ id: string; text: string } | undefined>(undefined), lastCompositionCommit = useRef<{ text: string; at: number } | undefined>(undefined), pointer = useRef<OfficePointerCapture | undefined>(undefined), clicks = useRef(new OfficePointerClickTracker());
  const inputFailure = useRef(''), paintRetry = useRef({ after: 0, failures: 0 }), lastSelectionProjection = useRef('');
  const lastInvalidationSequence = useRef(-1);
  const pendingScroll=useRef(new OfficePendingScroll());
  const retiredSessions = useRef(new Set<string>());
  useLayoutEffect(() => {
    if (file.format !== 'xlsx' && file.format !== 'pptx') return;
    const host=scroll.current?.closest<HTMLElement>('.embedded-office-document'),reader=host?.closest<HTMLElement>('.reader-panel');
    if (!host || !reader) return;
    // Calc owns a bounded sheet frame in the same unobstructed lane as the
    // navigation. Impress only bounds the page until the user manually zooms.
    const write=(name:string,value:number)=>{const next=value+'px';if(host.style.getPropertyValue(name)!==next)host.style.setProperty(name,next);};
    const update=()=>{
      const lane=readNavigationLane(reader);
      const right=Math.max(0,reader.getBoundingClientRect().width-lane.right);
      write('--office-controls-left-inset',lane.left);write('--office-controls-right-inset',right);
      const nav=reader.querySelector<HTMLElement>('.navigation-toolbar'),height=nav&&!nav.classList.contains('is-hidden')?Number.parseFloat(getComputedStyle(nav).getPropertyValue('--navigation-height'))||60:0;
      if(file.format==='xlsx'){
        write('--office-sheet-left-inset',lane.left);write('--office-sheet-right-inset',right);
        write('--office-sheet-top-inset',height?height+24:12);
      }
      if(file.format==='pptx'){
        const changed=presentationLane.current.left!==lane.left||presentationLane.current.right!==lane.right;presentationLane.current={left:lane.left,right:lane.right};
        if(changed&&!presentationFit?.enabled)setViewportVersion(version=>version+1);
        write('--office-presentation-left-inset',lane.left);write('--office-presentation-right-inset',right);
        write('--office-presentation-top-inset',height+24);
      }
    };
    const stop=observeNavigationLane(reader,update),nav=reader.querySelector('.navigation-toolbar'),changes=new MutationObserver(update);
    if(nav)changes.observe(nav,{attributes:true,attributeFilter:['style','class','aria-hidden']});
    return()=>{stop();changes.disconnect();};
  }, [identity, file.format,presentationFit]);
  const cache = useMemo(() => new OfficeTileCache<ImageBitmap>(48 * 1024 * 1024, bitmap => bitmap.close()), [identity]);
  const accept = useCallback((next: OfficeSurfaceState) => {
    if (!mounted.current || !isOfficeSurfaceState(next) || next.documentId !== latest.current.document.id || next.viewId !== latest.current.view.id) return;
    const previous = current.current;
    const source = next.sessionId + ':' + next.engineEpoch;
    if (retiredSessions.current.has(source)) return;
    if (previous && sameIdentity(previous, next) && (next.engineRevision < previous.engineRevision || next.engineRevision === previous.engineRevision && ((next.selectionEpoch ?? 0) < (previous.selectionEpoch ?? 0) || next.eventSequence < previous.eventSequence))) return;
    if (!previous || !sameIdentity(previous, next) || next.renderGeneration !== previous.renderGeneration) { cache.clear(); generation.current++; if (!previous || !sameIdentity(previous, next)) { lastInvalidationSequence.current = -1; if (previous) { retiredSessions.current.add(previous.sessionId + ':' + previous.engineEpoch); if (retiredSessions.current.size > 32) retiredSessions.current.delete(retiredSessions.current.values().next().value!); } } }
    if(!previous||!sameIdentity(previous,next)||next.partIndex!==previous.partIndex){presenter.clear();const target=canvas.current;target?.getContext('2d')?.clearRect(0,0,target.width,target.height);}
    if (previous && next.partIndex !== previous.partIndex) { const host = scroll.current; if (host) { host.scrollTop = 0; host.scrollLeft = 0; } lastLayout.current = ''; }
    current.current = next; layoutRevision.current = Math.max(layoutRevision.current, next.layoutRevision); setSurface(next); if (next.status === 'ready' && !inputFailure.current) setFailure('');
  }, [cache,presenter]);
  const measure = useCallback((): OfficeSurfaceGeometry | undefined => {
    const host = scroll.current, state = current.current; if (!host || !state) return;
    const rect = host.getBoundingClientRect(), size = officeSurfaceSize(state), scale = officeCssScale(zoom.current);
    const viewport={x:rect.x,y:rect.y,width:host.clientWidth,height:host.clientHeight};
    const manual=latest.current.document.format==='pptx'&&!presentationFit?.enabled,reader=manual?host.closest('.reader-panel')?.getBoundingClientRect():undefined;
    const extra=latest.current.document.format==='xlsx'?officeSheetCanvasLayout({width:size.width*scale,height:size.height*scale},viewport):manual&&reader?officePresentationManualLayout({width:size.width*scale,height:size.height*scale},viewport,{left:Math.max(0,presentationLane.current.left-(rect.left-reader.left)),right:Math.max(0,(rect.left+host.clientWidth-reader.left)-presentationLane.current.right)}):{};
    return { zoom: zoom.current, scrollX: host.scrollLeft, scrollY: host.scrollTop, offsetX: Math.max(0, (host.clientWidth - size.width * scale) / 2), offsetY: latest.current.document.format==='pptx'?Math.max(0,(host.clientHeight-size.height*scale)/2):0, viewport,...extra };
  }, [presentationFit]);
  const refresh = useCallback(async () => { const next = await call<OfficeSurfaceState>(OFFICE_SURFACE_METHODS.state, { viewId: latest.current.view.id }); if (!isOfficeSurfaceState(next)) throw new Error('Office 内置核心没有返回 tiled 编辑会话。'); accept(next); }, [accept]);
  const synchronizeLayoutLocked = useCallback(async (): Promise<void> => {
    if (!mounted.current || latest.current.document.id + ':' + latest.current.view.id !== identity) return;
    const state = current.current, geometry = measure(); if (!state || !geometry || state.status !== 'ready') return;
    const host=scroll.current;if(!host)return;
    const size = officeSurfaceSize(state), request: OfficeSurfaceLayoutRequest = { viewId: state.viewId, layoutRevision: 0, partIndex: state.partIndex, visibleTwips: officeVisibleTwips(geometry, size), viewportCss: { width: geometry.viewport.width, height: geometry.viewport.height }, documentOriginCss: { x: geometry.offsetX - geometry.scrollX, y: geometry.offsetY - geometry.scrollY },canvasOffsetCss:{x:geometry.offsetX,y:geometry.offsetY},scrollCss:{x:geometry.scrollX,y:geometry.scrollY},scrollExtentCss:{x:Math.max(0,host.scrollWidth-host.clientWidth),y:Math.max(0,host.scrollHeight-host.clientHeight)},safeViewportCss:geometry.safeViewport??{x:0,y:0,width:host.clientWidth,height:host.clientHeight}, boundsCss: geometry.viewport, zoom: zoom.current, deviceScaleFactor: window.devicePixelRatio || 1, visible: !latest.current.obscured && !window.document.hidden, focused: window.document.activeElement === input.current };
    const signature = JSON.stringify({ ...request, layoutRevision: undefined });
    if (signature === lastLayout.current && state.layoutRevision === layoutRevision.current) return;
    request.layoutRevision = ++layoutRevision.current;
    const next = await call<OfficeSurfaceState>(OFFICE_SURFACE_METHODS.layout, request);
    // Rendering invalidation may happen while the layout call is in flight.
    // It retires pixels, not an acknowledged layout of the same live session.
    if (mounted.current && current.current && sameIdentity(state, current.current) && isOfficeSurfaceState(next) && sameIdentity(state, next)) { lastLayout.current = signature; accept(next); }
  }, [identity, accept, measure]);
  const synchronizeLayout = useCallback(() => dispatchQueue.run(synchronizeLayoutLocked), [dispatchQueue, synchronizeLayoutLocked]);
  const inputRequest = useCallback(<T,>(method: string, args: Record<string, unknown> = {}): Promise<T> => {
    const before = current.current;
    return dispatchQueue.run(async () => {
    if (!mounted.current || !before || before.viewId !== args.viewId || before.partIndex !== args.expectedPartIndex || !current.current || !sameIdentity(before, current.current) || before.partIndex !== current.current.partIndex) throw new Error('Office 输入目标已变化；输入不会自动重试。');
    await synchronizeLayoutLocked();
    const live = current.current;
    if (!mounted.current || !before || !live || !sameIdentity(before, live) || args.expectedPartIndex !== live.partIndex) throw new Error('Office 输入目标已变化；输入不会自动重试。');
    // The exact engine coordinate version is read while layout writers are
    // excluded, immediately before this one input is dispatched.
    return call<T>(method, { ...args, layoutRevision: live.layoutRevision });
    });
  }, [dispatchQueue, synchronizeLayoutLocked]);
  const inputController = useMemo(() => new OfficeSurfaceInputController(view.id, { request: inputRequest, state: () => current.current, beforeInput: async () => {}, accept, changed: () => { if (mounted.current) inputChanged(version => version + 1); } }), [identity, surface?.sessionId, surface?.engineEpoch, accept, inputRequest]);
  const fail = useCallback((cause: unknown) => { if (!mounted.current) return; const message = cause instanceof Error ? cause.message : String(cause); setFailure(message); latest.current.reportError(cause); }, []);
  const schedulePresentationFit=useCallback(()=>{
    if(!presentationFit?.enabled)return;
    const now=performance.now(),timing=fitTiming.current;if(!timing.started)timing.started=now;
    clearTimeout(timing.timer);timing.timer=window.setTimeout(()=>{
      timing.timer=0;timing.started=0;
      const state=current.current,geometry=measure();if(!mounted.current||!state||!geometry||latest.current.obscured||state.status!=='ready'||latest.current.document.id+':'+latest.current.view.id!==identity)return;
      if(state.pendingInput){schedulePresentationFit();return;}
      const factor=presentationFit.request(officeSurfaceSize(state),geometry.viewport,latest.current.view.zoom??1);
      if(factor===undefined)return;
      if(latest.current.onZoomChange)latest.current.onZoomChange(factor);else void call('zoom',{viewId:latest.current.view.id,factor}).catch(fail);
    },Math.max(0,Math.min(180,500-(now-timing.started))));
  },[identity,presentationFit,measure,fail]);
  useEffect(()=>{if(surface)schedulePresentationFit();},[surface,viewportVersion,view.zoom,schedulePresentationFit]);
  useEffect(()=>()=>{clearTimeout(fitTiming.current.timer);fitTiming.current={timer:0,started:0};},[identity]);
  useEffect(()=>{
    if(!presentationFit)return;
    const manual=(event:Event)=>{
      const detail=(event as CustomEvent<{viewId?:string}>).detail;if(detail?.viewId!==latest.current.view.id)return;
      presentationFit.manual();clearTimeout(fitTiming.current.timer);fitTiming.current={timer:0,started:0};inputChanged(version=>version+1);
    };
    window.addEventListener('agentviewer:office-manual-zoom',manual);return()=>window.removeEventListener('agentviewer:office-manual-zoom',manual);
  },[identity,presentationFit]);
  const post = useCallback((event: OfficeSurfaceInputEvent) => { void inputController.post(event).catch(cause => { inputFailure.current = cause instanceof Error ? cause.message : String(cause); fail(cause); }); }, [inputController, fail]);
  const paint = useCallback(async () => {
    const state = current.current, geometry = measure(), host = scroll.current, target = canvas.current;
    if (!mounted.current || !state || state.status !== 'ready' || !geometry || !host || !target || latest.current.obscured || performance.now() < paintRetry.current.after) return;
    const size = officeSurfaceSize(state), dpr = window.devicePixelRatio || 1, scale = officeCssScale(geometry.zoom), visible = officeVisibleTwips(geometry, size), allSpecs = officeVisibleTiles(visible, size, geometry.zoom, dpr);
    const visibleBytes = allSpecs.filter(spec => intersectOfficeRect(spec.rectTwips, visible)).reduce((sum, spec) => sum + spec.pixelWidth * spec.pixelHeight * 4, 0);
    if (visibleBytes > 256 * 1024 * 1024) throw new Error('当前 Office 可见区域超过画布资源限制。');
    cache.setBudget(Math.max(16 * 1024 * 1024, Math.min(256 * 1024 * 1024, visibleBytes + 16 * 1024 * 1024)));
    let requestedBytes = 0;
    const specs = allSpecs.sort((a, b) => Number(!!intersectOfficeRect(b.rectTwips, visible)) - Number(!!intersectOfficeRect(a.rectTwips, visible))).filter(spec => { const bytes = spec.pixelWidth * spec.pixelHeight * 4; if (requestedBytes + bytes > cache.budgetBytes) return false; requestedBytes += bytes; return true; });
    const prefix = `${state.sessionId}:${state.engineEpoch}:${state.partIndex}:${state.renderGeneration}:`, active = new Set(specs.map(spec => prefix + spec.key)); cache.pin(active);
    const visibleSpecs=specs.filter(spec=>intersectOfficeRect(spec.rectTwips,visible));
    const presented=presenter.present(target,{scope:state,geometry,dpr,rects:officeSurfaceClipRects(state).filter(rect=>intersectOfficeRect(rect,visible)),pixelRevision:cache.version,complete:visibleSpecs.every(spec=>cache.has(prefix+spec.key)),draw:(context,replacing)=>{
      for(const spec of visibleSpecs){const bitmap=cache.get(prefix+spec.key);if(bitmap)drawOfficeFrameTile(context,bitmap,{x:geometry.offsetX+spec.rectTwips.x*scale-geometry.scrollX,y:geometry.offsetY+spec.rectTwips.y*scale-geometry.scrollY,width:spec.rectTwips.width*scale,height:spec.rectTwips.height*scale},replacing);}
    }});
    if(presented.changed){target.dataset.officeFrameReused=String(presented.reused);target.dataset.officeFrameRevision=String(state.engineRevision);target.dataset.officeFrameZoom=String(geometry.zoom);}
    const missing = specs.filter(spec => !cache.has(prefix + spec.key)); if (!missing.length) return;
    if (tileFlight.current) { tileQueued.current = true; return; }
    tileFlight.current = true; const token = generation.current; let painted = false;
    try {
      for (const batch of officeTileBatches(missing)) {
        if (!mounted.current || token !== generation.current) break;
        const tickets = new Map(batch.map(spec => [spec.key, cache.begin(prefix + spec.key, spec.rectTwips, state.partIndex)]));
        try {
          const reply = await call<OfficeSurfaceTilesReply>(OFFICE_SURFACE_METHODS.tiles, { viewId: state.viewId, layoutRevision: state.layoutRevision, renderGeneration: state.renderGeneration, partIndex: state.partIndex, tiles: batch });
          if (!mounted.current || token !== generation.current || !isOfficeSurfaceState(reply.state) || !sameIdentity(state, reply.state) || reply.partIndex !== state.partIndex || reply.renderGeneration !== state.renderGeneration || reply.layoutRevision !== state.layoutRevision) break;
          const expected = new Map(batch.map(spec => [spec.key, spec]));
          for (const tile of reply.tiles) {
            const spec = expected.get(tile.key), ticket = tickets.get(tile.key); if (!spec || !ticket || tile.width !== spec.pixelWidth || tile.height !== spec.pixelHeight || JSON.stringify(tile.rectTwips) !== JSON.stringify(spec.rectTwips)) throw new Error('Office tile 回执目标不匹配。');
            const bitmap = await createImageBitmap(new ImageData(officeTileRgba(tile), tile.width, tile.height));
            if (!mounted.current || token !== generation.current) { bitmap.close(); break; }
            painted = cache.admit(ticket, bitmap, tile.width * tile.height * 4) || painted; tickets.delete(tile.key);
          }
          if(painted)scheduleRef.current();
        } catch (cause) {
          if (!officeSurfaceStaleRead(cause, 'document')) throw cause;
          // Layout may advance while a batch waits on the engine thread. Its old pixels are simply retired.
          await refresh(); await synchronizeLayout(); tileQueued.current = true; break;
        } finally { for (const ticket of tickets.values()) cache.cancel(ticket); }
      }
      paintRetry.current = { after: 0, failures: 0 };
    } catch (cause) { const failures = paintRetry.current.failures + 1; paintRetry.current = { failures, after: performance.now() + Math.min(10000, 500 * 2 ** Math.min(failures, 5)) }; throw cause; }
    finally { tileFlight.current = false; const queued = tileQueued.current; tileQueued.current = false; if (mounted.current && (painted || queued)) schedule(); }
  }, [cache,presenter, measure, refresh, synchronizeLayout]);
  const paintRef = useRef(paint); paintRef.current = paint;
  const schedule = useCallback(() => { if (!mounted.current || frame.current) return; frame.current = requestAnimationFrame(() => { frame.current = 0; void paintRef.current().catch(fail); }); }, [fail]);
  const scheduleRef = useRef(schedule); scheduleRef.current = schedule;
  useLayoutEffect(() => {
    mounted.current = true; current.current = undefined; generation.current++; lastLayout.current = ''; layoutRevision.current = 0; inputFailure.current = ''; paintRetry.current = { after: 0, failures: 0 }; lastSelectionProjection.current = '';pendingScroll.current.clear();
    let stopped = false, running = false;
    const poll = async () => { if (stopped || running || window.document.hidden) return; running = true; try { await refresh(); } catch (cause) { if (!stopped) { setFailure(cause instanceof Error ? cause.message : String(cause)); } } finally { running = false; } };
    const off = window.agentViewer?.onToolbar(value => {
      const event = value as unknown as OfficeSurfaceEvent;
      if (event.action === 'office-surface-state') { accept(event.state); scheduleRef.current(); }
      else if (event.action === 'office-surface-invalidate') { const state = current.current; if (state && event.viewId === state.viewId && event.sessionId === state.sessionId && event.engineEpoch === state.engineEpoch && event.eventSequence > lastInvalidationSequence.current && event.renderGeneration >= state.renderGeneration) { lastInvalidationSequence.current = event.eventSequence; cache.invalidate(event.partIndex, event.rectTwips); if (!event.rectTwips) generation.current++; scheduleRef.current(); void poll(); } }
      else if (event.action === 'office-surface-scroll') { const state = current.current;if(state){const scale=officeCssScale(zoom.current);if(pendingScroll.current.queue(state,{...event,x:event.scrollCss?.x??event.rectTwips.x*scale-24,y:event.scrollCss?.y??event.rectTwips.y*scale-48})){layoutRevision.current=Math.max(layoutRevision.current,event.layoutRevision);setViewportVersion(version=>version+1);void poll();}} }
    });
    void poll(); const timer = window.setInterval(() => void poll(), 650);
    return () => { stopped = true; mounted.current = false; generation.current++; off?.(); clearInterval(timer); cancelAnimationFrame(frame.current); frame.current = 0; cache.clear();presenter.clear();pendingScroll.current.clear(); };
  }, [identity, accept, refresh, cache,presenter]);
  useEffect(() => () => inputController.dispose(), [inputController]);
  useEffect(() => { const host = scroll.current; if (!host || !surface) return; const changed = () => { setViewportVersion(version => version + 1); lastLayout.current = ''; scheduleRef.current(); void synchronizeLayout().catch(fail); }; const observer = new ResizeObserver(changed); observer.observe(host); window.addEventListener('resize', changed); changed(); return () => { observer.disconnect(); window.removeEventListener('resize', changed); }; }, [!!surface, identity, synchronizeLayout, fail]);
  useEffect(() => { if (!surface) return; schedule(); void synchronizeLayout().catch(fail); }, [surface,viewportVersion, view.zoom, props.obscured, schedule, synchronizeLayout, fail]);
  useLayoutEffect(() => {
    const draft: OfficeDraftController = { viewId: view.id, hasDrafts: () => inputController.pendingEdit || inputController.compositionActive || !!inputController.failure || !!current.current?.pendingInput || !!formulaDraft.current?.hasDrafts(), flush: async () => { await formulaDraft.current?.flush(); await inputController.flush(async () => { await call('office-flush', { viewId: view.id }); await refresh(); }); }, discard: () => { formulaDraft.current?.discard(); if (inputController.compositionActive || inputController.failure || current.current?.pendingInput) throw new Error('输入法或未确认输入尚未稳定，不能静默丢弃。'); } };
    latest.current.onOfficeDraftController?.(draft); return () => latest.current.onOfficeDraftController?.(undefined);
  }, [identity, inputController, refresh]);
  const inputDirty = inputController.pendingEdit || inputController.compositionActive || !!inputController.failure || !!surface?.pendingInput;
  useEffect(() => { latest.current.onOfficeDraftChange?.({ viewId: view.id, dirty: inputDirty || !!formulaDraft.current?.hasDrafts() }); }, [identity, inputDirty]);
  useEffect(() => {
    const host = scroll.current; if (!host) return;
    const wheel = (event: WheelEvent) => { if (!event.ctrlKey) return; event.preventDefault();presentationFit?.manual(); const next = Math.max(.25, Math.min(4, zoom.current * Math.exp(-event.deltaY * .002))); if (latest.current.onZoomChange) latest.current.onZoomChange(next); else void call('zoom', { viewId: view.id, factor: next }).catch(fail); };
    host.addEventListener('wheel', wheel, { passive: false }); return () => host.removeEventListener('wheel', wheel);
  }, [identity, fail,presentationFit]);
  useEffect(() => {
    const textarea = input.current; if (!textarea) return;
    // React's before-input polyfill can deliver a TextEvent without inputType.
    // The native Chromium InputEvent is the authoritative committed text path.
    const beforeInput = (event: InputEvent) => {
      if (composition.current || event.isComposing || event.inputType === 'insertCompositionText') return;
      if (['insertText', 'insertReplacementText', 'insertFromComposition'].includes(event.inputType) && event.data) {
        event.preventDefault(); const recent = lastCompositionCommit.current;
        if (!recent || recent.text !== event.data || performance.now() - recent.at > 150) post({ kind: 'text', text: event.data });
        lastCompositionCommit.current = undefined; return;
      }
      const key = event.inputType === 'deleteContentBackward' ? 'Backspace' : event.inputType === 'deleteContentForward' ? 'Delete' : event.inputType === 'insertLineBreak' ? 'Enter' : undefined;
      if (key) { event.preventDefault(); const modifiers = { shift: false, control: false, alt: false, meta: false }; post({ kind: 'key', phase: 'down', key, code: key, repeat: false, modifiers }); post({ kind: 'key', phase: 'up', key, code: key, repeat: false, modifiers }); }
    };
    textarea.addEventListener('beforeinput', beforeInput); return () => textarea.removeEventListener('beforeinput', beforeInput);
  }, [identity, !!surface, post]);
  const geometry = measure(), size = surface && officeSurfaceSize(surface), scale = officeCssScale(view.zoom ?? 1), offsetX = geometry?.offsetX ?? 0,offsetY=geometry?.offsetY??0;
  const rectStyle = (rect: Rect): CSSProperties => ({ left: offsetX + rect.x * scale, top: offsetY+rect.y * scale, width: Math.max(1, rect.width * scale), height: Math.max(1, rect.height * scale) });
  const pageIndex = surface && geometry && surface.pages ? officeCurrentPage(surface.pages, officeVisibleTwips(geometry, officeSurfaceSize(surface))) : undefined;
  useLayoutEffect(()=>{
    const apply=()=>{const state=current.current,host=scroll.current;if(!mounted.current||!state||!host)return;const target=pendingScroll.current.take(state,state.partIndex,{x:Math.max(0,host.scrollWidth-host.clientWidth),y:Math.max(0,host.scrollHeight-host.clientHeight)});if(!target)return;host.scrollLeft=target.x;host.scrollTop=target.y;scheduleRef.current();void synchronizeLayout().catch(fail);};
    apply();const retry=requestAnimationFrame(apply);return()=>cancelAnimationFrame(retry);
  },[surface,viewportVersion,view.zoom,synchronizeLayout,fail]);
  useEffect(() => {
    const state = current.current, geometry = measure(); if (!state || !geometry) return;
    const selected = state.selection?.kind === 'objects' && state.graphicSelection ? [state.graphicSelection.rect] : state.selection?.kind === 'cells' && (state.cellSelection || state.cellCursor) ? [state.cellSelection || state.cellCursor!] : state.selectionRects;
    const rects = selected.map(rect => officeViewportRect(rect, geometry)).map(rect => intersectOfficeRect(rect, geometry.viewport)).filter((rect): rect is Rect => !!rect);
    const projection: OfficeSurfaceSelectionProjection = { viewId: state.viewId, documentId: state.documentId, sessionId: state.sessionId, engineEpoch: state.engineEpoch, engineRevision: state.engineRevision, selectionEpoch: state.selectionEpoch, layoutRevision: state.layoutRevision, actor: state.actor, selection: state.selection, rects, visibleTwips: officeVisibleTwips(geometry, officeSurfaceSize(state)), viewportCss: geometry.viewport, pageIndex, partIndex: state.partIndex };
    const signature = JSON.stringify(projection); if (signature !== lastSelectionProjection.current) { lastSelectionProjection.current = signature; window.dispatchEvent(new CustomEvent('agentviewer:office-surface-selection', { detail: projection })); }
  }, [surface, viewportVersion, pageIndex, view.zoom, measure]);
  const takeFocus = () => { input.current?.focus({ preventScroll: true }); };
  const modalOpen = !!surface?.windows?.some(window => window.visible && window.modal === true);
  const pointerEvent = (event: React.PointerEvent<HTMLDivElement>, phase: 'down' | 'move' | 'up' | 'cancel') => {
    if (latest.current.obscured || modalOpen || !current.current || current.current.status !== 'ready' || inputController.failure) return;
    if (phase === 'down') { if (composition.current) return;pendingScroll.current.clear(); event.preventDefault(); pointer.current = { id: event.pointerId, button: event.button, clickCount: clicks.current.down(event) }; event.currentTarget.setPointerCapture(event.pointerId); takeFocus(); }
    if (phase !== 'down' && pointer.current?.id !== event.pointerId && event.buttons) return;
    if (phase !== 'down' && phase !== 'move' && pointer.current?.id !== event.pointerId) return;
    if (phase === 'move') clicks.current.move(event); if (phase === 'cancel') clicks.current.reset();
    const g = measure(); if (!g) return; const pointTwips = officeDocumentPoint(event.clientX, event.clientY, g);
    post({ kind: 'pointer', phase, pointTwips, button: pointer.current?.button ?? event.button, buttons: phase === 'up' || phase === 'cancel' ? 0 : event.buttons, clickCount: phase === 'move' ? 0 : pointer.current?.clickCount ?? 1, modifiers: modifiers(event) });
    if (phase === 'up' || phase === 'cancel') { pointer.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
  };
  const keyEvent = (event: React.KeyboardEvent<HTMLTextAreaElement>, phase: 'down' | 'up') => {
    if (event.nativeEvent.isComposing || composition.current || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && ['s', 'o', 't', ',', 'l'].includes(event.key.toLowerCase())) return;
    if ((event.ctrlKey || event.metaKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase())) return;
    if(phase==='down'&&!['Control','Shift','Alt','Meta'].includes(event.key))pendingScroll.current.clear();
    if (event.key === 'Dead' || event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault(); post({ kind: 'key', phase, key: event.key, code: event.code, repeat: event.repeat, modifiers: modifiers(event) });
  };
  const selectionHandle = (event: React.PointerEvent<HTMLButtonElement>, edge: 'start' | 'end', phase: 'down' | 'move' | 'up' | 'cancel') => {
    event.preventDefault(); event.stopPropagation(); if (composition.current || inputController.failure || props.obscured || modalOpen) return;
    if (phase === 'down') { event.currentTarget.setPointerCapture(event.pointerId); takeFocus(); }
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const geometry = measure(); if (geometry && phase !== 'cancel') post({ kind: 'selection-handle', edge, pointTwips: officeDocumentPoint(event.clientX, event.clientY, geometry) });
    if (phase === 'up' || phase === 'cancel') event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const navigatePart = async (index: number) => {
    try { await formulaDraft.current?.flush(); await inputController.barrier(); const state = current.current; if (!state) return; await call('office-navigate', { viewId: view.id, expectedEngineEpoch: state.engineEpoch, expectedEngineRevision: state.engineRevision, expectedSelectionEpoch: state.selectionEpoch, idempotencyKey: crypto.randomUUID(), target: { kind: file.format === 'xlsx' ? 'sheet' : 'slide', index } }); await refresh(); } catch (cause) { fail(cause); }
  };
  void viewportVersion;
  return <section className={'embedded-office-document embedded-office-' + file.format} data-office-engine="libreofficekit" data-office-ready={surface?.status === 'ready'} data-office-actor={surface?.actor} data-office-agent-active={!!view.agentState} data-office-fit-mode={presentationFit?(presentationFit.enabled?'page':'manual'):undefined}>
    {file.format === 'xlsx' && formulaHost && createPortal(<NativeOfficeFormulaBar documentId={file.id} viewId={view.id} state={surface} active={surface?.status === 'ready' && !props.obscured && !modalOpen} onState={next => { if (isOfficeSurfaceState(next)) accept(next); else void refresh().catch(fail); }} onError={props.reportError} onDraftController={controller => { formulaDraft.current = controller; }} onDraftChange={dirty => latest.current.onOfficeDraftChange?.({ viewId: view.id, dirty: dirty || inputController.pendingEdit || inputController.compositionActive || !!current.current?.pendingInput })} />,formulaHost)}
    <div ref={scroll} id={'office-scroll-'+identity} className={'document-content embedded-office-content format-' + file.format} data-office-surface={view.id} data-office-page={pageIndex} tabIndex={-1} aria-label={file.title + ' 编辑区'} onWheelCapture={()=>pendingScroll.current.clear()} onScroll={() => { clicks.current.reset(); setViewportVersion(version => version + 1); latest.current.onReaderScroll?.(scroll.current?.scrollTop ?? 0); schedule(); void synchronizeLayout().catch(fail); }}>
      {size && <div className="embedded-office-stage" style={geometry?.stageSize??{ width: Math.max(size.width * scale, geometry?.viewport.width ?? 1), height: Math.max(size.height * scale, geometry?.viewport.height ?? 1) }}>
        {(surface.pages?.length ? surface.pages : file.format === 'pptx' ? [{ x: 0, y: 0, ...size }] : []).map((rect, index) => <span key={index} className="embedded-office-paper-base" style={rectStyle(rect)} />)}
        <canvas ref={canvas} className="embedded-office-canvas" aria-hidden="true" style={{ width: geometry?.viewport.width ?? '100%', height: geometry?.viewport.height ?? '100%' }} />
        <div className="embedded-office-interaction" style={{ cursor: surface?.mousePointer ?? 'text' }} onPointerDown={event => pointerEvent(event, 'down')} onPointerMove={event => pointerEvent(event, 'move')} onPointerUp={event => pointerEvent(event, 'up')} onPointerCancel={event => pointerEvent(event, 'cancel')} onContextMenu={event => event.preventDefault()}>
          {surface.selectionRects.map((rect, index) => <span key={index} className="embedded-office-selection" style={rectStyle(rect)} />)}
          {surface.cellCursor && <span className="embedded-office-cell-cursor" style={rectStyle(surface.cellCursor)} />}
          {surface.cellSelection && <span className="embedded-office-cell-selection" style={rectStyle(surface.cellSelection)} />}
          {surface.cellAutoFill && <span className="embedded-office-auto-fill" style={rectStyle(surface.cellAutoFill)} />}
          {surface.graphicSelection && <span className="embedded-office-object-selection" style={rectStyle(surface.graphicSelection.rect)} />}
          {surface.caret && surface.caretVisible !== false && <span className="embedded-office-caret" style={rectStyle(surface.caret)} />}
          {surface.selectionRects.length > 0 && (['start', 'end'] as const).map(edge => { const rect = edge === 'start' ? surface.selectionStart : surface.selectionEnd; return rect && <button key={edge} type="button" className="embedded-office-selection-handle" aria-label={edge === 'start' ? '调整选区开始位置' : '调整选区结束位置'} style={{ left: offsetX + rect.x * scale - 5, top: offsetY + (edge === 'start' ? rect.y : rect.y + rect.height) * scale - 5 }} onPointerDown={event => selectionHandle(event, edge, 'down')} onPointerMove={event => selectionHandle(event, edge, 'move')} onPointerUp={event => selectionHandle(event, edge, 'up')} onPointerCancel={event => selectionHandle(event, edge, 'cancel')} />; })}
        </div>
        <textarea ref={input} className="embedded-office-input" aria-label={file.title + ' 文本输入'} aria-describedby="embedded-office-input-help" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} disabled={!surface || surface.status !== 'ready' || !!inputController.failure || !!props.obscured || modalOpen} style={surface.caret ? { left: offsetX + surface.caret.x * scale, top: offsetY+surface.caret.y * scale } : { left: offsetX, top: offsetY }} onFocus={() => void synchronizeLayout().catch(fail)} onBlur={() => void synchronizeLayout().catch(fail)} onKeyDown={event => keyEvent(event, 'down')} onKeyUp={event => keyEvent(event, 'up')} onInput={event => { if (!composition.current) event.currentTarget.value = ''; }} onCompositionStart={() => { const session = { id: crypto.randomUUID(), text: '' }; composition.current = session; post({ kind: 'composition', compositionId: session.id, phase: 'start', text: '' }); }} onCompositionUpdate={event => { const session = composition.current; if (session) { session.text = event.data; post({ kind: 'composition', compositionId: session.id, phase: 'update', text: event.data }); } }} onCompositionEnd={event => { const session = composition.current; if (!session) return; composition.current = undefined; lastCompositionCommit.current = { text: event.data, at: performance.now() }; post({ kind: 'composition', compositionId: session.id, phase: event.data ? 'end' : 'cancel', text: event.data }); event.currentTarget.value = ''; }} onPaste={event => {
          event.preventDefault(); if (composition.current) return;
          const text = event.clipboardData.getData('text/plain'), html = event.clipboardData.getData('text/html'), encode = new TextEncoder();
          const items = [...(html ? [{ mimeType: 'text/html', data: encode.encode(html) }] : []), { mimeType: 'text/plain;charset=utf-8', data: encode.encode(text) }]; post({ kind: 'paste', items });
        }} onCopy={event => { if (surface.selection?.text) { event.preventDefault(); event.clipboardData.setData('text/plain', surface.selection.text); } }} onCut={event => { if (surface.selection?.text) { event.preventDefault(); event.clipboardData.setData('text/plain', surface.selection.text); post({ kind: 'key', phase: 'down', key: 'Delete', code: 'Delete', repeat: false, modifiers: { shift: false, control: false, alt: false, meta: false } }); post({ kind: 'key', phase: 'up', key: 'Delete', code: 'Delete', repeat: false, modifiers: { shift: false, control: false, alt: false, meta: false } }); } }} />
      </div>}
      {(!surface || surface.status !== 'ready' || failure) && <div className={'embedded-office-message' + (failure ? ' has-error' : '')} role="status">{failure || '正在初始化内置文档核心…'}</div>}
    </div>
    <OfficeHorizontalScrollbar host={scroll} identity={identity} version={viewportVersion+':'+(view.zoom??1)} active={file.format==='pptx'&&!presentationFit?.enabled&&surface?.status==='ready'} />
    {file.format === 'xlsx' && surface && <div className="embedded-office-sheet-tabs" role="tablist" aria-label="工作表">{surface.parts.filter(part => part.visible !== false).map(part => <button key={part.index} type="button" role="tab" aria-selected={part.index === surface.partIndex} disabled={!!props.obscured || modalOpen || inputController.pending || inputController.compositionActive} onClick={() => void navigatePart(part.index)}>{part.name}</button>)}</div>}
    <EmbeddedOfficeDialogHost state={surface} obscured={props.obscured} onState={accept} onError={fail} returnFocus={takeFocus} />
    <span id="embedded-office-input-help" className="embedded-office-accessible-text">{surface?.focusedParagraph || '使用鼠标定位文字或对象，使用键盘编辑。'}</span>
  </section>;
}
