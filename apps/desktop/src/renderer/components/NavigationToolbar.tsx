import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ArrowLeft, ArrowRight, Copy, Languages, Minus, MoreHorizontal, Plus, RotateCw, Save, Undo2, X } from 'lucide-react';
import { NavigationGlass } from './NavigationGlass';
import { NAVIGATION_METRICS, type NavigationBackdropSample, type NavigationBounds } from '../lib/navigation-optics';
import { navigationMotionDuration, useMotionSnapshot } from '../lib/motion';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { useGlassSpringValue } from '../lib/glass-elasticity';
import { KUBE_GLASS_SPRINGS } from '../lib/glass-presets';
import { boundedNavigationPresentation, navigationControlMetrics, navigationDensity, observeNavigationLane, preferredNavigationWidth, readNavigationLane, type NavigationLane } from '../lib/navigation-lane';

export type NavigationAction =
  | { type: 'back' | 'forward' | 'reload' | 'copy' | 'translate' | 'undo' | 'save' | 'dismiss' }
  | { type: 'navigate'; url: string }
  | { type: 'zoom'; factor: number }
  | { type: 'mode'; mode: 'read' | 'source' | 'split' };
export type NavigationState = {
  format: string; title?: string; titleIcon?: ReactNode; address?: string;
  mode?: 'read' | 'source' | 'split'; canUndo?: boolean; busy?: boolean; translated?: boolean; zoom?: number;
};
type ModuleProps = { state: NavigationState; dispatch(action: NavigationAction): void; addressDraft?: string; setAddressDraft?(value: string): void; zoomDraft?: string; setZoomDraft?(value: string): void };

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
function ZoomModule({ state, dispatch, zoomDraft: draft = '100', setZoomDraft: setDraft, steps = true, value = true }: ModuleProps & { steps?: boolean; value?: boolean }) {
  const percentage = Math.round((state.zoom ?? 1) * 100);
  const cancelBlur = useRef(false);
  const commit = () => { if (cancelBlur.current) { cancelBlur.current = false; return; } const next = Number(draft); if (Number.isFinite(next) && next >= 25 && next <= 400) dispatch({ type: 'zoom', factor: next / 100 }); else setDraft?.(String(percentage)); };
  return <div className="navigation-module navigation-zoom" data-navigation-module="zoom">
    {steps && <button className="icon-button" aria-label="缩小正文" title="缩小正文 · Ctrl+滚轮" disabled={percentage <= 25} onClick={() => dispatch({ type: 'zoom', factor: Math.max(.25, (percentage - 10) / 100) })}><Minus size={14} /></button>}
    {value && <label className="navigation-zoom-value"><input aria-label="正文缩放比例" title="输入 25–400；双击恢复 100%" type="number" min={25} max={400} value={draft} onChange={event => setDraft?.(event.target.value)} onBlur={commit} onDoubleClick={() => dispatch({ type: 'zoom', factor: 1 })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.preventDefault(); cancelBlur.current = true; setDraft?.(String(percentage)); event.currentTarget.blur(); } }} /><span>%</span></label>}
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

