import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LocateFixed, Play, RefreshCw, Search } from 'lucide-react';
import type { NativeOfficeCommand, NativeOfficeFormat, NativeOfficeNavigateTarget, NativeOfficeQuery, NativeOfficeState } from '../../../../../packages/contracts/src/native-office';
import { call } from '../lib/transport';
import { createNativeOfficeToolController, latestNativeOfficeRead, nativeOfficeCommandAvailability, nativeOfficeCommandPresentation, nativeOfficeCommandTooltip, nativeOfficeCommandVisible, nativeOfficeOwnedState, nativeOfficeStateVersionOrder, nativeOfficeStatusKey, nativeOfficeToolCandidates, parseNativeOfficeArguments, type NativeOfficeActionResult, type NativeOfficeRequest, type NativeOfficeToolController } from '../lib/native-office-tools';
import { nativeOfficeReadMessages, updateNativeOfficeReadErrors, type NativeOfficeReadErrors } from '../lib/native-office-read-errors';
import { readNativeOfficeCatalog, shareNativeOfficeState, subscribeNativeOfficeState } from '../lib/native-office-observer';
import { officeToolboxCategory, officeToolboxContribution, type OfficeToolboxCategory } from './office/toolbox-contributions';
import { nativeStyleReplacedCommands, nativeStyleTargets } from '../lib/native-office-style';
import { NativeOfficeStyleInspector } from './NativeOfficeStyleInspector';
import { nativeOfficeCommandIcon } from './office/native-command-icons';
import { NativeOfficeToolGlyph } from './office/NativeOfficeToolGlyph';
import { NativeOfficeSlides } from './NativeOfficeSlides';
import '../native-office-tools.css';
import '../office-toolbox-icons.css';

export type NativeOfficeToolsProps = {
  documentId: string; viewId: string; format: NativeOfficeFormat;
  category?: OfficeToolboxCategory; onCategoryChange?(category: OfficeToolboxCategory): void;
  state?: NativeOfficeState; request?: NativeOfficeRequest;
  onState?(state: NativeOfficeState): void; onError?(error: unknown): void;
  beforeAction?(): Promise<NativeOfficeState | void>;
  onController?(controller: NativeOfficeToolController | undefined): void;
};
type NavigationItem = { index: number; name: string; text?: string; thumbnail?: string; visible?: boolean };
type NavigationData = { items: NavigationItem[]; activeIndex?: number };
const emptyCommands: NativeOfficeCommand[] = [];
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function navigationData(format: NativeOfficeFormat, value: unknown): NavigationData {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (format === 'docx') return { items: [] };
  const source = format === 'pptx' ? data.slides : data.sheets;
  const items = Array.isArray(source) ? source.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>, index = number(item.index);
    if (index === undefined) return [];
    return [{ index, name: typeof item.name === 'string' ? item.name : format === 'pptx' ? '幻灯片 ' + (index + 1) : '工作表 ' + (index + 1), text: typeof item.text === 'string' ? item.text.slice(0, 400) : undefined, thumbnail: typeof item.thumbnail === 'string' && item.thumbnail.length < 3_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(item.thumbnail) ? item.thumbnail : undefined, visible: typeof item.visible === 'boolean' ? item.visible : undefined }];
  }) : [];
  return { items, activeIndex: number(data.activeIndex) };
}
const receiptText = (result: NativeOfficeActionResult) => ({ applied: '修改已应用。', dispatched: '命令已派发；请在原生对话框或正文中完成后续操作。', 'no-change': '操作完成，文档内容没有变化。', requested: '已请求跳转，等待引擎呈现。', rendered: '目标已呈现。' }[result.status] ?? '已收到引擎回执。');

