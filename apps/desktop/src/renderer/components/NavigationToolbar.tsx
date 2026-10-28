import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Copy, Languages, Minus, MoreHorizontal, Plus, RotateCw, Save, Undo2, X } from 'lucide-react';
import { NavigationGlass } from './NavigationGlass';
import { NAVIGATION_METRICS, type NavigationBackdropSample, type NavigationBounds } from '../lib/navigation-optics';
import { navigationMotionDuration, useMotionSnapshot } from '../lib/motion';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { SELECTION_NAVIGATION_EVENT, type SelectionNavigationBounds } from '../lib/selection-position';
import { clearSidebarNavigationReservation, navigationControlMetrics, navigationDensity, navigationLane, observeNavigationLane, readNavigationTargetLane, prepareSidebarNavigationReservation, type NavigationLane } from '../lib/navigation-lane';
import { scheduleLayoutRead } from '../lib/layout-frame';
import { useNavigationLayout } from '../lib/useNavigationLayout';

export type NavigationAction =
  | { type: 'back' | 'forward' | 'reload' | 'copy' | 'translate' | 'undo' | 'save' | 'dismiss' }
  | { type: 'navigate'; url: string }
  | { type: 'zoom'; factor: number }
  | { type: 'mode'; mode: 'read' | 'source' | 'split' };
export type NavigationState = {
  format: string; title?: string; titleIcon?: ReactNode; address?: string;
  mode?: 'read' | 'source' | 'split'; canUndo?: boolean; busy?: boolean; translated?: boolean; zoom?: number;
};
type ModuleProps = { state: NavigationState; dispatch(action: NavigationAction): void; addressDraft?: string; setAddressDraft?(value: string): void; zoomDraft?: string; setZoomDraft?(value: string): void; setZoomEditing?(value: boolean): void };
const sameLane = (a: NavigationLane, b: NavigationLane) => a.left === b.left && a.right === b.right && a.width === b.width && a.center === b.center;

function Divider() { return <span className="capsule-divider" aria-hidden="true" />; }
function HistoryModule({ dispatch, forward = true, reload = true, back = true }: ModuleProps & { forward?: boolean; reload?: boolean; back?: boolean }) {
  return <div className="navigation-module navigation-history" data-navigation-module="history">
    {back && <button className="icon-button" title="后退" aria-label="后退" onClick={() => dispatch({ type: 'back' })}><ArrowLeft size={17} /></button>}
    {forward && <button className="icon-button" title="前进" aria-label="前进" onClick={() => dispatch({ type: 'forward' })}><ArrowRight size={17} /></button>}
    {reload && <button className="icon-button" title="刷新" aria-label="刷新" onClick={() => dispatch({ type: 'reload' })}><RotateCw size={16} /></button>}
  </div>;
}
function AddressModule({ dispatch, addressDraft: address = '', setAddressDraft: setAddress }: ModuleProps) {
  return <form className="address navigation-module" data-navigation-module="address" onSubmit={event => { event.preventDefault(); dispatch({ type: 'navigate', url: address }); }}>
    <input className="address-input" aria-label="网页地址" value={address} onChange={event => setAddress?.(event.target.value)} placeholder="输入网页地址" />
  </form>;
}
function DocumentModule({ state }: ModuleProps) {
  return <span className="capsule-document-title navigation-module" data-navigation-module="document" title={state.title ?? '未命名文档'}>
    {state.titleIcon}<span>{state.title ?? '未命名文档'}</span>
  </span>;
}
function ModeModule({ state, dispatch }: ModuleProps) {
  return <div className="view-modes navigation-module" data-navigation-module="modes">
    {(['read', 'source', 'split'] as const).map((mode, index) => <button key={mode} className={state.mode === mode ? 'selected' : ''} aria-pressed={state.mode === mode} onClick={() => dispatch({ type: 'mode', mode })}>{['阅读', '源码', '分栏'][index]}</button>)}
  </div>;
}
function EditModule({ state, dispatch, undo = true, save = true }: ModuleProps & { undo?: boolean; save?: boolean }) {
  return <div className="navigation-module" data-navigation-module="editing">
    {undo && <button className="icon-button" title="撤销最近修改" aria-label="撤销最近修改" disabled={!state.canUndo} onClick={() => dispatch({ type: 'undo' })}><Undo2 size={16} /></button>}
    {save && <button className="icon-button" title="保存" aria-label="保存" onClick={() => dispatch({ type: 'save' })}><Save size={16} /></button>}
  </div>;
}
function ZoomModule({ state, dispatch, zoomDraft: draft = '100', setZoomDraft: setDraft, setZoomEditing, steps = true, value = true }: ModuleProps & { steps?: boolean; value?: boolean }) {
  const percentage = Math.round((state.zoom ?? 1) * 100);
  const cancelBlur = useRef(false);
  const commit = () => { if (cancelBlur.current) { cancelBlur.current = false; return; } const next = Number(draft); if (Number.isFinite(next) && next >= 25 && next <= 400) dispatch({ type: 'zoom', factor: next / 100 }); else setDraft?.(String(percentage)); };
  return <div className="navigation-module navigation-zoom" data-navigation-module="zoom">
    {steps && <button className="icon-button" aria-label="缩小正文" title="缩小正文 · Ctrl+滚轮" disabled={percentage <= 25} onClick={() => dispatch({ type: 'zoom', factor: Math.max(.25, (percentage - 10) / 100) })}><Minus size={14} /></button>}
    {value && <label className="navigation-zoom-value"><input aria-label="正文缩放比例" title="输入 25–400；双击恢复 100%" type="number" min={25} max={400} value={draft} onFocus={() => setZoomEditing?.(true)} onChange={event => setDraft?.(event.target.value)} onBlur={() => { commit(); setZoomEditing?.(false); }} onDoubleClick={() => dispatch({ type: 'zoom', factor: 1 })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.preventDefault(); cancelBlur.current = true; setDraft?.(String(percentage)); event.currentTarget.blur(); } }} /><span>%</span></label>}
    {steps && <button className="icon-button" aria-label="放大正文" title="放大正文 · Ctrl+滚轮" disabled={percentage >= 400} onClick={() => dispatch({ type: 'zoom', factor: Math.min(4, (percentage + 10) / 100) })}><Plus size={14} /></button>}
  </div>;
}
function WebPageModule({ state, dispatch }: ModuleProps) {
  return <div className="navigation-module" data-navigation-module="web-actions">
    <button className="icon-button" title="建立阅读副本" aria-label="建立阅读副本" onClick={() => dispatch({ type: 'copy' })}><Copy size={16} /></button>
    <button className="capsule-text" disabled={state.busy} onClick={() => dispatch({ type: 'translate' })}><Languages size={15} />{state.translated ? '显示原文' : '翻译网页'}</button>
  </div>;
}