export function NavigationToolbar({ state, dispatch, progress = 0, durationMs = 650, manualHidden = false, instant = false, backdropImage, backdropSample, availableWidth, onOverflowChange, onGeometry, onHover, onLeave, onFocus, onBlur }: ModuleProps & {
  progress?: number; durationMs?: number; manualHidden?: boolean; instant?: boolean; backdropImage?: string; backdropSample?: NavigationBackdropSample;
  availableWidth?: number; onOverflowChange?(open: boolean): Promise<unknown> | void;
  onGeometry?(bounds: NavigationBounds): void;
  onHover?(): void; onLeave?(): void; onFocus?(): void; onBlur?(): void;
}) {
  const contribution = contributions[state.format as keyof typeof contributions] ?? contributions.document;
  const Identity = contribution.identity, hidden = progress >= 1;
  const nav = useRef<HTMLElement>(null), menu = useRef<HTMLDivElement>(null), more = useRef<HTMLButtonElement>(null);
  const [lane,setLane] = useState<NavigationLane>({left:0,right:availableWidth ?? 820,width:availableWidth ?? 820,center:(availableWidth ?? 820)/2});
  useLayoutEffect(() => {
    const reader = nav.current?.closest<HTMLElement>('.reader-panel');
    if (!reader) { const width = availableWidth ?? 820; setLane({left:0,right:width,width,center:width/2}); return; }
    return observeNavigationLane(reader,beforePaint => { const next = readNavigationLane(reader), apply = () => setLane(old => JSON.stringify(old) === JSON.stringify(next) ? old : next); if (beforePaint) flushSync(apply); else apply(); });
  },[availableWidth]);
  const animatedWidth = useGlassSpringValue(preferredNavigationWidth(lane.width),KUBE_GLASS_SPRINGS.lensShape);
  const animatedCenter = useGlassSpringValue(lane.center,KUBE_GLASS_SPRINGS.lensShape);
  const fitted = boundedNavigationPresentation(lane,animatedWidth,animatedCenter), density = navigationDensity(fitted.width);
  const wide = density === 'wide', tight = density === 'tight', compact = density === 'compact', minimal = density === 'minimal', micro = density === 'micro';
  const showIdentity = !minimal && !micro, showHistory = !minimal && !micro, showForward = wide || tight || compact, showReload = wide || tight, showSteps = wide || tight || compact, showUndo = wide || tight;
  const isWeb = state.format === 'web', isText = state.format === 'markdown' || state.format === 'html', hasMore = !wide;
  const [addressDraft,setAddressDraft] = useState(state.address ?? ''), [zoomDraft,setZoomDraft] = useState(String(Math.round((state.zoom ?? 1)*100))), [menuOpen,setMenuOpen] = useState(false);
  useEffect(() => setAddressDraft(state.address ?? ''),[state.address]);
  useEffect(() => setZoomDraft(String(Math.round((state.zoom ?? 1)*100))),[state.zoom]);
  const moduleProps = {state,dispatch,addressDraft,setAddressDraft,zoomDraft,setZoomDraft};
  const overflowHandler = useRef(onOverflowChange); overflowHandler.current = onOverflowChange;
  const positionMenu = () => {
    const popup = menu.current, button = more.current; if (!popup || !button) return;
    const box = button.getBoundingClientRect(), width = Math.min(300,window.innerWidth - 24);
    popup.style.width = width + 'px'; popup.style.left = Math.max(12,Math.min(window.innerWidth - width - 12,box.right - width)) + 'px'; popup.style.top = box.bottom + 12 + 'px';
    popup.style.maxHeight = Math.max(90,window.innerHeight - box.bottom - 24) + 'px';
  };
  const closeMenu = () => menu.current?.hidePopover();
  const openMenu = async () => { if (!menu.current || !hasMore) return; await overflowHandler.current?.(true); await new Promise<void>(resolve => requestAnimationFrame(() => { positionMenu(); menu.current?.showPopover(); resolve(); })); };
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
  const [entered, setEntered] = useState(immediate);
  // Native navigation unmounts after closing. Establish a painted collapsed
  // frame on its next mount so it opens with the same transition as documents.
  useLayoutEffect(() => {
    if (entered) return;
    if (immediate) { setEntered(true); return; }
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setEntered(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [entered, immediate]);
  const visualProgress = !entered && !immediate ? 1 : progress;
  const capsule = useRef<HTMLDivElement>(null);
  const [capsuleBounds, setCapsuleBounds] = useState<NavigationBounds>();
  const [surface, setSurface] = useState<'light' | 'dark'>();
  const reportGeometry = useRef(onGeometry); reportGeometry.current = onGeometry;
  useLayoutEffect(() => {
    if (!onGeometry || !capsule.current) return;
    let frame = 0;
    const until = performance.now() + durationMs + 50;
    const measure = () => {
      cancelAnimationFrame(frame);
      const node = capsule.current; if (!node) return;
      const rect = node.getBoundingClientRect();
      const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      setCapsuleBounds(old => {
        if (old && ['x', 'y', 'width', 'height'].every(key => Math.abs(old[key as keyof NavigationBounds] - bounds[key as keyof NavigationBounds]) < .125)) return old;
        return bounds;
      });
      reportGeometry.current?.(bounds);
      if (performance.now() < until) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(measure); observer.observe(capsule.current);
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [!!onGeometry, visualProgress, durationMs, state.format, fitted.center, fitted.width]);
  const metrics = navigationControlMetrics(density);
  const style = { '--navigation-slot-left': fitted.center + 'px', '--navigation-slot-width': fitted.width + 'px', '--navigation-hide-progress': Math.max(0, Math.min(1, visualProgress)), '--navigation-hide-duration': (immediate ? 0 : durationMs) + 'ms', '--navigation-height': metrics.height + 'px', '--navigation-radius': metrics.radius + 'px', '--navigation-button-size': metrics.buttonSize + 'px', '--navigation-hide-shift': NAVIGATION_METRICS.hideShift + 'px' } as CSSProperties;
  return <nav ref={nav} className={'reader-toolbar navigation-toolbar' + (hidden ? ' is-hidden' : '')} aria-label="阅读导航" aria-hidden={hidden || undefined} inert={hidden || undefined} data-navigation-format={state.format} data-navigation-density={density} data-navigation-manual-hidden={manualHidden || undefined} style={style}
    data-navigation-entering={!entered && !immediate || undefined}
    onMouseEnter={onHover} onMouseLeave={onLeave} onFocusCapture={onFocus} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.(); }}>
    <div ref={capsule} className="floating-capsule navigation-capsule" data-navigation-surface={surface}>
      <NavigationGlass backdropImage={backdropImage} backdropSample={backdropSample} capsuleBounds={capsuleBounds} onSurface={setSurface} />
      {showHistory && <><HistoryModule {...moduleProps} forward={showForward} reload={showReload} /><Divider /></>}
      {showIdentity && <><Identity {...moduleProps} /><Divider /></>}
      {!micro && <ZoomModule {...moduleProps} steps={showSteps} />}
      {wide && isText && <ModeModule {...moduleProps} />}
      {!isWeb && !micro && <EditModule {...moduleProps} undo={showUndo} />}
      {wide && isWeb && <WebPageModule {...moduleProps} />}
      {hasMore && <div className="navigation-module"><button ref={more} className="icon-button" aria-label="更多导航工具" title="更多导航工具" aria-expanded={menuOpen} onClick={() => { if (menuOpen) closeMenu(); else void openMenu(); }}><MoreHorizontal size={17} /></button></div>}
      {!minimal && !micro && <div className="navigation-module navigation-dismiss"><button className="icon-button" aria-label="关闭导航栏" title="关闭导航栏 · 鼠标移至阅读区顶部可重新显示" onClick={() => dispatch({ type: 'dismiss' })}><X size={16} /></button></div>}
    </div>
    <div ref={menu} popover="auto" className="navigation-overflow-menu material-host" aria-label="更多阅读导航工具" onToggle={event => { const open = event.currentTarget.matches(':popover-open'); setMenuOpen(open); if (!open) void overflowHandler.current?.(false); }}>
      <LiquidGlassSurface variant="panel" />
      {!showIdentity && <Identity {...overflowProps} />}
      {(!showHistory || !showForward || !showReload) && <HistoryModule {...overflowProps} back={!showHistory} forward={!showForward} reload={!showReload} />}
      {!showSteps && <ZoomModule {...overflowProps} value={micro} />}
      {isText && <ModeModule {...overflowProps} />}
      {!isWeb && !showUndo && <EditModule {...overflowProps} save={micro} />}
      {isWeb && <WebPageModule {...overflowProps} />}
      {(minimal || micro) && <button className="capsule-text" onClick={() => overflowProps.dispatch({type:'dismiss'})}><X size={15} />关闭导航栏</button>}
    </div>
  </nav>;
}