/** The application rail controls categories; this panel never adds a second native toolbar. */
export function NativeOfficeTools(props: NativeOfficeToolsProps) {
  const { documentId, viewId, format } = props, identity = documentId + '\0' + viewId + '\0' + format;
  const latestProps = useRef(props); latestProps.current = props;
  const [localState, setLocalState] = useState<NativeOfficeState>();
  const supplied = nativeOfficeOwnedState(props.state, props) ? props.state : undefined;
  const owned = nativeOfficeOwnedState(localState, props) ? localState : undefined;
  const state = supplied && nativeOfficeStateVersionOrder(owned, supplied) === 1 ? owned : supplied ?? owned;
  const current = useRef(state); current.current = state;
  // The tiled importer can be ready before the first frame is presented.
  // Tool discovery and thumbnail export must yield to that first real frame.
  const backgroundReadsReady=!!state&&state.status==='ready'&&(!('surfaceKind' in state)||state.surfaceKind!=='tiled'||state.visible===true&&state.nativeGeometry===true);
  const liveIdentity = useRef(identity); liveIdentity.current = identity;
  const request: NativeOfficeRequest = useMemo(() => (method, args) => (latestProps.current.request ?? call)(method, args), []);
  const acceptState = useMemo(() => (value: NativeOfficeState) => {
    const latest = latestProps.current;
    if (!nativeOfficeOwnedState(value, latest)) return;
    const previous = current.current;
    if (nativeOfficeStateVersionOrder(value, previous) === -1) return;
    const shared = shareNativeOfficeState(previous, value);
    current.current = shared; setLocalState(prior => shareNativeOfficeState(prior, shared)); latest.onState?.(shared);
  }, []);
  const owner = useMemo(() => createNativeOfficeToolController({ documentId, viewId }, { current: () => current.current, request, accept: acceptState, beforeAction: async () => latestProps.current.beforeAction?.() }), [documentId, viewId, request, acceptState]);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; latestProps.current.onController?.(owner.controller); return () => { alive.current = false; owner.dispose(); latestProps.current.onController?.(undefined); }; }, [owner]);
  const [localCategory, setLocalCategory] = useState<{ identity: string; category: OfficeToolboxCategory }>();
  const category = officeToolboxCategory(format, props.category ?? (localCategory?.identity === identity ? localCategory.category : undefined));
  const navigationCategory = format === 'pptx' ? category === 'slides' : format === 'xlsx' && category === 'worksheet';
  const contribution = officeToolboxContribution(format)!;
  const [catalog, setCatalog] = useState<{ key: string; commands: NativeOfficeCommand[] }>();
  const [statuses, setStatuses] = useState<{ key: string; commands: NativeOfficeCommand[] }>();
  const [navigation, setNavigation] = useState<{ key: string; data: NavigationData }>();
  const [query, setQuery] = useState(''), [searchPage, setSearchPage] = useState(0), [searchOpen, setSearchOpen] = useState(false), [selectedCommand, setSelectedCommand] = useState<string>();
  const [parameters, setParameters] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState('');
  const [readErrors, setReadErrors] = useState<NativeOfficeReadErrors>({});
  const activeAction = useRef(0), busyRef = useRef(false), [address, setAddress] = useState(''), [queryRetry, setQueryRetry] = useState(0), [catalogRetry, setCatalogRetry] = useState(0);
  const catalogController = useRef<AbortController | undefined>(undefined);
  const engineKey = state ? JSON.stringify([identity, state.sessionId, state.engineEpoch]) : '';
  const statusKey = state ? nativeOfficeStatusKey(state) : '';
  const documentKey = state ? JSON.stringify([engineKey, state.engineRevision]) : '';
  const commands = useMemo(() => catalog?.key === engineKey ? catalog.commands.filter(nativeOfficeCommandVisible) : emptyCommands, [catalog, engineKey]);
  const visibleGroups = useMemo(() => {
    const replaced = nativeStyleReplacedCommands(nativeStyleTargets(format, category));
    return nativeOfficeToolCandidates(format, category).map(group => ({ ...group, commands: group.commands.filter(command=>!replaced.has(command.command)) })).filter(group=>group.commands.length>0);
  }, [format, category]);
  const matching = useMemo(() => { const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean); return words.length ? commands.filter(item => { const presentation = nativeOfficeCommandPresentation(format, item); return words.every(word => (item.command + ' ' + (item.label ?? '') + ' ' + (item.group ?? '') + ' ' + presentation.label + ' ' + (presentation.description ?? '')).toLocaleLowerCase().includes(word)); }) : commands; }, [commands, query, format]);
  const searchCommands = useMemo(() => matching.slice(searchPage * 20, searchPage * 20 + 20), [matching, searchPage]);
  const wanted = [...new Set([...visibleGroups.flatMap(group => group.commands.map(item => item.command)), ...(searchOpen ? searchCommands.map(item => item.command) : [])])];
  const wantedKey = wanted.join('\0');
  const statusById = new Map((statuses?.key === statusKey + wantedKey ? statuses.commands : []).map(item => [item.command, item]));
  const resolved = (command: NativeOfficeCommand) => ({ ...command, available: undefined, enabled: undefined, state: undefined, ...statusById.get(command.command), label: command.label ?? statusById.get(command.command)?.label });
  const navigationItems = navigation?.key === documentKey ? navigation.data.items : [];
  const selectedIndex = format === 'pptx' ? state?.selection?.slideIndex : state?.selection?.sheetIndex;
  const activeIndex = selectedIndex ?? (navigation?.key === documentKey ? navigation.data.activeIndex : undefined);
  const canNavigate = !!state && state.status === 'ready' && !state.pendingInput && !busy;
  const navigationReason = busy ? '正在等待引擎回执…' : state?.pendingInput ? '请先完成正文中的输入。' : state?.status !== 'ready' ? '文档引擎尚未就绪。' : undefined;
  const initializing = !state || state.status === 'opening';
  const readMessages = nativeOfficeReadMessages(readErrors, { poll: identity, catalog: searchOpen ? engineKey : '', status: statusKey + wantedKey, navigation: documentKey }, initializing);
  const errors = [...new Set([error, ...readMessages].filter(Boolean))];

  useEffect(() => {
    setQuery(''); setSearchPage(0); setSearchOpen(false); setSelectedCommand(undefined); setParameters(''); setError(''); setReadErrors({}); setFeedback(''); setAddress('');
    activeAction.current++; busyRef.current = false; setBusy(false);
  }, [identity]);
  useEffect(() => {
    if (supplied) setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'poll', key: identity, outcome: 'success' }));
  }, [identity, supplied]);
  useEffect(() => {
    if (props.state !== undefined) return;
    return subscribeNativeOfficeState(props.request ?? call, viewId, documentId, {
      state: value => { if (liveIdentity.current === identity && nativeOfficeOwnedState(value, latestProps.current)) { acceptState(value); setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'poll', key: identity, outcome: 'success' })); } },
      healthy: () => { if (liveIdentity.current === identity) setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'poll', key: identity, outcome: 'success' })); },
      error: cause => { if (liveIdentity.current === identity) setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'poll', key: identity, outcome: 'failure', cause })); },
    });
  }, [identity, viewId, documentId, props.state === undefined, props.request, acceptState]);
  useEffect(() => {
    if (!searchOpen || !state || !backgroundReadsReady) return;
    let stopped = false; const controller = new AbortController(); catalogController.current = controller;
    void (async () => {
      try {
        const result = await readNativeOfficeCatalog(latestProps.current.request ?? call, state, catalogRetry > 0, controller.signal);
        if (!stopped && liveIdentity.current === identity) { setCatalog({ key: engineKey, commands: result }); setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'catalog', key: engineKey, outcome: 'success' })); }
      } catch (cause) { if (!stopped && !controller.signal.aborted && liveIdentity.current === identity) setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'catalog', key: engineKey, outcome: 'failure', cause })); }
    })(); return () => { stopped = true; controller.abort(); if(catalogController.current===controller)catalogController.current=undefined; };
  }, [engineKey, catalogRetry, props.request, searchOpen,backgroundReadsReady]);
  useEffect(() => {
    if (!state || !backgroundReadsReady || !wanted.length) return;
    let stopped = false;
    void (async () => {
      try {
        const result: NativeOfficeCommand[] = [];
        for (let offset = 0; offset < wanted.length; offset += 50) {
          const response = await latestNativeOfficeRead<{ state: NativeOfficeState; commands: NativeOfficeCommand[] }>(request,identity+':commands:'+offset,'office-command-status', { viewId, commands: wanted.slice(offset, offset + 50) });
          if (stopped || liveIdentity.current !== identity || !nativeOfficeOwnedState(response.state, props) || nativeOfficeStatusKey(response.state) !== statusKey) return;
          result.push(...response.commands);
        }
        if (!stopped) { setStatuses({ key: statusKey + wantedKey, commands: result }); setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'status', key: statusKey + wantedKey, outcome: 'success' })); }
      } catch (cause) { if (!stopped && liveIdentity.current === identity) setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'status', key: statusKey + wantedKey, outcome: 'failure', cause })); }
    })(); return () => { stopped = true; };
  }, [statusKey, wantedKey, request, queryRetry,backgroundReadsReady]);
  useEffect(() => {
    if (!state || !backgroundReadsReady || !navigationCategory || format === 'pptx') return;
    const target: NativeOfficeQuery = { kind: 'sheets' };
    let stopped = false;
    const load = () => void request<{ state: NativeOfficeState; data: unknown }>('office-query', { viewId, target }).then(response => {
      if (stopped || liveIdentity.current !== identity || !nativeOfficeOwnedState(response.state, props) || response.state.engineEpoch !== state.engineEpoch || response.state.engineRevision !== state.engineRevision) return;
      setNavigation({ key: documentKey, data: navigationData(format, response.data) });
      setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'navigation', key: documentKey, outcome: 'success' }));
    }).catch(cause => { if (!stopped && liveIdentity.current === identity) setReadErrors(previous => updateNativeOfficeReadErrors(previous, { kind: 'navigation', key: documentKey, outcome: 'failure', cause })); });
    load();
    return () => { stopped = true; };
  }, [documentKey, request, queryRetry, navigationCategory,backgroundReadsReady]);

  const perform = async (operation: () => Promise<NativeOfficeActionResult>, propagate = false) => {
    if (busyRef.current) { if(propagate)throw new Error('上一条 Office 操作仍在处理中。'); return; }
    busyRef.current = true; setBusy(true); setError(''); setFeedback(''); const origin = identity, action = ++activeAction.current;
    try { const result = await operation(); if (alive.current && liveIdentity.current === origin) { setFeedback([receiptText(result), ...(result.warnings ?? [])].join(' ')); setQueryRetry(value => value + 1); } return result; }
    catch (cause) { if (alive.current && liveIdentity.current === origin) { setError(cause instanceof Error ? cause.message : String(cause)); latestProps.current.onError?.(cause); } if(propagate)throw cause; }
    finally { if (activeAction.current === action) { busyRef.current = false; if (alive.current && liveIdentity.current === origin) setBusy(false); } }
  };
  const execute = (command: string, args?: string) => {
    let parsed;
    try { parsed = parseNativeOfficeArguments(args ?? ''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    void perform(() => owner.controller.execute(command, parsed));
  };
  const navigate = (target: NativeOfficeNavigateTarget) => void perform(() => owner.controller.navigate(target));
  const selected = selectedCommand && commands.find(item => item.command === selectedCommand);
  const renderCommand = (raw: NativeOfficeCommand & { icon?: string }) => {
    const item = resolved(raw), availability = nativeOfficeCommandAvailability(item, state), glyph = nativeOfficeCommandIcon(format, item.command), presentation = nativeOfficeCommandPresentation(format, item);
    const reason = busy ? '正在等待引擎回执…' : availability.reason;
    return <button key={item.command} type="button" className={glyph ? 'native-office-icon native-office-tool icon-button' : 'native-office-action'} aria-label={presentation.label} aria-pressed={typeof item.state === 'boolean' ? item.state : undefined} disabled={busy || !availability.enabled} title={nativeOfficeCommandTooltip(presentation, reason)} data-uno-command={item.command} onMouseDown={event => event.preventDefault()} onClick={() => execute(item.command)}>{glyph ? <NativeOfficeToolGlyph glyph={glyph} /> : presentation.label}</button>;
  };
  return <div className="native-office-tools office-sidebar" data-native-office-format={format} data-office-category={category}>
    {props.category === undefined && <div className="native-office-categories" role="tablist" aria-label="Office 工具分类">{contribution.categories.map(item => <button key={item.id} type="button" role="tab" aria-selected={item.id === category} tabIndex={item.id === category ? 0 : -1} className={item.id === category ? 'selected' : ''} onMouseDown={event => event.preventDefault()} onClick={() => { setLocalCategory({ identity, category: item.id }); props.onCategoryChange?.(item.id); }}>{item.label}</button>)}</div>}
    <div role="tabpanel" aria-label={contribution.categories.find(item => item.id === category)?.label} data-office-category={category}>
      {initializing ? <p className="native-office-note" role="status">正在等待文档引擎，工具准备好后会自动显示…</p> : state.status === 'failed' ? <p className="native-office-note">文档引擎未就绪。</p> : <>
        <NativeOfficeStyleInspector documentId={documentId} viewId={viewId} format={format} category={category} state={state} busy={busy||!backgroundReadsReady} request={props.request} onInspect={acceptState} onApply={async(target,values,source)=>{const result=await perform(()=>owner.controller.setStyle(target,values,source),true);if(result?.status==='dispatched')throw new Error('修改已派发，尚未确认完整结果。请重新读取属性后检查。');}}/>
        {visibleGroups.map(group => <section key={group.title} className="native-office-group" aria-label={group.title}><h3>{group.title}</h3><div className="native-office-command-grid">{group.commands.filter(item => item.command !== '.uno:NotesPage' || statusById.get('.uno:NotesMode')?.available !== true).map(renderCommand)}</div></section>)}
        {!visibleGroups.length && commands.length > 0 && <p className="native-office-note">当前引擎未在此分类提供常用命令，可在已发现命令中查找。</p>}
        {format === 'pptx' && navigationCategory && <NativeOfficeSlides state={state} ready={backgroundReadsReady} request={request} disabled={!canNavigate} reason={navigationReason} navigate={target => void navigate(target)} />}
        {format === 'xlsx' && navigationCategory && <section className="native-office-group native-office-navigation" aria-label="工作表导航">
            <h3>工作表</h3>
            <div className="native-office-sheet-list">{navigationItems.map(item => <button key={item.index} type="button" className={activeIndex === item.index ? 'selected' : ''} aria-label={'转到工作表 ' + item.name} aria-current={activeIndex === item.index ? 'page' : undefined} disabled={!canNavigate || item.visible === false} title={item.visible === false ? '此工作表已隐藏，请先在工作表工具中显示。' : item.text || item.name} onMouseDown={event => event.preventDefault()} onClick={() => navigate({ kind: 'sheet', index: item.index })}>
              <span className="native-office-item-label">{item.name}</span>
            </button>)}</div>
            {format === 'xlsx' && <form className="native-office-inline" onSubmit={event => { event.preventDefault(); const sheetName = state.selection?.sheetName; if (sheetName && address.trim()) navigate({ kind: 'cell', sheetName, address: address.trim() }); }}><input aria-label="定位单元格或范围" placeholder="A1 或 A1:C10" value={address} onChange={event => setAddress(event.target.value)} /><button className="native-office-icon native-office-tool icon-button" type="submit" aria-label="定位" title={'定位单元格或范围'+(navigationReason?'\n'+navigationReason:!state.selection?.sheetName?'\n请先选择工作表。':!address.trim()?'\n请输入单元格地址。':'')} disabled={!canNavigate || !state.selection?.sheetName || !address.trim()}><LocateFixed size={17} aria-hidden="true" /></button></form>}
        </section>}
      </>}
      <details className="native-office-search" open={searchOpen} onToggle={event => { const open=event.currentTarget.open; if(!open)catalogController.current?.abort(); setSearchOpen(open); }}><summary>全部引擎命令 <span>{commands.length || ''}</span></summary>{searchOpen && <>{catalog?.key !== engineKey && <p className="native-office-note" role="status">正在读取完整命令目录…</p>}<label className="native-office-search-field"><Search size={15} /><input aria-label="搜索原生 Office 命令" placeholder="名称或 .uno: 命令" value={query} onChange={event => { setQuery(event.target.value); setSearchPage(0); setSelectedCommand(undefined); }} /></label>
        <div className="native-office-search-results">{searchCommands.map(item => { const availability = nativeOfficeCommandAvailability(resolved(item), state), presentation = nativeOfficeCommandPresentation(format, item); return <button type="button" key={item.command} className={selectedCommand === item.command ? 'selected' : ''} title={nativeOfficeCommandTooltip(presentation, availability.reason)} data-uno-command={item.command} onMouseDown={event => event.preventDefault()} onClick={() => { setSelectedCommand(item.command); setParameters(''); }}><span>{presentation.label}</span><code>{item.command}</code>{!availability.enabled && <small>{availability.reason}</small>}</button>; })}{commands.length > 0 && !matching.length && <p className="native-office-note">没有匹配的引擎命令。</p>}</div>
        {matching.length > 20 && <div className="native-office-inline native-office-page-controls"><button type="button" className="icon-button" aria-label="上一页命令" title={searchPage === 0 ? '上一页命令\n已经是第一页。' : '上一页命令'} disabled={searchPage === 0} onClick={() => { setSearchPage(value => value - 1); setSelectedCommand(undefined); }}><ChevronLeft size={15} aria-hidden="true" /></button><span>{searchPage + 1} / {Math.ceil(matching.length / 20)}</span><button type="button" className="icon-button" aria-label="下一页命令" title={(searchPage + 1) * 20 >= matching.length ? '下一页命令\n已经是最后一页。' : '下一页命令'} disabled={(searchPage + 1) * 20 >= matching.length} onClick={() => { setSearchPage(value => value + 1); setSelectedCommand(undefined); }}><ChevronRight size={15} aria-hidden="true" /></button></div>}
        {selected && <section className="native-office-command-detail" aria-label="原生命令参数"><strong>{nativeOfficeCommandPresentation(format, selected).label}</strong><code>{selected.command}</code>{selected.parameters?.length ? <p className="native-office-note">{selected.parameters.map(item => item.name + (item.type ? ' · ' + item.type : '') + (item.required ? '（必填）' : '')).join('，')}</p> : <p className="native-office-note">不提供参数时使用引擎默认交互；复杂命令可能打开原生对话框。</p>}<details><summary>显式参数</summary><textarea aria-label="UNO 类型参数 JSON" value={parameters} rows={4} spellCheck={false} placeholder={'[{"name":"属性名","type":"string","value":"值"}]'} onChange={event => setParameters(event.target.value)} /><p className="native-office-note">使用引擎要求的属性名与类型。未知参数不自动推断。</p></details><button type="button" className="native-office-action" disabled={busy || !nativeOfficeCommandAvailability(resolved(selected), state).enabled} onMouseDown={event => event.preventDefault()} onClick={() => execute(selected.command, parameters)}><Play size={14} />运行命令</button></section>}
      </>}</details>
      {busy && <p className="native-office-note" role="status">正在等待引擎回执…</p>}{feedback && <p className="native-office-feedback" role="status">{feedback}</p>}{errors.length > 0 && <div className="native-office-error" role="alert">{errors.map(message => <p key={message}>{message}</p>)}<button type="button" className="native-office-icon native-office-tool icon-button" aria-label="刷新工具状态" title={'刷新工具状态'+(busy?'\n正在等待引擎回执…':'')} disabled={busy} onClick={() => { setError(''); setReadErrors({}); setQueryRetry(value => value + 1); setCatalogRetry(value => value + 1); }}><RefreshCw size={17} aria-hidden="true" /></button></div>}
    </div>
  </div>;
}

export { NativeOfficeTools as NativeOfficeSidebar };
