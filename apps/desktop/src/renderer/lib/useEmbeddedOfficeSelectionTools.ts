import { useEffect } from 'react';
import { call } from './transport';
import type {SelectionContext} from '../../../../../packages/contracts/src/index';
import { OFFICE_SELECTION_EVENTS, OfficeSurfaceSelectionBridge, type OfficeSelectionToolState, type OfficeSelectionToolsEvent } from './office-surface-selection';

/** Attach once for the active tiled Office view. The shared SelectionTools renders the ready event. */
export function useEmbeddedOfficeSelectionTools(viewId: string | undefined, enabled = true) {
  useEffect(() => {
    if (!enabled || !viewId) return;
    const bridge = new OfficeSurfaceSelectionBridge(viewId, {
      request: async (target,projection) => { const {sessionId,engineEpoch,engineRevision,selectionEpoch}=projection;const result=await call<{selectionContext:SelectionContext;actions:OfficeSelectionToolState['actions']}>('selection-context', { viewId: target,expected:{sessionId,engineEpoch,engineRevision,selectionEpoch} });return {snapshot:result.selectionContext,actions:result.actions}; },
      publish: detail => window.dispatchEvent(new CustomEvent<OfficeSelectionToolsEvent>(OFFICE_SELECTION_EVENTS.ready, { detail })),
    });
    const projection = (event: Event) => bridge.update((event as CustomEvent).detail);
    const dismiss = (event: Event) => { const detail = (event as CustomEvent<{ viewId: string; lease?: string }>).detail; if (detail?.viewId === viewId) bridge.dismiss(detail.lease); };
    window.addEventListener(OFFICE_SELECTION_EVENTS.projection, projection); window.addEventListener(OFFICE_SELECTION_EVENTS.dismiss, dismiss);
    return () => { window.removeEventListener(OFFICE_SELECTION_EVENTS.projection, projection); window.removeEventListener(OFFICE_SELECTION_EVENTS.dismiss, dismiss); bridge.dispose(); };
  }, [viewId, enabled]);
}
