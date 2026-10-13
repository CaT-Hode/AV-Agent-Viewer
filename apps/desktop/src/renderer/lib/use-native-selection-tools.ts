import { useEffect, useRef } from 'react';
import type { ReadingContext } from '../../../../../packages/contracts/src/index';
import type { SettingsSnapshot } from '../../../../../packages/settings/src/index';
import { call } from './transport';
import { nativeSelectionKey, nativeSelectionLayout } from './native-selection';

type SelectionTools = { snapshot: { id: string }; actions: unknown[] };
/** Fetch once per source selection. Scroll/resize only moves the trusted surface. */
export function useNativeSelectionTools(enabled: boolean, context: ReadingContext | undefined, settings: SettingsSnapshot | undefined, report: (error: unknown) => void) {
  const current = useRef({ enabled, context, settings, report }); current.current = { enabled, context, settings, report };
  const cache = useRef<{ key: string; value?: SelectionTools; pending?: Promise<SelectionTools> } | undefined>(undefined);
  const dismissed = useRef<string | undefined>(undefined);
  const publish = () => {
    const now = current.current, c = now.context;
    if (!now.enabled || !c || c.actor !== 'human' || !c.selection.rect || c.selection.kind === 'none' || !c.selection.text) {
      cache.current = undefined; dismissed.current = undefined; void call('selection-layout', { visible: false }); return;
    }
    const key = nativeSelectionKey(c);
    if (dismissed.current === key) return;
    const present = (selection: SelectionTools) => {
      const latest = current.current, context = latest.context;
      if (!latest.enabled || !context || cache.current?.key !== key || nativeSelectionKey(context) !== key || dismissed.current === key) return;
      const reader = document.querySelector('.reader-panel')?.getBoundingClientRect(); if (!reader) return;
      const surface=document.querySelector('.native-office-surface')?.getBoundingClientRect();
      const bounds = nativeSelectionLayout(context, reader, selection.actions.length, surface ?? reader);
      void call('selection-layout', { viewId: context.viewId, visible: !!bounds, selection, settings: latest.settings, bounds }).catch(latest.report);
    };
    if (cache.current?.key === key) { if (cache.current.value) present(cache.current.value); return; }
    const entry = { key, pending: call<SelectionTools>('selection-tools', { viewId: c.viewId }) } as NonNullable<typeof cache.current>;
    cache.current = entry;
    // An obsolete async request must never display a previous selection.
    void call('selection-layout', { visible: false });
    void entry.pending!.then(value => { if (cache.current !== entry) return; entry.value = value; entry.pending = undefined; present(value); }).catch(error => { if (cache.current === entry) { cache.current = undefined; current.current.report(error); } });
  };
  const key = context && nativeSelectionKey(context), r = context?.selection.rect;
  useEffect(publish, [enabled, key, r?.x, r?.y, r?.width, r?.height, context?.viewport?.width, context?.viewport?.height, settings?.revision]);
  useEffect(() => {
    const resize = new ResizeObserver(() => publish()), reader = document.querySelector('.reader-panel'); if (reader) resize.observe(reader);
    const off = window.agentViewer?.onSelectionTool(event => { if (event.action === 'dismiss') { const c = current.current.context; dismissed.current = c && nativeSelectionKey(c); void call('selection-layout', { visible: false, animate: true }); } });
    window.addEventListener('resize', publish);
    return () => { resize.disconnect(); off?.(); window.removeEventListener('resize', publish); void call('selection-layout', { visible: false }); };
  }, [enabled]);
}
