import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentOperationCapsule, type AgentOperationStatus } from './components/AgentOperationCapsule';
import { usePresence } from './components/MotionPresence';
import { call } from './lib/transport';
import { applyAppearance } from './lib/appearance';
import type { SettingsSnapshot } from '../../../../packages/settings/src/index';
import { AGENT_OPERATION_METRICS, type NavigationBackdropSample, type NavigationBounds } from './lib/navigation-optics';

type AgentState = { viewId?: string; visible?: boolean; kind?: string; status?: AgentOperationStatus; target?: string; settings?: SettingsSnapshot; backdropImage?: string; backdropSample?: NavigationBackdropSample };
/** This route is loaded only in an application-owned capsule-sized native view. */
export function AgentOperationToolbar() {
  const [state, setState] = useState<AgentState>({}), geometry = useRef<NavigationBounds | undefined>(undefined);
  useEffect(() => {
    document.documentElement.classList.add('native-agent-root');
    void call<AgentState>('toolbar-state', { backdropPatches: true }).then(value => setState(previous => previous.viewId ? previous : value));
    return window.agentViewer?.onToolbar(value => {
      if (value.action === 'backdrop') setState(previous => value.viewId !== previous.viewId ? previous : { ...previous, ...value } as AgentState);
      else if (value.action === 'state') setState(previous => ({ ...(value.viewId === previous.viewId ? previous : { backdropImage: undefined, backdropSample: undefined }), ...value } as AgentState));
    });
  }, []);
  useEffect(() => applyAppearance(state.settings), [state.settings?.revision]);
  const onGeometry = useCallback((bounds: NavigationBounds) => { if (geometry.current && ['x', 'y', 'width', 'height'].every(key => Math.abs(geometry.current![key as keyof NavigationBounds] - bounds[key as keyof NavigationBounds]) < .125)) return; geometry.current = bounds; void call('toolbar-action', { action: 'geometry', viewId: state.viewId, capsuleBounds: bounds }).catch(() => {}); }, [state.viewId]);
  useEffect(() => { geometry.current = undefined; }, [state.viewId]);
  const presence = usePresence(!!state.viewId && !!state.visible, { duration: 200, identity: state.viewId, keyboardImmediate: false });
  if (!state.viewId || !presence.present) return null;
  return <div className="native-agent-slot" style={{ padding: AGENT_OPERATION_METRICS.shadowGutter }}><AgentOperationCapsule {...presence.props} data-motion-surface="agent" native kind={state.kind} status={state.status} target={state.target} backdropImage={state.backdropImage} backdropSample={state.backdropSample} onGeometry={onGeometry} onControl={status => void call('agent-control', { viewId: state.viewId, status }).then(() => setState(previous => ({ ...previous, status }))).catch(error => setState(previous => ({ ...previous, target: String(error) })))} /></div>;
}