// Every host renders this registry. Format contributions contain no host-specific markup.
const contributions = {
  web: { identity: AddressModule, tools: [WebPageModule] },
  markdown: { identity: DocumentModule, tools: [ModeModule, EditModule] },
  html: { identity: DocumentModule, tools: [ModeModule, EditModule] },
  document: { identity: DocumentModule, tools: [EditModule] },
};

export function NavigationToolbar({ state, dispatch, progress = 0, durationMs = 650, manualHidden = false, instant = false, backdropImage, backdropSample, availableWidth, laneBounds, onOverflowChange, onGeometry, onHover, onLeave, onFocus, onBlur }: ModuleProps & {
  progress?: number; durationMs?: number; manualHidden?: boolean; instant?: boolean; backdropImage?: string; backdropSample?: NavigationBackdropSample;
  availableWidth?: number; laneBounds?: NavigationLane; onOverflowChange?(open: boolean): Promise<unknown> | void;
  onGeometry?(bounds: NavigationBounds): void;
  onHover?(): void; onLeave?(): void; onFocus?(): void; onBlur?(): void;
}) {
  const contribution = contributions[state.format as keyof typeof contributions] ?? contributions.document;
  const Identity = contribution.identity, hidden = progress >= 1, isSheet = state.format === 'xlsx';
  const nav = useRef<HTMLElement>(null), capsule = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), more = useRef<HTMLButtonElement>(null);
  const nativeInset = document.documentElement.classList.contains('native-toolbar-root') ? NAVIGATION_METRICS.shadowGutter : 0;
  const initialCanvas = navigationLane({left:nativeInset,right:nativeInset+(availableWidth??820)});
  const [lane,setLane] = useState<NavigationLane>(laneBounds ?? initialCanvas), [canvas,setCanvas] = useState<NavigationLane>(initialCanvas);
  useLayoutEffect(() => {
    const reader = nav.current?.closest<HTMLElement>('.reader-panel');
    if (!reader) { const next = navigationLane({left:nativeInset,right:nativeInset+(availableWidth??820)}); setCanvas(next); setLane(laneBounds??next); return; }
    const dispose = observeNavigationLane(reader,() => {
      const next = readNavigationTargetLane(reader), nextCanvas = navigationLane({left:0,right:reader.getBoundingClientRect().width});
      return () => { setLane(old => sameLane(old,next) ? old : next); setCanvas(old => sameLane(old,nextCanvas) ? old : nextCanvas); };
    },false);
    return () => { dispose(); clearSidebarNavigationReservation(reader); };
  },[availableWidth,laneBounds?.left,laneBounds?.right,laneBounds?.width,laneBounds?.center,nativeInset,hidden]);
  // Density follows the available lane, never the content width or a spring
  // frame. A short title must not remove otherwise available controls.
  const density = navigationDensity(lane.width);
  const wide = density === 'wide', tight = density === 'tight', compact = density === 'compact', minimal = density === 'minimal', micro = density === 'micro';
  const showIdentity = !minimal && !micro && (!isSheet || wide), showHistory = !minimal && !micro && (!isSheet || wide), showForward = (wide || tight || compact) && (!isSheet || wide), showReload = (wide || tight) && !isSheet, showSteps = (wide || tight || compact) && !isSheet, showUndo = (wide || tight) && !isSheet;
  const isWeb = state.format === 'web', isText = state.format === 'markdown' || state.format === 'html', hasMore = isSheet || !wide;
  const showZoom = !micro && (!isSheet || wide || tight), showEditing = !isWeb && !micro && (!isSheet || wide || tight);
  const [addressDraft,setAddressDraft] = useState(state.address ?? ''), [zoomDraft,setZoomDraft] = useState(String(Math.round((state.zoom ?? 1)*100))), [zoomEditing,setZoomEditing] = useState(false), [menuOpen,setMenuOpen] = useState(false);
  useEffect(() => setAddressDraft(state.address ?? ''),[state.address]);
  // Native automatic-fit receipts may arrive while the user types an explicit
  // percentage. Keep that focused draft intact until they commit or cancel it.
  useEffect(() => { if (!zoomEditing) setZoomDraft(String(Math.round((state.zoom ?? 1)*100))); },[state.zoom,zoomEditing]);
  const moduleProps = {state,dispatch,addressDraft,setAddressDraft,zoomDraft,setZoomDraft,setZoomEditing};
  const overflowHandler = useRef(onOverflowChange); overflowHandler.current = onOverflowChange;
  const positionMenu = () => {
    const popup = menu.current, button = more.current; if (!popup || !button) return;
    const box = button.getBoundingClientRect(), width = Math.min(300,window.innerWidth - 24);
    popup.style.width = width + 'px'; popup.style.left = Math.max(12,Math.min(window.innerWidth - width - 12,box.right - width)) + 'px'; popup.style.top = box.bottom + 12 + 'px';
    popup.style.maxHeight = Math.max(90,window.innerHeight - box.bottom - 24) + 'px';
  };
  const closeMenu = () => menu.current?.hidePopover();
  const openMenu = async () => {
    if (!menu.current || !hasMore) return;
    // A native Web toolbar needs its enlarged viewport before placing a menu.
    // The document toolbar already owns its viewport and opens in this event.
    if (overflowHandler.current) { await overflowHandler.current(true); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
    positionMenu(); menu.current?.showPopover();
  };
  useEffect(() => {
    const close = () => closeMenu(), resize = () => { if (menu.current?.matches(':popover-open')) positionMenu(); };
    window.addEventListener('blur',close); window.addEventListener('resize',resize);
    return () => { window.removeEventListener('blur',close); window.removeEventListener('resize',resize); void overflowHandler.current?.(false); };
  },[]);
  useEffect(() => { if (hidden || !hasMore) closeMenu(); },[hidden,hasMore]);
  useEffect(() => {
    const focus = async () => { if (isWeb && !showIdentity) { await openMenu(); menu.current?.querySelector<HTMLInputElement>('.address-input')?.select(); } };
    window.addEventListener('agentviewer:navigation-address-focus',focus); return () => window.removeEventListener('agentviewer:navigation-address-focus',focus);
  },[isWeb,showIdentity,hasMore]);
  const overflowProps = {...moduleProps,dispatch:(action:NavigationAction) => { dispatch(action); if (action.type !== 'zoom') closeMenu(); }};
  const motion = useMotionSnapshot();
  durationMs = navigationMotionDuration(durationMs, motion);
  const immediate = instant || motion.split(':')[0] === 'off';
  useNavigationLayout(nav, capsule, lane, canvas, [density, state.format, state.title, addressDraft, state.translated, zoomDraft].join('\0'), instant);
  const [entered, setEntered] = useState(immediate);
  // Native navigation unmounts after closing. Establish a painted collapsed
  // frame on its next mount so it opens with the same transition as documents.
  useLayoutEffect(() => {
    if (entered) return;
    if (immediate) { setEntered(true); return; }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [entered, immediate]);
  const visualProgress = !entered && !immediate ? 1 : progress;
  const [capsuleBounds, setCapsuleBounds] = useState<NavigationBounds>();
  const [surface, setSurface] = useState<'light' | 'dark'>();
  const reportGeometry = useRef(onGeometry); reportGeometry.current = onGeometry;
  const presentation = useRef({ hidden, durationMs, sampled: !!backdropImage }); presentation.current = { hidden, durationMs, sampled: !!backdropImage };
  useLayoutEffect(() => {
    const node = capsule.current, toolbar = nav.current;
    if (!node || !toolbar) return;
    let cancelFrame: (() => void) | undefined, movingUntil = 0, previous: NavigationBounds | undefined, sampledBounds: NavigationBounds | undefined, previousHidden: boolean | undefined;
    const reader = toolbar.closest<HTMLElement>('.reader-panel');
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      // Optical maps use local CSS dimensions; presence transforms already
      // scale their host, so transformed bounds would scale the field twice.
      const mapWidth = Number(node.dataset.navigationOpticsWidth), mapHeight = Number(node.dataset.navigationOpticsHeight), overscan = Number(node.dataset.navigationOpticsOverscan) || 0;
      const localWidth = Number.parseFloat(toolbar.style.getPropertyValue('--navigation-slot-width')) || node.offsetWidth;
      const opticalScale = mapWidth > 0 && mapHeight > 0 ? { x: (localWidth + 2 * overscan) / (mapWidth + 2 * overscan), y: (node.offsetHeight + 2 * overscan) / (mapHeight + 2 * overscan) } : { x: 1, y: 1 };
      const { hidden, sampled } = presentation.current;
      const changed = !previous || ['x', 'y', 'width', 'height'].some(key => Math.abs(previous![key as keyof NavigationBounds] - bounds[key as keyof NavigationBounds]) >= .125) || hidden !== previousHidden;
      const box = reader?.getBoundingClientRect();
      const reserve = reader && box && !hidden ? prepareSidebarNavigationReservation(reader,rect.left-box.left,rect.right-box.left,box) : undefined;
      return () => {
        const setProperty = (name: string, value: string) => { if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value); };
        setProperty('--navigation-optics-scale-x', opticalScale.x.toFixed(6));
        setProperty('--navigation-optics-scale-y', opticalScale.y.toFixed(6));
        if (reader) { if (hidden) clearSidebarNavigationReservation(reader); else reserve?.(); }
        if (sampled) {
          setProperty('--navigation-capsule-x', bounds.x.toFixed(3) + 'px');
          setProperty('--navigation-capsule-y', bounds.y.toFixed(3) + 'px');
          // Sample coordinates follow imperatively while the old decoded
          // optical field scales. React receives only the settled geometry.
          if (node.dataset.navigationResizing !== 'true' && (!sampledBounds || ['x', 'y', 'width', 'height'].some(key => Math.abs(sampledBounds![key as keyof NavigationBounds] - bounds[key as keyof NavigationBounds]) >= .125))) { sampledBounds = bounds; setCapsuleBounds(bounds); }
        }
        if (changed) {
          previous = bounds; previousHidden = hidden;
          reportGeometry.current?.(bounds);
          window.dispatchEvent(new CustomEvent<SelectionNavigationBounds>(SELECTION_NAVIGATION_EVENT, {detail:{visible:!hidden,bounds}}));
        }
        if (performance.now() < movingUntil) schedule();
      };
    };
    const schedule = () => { if (!cancelFrame) cancelFrame = scheduleLayoutRead(() => { cancelFrame = undefined; return measure(); }); };
    const transition = (event: TransitionEvent) => {
      if (event.target !== node && event.target !== toolbar) return;
      if (event.type === 'transitionrun') movingUntil = performance.now() + presentation.current.durationMs + 50;
      else movingUntil = 0;
      schedule();
    };
    const observer = new ResizeObserver(schedule); observer.observe(node);
    const attributes = new MutationObserver(schedule); attributes.observe(toolbar,{attributes:true,attributeFilter:['style','class']});
    for (const name of ['transitionrun','transitionend','transitioncancel']) toolbar.addEventListener(name,transition as EventListener);
    node.addEventListener('agentviewer:glass-optics', schedule);
    window.addEventListener('resize',schedule); schedule();
    return () => { cancelFrame?.(); observer.disconnect(); attributes.disconnect(); node.removeEventListener('agentviewer:glass-optics',schedule); window.removeEventListener('resize',schedule); for (const name of ['transitionrun','transitionend','transitioncancel']) toolbar.removeEventListener(name,transition as EventListener); };
  }, [!!onGeometry, !!backdropImage, state.format]);
  const metrics = navigationControlMetrics(density);
  const style = { '--navigation-hide-progress': Math.max(0, Math.min(1, visualProgress)), '--navigation-hide-duration': (immediate ? 0 : durationMs) + 'ms', '--navigation-height': metrics.height + 'px', '--navigation-radius': metrics.radius + 'px', '--navigation-button-size': metrics.buttonSize + 'px', '--navigation-hide-shift': NAVIGATION_METRICS.hideShift + 'px' } as CSSProperties;
  return <nav ref={nav} className={'reader-toolbar navigation-toolbar' + (hidden ? ' is-hidden' : '')} aria-label="阅读导航" aria-hidden={hidden || undefined} inert={hidden || undefined} data-navigation-format={state.format} data-navigation-density={density} data-navigation-manual-hidden={manualHidden || undefined} style={style}
    data-navigation-entering={!entered && !immediate || undefined}
    onMouseEnter={onHover} onMouseLeave={onLeave} onFocusCapture={onFocus} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.(); }}>
    <div ref={capsule} className="floating-capsule navigation-capsule" data-navigation-surface={surface}>
      <NavigationGlass backdropImage={backdropImage} backdropSample={backdropSample} capsuleBounds={capsuleBounds} onSurface={setSurface} />
      {showHistory && <><HistoryModule {...moduleProps} forward={showForward} reload={showReload} /><Divider /></>}
      {showIdentity && <><Identity {...moduleProps} /><Divider /></>}
      {/* The existing cell draft editor is portalled here by its document owner.
          Density/hide changes must never unmount or duplicate this host. */}
      {isSheet && <div className="navigation-module navigation-formula-slot" data-navigation-module="formula" role="group" aria-label="单元格内容与公式" />}
      {showZoom && <ZoomModule {...moduleProps} steps={showSteps} />}
      {wide && isText && <ModeModule {...moduleProps} />}
      {showEditing && <EditModule {...moduleProps} undo={showUndo} />}
      {wide && isWeb && <WebPageModule {...moduleProps} />}
      {hasMore && <div className="navigation-module"><button ref={more} className="icon-button" aria-label="更多导航工具" title="更多导航工具" aria-expanded={menuOpen} onClick={() => { if (menuOpen) closeMenu(); else void openMenu(); }}><MoreHorizontal size={17} /></button></div>}
      {!minimal && !micro && <div className="navigation-module navigation-dismiss"><button className="icon-button" aria-label="关闭导航栏" title="关闭导航栏 · 鼠标移至阅读区顶部可重新显示" onClick={() => dispatch({ type: 'dismiss' })}><X size={16} /></button></div>}
    </div>
    <div ref={menu} popover="auto" className="navigation-overflow-menu material-host" aria-label="更多阅读导航工具" onToggle={event => { const open = event.currentTarget.matches(':popover-open'); setMenuOpen(open); if (!open) void overflowHandler.current?.(false); }}>
      <LiquidGlassSurface variant="panel" />
      {!showIdentity && <Identity {...overflowProps} />}
      {(!showHistory || !showForward || !showReload) && <HistoryModule {...overflowProps} back={!showHistory} forward={!showForward} reload={!showReload} />}
      {!showSteps && <ZoomModule {...overflowProps} value={!showZoom} />}
      {isText && <ModeModule {...overflowProps} />}
      {!isWeb && !showUndo && <EditModule {...overflowProps} save={!showEditing} />}
      {isWeb && <WebPageModule {...overflowProps} />}
      {(minimal || micro) && <button className="capsule-text" onClick={() => overflowProps.dispatch({type:'dismiss'})}><X size={15} />关闭导航栏</button>}
    </div>
  </nav>;
}
