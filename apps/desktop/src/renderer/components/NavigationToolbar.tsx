import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Copy, Languages, Minus, Plus, RotateCw, Save, Undo2 } from 'lucide-react';
import { NavigationGlass } from './NavigationGlass';
import { NAVIGATION_METRICS, type NavigationBackdropSample, type NavigationBounds } from '../lib/navigation-optics';

export type NavigationAction =
  | { type: 'back' | 'forward' | 'reload' | 'copy' | 'translate' | 'undo' | 'save' }
  | { type: 'navigate'; url: string }
  | { type: 'zoom'; factor: number }
  | { type: 'mode'; mode: 'read' | 'source' | 'split' };
export type NavigationState = {
  format: string; title?: string; titleIcon?: ReactNode; address?: string;
  mode?: 'read' | 'source' | 'split'; canUndo?: boolean; busy?: boolean; translated?: boolean; zoom?: number;
};
type ModuleProps = { state: NavigationState; dispatch(action: NavigationAction): void };

function Divider() { return <span className="capsule-divider" aria-hidden="true" />; }
function HistoryModule({ dispatch }: ModuleProps) {
  return <div className="navigation-module navigation-history" data-navigation-module="history">
    <button className="icon-button" title="后退" aria-label="后退" onClick={() => dispatch({ type: 'back' })}><ArrowLeft size={17} /></button>
    <button className="icon-button" title="前进" aria-label="前进" onClick={() => dispatch({ type: 'forward' })}><ArrowRight size={17} /></button>
    <button className="icon-button" title="刷新" aria-label="刷新" onClick={() => dispatch({ type: 'reload' })}><RotateCw size={16} /></button>
  </div>;
}
function AddressModule({ state, dispatch }: ModuleProps) {
  const [address, setAddress] = useState(state.address ?? '');
  // Sampling, theme notifications and hide progress must never replace a draft URL.
  useEffect(() => { setAddress(state.address ?? ''); }, [state.address]);
  return <form className="address navigation-module" data-navigation-module="address" onSubmit={event => { event.preventDefault(); dispatch({ type: 'navigate', url: address }); }}>
    <input className="address-input" aria-label="网页地址" value={address} onChange={event => setAddress(event.target.value)} placeholder="输入网页地址" />
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
function EditModule({ state, dispatch }: ModuleProps) {
  return <div className="navigation-module" data-navigation-module="editing">
    <button className="icon-button" title="撤销最近修改" aria-label="撤销最近修改" disabled={!state.canUndo} onClick={() => dispatch({ type: 'undo' })}><Undo2 size={16} /></button>
    <button className="icon-button" title="保存" aria-label="保存" onClick={() => dispatch({ type: 'save' })}><Save size={16} /></button>
  </div>;
}
function ZoomModule({ state, dispatch }: ModuleProps) {
  const percentage = Math.round((state.zoom ?? 1) * 100), [draft, setDraft] = useState(String(percentage));
  const cancelBlur = useRef(false);
  useEffect(() => { setDraft(String(percentage)); }, [percentage]);
  const commit = () => { if (cancelBlur.current) { cancelBlur.current = false; return; } const next = Number(draft); if (Number.isFinite(next) && next >= 25 && next <= 400) dispatch({ type: 'zoom', factor: next / 100 }); else setDraft(String(percentage)); };
  return <div className="navigation-module navigation-zoom" data-navigation-module="zoom">
    <button className="icon-button" aria-label="缩小正文" title="缩小正文 · Ctrl+滚轮" disabled={percentage <= 25} onClick={() => dispatch({ type: 'zoom', factor: Math.max(.25, (percentage - 10) / 100) })}><Minus size={14} /></button>
    <label className="navigation-zoom-value"><input aria-label="正文缩放比例" title="输入 25–400；双击恢复 100%" type="number" min={25} max={400} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onDoubleClick={() => dispatch({ type: 'zoom', factor: 1 })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.preventDefault(); cancelBlur.current = true; setDraft(String(percentage)); event.currentTarget.blur(); } }} /><span>%</span></label>
    <button className="icon-button" aria-label="放大正文" title="放大正文 · Ctrl+滚轮" disabled={percentage >= 400} onClick={() => dispatch({ type: 'zoom', factor: Math.min(4, (percentage + 10) / 100) })}><Plus size={14} /></button>
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

export function NavigationToolbar({ state, dispatch, progress = 0, durationMs = 650, backdropImage, backdropSample, onGeometry, onHover, onLeave, onFocus, onBlur }: ModuleProps & {
  progress?: number; durationMs?: number; backdropImage?: string; backdropSample?: NavigationBackdropSample;
  onGeometry?(bounds: NavigationBounds): void;
  onHover?(): void; onLeave?(): void; onFocus?(): void; onBlur?(): void;
}) {
  const contribution = contributions[state.format as keyof typeof contributions] ?? contributions.document;
  const Identity = contribution.identity, hidden = progress >= 1;
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
  }, [!!onGeometry, progress, durationMs, state.format]);
  const style = { '--navigation-hide-progress': Math.max(0, Math.min(1, progress)), '--navigation-hide-duration': durationMs + 'ms', '--navigation-height': NAVIGATION_METRICS.height + 'px', '--navigation-radius': NAVIGATION_METRICS.radius + 'px', '--navigation-button-size': NAVIGATION_METRICS.buttonSize + 'px' } as CSSProperties;
  return <nav className={'reader-toolbar navigation-toolbar' + (hidden ? ' is-hidden' : '')} aria-label="阅读导航" aria-hidden={hidden || undefined} inert={hidden || undefined} data-navigation-format={state.format} style={style}
    onMouseEnter={onHover} onMouseLeave={onLeave} onFocusCapture={onFocus} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.(); }}>
    <div ref={capsule} className="floating-capsule navigation-capsule" data-navigation-surface={surface}>
      <NavigationGlass backdropImage={backdropImage} backdropSample={backdropSample} capsuleBounds={capsuleBounds} onSurface={setSurface} />
      <HistoryModule state={state} dispatch={dispatch} /><Divider />
      <Identity state={state} dispatch={dispatch} /><Divider />
      <ZoomModule state={state} dispatch={dispatch} /><Divider />
      {contribution.tools.map((Module, index) => <Module key={index} state={state} dispatch={dispatch} />)}
    </div>
  </nav>;
}
