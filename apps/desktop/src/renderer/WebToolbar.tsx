import { useCallback, useEffect, useRef, useState } from 'react';
import { usePresence } from './components/MotionPresence';
import { NavigationToolbar } from './components/NavigationToolbar';
import { call } from './lib/transport';
import { applyAppearance } from './lib/appearance';
import type { SettingsSnapshot } from '../../../../packages/settings/src/index';
import type { NavigationBackdropSample, NavigationBounds } from './lib/navigation-optics';

type State = { visible?: boolean; manualHidden?: boolean; instant?: boolean; hideProgress?: number; hideDurationMs?: number; backdropImage?: string; backdropSample?: NavigationBackdropSample; viewId?: string; address?: string; translated?: boolean; busy?: boolean; settings?: SettingsSnapshot; zoom?: number };

// The native host only supplies transport; all navigation UI and modules are shared.
export function WebToolbar() {
  const [state, setState] = useState<State>({});
  const pendingAddressFocus = useRef(false);
  useEffect(() => {
    document.documentElement.classList.add('native-toolbar-root');
    void call<State>('toolbar-state', { backdropPatches: true }).then(value => setState(previous => previous.viewId ? previous : value));
    return window.agentViewer?.onToolbar(value => {
      if (value.action === 'focus-address') {
        const input = document.querySelector<HTMLInputElement>('.address-input');
        input?.select();
        pendingAddressFocus.current = !input || document.activeElement !== input;
      }
      else if (value.action === 'backdrop') setState(previous => value.viewId !== previous.viewId ? previous : { ...previous, ...value } as State);
      // Instant focus is one command, never a sticky preference. Authoritative
      // layout states omit it; only backdrop patches retain the current flag.
      else if (value.action === 'state') setState(previous => ({ ...(value.viewId === previous.viewId ? previous : { backdropImage: undefined, backdropSample: undefined }), ...value, instant: value.instant === true } as State));
      else setState(value as State);
    });
  }, []);
  useEffect(() => { applyAppearance(state.settings); }, [state.settings?.revision]);
  const action = (name: string, extra = {}) => void call('toolbar-action', { action: name, viewId: state.viewId, ...extra });
  const geometry = useRef<NavigationBounds | undefined>(undefined);
  const onGeometry = useCallback((bounds: NavigationBounds) => {
    if (geometry.current && ['x', 'y', 'width', 'height'].every(key => Math.abs(geometry.current![key as keyof NavigationBounds] - bounds[key as keyof NavigationBounds]) < .125)) return;
    geometry.current = bounds;
    void call('toolbar-action', { action: 'geometry', viewId: state.viewId, capsuleBounds: bounds }).catch(() => {});
  }, [state.viewId]);
  useEffect(() => { geometry.current = undefined; }, [state.viewId]);
  const presence = usePresence(!!state.viewId && state.visible !== false, { duration: state.instant ? 0 : state.hideDurationMs ?? 650 });
  useEffect(() => {
    if (!presence.present || state.visible === false || !pendingAddressFocus.current) return;
    const frame = requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.address-input');
      if (input) { input.select(); pendingAddressFocus.current = document.activeElement !== input; }
    });
    return () => cancelAnimationFrame(frame);
  }, [presence.present, state.visible, state.viewId, state.hideProgress, state.manualHidden, state.instant]);
  if (!presence.present) return null;
  return (
    <div className="workbench native-toolbar">
      <NavigationToolbar key={state.viewId} state={{ format: 'web', address: state.address, translated: state.translated, busy: state.busy, zoom: state.zoom }}
        progress={state.instant ? 0 : state.hideProgress ?? (state.visible === false ? 1 : 0)} durationMs={state.instant ? 0 : state.hideDurationMs ?? 650} instant={state.instant} backdropImage={state.backdropImage} backdropSample={state.backdropSample} onGeometry={onGeometry} manualHidden={state.manualHidden}
        dispatch={command => { const { type, ...args } = command; action(type, args); }}
        onHover={() => action('hover')} onLeave={() => action('leave')} onFocus={() => action('focus')} onBlur={() => action('blur')} />
    </div>
  );
}
