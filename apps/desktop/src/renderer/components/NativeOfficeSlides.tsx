import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import type { NativeOfficeNavigateTarget, NativeOfficeState } from '../../../../../packages/contracts/src/native-office';
import type { NativeOfficeRequest } from '../lib/native-office-tools';
import { OfficeSlideThumbnailController, readOfficeSlideNavigation, type OfficeSlideNavigation } from '../lib/native-office-slide-thumbnails';

export function NativeOfficeSlides(props: { state: NativeOfficeState; ready: boolean; request: NativeOfficeRequest; disabled: boolean; reason?: string; navigate(target: NativeOfficeNavigateTarget): void }) {
  const { state } = props, identity = JSON.stringify([state.documentId, state.viewId, state.sessionId, state.engineEpoch]);
  const renderGeneration = (state as NativeOfficeState & { renderGeneration?: number }).renderGeneration;
  const metadataKey = JSON.stringify([identity, state.engineRevision, renderGeneration ?? state.viewport?.layoutRevision]);
  const [navigation, setNavigation] = useState<{ identity: string; key: string; value: OfficeSlideNavigation }>(), [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0), [visible, setVisible] = useState<Set<number>>(new Set()), [, changed] = useState(0);
  const list = useRef<HTMLDivElement>(null), latest = useRef(props), live = useRef(false), autoReload = useRef(''); latest.current = props;
  const currentMetadataKey = useRef(metadataKey); currentMetadataKey.current = metadataKey;
  const request: NativeOfficeRequest = useMemo(() => (method, args) => latest.current.request(method, args), []);
  const controller = useMemo(() => new OfficeSlideThumbnailController({ viewId: state.viewId!, request, changed: () => { if (live.current) changed(value => value + 1); }, invalidated: sourceKey => {
    if (!live.current) return;
    if (autoReload.current !== sourceKey) { autoReload.current = sourceKey; setRetry(value => value + 1); }
    else setError('页面来源仍在变化，请稍后刷新缩略图。');
  } }), [identity, request]);
  const data = navigation?.identity === identity ? navigation.value : undefined, fresh = navigation?.key === metadataKey;
  const items = data?.items ?? [], sourceKey = data?.source && JSON.stringify(data.source);
  const itemIndices = items.map(item => item.index).join(',');
  const activeIndex = state.selection?.slideIndex ?? data?.activeIndex;
  const paused = !props.ready || props.disabled || !!state.pendingInput;
  useEffect(() => { live.current = true; return () => { live.current = false; controller.dispose(); }; }, [controller]);
  useEffect(() => {
    if (!props.ready || state.pendingInput) return;
    let stopped = false; setError(''); setLoading(true); controller.setPaused(true);
    void readOfficeSlideNavigation(request, state).then(value => {
      if (!stopped && live.current && currentMetadataKey.current === metadataKey) { controller.confirmSourceReceipt(value.source); setNavigation({ identity, key: metadataKey, value }); }
    }).catch(cause => { if (!stopped && live.current && currentMetadataKey.current === metadataKey) setError(String(cause)); }).finally(() => { if (!stopped && live.current) setLoading(false); });
    return () => { stopped = true; };
  }, [metadataKey, retry, props.ready, !!state.pendingInput, request, controller]);
  useEffect(() => window.agentViewer?.onSettingsChanged(() => setRetry(value => value + 1)), [identity]);
  useEffect(() => { controller.setSource(data?.source); controller.setPaused(paused || !fresh || loading || !!error); controller.setVisible([...visible].sort((a, b) => Number(b === activeIndex) - Number(a === activeIndex))); }, [controller, sourceKey, paused, fresh, loading, error, visible, activeIndex]);
  useEffect(() => {
    const host = list.current;
    if (!host || !items.length) { setVisible(new Set()); controller.setVisible([]); return; }
    const root = host.closest<HTMLElement>('.adaptive-panel-scroll') ?? host.closest<HTMLElement>('.format-scroll') ?? host.closest<HTMLElement>('.floating-side-panel');
    const buttons = [...host.querySelectorAll<HTMLElement>('[data-office-slide-index]')];
    const update = (indices: Set<number>) => setVisible(previous => previous.size === indices.size && [...indices].every(index => previous.has(index)) ? previous : new Set(indices));
    const indices = new Set<number>();
    const observer = new IntersectionObserver(entries => { for (const entry of entries) { const index = Number((entry.target as HTMLElement).dataset.officeSlideIndex); if (entry.isIntersecting) indices.add(index); else indices.delete(index); } update(indices); }, { root, rootMargin: '64px 0px', threshold: 0 });
    buttons.forEach(button => observer.observe(button));
    return () => observer.disconnect();
  }, [itemIndices, controller]);
  const failed = [...visible].some(index => controller.error(index));
  const retryVisible = () => { if (error) setRetry(value => value + 1); else controller.retry(); };
  return <section className="native-office-group native-office-navigation" aria-label="幻灯片导航" data-office-slide-source={sourceKey} data-office-slide-mode="visible">
    <h3>幻灯片</h3>
    <div className="native-office-inline native-office-page-controls"><button className="icon-button" type="button" aria-label="上一张幻灯片" title={'上一张幻灯片' + (props.reason ? '\n' + props.reason : '')} disabled={props.disabled || activeIndex === undefined || !items.some(item => item.index === activeIndex - 1)} onMouseDown={event => event.preventDefault()} onClick={() => activeIndex !== undefined && props.navigate({ kind: 'slide', index: activeIndex - 1 })}><ChevronLeft size={16} aria-hidden="true" /></button><span>{activeIndex === undefined ? '—' : activeIndex + 1} / {items.length}</span><button className="icon-button" type="button" aria-label="下一张幻灯片" title={'下一张幻灯片' + (props.reason ? '\n' + props.reason : '')} disabled={props.disabled || activeIndex === undefined || !items.some(item => item.index === activeIndex + 1)} onMouseDown={event => event.preventDefault()} onClick={() => activeIndex !== undefined && props.navigate({ kind: 'slide', index: activeIndex + 1 })}><ChevronRight size={16} aria-hidden="true" /></button></div>
    {!data && !error && <p className="native-office-note" role="status">正在读取幻灯片列表…</p>}
    <div className="native-office-slide-list" ref={list}>{items.map(item => {
      const near = visible.has(item.index), thumbnail = near && fresh && !loading ? controller.get(item.index) : undefined;
      return <button key={item.index} type="button" data-office-slide-index={item.index} data-thumbnail-visible={near} className={activeIndex === item.index ? 'selected' : ''} aria-label={'第 ' + (item.index + 1) + ' 张幻灯片'} aria-current={activeIndex === item.index ? 'page' : undefined} disabled={props.disabled} title={item.text || item.name} onMouseDown={event => event.preventDefault()} onClick={() => props.navigate({ kind: 'slide', index: item.index })}>
        <span className="native-office-slide-preview" style={{ aspectRatio: item.width / item.height }}>{thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <span className="native-office-slide-excerpt">{item.text || item.name}</span>}</span>
        <span className="native-office-item-label"><span>{item.index + 1}</span>{item.name}</span>
      </button>;
    })}</div>
    {(error || failed) && <div className="native-office-error" role="status"><p>{error || '部分缩略图暂不可用，页面导航仍可使用。'}</p><button className="native-office-icon native-office-tool icon-button" type="button" aria-label="刷新幻灯片缩略图" title="刷新幻灯片缩略图" disabled={paused} onClick={retryVisible}><RefreshCw size={16} /></button></div>}
  </section>;
}
