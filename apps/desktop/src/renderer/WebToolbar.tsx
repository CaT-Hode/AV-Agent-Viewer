import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Copy, Languages } from 'lucide-react';
import { call } from './lib/transport';
import { applyAppearance } from './lib/appearance';
import type { SettingsSnapshot } from '../../../../packages/settings/src/index';
type State = { backdrop?: string; backdropImage?: string; viewId?: string; address?: string; translated?: boolean; busy?: boolean; settings?: SettingsSnapshot };
export function WebToolbar() {
  const [state, setState] = useState<State>({}), [address, setAddress] = useState('');
  useEffect(() => { document.documentElement.classList.add('native-toolbar-root'); void call<State>('toolbar-state').then(setState); return window.agentViewer?.onToolbar(value => { if (value.action === 'focus-address') document.querySelector<HTMLInputElement>('.address-input')?.select(); else setState(value as State); }); }, []);
  useEffect(() => { setAddress(state.address ?? ''); }, [state.address]);
  useEffect(() => { applyAppearance(state.settings); }, [state.settings]);
  useEffect(() => { document.documentElement.dataset.backdrop = state.backdrop ?? 'dark'; }, [state.backdrop]);
  const action = (name: string, extra = {}) => void call('toolbar-action', { action: name, ...extra });
  return <div className="workbench native-toolbar"><div className="reader-toolbar" onMouseEnter={() => action('hover')} onFocusCapture={() => action('focus')} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) action('blur'); }}><div className="floating-capsule">
    {state.backdropImage && <span className="native-glass-backdrop" aria-hidden="true" style={{backgroundImage:`url(${state.backdropImage})`}}/>}
    <button className="icon-button" title="后退" onClick={() => action('back')}><ArrowLeft size={17}/></button><button className="icon-button" title="前进" onClick={() => action('forward')}><ArrowRight size={17}/></button><button className="icon-button" title="刷新" onClick={() => action('reload')}><RotateCw size={16}/></button><span className="capsule-divider"/>
    <form className="address" onSubmit={event => { event.preventDefault(); action('navigate', { url: address }); }}><input className="address-input" aria-label="网页地址" value={address} onChange={event => setAddress(event.target.value)} /></form><span className="capsule-divider"/>
    <button className="icon-button" title="建立阅读副本" onClick={() => action('copy')}><Copy size={16}/></button><button className="capsule-text" disabled={state.busy} onClick={() => action('translate')}><Languages size={15}/>{state.translated ? '显示原文' : '翻译网页'}</button>
  </div></div></div>;
}
