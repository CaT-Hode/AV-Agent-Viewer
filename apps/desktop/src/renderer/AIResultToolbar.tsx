import { useCallback, useEffect, useRef, useState } from 'react';
import type { HarnessTask } from '../../../../packages/contracts/src/index';
import type { SettingsSnapshot } from '../../../../packages/settings/src/index';
import { AIResultPopover } from './components/AIResultPopover';
import { usePresence } from './components/MotionPresence';
import type { NavigationBackdropSample, NavigationBounds } from './lib/navigation-optics';
import { call } from './lib/transport';
import { applyAppearance } from './lib/appearance';

type AIResultState = { visible?: boolean; viewId?: string; taskId?: string; label?: string; source?: string; task?: HarnessTask; settings?: SettingsSnapshot; backdropImage?: string; backdropSample?: NavigationBackdropSample };
/** A trusted readout for one validated task/source. It has no generic task API. */
export function AIResultToolbar() {
  const [state, setState] = useState<AIResultState>({}), geometry = useRef<NavigationBounds | undefined>(undefined), [bounds, setBounds] = useState<NavigationBounds>();
  useEffect(() => {
    document.documentElement.classList.add('native-ai-result-root');
    void call<AIResultState>('toolbar-state', { backdropPatches: true }).then(value => setState(previous => previous.viewId ? previous : value));
    return window.agentViewer?.onToolbar(value => {
      if (value.action === 'backdrop') setState(previous => value.viewId !== previous.viewId ? previous : { ...previous, ...value } as AIResultState);
      else if (value.action === 'state') setState(previous => ({ ...(value.viewId === previous.viewId ? previous : { backdropImage: undefined, backdropSample: undefined }), ...value } as AIResultState));
    });
  }, []);
  useEffect(() => applyAppearance(state.settings), [state.settings?.revision]);
  const onGeometry = useCallback((next: NavigationBounds) => {
    if (geometry.current && ['x', 'y', 'width', 'height'].every(key => Math.abs(geometry.current![key as keyof NavigationBounds] - next[key as keyof NavigationBounds]) < .125)) return;
    geometry.current = next; setBounds(next); void call('toolbar-action', { action: 'geometry', viewId: state.viewId, capsuleBounds: next }).catch(() => {});
  }, [state.viewId]);
  useEffect(() => { geometry.current = undefined; setBounds(undefined); }, [state.viewId]);
  const presence = usePresence(!!state.visible && !!state.task, { duration: 200, identity: state.viewId, keyboardImmediate: false });
  const action = (action: 'close' | 'save' | 'cancel') => void call('ai-result-action', { action, viewId: state.viewId, taskId: state.taskId }).catch(error => setState(previous => previous.task ? { ...previous, task: { ...previous.task, error: String(error) } } : previous));
  if (!presence.present || !state.task) return null;
  return <div className="native-ai-result-slot"><AIResultPopover {...presence.props} data-motion-surface="right" native task={state.task} label={state.label ?? 'AI 分析'} source={state.source ?? ''} backdropImage={state.backdropImage} backdropSample={state.backdropSample} bounds={bounds} onGeometry={onGeometry} onClose={() => action('close')} onSave={() => action('save')} onCancel={() => action('cancel')} /></div>;
}
