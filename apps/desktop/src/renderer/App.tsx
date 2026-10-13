import { LiquidGlassSurface } from './components/LiquidGlassSurface';
import { HomeSearch } from './components/HomeSearch';
import { buildHomeSearchCandidates, type HomeSearchCandidate } from './lib/home-search';
import { replaceHomeTabSlot } from './lib/home-tabs';
import { AgentOperationCapsule } from './components/AgentOperationCapsule';
import { AIReadingTools } from './components/AIReadingTools';
import { AIResultPopover } from './components/AIResultPopover';
import type { AIReadingToolDefinition, AIReadingScope } from './lib/ai-reading-tools';
import { FileDropHost } from './components/FileDropHost';
import { AGENT_OPERATION_METRICS, NAVIGATION_METRICS } from './lib/navigation-optics';
import { AnimatedDisclosure, MotionPresence, usePresence } from './components/MotionPresence';
import { NavigationToolbar, type NavigationAction } from './components/NavigationToolbar';
import { useNavigationVisibility } from './lib/navigation-visibility';
import { motionDuration } from './lib/motion';
import { scrollReadingTarget } from './lib/reading-scroll';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, BookOpen, Braces, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Copy, ExternalLink, FileCode2, FilePlus2, FileText, FolderOpen, Globe, Highlighter, Languages, ListTree, ListTodo, Minus, Pause, Pilcrow, Pin, Plus, Presentation, RotateCw, Search, Send, Settings2, Sparkles, Square, StopCircle, Table2, X } from 'lucide-react';
import { DocumentPane, type PdfToolsState } from './components/DocumentPane';
import { OfficeTools, type OfficeTarget } from './components/OfficeTools';
import type { OfficeDraftController } from './components/OfficeDocument';
import { call, desktop, samples, state, windowId } from './lib/transport';
import type { DocumentInfo, EditOperation, HarnessTask, PreparedPatch, ReadingSnapshot, Receipt, ViewInfo, WorkspaceState } from '../../../../packages/contracts/src/index';
import { normalizeWebAddress } from '../../../../packages/contracts/src/index';
import type { SettingsSnapshot, SettingValue } from '../../../../packages/settings/src/index';
import type { TranslationArtifact, TranslationJob } from '../../../../packages/translation/src/index';
import { applyAppearance } from './lib/appearance';
import { sharePolledValue } from './lib/polled-state';
import logoMark from './assets/agentviewer-logo.svg';

const emptyState: WorkspaceState = { protocolVersion: '1.0', documents: [], views: [], tasks: [], eventsSeq: 0 };
const pollStats = { successfulPolls: 0, changedRoot: 0 };
/** Counts only. No document identities, content, routes or account information. */
export function rendererPollStats() { return { ...pollStats }; }
const emptyPdfTools: PdfToolsState = { note: '', highlight: false, ocrBusy: false };
const formats = [{ id: 'markdown', title: 'Markdown', extension: 'md' }, { id: 'docx', title: 'Word', extension: 'docx' }, { id: 'pptx', title: 'PowerPoint', extension: 'pptx' }, { id: 'xlsx', title: 'Excel', extension: 'xlsx' }, { id: 'pdf', title: 'PDF', extension: 'pdf' }, { id: 'html', title: 'HTML', extension: 'html' }];
const formatName: Record<string, string> = { markdown: 'Markdown', html: 'HTML', docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel', pdf: 'PDF', web: '网页' };
type Card = { id: string; viewId: string; source: string; result: string; sourceRevision: number; locator?: { quote?: string; pageIndex?: number; slideId?: string; sheetId?: string; cell?: string }; pinned: boolean; status: 'loading' | 'ready' | 'error'; error?: string };
type EventItem = { seq: number; type: string; data: { viewId?: string; documentId?: string; kind?: string; point?: { x: number; y: number }; actor?: string; target?: { kind: string; blockId?: string; shapeId?: string; address?: string; pageIndex?: number } }; time: string };
function FileIcon({ format }: { format: string }) { return format === 'web' ? <Globe size={17} /> : ['docx', 'pptx', 'xlsx'].includes(format) ? <span className={'office-icon ' + format}>{({ docx: 'W', pptx: 'P', xlsx: 'X' } as Record<string, string>)[format]}</span> : <FileText size={17} className={format === 'pdf' ? 'pdf-icon' : ''} />; }
function FormatToolIcon({ format }: { format?: string }) {
  switch (format) {
    case 'markdown': return <Braces size={20} />;
    case 'html': return <FileCode2 size={20} />;
    case 'docx': return <Pilcrow size={20} />;
    case 'pptx': return <Presentation size={20} />;
    case 'xlsx': return <Table2 size={20} />;
    case 'pdf': return <Highlighter size={20} />;
    case 'web': return <Globe size={20} />;
    default: return <FileText size={20} />;
  }
}
function tone(format?: string) { return format === 'web' ? '网页' : formatName[format ?? ''] ?? '文档'; }
function sourceName(card: Card) { if (card.locator?.pageIndex !== undefined) return '第 ' + (card.locator.pageIndex + 1) + ' 页'; if (card.locator?.cell) return card.locator.cell; if (card.locator?.slideId) return '幻灯片'; return card.locator?.quote?.slice(0, 36) || '当前选区'; }
function alreadyTarget(text: string, target: string) { const letters = [...text].filter(char => /[\p{L}]/u.test(char)); if (letters.length < 5) return false; if (target === 'zh-CN') return letters.filter(char => /\p{Script=Han}/u.test(char)).length / letters.length > .72; if (target === 'en') return letters.filter(char => /[A-Za-z]/.test(char)).length / letters.length > .92; if (target === 'ja') return letters.some(char => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)); return false; }

export function App() {
  const [workspace, setWorkspace] = useState(emptyState), stateRef = useRef(workspace);
  const [settings, setSettings] = useState<SettingsSnapshot>(), [sampleFiles, setSampleFiles] = useState<{ name: string; format: string; path: string }[]>([]);
  const [selectionProfile, setSelectionProfile] = useState(''), [chatProfile, setChatProfile] = useState('');
  const [pdfEngineAvailable, setPdfEngineAvailable] = useState(false);
  const [fullOfficeAvailable, setFullOfficeAvailable] = useState(false);
  const [pdfTools, setPdfTools] = useState<PdfToolsState>(emptyPdfTools);
  const [officeTarget, setOfficeTarget] = useState<OfficeTarget>();
  const [homeTabs, setHomeTabs] = useState<string[]>([]), [homeTabId, setHomeTabId] = useState<string>(), [tabOrder, setTabOrder] = useState<string[]>([]);
  const [home, setHome] = useState(false), [activeId, setActiveId] = useState<string>(), [address, setAddress] = useState('');
  const [homeQueries, setHomeQueries] = useState<Record<string, string>>({});
  const homeFocus = useRef<string | undefined>(undefined);
  // Request identity belongs to the tab, and survives its search component
  // unmounting when the user reads another tab during a slow open.
  const homeTabsRef = useRef<string[]>([]), homeRequests = useRef(new Set<string>());
  const foreground = useRef<{ homeId?: string; viewId?: string }>({});
  const [pendingHomes, setPendingHomes] = useState<Record<string, boolean>>({});
  const [closing, setClosing] = useState<ViewInfo>(), [closingBusy, setClosingBusy] = useState(false);
  const [annotations, setAnnotations] = useState<any[]>([]);
  const [modal, setModal] = useState<'new' | 'open' | 'save' | null>(null), [toast, setToast] = useState(''), [prompt, setPrompt] = useState('');
  const [driver, setDriver] = useState(''), [drivers, setDrivers] = useState<{ id: string }[]>([]), [drawer, setDrawer] = useState<'ai' | 'translation' | 'tasks' | 'annotations' | null>(null);
  const [leftOpen, setLeftOpen] = useState(true), [leftSection, setLeftSection] = useState('outline');
  const leftPanelViews = useRef(new Map<string, { section: string; open: boolean }>());
  const leftPanelView = useRef<string | undefined>(undefined);
  const [aiResult, setAIResult] = useState<{ taskId: string; label: string; source: string; viewId: string }>();
  const [aiPending, setAIPending] = useState(false);
  const [fixed, setFixed] = useState<ReadingSnapshot>(), [drafts, setDrafts] = useState<Record<string, string>>({}), [cards, setCards] = useState<Card[]>([]);
  const [translationJobs, setTranslationJobs] = useState<TranslationJob[]>([]), [artifacts, setArtifacts] = useState<TranslationArtifact[]>([]);
  const homeCandidates = useMemo(() => buildHomeSearchCandidates({ documents: workspace.documents, samples: sampleFiles, artifacts }), [workspace.documents, sampleFiles, artifacts]);
  const [webTranslated, setWebTranslated] = useState<Record<string, boolean>>({}), [webBusy, setWebBusy] = useState(false);
  const [agentEvent, setAgentEvent] = useState<EventItem>(), eventSeq = useRef(0), selectionSeq = useRef(0);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, 'running' | 'paused' | 'stopped'>>({});
  const autoOpenedJobs = useRef(new Set<string>());
  const editQueue = useRef(Promise.resolve()), lastTransactions = useRef(new Map<string, string>()), history = useRef<string[]>([]), future = useRef<string[]>([]), mounted = useRef(true);
  const officeControllers = useRef(new Map<string, OfficeDraftController>());
  const [officeDraftDirty, setOfficeDraftDirty] = useState<Record<string, boolean>>({});
  const onOfficeDraftController = useCallback((controller: OfficeDraftController | undefined) => { if (controller) officeControllers.current.set(controller.viewId, controller); else officeControllers.current.clear(); }, []);
  const onOfficeDraftChange = useCallback(({ viewId, dirty }: { viewId: string; dirty: boolean }) => setOfficeDraftDirty(previous => previous[viewId] === dirty ? previous : { ...previous, [viewId]: dirty }), []);
  async function flushDrafts(viewId?: string) {
    for (const controller of officeControllers.current.values()) if (!viewId || controller.viewId === viewId) {
      await controller.flush();
      if (controller.hasDrafts()) throw new Error('输入内容仍在变化，请完成输入后重试。');
    }
    await editQueue.current;
  }
  const viewList = workspace.views.filter(v => v.windowId === windowId);
  const view = viewList.find(v => v.id === activeId) ?? viewList.find(v => v.id === workspace.activeViewId) ?? viewList[0];
  useEffect(() => { setTabOrder(order => [...order, ...viewList.map(v => v.id).filter(id => !order.includes(id))]); }, [viewList.map(v => v.id).join(',')]);
  async function newHomeTab(focusSearch = false) { try { await flushDrafts(); const id = 'home:' + crypto.randomUUID(); if (focusSearch) homeFocus.current = id; homeTabsRef.current = [...homeTabsRef.current, id]; setHomeTabs(homeTabsRef.current); setTabOrder(order => [...order, id]); foreground.current = { ...foreground.current, homeId: id }; setHomeTabId(id); setHome(true); } catch (error) { alert(error); } }
  async function switchHomeTab(id: string) { try { await flushDrafts(); if (!homeTabsRef.current.includes(id)) return; foreground.current = { ...foreground.current, homeId: id }; setHomeTabId(id); setHome(true); } catch (error) { alert(error); } }
  function closeHomeTab(id: string) { const remaining = homeTabsRef.current.filter(tab => tab !== id); homeTabsRef.current = remaining; setHomeTabs(remaining); setTabOrder(order => order.filter(tab => tab !== id)); setHomeQueries(previous => { const next = { ...previous }; delete next[id]; return next; }); if (foreground.current.homeId === id) { foreground.current = { ...foreground.current, homeId: remaining.at(-1) }; setHomeTabId(remaining.at(-1)); setHome(remaining.length > 0); } }
  useEffect(() => {
    if (!home || homeFocus.current !== homeTabId) return;
    homeFocus.current = undefined;
    const frame = requestAnimationFrame(() => window.document.querySelector<HTMLInputElement>('.home-search-input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [home, homeTabId]);
  const original = workspace.documents.find(d => d.id === view?.documentId);
  const document = original && drafts[original.id] !== undefined ? { ...original, dirty: true, model: { ...original.model, text: drafts[original.id] } } : original;
  useEffect(() => {
    if (!view || !document || leftPanelView.current === view.id) return;
    if (leftPanelView.current) leftPanelViews.current.set(leftPanelView.current, { section: leftSection, open: leftOpen });
    const panel = leftPanelViews.current.get(view.id) ?? { section: ['docx', 'pptx', 'xlsx'].includes(document.format) ? 'tools' : 'outline', open: true };
    leftPanelView.current = view.id; setLeftSection(panel.section); setLeftOpen(panel.open);
  }, [view?.id, document?.format]);
  const motionIdentity = home ? 'home' : view?.id;
  const leftMotion = usePresence(!home && leftOpen && document?.format !== 'web', { duration: 220, identity: motionIdentity });
  const rightMotion = usePresence(!home && !!drawer, { duration: 220, identity: motionIdentity });
  const modalMotion = usePresence(!!modal || !!closing, { duration: 200 });
  const layoutView = useRef(motionIdentity);
  const animateLayout = layoutView.current === motionIdentity;
  useEffect(() => { layoutView.current = motionIdentity; }, [motionIdentity]);
  const context = fixed && fixed.context.viewId === view?.id ? fixed.context : view?.context;
  const val = (id: string, fallback: SettingValue) => settings?.values[id] ?? fallback;
  const navigation = useNavigationVisibility({ enabled: !!val('appearance.autoHideToolbar', true), delayMs: Number(val('appearance.toolbarDelayMs', 2500)), identity: motionIdentity });
  const onReaderScroll = navigation.onScroll;
  const alert = (error: unknown) => setToast(error instanceof Error ? error.message : String(error));
  useEffect(() => window.agentViewer?.onBeforeClose(async options => {
    try {
      if (options.checkOnly) {
        if ([...officeControllers.current.values()].some(controller => (!options.documentId || stateRef.current.views.find(view => view.id === controller.viewId)?.documentId === options.documentId) && controller.hasDrafts())) throw new Error('当前文档有未提交输入，请完成输入后重试。');
        return;
      }
      await flushDrafts();
    } catch (error) { alert(error); throw error; }
  }), []);
  const refresh = async () => { const result = await state(), previous = stateRef.current, next = sharePolledValue(previous, result); if (previous.activeViewId !== next.activeViewId) { setActiveId(next.activeViewId); if (!foreground.current.homeId) foreground.current = { viewId: next.activeViewId }; } if (next !== previous) { stateRef.current = next; if (mounted.current) setWorkspace(next); pollStats.changedRoot++; } pollStats.successfulPolls++; return next; };
  const refreshTranslations = async () => { if (!desktop) return; const result = await call<{ jobs: TranslationJob[]; artifacts: TranslationArtifact[] }>('translation-list'); setTranslationJobs(previous => sharePolledValue(previous, result.jobs)); setArtifacts(previous => sharePolledValue(previous, result.artifacts)); };
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(alert); void samples().then(setSampleFiles).catch(alert); void call<{ id: string }[]>('harness-list').then(setDrivers).catch(alert);
    if (desktop) { void call<{ snapshot: SettingsSnapshot }>('settings-read').then(data => setSettings(data.snapshot)).catch(alert); void call<{ routes: { selection: string; chat: string } }>('connections-read').then(data => { setSelectionProfile(data.routes.selection); setChatProfile(data.routes.chat); }).catch(() => {}); void call<{ babeldoc: { available: boolean }; libreoffice: { available: boolean } }>('engine-status').then(data => { setPdfEngineAvailable(data.babeldoc.available); setFullOfficeAvailable(data.libreoffice.available); }).catch(() => {}); void refreshTranslations().catch(alert); }
    const off = window.agentViewer?.onSettingsChanged(value => setSettings(value as SettingsSnapshot));
    const timer = setInterval(() => { void refresh().catch(() => {}); void refreshTranslations().catch(() => {}); if (desktop) void call<{ routes: { selection: string; chat: string } }>('connections-read').then(data => { setSelectionProfile(data.routes.selection); setChatProfile(data.routes.chat); }).catch(() => {}); }, 650);
    return () => { mounted.current = false; clearInterval(timer); off?.(); };
  }, []);
  useEffect(() => { const id = setInterval(() => { if (!desktop) return; void call<EventItem[]>('events', { after: eventSeq.current }).then(events => {
    for (const event of events) { eventSeq.current = Math.max(eventSeq.current, event.seq); if ((event.type === 'browser.input' || event.type === 'document.changed' || event.type === 'ai.reading') && event.data.actor === 'agent') setAgentEvent(event); if (event.type === 'agent.control' && event.data.viewId) setAgentStatuses(old => ({ ...old, [event.data.viewId!]: (event.data as { status: 'running' | 'paused' | 'stopped' }).status })); if (event.type === 'browser.translation' && event.data.viewId) setWebTranslated(old => ({ ...old, [event.data.viewId!]: true })); if (event.type === 'browser.translation-restored' && event.data.viewId) setWebTranslated(old => ({ ...old, [event.data.viewId!]: false })); }
  }).catch(() => {}); }, 300); return () => clearInterval(id); }, []);
  useEffect(() => { if (!agentEvent) return; const timer = setTimeout(() => setAgentEvent(current => current?.seq === agentEvent.seq ? undefined : current), 2600); return () => clearTimeout(timer); }, [agentEvent, agentStatuses]);
  useEffect(() => { for (const job of translationJobs) if (job.status === 'completed' && job.artifact && !autoOpenedJobs.current.has(job.id)) { autoOpenedJobs.current.add(job.id); if (val('translation.openArtifact', false)) void openUri(job.artifact.path); } }, [translationJobs, settings?.revision]);
  useEffect(() => { setAddress(document?.model.url ?? document?.path ?? document?.title ?? ''); setFixed(undefined); }, [view?.id, document?.model.url]);
  useEffect(() => setPdfTools(emptyPdfTools), [view?.id]);
  useEffect(() => { applyAppearance(settings); }, [settings?.revision]);
  useEffect(() => { if (settings?.values['general.startPage'] === 'home') newHomeTab(); }, [!!settings]);
  useEffect(() => { const configured = chatProfile ? 'provider' : String(val('ai.defaultDriver', 'none')); setDriver(drivers.some(item => item.id === configured) ? configured : ''); }, [settings?.revision, drivers, chatProfile]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 6000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const shortcut = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 's') { event.preventDefault(); void save(event.shiftKey); }
    else if (event.key.toLowerCase() === 't') { event.preventDefault(); void newHomeTab(true); }
    else if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openFile(); }
    else if (event.key.toLowerCase() === 'l') { event.preventDefault(); if (home) window.document.querySelector<HTMLInputElement>('.home-search-input')?.select(); else if (document?.format === 'web') { revealToolbar(); if (desktop) void call('toolbar-focus'); else window.document.querySelector<HTMLInputElement>('.address-input')?.select(); } else setModal('open'); }
    else if (event.key === ',') { event.preventDefault(); void openSettings(); }
  }; window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut); }, [document, view, home, homeTabId]);
  useEffect(() => {
    if (!view || document?.format === 'web' || !context?.selection.text || context.selection.kind !== 'text' || context.actor !== 'human' || !val('translation.selectionAuto', true) || alreadyTarget(context.selection.text, String(val('translation.targetLanguage', 'zh-CN'))) || (val('ai.defaultDriver', 'none') === 'none' && !selectionProfile)) return;
    const text = context.selection.text, viewId = view.id, revision = context.contentRevision, sequence = ++selectionSeq.current;
    const timer = setTimeout(() => { if (selectionSeq.current === sequence) void translateSelection(viewId, text, revision, context.selection.locator); }, Number(val('translation.selectionDelayMs', 500)));
    return () => clearTimeout(timer);
  }, [view?.id, context?.selection.text, context?.contentRevision, context?.actor, settings?.revision, selectionProfile]);
  useEffect(() => {
    // Seed the restored location once; real native source scroll events drive
    // the velocity/threshold reducer, never the workspace's 650ms polling.
    if (document?.format === 'web') navigation.onScroll(view?.context?.viewport?.scrollY ?? 0);
  }, [view?.id, document?.format, navigation.onScroll]);
  useEffect(() => {
    if (document?.format !== 'web') navigation.onScroll(window.document.querySelector<HTMLElement>('.document-content')?.scrollTop ?? 0);
  }, [view?.id, document?.format, navigation.onScroll]);
  useEffect(() => window.agentViewer?.onToolbar(event => {
    if (event.action === 'close-error') { alert(event.message); return; }
    if (event.action === 'files-opened') { void handleFilesOpened(event as unknown as { views: ViewInfo[]; errors: string[] }); return; }
    if (event.viewId !== view?.id) return;
    if (event.action === 'focus') navigation.onFocus();
    else if (event.action === 'blur') navigation.onBlur();
    else if (event.action === 'hover') navigation.onHover();
    else if (event.action === 'leave') navigation.onLeave();
    else if (event.action === 'reveal') navigation.revealFromEdge(Number(event.distanceToTop));
    else if (event.action === 'dismiss') navigation.dismiss();
    else if (event.action === 'focus-address-request') { navigation.reveal(); void call('toolbar-focus').catch(alert); }
    else if (event.action === 'scroll' && Number.isFinite(event.scrollY)) navigation.onScroll(Number(event.scrollY));
    else if (event.action === 'navigate') void navigationAction({ type: 'navigate', url: String(event.url ?? '') });
    else if (event.action === 'zoom') void navigationAction({ type: 'zoom', factor: Number(event.factor) });
    else if (event.action === 'zoom-updated') void refresh();
    else if (['back', 'forward', 'reload', 'copy', 'translate'].includes(String(event.action))) void navigationAction({ type: event.action as 'back' | 'forward' | 'reload' | 'copy' | 'translate' });
  }), [view?.id, view?.zoom, document?.format, home, homeTabId, webTranslated, webBusy, navigation.onFocus, navigation.onBlur, navigation.onHover, navigation.onLeave, navigation.reveal, navigation.revealFromEdge, navigation.dismiss, navigation.onScroll]);
  useEffect(() => {
    if (!desktop) return;
    if (home || modalMotion.present || document?.format !== 'web' || !view) { void call('toolbar-layout', { visible: false }); return; }
    const reader = window.document.querySelector('.reader-panel'); if (!reader) return;
    const update = () => { const box = reader.getBoundingClientRect(), width = Math.min(780, box.width - 28); void call('toolbar-layout', { viewId: view.id, visible: navigation.visible, manualHidden: navigation.manualHidden, hideProgress: navigation.progress, hideDurationMs: navigation.durationMs, address: document.model.url, translated: webTranslated[view.id], busy: webBusy, settings, zoom: view.zoom ?? 1, bounds: { x: box.x + (box.width - width) / 2, y: box.y + NAVIGATION_METRICS.top - NAVIGATION_METRICS.shadowGutter, width, height: NAVIGATION_METRICS.height + 2 * NAVIGATION_METRICS.shadowGutter } }).catch(alert); };
    const observer = new ResizeObserver(update); observer.observe(reader); update();
    return () => observer.disconnect();
  }, [home, modalMotion.present, view?.id, view?.zoom, document?.model.url, navigation.visible, navigation.manualHidden, navigation.progress, navigation.durationMs, settings, webBusy, webTranslated, leftOpen, drawer]);
  useEffect(() => {
    if (!desktop) return;
    const visible = !home && !modalMotion.present && document?.format === 'web' && !!view && !!agentEvent && (agentEvent.data.viewId === view.id || agentEvent.data.documentId === document.id);
    if (!visible || !view || !document) { const sameTarget = !home && !modalMotion.present && document?.format === 'web' && !!view; void call('agent-layout', { visible: false, viewId: sameTarget ? view.id : undefined, animate: sameTarget, hideDurationMs: motionDuration(200, undefined, false) }).catch(alert); return; }
    const reader = window.document.querySelector('.reader-panel'); if (!reader) return;
    const update = () => { const box = reader.getBoundingClientRect(), width = Math.min(AGENT_OPERATION_METRICS.maxSlotWidth, box.width - 2 * AGENT_OPERATION_METRICS.shadowGutter); void call('agent-layout', { viewId: view.id, visible: true, kind: agentEvent?.data.kind, status: agentStatuses[view.id] ?? 'running', target: val('agent.capsuleDetail', 'minimal') === 'target' ? document.title : undefined, settings, bounds: { x: box.x + (box.width - width) / 2, y: box.bottom - AGENT_OPERATION_METRICS.bottom - AGENT_OPERATION_METRICS.height - AGENT_OPERATION_METRICS.shadowGutter, width, height: AGENT_OPERATION_METRICS.height + 2 * AGENT_OPERATION_METRICS.shadowGutter } }).catch(alert); };
    const observer = new ResizeObserver(update); observer.observe(reader); update();
    return () => observer.disconnect();
  }, [home, modalMotion.present, view?.id, document?.id, document?.format, document?.title, agentEvent?.seq, agentStatuses, settings?.revision, leftOpen, drawer]);
  useEffect(() => { window.dispatchEvent(new Event('agentviewer:selection-clear')); }, [view?.id, home, document?.revision]);
  const refreshAnnotations = () => { if(document) void call<any[]>('annotations-list',{documentId:document.id}).then(setAnnotations).catch(alert); };
  useEffect(refreshAnnotations,[document?.id,drawer]);
  useEffect(()=>{
    const registry=(CSS as any).highlights, Highlight=(window as any).Highlight;if(!registry||!Highlight)return;
    registry.delete('reader-annotations'); const ranges:Range[]=[];
    const frame=window.document.querySelector<HTMLElement>('.document-content');if(!frame)return;
    for(const note of annotations){if(note.documentId!==document?.id||note.sourceRevision!==document?.revision||!note.selection.text)continue;
      const id=note.selection.locator?.blockId??note.selection.locator?.shapeId;const root=id?frame.querySelector<HTMLElement>('[data-block-id="'+CSS.escape(id)+'"]'):frame.querySelector<HTMLElement>('.prose');if(!root)continue;
      const walker=window.document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes:Text[]=[];let node:Node|null,text='';while(node=walker.nextNode()){nodes.push(node as Text);text+=node.textContent??'';}
      const from=note.selection.locator?.from??text.indexOf(note.selection.text);if(from<0||text.slice(from,from+note.selection.text.length)!==note.selection.text)continue;
      let offset=0,start=false;const range=window.document.createRange();for(const node of nodes){const end=offset+node.length;if(!start&&from<end){range.setStart(node,from-offset);start=true;}if(start&&from+note.selection.text.length<=end){range.setEnd(node,from+note.selection.text.length-offset);ranges.push(range);break;}offset=end;}
    }registry.set('reader-annotations',new Highlight(...ranges));return()=>registry.delete('reader-annotations');
  },[annotations,document?.revision,document?.id]);
  useEffect(() => {
    const result = (event: Event) => { const {action,result,snapshot}=(event as CustomEvent<any>).detail;
      if(result.receipt) { lastTransactions.current.set(result.receipt.documentId, result.receipt.transactionId);void refresh(); }
      if(result.view) void activate(result.view);
      if(result.annotation){refreshAnnotations();setToast(action==='note'?'批注已独立保存。':'高亮已保存在阅读器中。');}
      if(action==='translate' && snapshot.document.format!=='web') {setCards(old=>[...old.filter(c=>c.pinned||c.viewId!==snapshot.context.viewId),{id:crypto.randomUUID(),viewId:snapshot.context.viewId,source:snapshot.context.selection.text,result:result.text,sourceRevision:snapshot.document.revision,locator:snapshot.context.selection.locator,pinned:false,status:'ready'}]);setDrawer('translation');}
      if(action==='translate'&&snapshot.document.format==='web')setWebTranslated(old=>({...old,[snapshot.context.viewId]:true}));
      if(result.task)setDrawer('tasks');
      if(action==='copy'||action==='citation')setToast('已复制。');
    };window.addEventListener('agentviewer:selection-result',result);return()=>window.removeEventListener('agentviewer:selection-result',result);
  },[view?.id,document?.id,home,homeTabId]);
  useEffect(()=>window.agentViewer?.onSelectionTool(event=>{if(event.action==='result')window.dispatchEvent(new CustomEvent('agentviewer:selection-result',{detail:event.detail}));if(event.action==='dismiss')void call('selection-layout',{visible:false,animate:true});}),[]);
  const webSelection=view?.context?.selection;
  useEffect(()=>{
    if(!desktop)return;
    if(home||modal||closing||document?.format!=='web'||!view||!webSelection?.text||!webSelection.rect||view.context?.actor!=='human'){void call('selection-layout',{visible:false});return;}
    let disposed=false;
    void call<any>('selection-tools',{viewId:view.id}).then(selection=>{if(disposed)return;const reader=window.document.querySelector('.reader-panel')?.getBoundingClientRect();if(!reader)return;const r=webSelection.rect!,width=350;void call('selection-layout',{viewId:view.id,visible:true,selection,settings,bounds:{x:Math.max(reader.x,Math.min(reader.right-width,reader.x+r.x+r.width/2-width/2)),y:Math.max(reader.y,Math.min(reader.bottom-70,reader.y+r.y+r.height+8)),width,height:62}});}).catch(alert);
    return()=>{disposed=true;};
  },[home,modal,closing,view?.id,webSelection?.text,view?.context?.viewport?.navigationId]);
  useEffect(()=>{if(desktop&&document?.format==='web')void call('selection-layout',{visible:false});},[view?.context?.viewport?.scrollY]);
  useEffect(()=>{
    if(!modal&&!closing)return;
    const previous=window.document.activeElement as HTMLElement|null,dialog=window.document.querySelector<HTMLElement>('.modal-backdrop:not([inert]) .modal');dialog?.setAttribute('role','dialog');dialog?.setAttribute('aria-modal','true');dialog?.setAttribute('tabindex','-1');dialog?.querySelector<HTMLElement>('input,button')?.focus();
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){if(!closingBusy){setModal(null);setClosing(undefined);}event.preventDefault();}if(event.key==='Tab'&&dialog){const controls=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,[tabindex="0"]')];const first=controls[0],last=controls.at(-1);if(event.shiftKey&&window.document.activeElement===first){last?.focus();event.preventDefault();}else if(!event.shiftKey&&window.document.activeElement===last){first?.focus();event.preventDefault();}}};window.addEventListener('keydown',key);return()=>{window.removeEventListener('keydown',key);previous?.focus();};
  },[modal,closing,closingBusy]);
  function revealToolbar() { navigation.reveal(); }
  async function navigationAction(action: NavigationAction) {
    try {
      if (!document || !view) return;
      if (action.type === 'dismiss') navigation.dismiss();
      else if (action.type === 'back' || action.type === 'forward') await navigate(action.type);
      else if (action.type === 'reload') { if(document.format === 'web' && desktop) await call('browser-navigate', { viewId: view.id, action: 'reload' }); else await refresh(); }
      else if (action.type === 'navigate') {
        const url = normalizeWebAddress(action.url);
        if (!url) throw new Error('请输入有效的网址，例如 example.com 或 https://example.com。');
        if (desktop && document.format === 'web') await call('browser-navigate', { viewId: view.id, action: 'url', url });
        else await openUri(url);
      }
      else if (action.type === 'mode') { await call('mode', { viewId: view.id, mode: action.mode }); await refresh(); }
      else if (action.type === 'zoom') { await call('zoom', { viewId: view.id, factor: action.factor }); await refresh(); }
      else if (action.type === 'undo') {
        await flushDrafts(view.id);
        const documentId = view.documentId;
        const pending = editQueue.current.catch(() => {}).then(async () => { const transactionId = lastTransactions.current.get(documentId); if (!transactionId) return; await call('undo', { transactionId }); lastTransactions.current.delete(documentId); await refresh(); });
        editQueue.current = pending; await pending;
      }
      else if (action.type === 'save' || action.type === 'copy') await save();
      else if (action.type === 'translate' && !webBusy) { if(webTranslated[view.id]) await webRestore(); else await webTranslate('page'); }
    } catch(error) { alert(error); }
  }
  async function openSettings(category?: string) { if (!desktop) return setToast('设置窗口仅在桌面应用中提供。'); try { await call('settings-open', { category }); } catch (e) { alert(e); } }
  async function activate(next: ViewInfo, record = true, replaceHome = false, requestHomeId?: string) {
    await flushDrafts();
    const origin = requestHomeId ?? (replaceHome ? foreground.current.homeId : undefined);
    const stillForeground = !requestHomeId || foreground.current.homeId === requestHomeId;
    if (origin) {
      homeTabsRef.current = homeTabsRef.current.filter(id => id !== origin); setHomeTabs(homeTabsRef.current);
      setHomeQueries(previous => { const remaining = { ...previous }; delete remaining[origin]; return remaining; });
      setTabOrder(order => replaceHomeTabSlot(order, origin, next.id));
    }
    // A completed background open replaces its own home slot, never the tab
    // the user switched to. Closing the origin leaves a reachable result tab.
    if (!stillForeground) { await refresh(); return; }
    const previousView = foreground.current.viewId;
    if (previousView && previousView !== next.id && record) { history.current.push(previousView); future.current = []; }
    foreground.current = { viewId: next.id };
    setHomeTabId(undefined); setHome(false); setActiveId(next.id); setFixed(undefined);
    await call('activate', { viewId: next.id }); await refresh();
  }
  async function openUri(uri: string) { try { await flushDrafts(); const next = await call<ViewInfo>('open', { uri, windowId }); await activate(next, true, true); setModal(null); } catch (e) { alert(e); } }
  async function openHomeUri(uri: string) {
    const normalized = uri.replaceAll('\\', '/').toLowerCase();
    const existing = homeCandidates.find(candidate => candidate.documentId && candidate.path?.replaceAll('\\', '/').toLowerCase() === normalized);
    return runHomeOpen(() => existing?.documentId ? call<ViewInfo>('document-open-view', { documentId: existing.documentId, windowId, activate: false }) : call<ViewInfo>('open', { uri, windowId, activate: false }));
  }
  async function openHomeCandidate(candidate: HomeSearchCandidate) {
    if (candidate.documentId) await openHomeDocument(candidate.documentId);
    else if (candidate.path) await openHomeUri(candidate.path);
  }
  async function openHomeDocument(documentId: string) {
    return runHomeOpen(() => call<ViewInfo>('document-open-view', { documentId, windowId, activate: false }));
  }
  async function runHomeOpen(load: () => Promise<ViewInfo>) {
    const origin = foreground.current.homeId;
    if (!origin || homeRequests.current.has(origin)) return;
    homeRequests.current.add(origin); setPendingHomes(previous => ({ ...previous, [origin]: true }));
    try { await flushDrafts(); const next = await load(); await activate(next, true, true, origin); }
    finally { homeRequests.current.delete(origin); setPendingHomes(previous => { const remaining = { ...previous }; delete remaining[origin]; return remaining; }); }
  }
  async function openFile() { if (desktop) { try { await flushDrafts(); const next = await call<ViewInfo | null>('choose-file', { windowId }); if (next) await activate(next, true, true); } catch (e) { alert(e); } } else setModal('open'); }
  async function handleFilesOpened(result: { views: ViewInfo[]; errors: string[] }) {
    await refresh();
    for (let index = 0; index < result.views.length; index++) await activate(result.views[index], true, index === 0);
    if (result.errors.length) setToast(result.errors.join('；'));
    else if (result.views.length > 1) setToast('已打开 ' + result.views.length + ' 个文档');
  }
  async function save(as = false) { if (!document) return; try { await flushDrafts(view?.id); if (document.format === 'web') { const copy = await call<ViewInfo>('browser-copy', { viewId: view!.id }); await activate(copy); setToast('已建立本地阅读副本。'); return; } if (desktop && (!document.path || as)) { if (!await call('choose-save', { documentId: document.id })) return; } else if (!document.path || as) { setModal('save'); return; } else await call('save', { documentId: document.id }); await refresh(); setToast('文件已保存。'); } catch (e) { alert(e); } }
  async function openFullOfficeEditor() { if (!view) return; try { await flushDrafts(view.id); await call('office-open-full-editor', { viewId: view.id }); setToast('已打开完整编辑器；保存后可从磁盘重新载入。'); } catch (e) { alert(e); } }
  async function reloadOffice() { if (!view) return; try { await flushDrafts(view.id); await call('office-reload-from-disk', { viewId: view.id }); lastTransactions.current.delete(view.documentId); await refresh(); setToast('已从磁盘重新载入。'); } catch (e) { alert(e); } }
  async function edit(operation: EditOperation) {
    if (!document) return; const id = document.id;
    if (['word.insertParagraph', 'word.deleteParagraph', 'word.insertTable', 'slides.addSlide', 'slides.deleteSlide', 'slides.duplicateSlide', 'slides.moveSlide', 'slides.deleteShape', 'sheets.addWorksheet', 'sheets.deleteWorksheet', 'sheets.insertRows', 'sheets.deleteRows', 'sheets.insertColumns', 'sheets.deleteColumns', 'sheets.mergeCells', 'sheets.unmergeCells', 'sheets.sortRange'].includes(operation.kind)) await flushDrafts(view?.id);
    const pending = editQueue.current.catch(() => {}).then(async () => { const current = stateRef.current.documents.find(d => d.id === id)!; const patch = await call<PreparedPatch>('prepare', { documentId: id, expectedRevision: current.revision, operation }); const receipt = await call<Receipt>('commit', { patchId: patch.id, idempotencyKey: crypto.randomUUID() }); lastTransactions.current.set(receipt.documentId, receipt.transactionId); await refresh(); });
    editQueue.current = pending; void pending.catch(alert); return pending;
  }
  function editText(text: string) {
    if (!document) return; const id = document.id; setDrafts(old => ({ ...old, [id]: text }));
    editQueue.current = editQueue.current.catch(() => {}).then(async () => { const current = stateRef.current.documents.find(d => d.id === id); if (!current) return; const old = current.model.text ?? ''; const patch = await call<PreparedPatch>('prepare', { documentId: id, expectedRevision: current.revision, operation: { kind: 'text.replace', from: 0, to: old.length, expectedText: old, text } }); const receipt = await call<Receipt>('commit', { patchId: patch.id, idempotencyKey: crypto.randomUUID() }); lastTransactions.current.set(receipt.documentId, receipt.transactionId); await refresh(); setDrafts(d => { if (d[id] !== text) return d; const next = { ...d }; delete next[id]; return next; }); }).catch(error => { alert(error); throw error; });
    void editQueue.current.catch(() => {});
  }
  async function performClose(target: ViewInfo) { try { await flushDrafts(target.id); await call('close', { viewId: target.id, retainRecovery: true }); setTabOrder(order => order.filter(id => id !== target.id)); if (activeId === target.id) setActiveId(undefined); setClosing(undefined); await refresh(); } catch(e) { alert(e); } }
  async function closeTab(target: ViewInfo) { try { await flushDrafts(target.id); const d = stateRef.current.documents.find(item => item.id === target.documentId); if(d?.dirty) setClosing(target); else await performClose(target); } catch (error) { alert(error); } }
  async function saveAndClose() { if(!closing)return;setClosingBusy(true);try{await flushDrafts(closing.id); const doc=stateRef.current.documents.find(d=>d.id===closing.documentId)!;if(desktop){if(!await call('choose-save',{documentId:doc.id}))return;}else{if(!doc.path)throw new Error('请先另存文档。');await call('save',{documentId:doc.id});}await performClose(closing);}catch(e){alert(e);}finally{setClosingBusy(false);} }
  async function navigate(direction: 'back' | 'forward') { if (document?.format === 'web' && desktop) { await call('browser-navigate', { viewId: view!.id, action: direction }); return; } const source = direction === 'back' ? history : future, dest = direction === 'back' ? future : history; const id = source.current.pop(); const next = workspace.views.find(v => v.id === id); if (next) { if (view) dest.current.push(view.id); await activate(next, false); } }
  async function send(message = prompt) { if (!message.trim() || !view) return; try { await flushDrafts(view.id); if (!driver) { setToast('请先在设置中选择 Harness。'); void openSettings('模型与连接'); return; } await call('harness-submit', { driverId: driver, prompt: message.trim(), viewId: view.id, snapshotId: fixed?.context.viewId === view.id ? fixed.id : undefined, sourceScope: context?.selection.text ? 'selection' : 'visible' }); setPrompt(''); setDrawer('tasks'); await refresh(); } catch (e) { alert(e); } }
  async function runAIReadingTool(tool: AIReadingToolDefinition, scope: AIReadingScope) {
    if (!view || aiPending || scope === 'document') return;
    const targetView = view.id, sourceTitle = document?.title ?? '当前文档';
    setAIPending(true);
    try {
      await flushDrafts(targetView);
      const source = fixed?.context.viewId === targetView ? fixed : await call<ReadingSnapshot>('snapshot', { viewId: targetView });
      const result = await call<{ task: HarnessTask }>('ai-reading-run', { viewId: targetView, snapshotId: source.id, toolId: tool.id, scope, idempotencyKey: crypto.randomUUID() });
      setAIResult({ taskId: result.task.id, label: tool.label, source: sourceTitle + ' · ' + (scope === 'selection' ? '选中内容' : '当前可见') + ' · 版本 ' + source.document.revision, viewId: targetView });
      setDrawer(null); await refresh();
    } catch (error) { throw error; }
    finally { setAIPending(false); }
  }
  async function saveAIResult(task: HarnessTask) {
    try { const next = await call<ViewInfo>('create-text', { title: (aiResult?.label ?? 'AI 分析') + '.md', text: task.text, windowId }); await activate(next, true); setAIResult(undefined); }
    catch (error) { alert(error); }
  }
  async function fixContext() { if (!view) return; try { await flushDrafts(view.id); setFixed(await call<ReadingSnapshot>('snapshot', { viewId: view.id })); } catch (error) { alert(error); } }
  async function translateSelection(viewId: string, text: string, sourceRevision: number, locator?: Card['locator']) {
    const card: Card = { id: crypto.randomUUID(), viewId, source: text, result: '', sourceRevision, locator, pinned: false, status: 'loading' };
    setCards(old => [...old.filter(item => item.pinned || item.viewId !== viewId), card]); if (val('translation.selectionPresentation', 'popover') === 'drawer') setDrawer('translation');
    try { const result = await call<{ text: string }>('translation-selection', { viewId, text, sourceRevision, targetLanguage: val('translation.targetLanguage', 'zh-CN') }); setCards(old => old.map(item => item.id === card.id ? { ...item, result: result.text, status: 'ready' } : item)); }
    catch (e) { setCards(old => old.map(item => item.id === card.id ? { ...item, error: String(e), status: 'error' } : item)); }
  }
  async function fullTranslation() { if (!document) return; try { await flushDrafts(view?.id); const job = await call<TranslationJob>('translation-start', { documentId: document.id, windowId }); setTranslationJobs(old => [...old.filter(item => item.id !== job.id), job]); setDrawer('tasks'); setToast('已在后台生成独立译文。'); } catch (e) { alert(e); } }
  async function webTranslate(scope: 'page' | 'selection') { if (!view) return; setWebBusy(true); try { const result = await call<{ translated: number; skipped: number }>('web-translation-apply', { viewId: view.id, scope }); setWebTranslated(old => ({ ...old, [view.id]: true })); setToast('已在当前网页替换 ' + result.translated + ' 处文字；跳过 ' + result.skipped + ' 处。'); } catch (e) { alert(e); } finally { setWebBusy(false); } }
  async function webRestore() { if (!view) return; try { const result = await call<{ restored: number; skipped: number }>('web-translation-restore', { viewId: view.id }); setWebTranslated(old => ({ ...old, [view.id]: false })); setToast('恢复 ' + result.restored + ' 处原文；' + result.skipped + ' 处因页面更新而保留。'); } catch (e) { alert(e); } }
  async function controlAgent(status: 'running' | 'paused' | 'stopped') { if (!view) return; try { await call('agent-control', { viewId: view.id, status }); setAgentStatuses(old => ({ ...old, [view.id]: status })); if (status === 'stopped') setToast('已停止此页面的 Agent 操作。'); } catch (e) { alert(e); } }
  const outline = document?.format === 'markdown' ? (document.model.text ?? '').split('\n').filter(t => /^#{1,6} /.test(t)).map(t => t.replace(/^#+ /, '')) : document?.format === 'docx' ? document.model.blocks?.filter(b => b.style?.startsWith('Heading')).map(b => b.text) ?? [] : document?.model.slides?.map((slide, index) => '第 ' + (index + 1) + ' 页 · ' + (slide.blocks[0]?.text ?? '')) ?? document?.model.sheets?.map(sheet => sheet.name) ?? document?.format === 'pdf' ? Array.from({ length: document.model.pageCount ?? 0 }, (_, index) => '第 ' + (index + 1) + ' 页') : [];
  const task = workspace.tasks.at(-1), currentCards = cards.filter(card => card.viewId === view?.id), newestCard = currentCards.at(-1), activeJob = translationJobs.find(job => job.status === 'running');
  const readingTask = aiResult ? workspace.tasks.find(item => item.id === aiResult.taskId) : undefined;
  const showingAIResult = !!readingTask && aiResult?.viewId === view?.id;
  useEffect(() => window.agentViewer?.onToolbar(event => {
    if (event.action === 'ai-result-dismiss') setAIResult(previous => previous?.taskId === event.taskId ? undefined : previous);
    if (event.action === 'ai-result-save' && aiResult?.taskId === event.taskId) {
      const result = workspace.tasks.find(item => item.id === event.taskId); if (result) void saveAIResult(result);
    }
  }), [aiResult, workspace.tasks]);
  useEffect(() => {
    if (!desktop) return;
    if (home || modalMotion.present || drawer || document?.format !== 'web' || !view || !readingTask || aiResult?.viewId !== view.id) {
      const animate = !home && !modalMotion.present && document?.format === 'web' && !!view;
      void call('ai-result-layout', { visible: false, animate, viewId: animate ? view.id : undefined }).catch(alert); return;
    }
    const reader = window.document.querySelector('.reader-panel'); if (!reader) return;
    const update = () => {
      const box = reader.getBoundingClientRect(), width = Math.min(402, box.width - 24), height = Math.min(362, box.height - 24);
      void call('ai-result-layout', { viewId: view.id, taskId: readingTask.id, visible: true, label: aiResult.label, source: aiResult.source, settings,
        bounds: { x: Math.max(box.x + 12, box.right - width - 12), y: Math.min(box.y + 78, box.bottom - height - 12), width, height } }).catch(alert);
    };
    const observer = new ResizeObserver(update); observer.observe(reader); window.addEventListener('resize', update); update();
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [home, modalMotion.present, drawer, document?.format, view?.id, readingTask?.id, readingTask?.text, readingTask?.status, aiResult, settings?.revision, leftOpen]);
  const openSample = (path: string) => { void openHomeUri(path).catch(alert); };
  const openWebFixture = () => { const existing = viewList.find(v => workspace.documents.find(d => d.id === v.documentId)?.format === 'web'); void (existing ? openHomeDocument(existing.documentId) : openHomeUri(new URL('/fixtures/interaction.html', window.location.href).href)).catch(alert); };
  const locationText = context?.locator.pageIndex !== undefined ? '第 ' + (context.locator.pageIndex + 1) + ' 页' : context?.locator.cell ?? context?.locator.quote?.slice(0, 52) ?? '正在确认阅读位置';
  const pdfCommand = (action: 'note' | 'highlight' | 'rotate' | 'add-page' | 'ocr' | 'clear-ocr', text?: string) => {
    if (!view || document?.format !== 'pdf') return;
    window.dispatchEvent(new CustomEvent('agentviewer:pdf-tool', { detail: { viewId: view.id, action, text } }));
  };
  const openReference = (event: React.MouseEvent) => { const anchor=(event.target as HTMLElement).closest<HTMLAnchorElement>('a'); if(!anchor?.href.startsWith('agentviewer://document/'))return;event.preventDefault();const url=new URL(anchor.href);void call<ViewInfo>('document-open-view',{documentId:url.pathname.slice(1),windowId}).then(next=>activate(next)).catch(alert); };
  return <div onClickCapture={openReference} className={'app-shell ' + (home ? 'show-home' : '')}>
    <header className="tab-strip"><div className="brand brand-static" aria-label="AgentViewer"><span className="brand-mark"><img src={logoMark} alt="AgentViewer" /></span></div><div className="tabs">{tabOrder.map(id => { if (homeTabs.includes(id)) return <div className={'tab ' + (home && homeTabId === id ? 'active' : '')} key={id} data-home-tab-id={id}><button className="tab-select" onClick={() => void switchHomeTab(id)}><FilePlus2 size={17} /><span>新标签页</span></button><button className="icon-button tab-close" aria-label="关闭 新标签页" onClick={() => closeHomeTab(id)}><X size={14}/></button></div>; const v = viewList.find(v => v.id === id); if (!v) return null; const d = workspace.documents.find(item => item.id === v.documentId)!; return <div className={'tab ' + (!home && v.id === view?.id ? 'active' : '')} key={v.id} data-view-id={v.id}><button className="tab-select" onClick={() => void activate(v)}><FileIcon format={d.format} /><span>{d.title}</span>{(d.dirty || officeDraftDirty[v.id]) && <span className="dirty-dot" />}</button><button className="icon-button tab-close" aria-label={'关闭 ' + d.title} onClick={() => void closeTab(v)}><X size={14} /></button></div>; })}<button className="icon-button new-tab" aria-label="新建标签页" title="新建标签页 · Ctrl+T" onClick={() => void newHomeTab()}><Plus size={18} /></button></div><div className="top-utility"><button className="icon-button" title="设置" onClick={() => void openSettings()}><Settings2 size={17} /></button></div><div className="window-controls">{desktop && <><button onClick={() => void call('window-control', { action: 'minimize' })} aria-label="最小化"><Minus size={16} /></button><button onClick={() => void call('window-control', { action: 'maximize' })} aria-label="最大化"><Square size={13} /></button><button onClick={() => void call('window-control', { action: 'close' })} aria-label="关闭窗口"><X size={17} /></button></>}</div></header>
    {home ? <div className="home-layout"><aside className="home-sidebar material-host"><LiquidGlassSurface variant="panel" /><div className="home-sidebar-head"><span>资源管理器</span></div><div className="home-tree"><div className="tree-caption"><ChevronDown size={14} /> 最近打开</div>{workspace.documents.map(d => <button key={d.id} className="file-row" onClick={() => void openHomeDocument(d.id).catch(alert)}><FileIcon format={d.format} /><span>{d.title}</span></button>)}<div className="tree-caption"><ChevronDown size={14} /> 示例文件</div>{sampleFiles.map(f => <button className="file-row" key={f.path} onClick={() => openSample(f.path)}><FileIcon format={f.format} /><span>{f.name}</span></button>)}<button className="file-row" onClick={openWebFixture}><Globe size={17} /><span>交互测试页</span></button>{artifacts.length > 0 && <><div className="tree-caption"><ChevronDown size={14} /> 生成的译文</div>{artifacts.map(a => <button className="file-row" key={a.id} onClick={() => void openHomeUri(a.path).catch(alert)}><Languages size={17} /><span>{a.path.split(/[\\/]/).at(-1)}</span></button>)}</>}</div></aside><main className="home-main"><div className="home-hero"><div className="home-kicker">YOUR READING WORKSPACE</div><h1>从这里继续阅读。</h1><p>打开文档、网页或最近的工作，把当前阅读位置直接交给 AI。</p><HomeSearch key={homeTabId} pending={!!pendingHomes[homeTabId ?? ""]} query={homeQueries[homeTabId ?? ""] ?? ""} onQueryChange={query => { if (homeTabId) setHomeQueries(previous => ({ ...previous, [homeTabId]: query })); }} candidates={homeCandidates} onOpenUri={openHomeUri} onOpenCandidate={openHomeCandidate} /><div className="home-actions"><button className="button primary" onClick={() => void openFile()}><FolderOpen size={17} />打开文件</button><button className="button" onClick={() => setModal('new')}><FilePlus2 size={17} />新建文档</button></div></div><div className="home-columns"><section><div className="home-section-title"><h2>继续阅读</h2><span>{viewList.length} 个标签</span></div><div className="recent-grid">{viewList.slice(-6).reverse().map(v => { const d = workspace.documents.find(item => item.id === v.documentId)!; return <button key={v.id} className="recent-card material-host" onClick={() => void openHomeDocument(v.documentId).catch(alert)}><LiquidGlassSurface variant="button" /><span className="recent-icon"><FileIcon format={d.format} /></span><strong>{d.title}</strong><small>{tone(d.format)} · {v.context?.locator.quote?.slice(0, 28) ?? '打开文档'}</small><ChevronRight size={16} /></button>; })}</div></section><section><div className="home-section-title"><h2>生成文档</h2><span>{artifacts.length} 个译文</span></div><p className="home-muted">文档全文翻译会在后台生成独立文件，原文保持原样。</p>{artifacts.slice(-3).reverse().map(a => <button className="artifact-row" key={a.id} onClick={() => void openHomeUri(a.path).catch(alert)}><Languages size={18} /><span>{a.sourceTitle} → {a.targetLanguage}</span><ChevronRight size={15} /></button>)}</section></div></main></div> :
    <div className="workbench motion-layout" style={{ gridTemplateColumns: `${document?.format === 'web' ? 0 : 52}px ${document?.format === 'web' ? 0 : 9}px ${document?.format !== 'web' && leftOpen ? val('appearance.leftWidth', 248) : 0}px ${document?.format !== 'web' && leftOpen ? 9 : 0}px minmax(0,1fr) ${drawer ? 9 : 0}px ${drawer ? val('appearance.rightWidth', 380) : 0}px 9px 52px`, transition: animateLayout ? `grid-template-columns ${Math.max(leftMotion.duration, rightMotion.duration)}ms var(--ease-drawer)` : 'none' }}>
      {document?.format !== 'web' && <nav className="activity-rail material-host" aria-label="文档工具"><LiquidGlassSurface variant="panel" /><button className={leftSection === 'outline' && leftOpen ? 'selected' : ''} aria-label="目录与结构" aria-pressed={leftSection === 'outline' && leftOpen} title="目录与结构" onClick={() => { setLeftOpen(leftSection === 'outline' ? !leftOpen : true); setLeftSection('outline'); }}><ListTree size={21} /></button><button className={leftSection === 'search' && leftOpen ? 'selected' : ''} aria-label="查找" aria-pressed={leftSection === 'search' && leftOpen} title="查找" onClick={() => { setLeftOpen(leftSection === 'search' ? !leftOpen : true); setLeftSection('search'); }}><Search size={20} /></button><button className={leftSection === 'tools' && leftOpen ? 'selected' : ''} aria-label={tone(document?.format) + '工具'} aria-pressed={leftSection === 'tools' && leftOpen} title={tone(document?.format) + '工具'} onClick={() => { setLeftOpen(leftSection === 'tools' ? !leftOpen : true); setLeftSection('tools'); }}><FormatToolIcon format={document?.format} /></button></nav>}
      <MotionPresence show={!home && leftOpen && document?.format !== 'web'} surface="left" duration={220} identity={motionIdentity}>{leftOpen && document?.format !== 'web' && <aside className="format-sidebar material-host" id="format-tools"><LiquidGlassSurface variant="panel" /><div className="format-heading"><span>{tone(document?.format)}工具</span></div>
      {leftSection === 'outline' ? <div className="format-scroll motion-swap" key={leftSection}><div className="side-label">当前位置</div><div className="location-chip"><span className="connection-dot ready" />{locationText}</div><div className="side-label">结构导航</div>{outline.map((item, index) => <button className="outline-item" key={index} onClick={() => { if (document?.format === 'markdown') scrollReadingTarget(window.document.querySelectorAll<HTMLElement>('.document-content h1,.document-content h2,.document-content h3,.document-content h4')[index]); else if (document?.format === 'pdf') scrollReadingTarget(window.document.querySelectorAll<HTMLElement>('.pdf-page')[index]); else window.dispatchEvent(new CustomEvent('agentviewer:navigate-structure', { detail: { index } })); }}>{item}</button>)}{!outline.length && <p className="side-hint">当前文档暂无可用大纲。</p>}</div> : leftSection === 'search' ? <div className="format-scroll motion-swap" key={leftSection}><label className="search-field material-host"><LiquidGlassSurface variant="search" /><Search size={16} /><input placeholder="查找当前文档" onKeyDown={e => { if (e.key === 'Enter' && document) void call<{ results: unknown[] }>('search', { documentId: document.id, query: e.currentTarget.value }).then(result => setToast('找到 ' + result.results.length + ' 处；当前引擎提供文本定位结果。')).catch(alert); }} /></label><p className="side-hint">按 Enter 搜索。源文件中的查找范围由格式引擎决定。</p></div> : <div className="format-scroll motion-swap" key={leftSection}><div className="side-label">阅读与编辑</div>{['markdown','html'].includes(document?.format ?? '') && <p className="side-hint">源码与分栏模式可在顶部操作胶囊中切换。</p>}{document?.format === 'pdf' && <div className="pdf-side-tools"><p className="side-hint">选中文字后，在浮窗中高亮、标记或添加批注。</p><button className="tool-row" onClick={() => pdfCommand('rotate')}>旋转当前页</button><button className="tool-row" onClick={() => pdfCommand('add-page')}>增加页面</button><div className="side-label">扫描文字</div><button className="tool-row" disabled={pdfTools.ocrBusy} onClick={() => pdfCommand('ocr')}>{pdfTools.ocrBusy ? '识别中…' : '识别本页'}</button>{pdfTools.ocrResult && <section className="pdf-side-result" aria-live="polite"><div><strong>第 {pdfTools.ocrResult.pageIndex + 1} 页 · {pdfTools.ocrResult.confidence}%</strong><button onClick={() => pdfCommand('clear-ocr')}>关闭</button></div><p>{pdfTools.ocrResult.text || '未识别出文字。'}</p></section>}<p className="side-hint">扫描文字仅显示在工具栏，不写入原 PDF。</p></div>}{document && view && ['docx','pptx','xlsx'].includes(document.format) && <OfficeTools document={document} viewId={view.id} target={officeTarget} edit={edit} openFullEditor={openFullOfficeEditor} reload={reloadOffice} fullEditorAvailable={desktop && fullOfficeAvailable} />}<div className="side-label">视图</div><button className="tool-row" disabled={!view} onClick={() => { if (view) void call<ViewInfo>('duplicate-view', { viewId: view.id }).then(activate).catch(alert); }}><Copy size={15} /> 复制视图</button><button className="tool-row" disabled={!desktop || !view} onClick={() => void call('new-window', { viewId: view?.id }).catch(alert)}><ExternalLink size={15} /> 新窗口</button></div>}</aside>}</MotionPresence>
      <main className={"reader-panel reader-format-" + (document?.format ?? "none")} onMouseMove={event => navigation.revealFromEdge(event.clientY - event.currentTarget.getBoundingClientRect().top)}>
        {document && (document.format !== 'web' || !desktop) && <NavigationToolbar key={'navigation:' + view?.id}
          state={{ format: document.format, zoom: view?.zoom ?? 1, title: document.title, titleIcon: <FileIcon format={document.format} />, address: document.model.url, mode: view?.mode, canUndo: lastTransactions.current.has(document.id), busy: webBusy, translated: view ? webTranslated[view.id] : false }}
          dispatch={action => void navigationAction(action)} progress={navigation.progress} durationMs={navigation.durationMs} manualHidden={navigation.manualHidden}
          onHover={navigation.onHover} onLeave={navigation.onLeave} onFocus={navigation.onFocus} onBlur={navigation.onBlur} />}
      {document && view ? <DocumentPane key={view.id} document={document} view={view} edit={edit} onTextChange={editText} reportError={alert} onPdfToolsChange={setPdfTools} onOfficeTargetChange={setOfficeTarget} onOfficeDraftController={onOfficeDraftController} onOfficeDraftChange={onOfficeDraftChange} onReaderScroll={onReaderScroll} onZoomChange={factor => void navigationAction({ type: 'zoom', factor })} obscured={modalMotion.present} annotations={annotations} /> : <div className="empty-workspace"><BookOpen size={40} /><h1>打开文档，开始阅读</h1><button className="button primary" onClick={() => void openFile()}>打开文件</button></div>}
      <MotionPresence show={!!agentEvent && (agentEvent.data.viewId === view?.id || agentEvent.data.documentId === document?.id) && document?.format !== 'web'} surface="agent" duration={200} identity={view?.id} keyboardImmediate={false}>{agentEvent && <AgentOperationCapsule kind={agentEvent.data.kind} status={agentStatuses[view!.id] ?? 'running'} target={val('agent.capsuleDetail', 'minimal') === 'target' ? document?.title : undefined} onControl={status => void controlAgent(status)} />}</MotionPresence>
      {agentEvent && (agentEvent.data.viewId === view?.id || agentEvent.data.documentId === document?.id) && <>{val('agent.pointer', true) && agentEvent.data.point && document?.format !== 'web' && <div className="agent-pointer" style={{ left: agentEvent.data.point.x, top: agentEvent.data.point.y + 72 }}><Sparkles size={18} /></div>}{agentEvent.data.target && <AgentTargetHighlight event={agentEvent} />}</>}
      {document && document.warnings.length > 0 && <div className="engine-notice" title={[...document.warnings, ...document.capabilities.limitations].join('\n')}>{document.warnings[0]}</div>}</main>
      <MotionPresence show={!!drawer} surface="right" duration={220} identity={motionIdentity}>{drawer && <aside className="ai-drawer material-host" id="ai-tools"><LiquidGlassSurface variant="panel" /><div className="drawer-heading"><div><span className="eyebrow">ASSISTANT</span><h2>{drawer === 'annotations' ? '批注与高亮' : drawer === 'translation' ? '选区译文' : drawer === 'tasks' ? '后台任务' : 'AI 工具'}</h2></div><button className="icon-button" aria-label="关闭 AI 抽屉" onClick={() => setDrawer(null)}><X size={17} /></button></div><div className="drawer-content motion-swap" key={drawer}>{drawer === 'annotations' ? <>{annotations.length===0&&<p className="side-hint">选中文字后添加批注或高亮。</p>}{annotations.map(note=><div className="job-card" key={note.id}><strong>{note.kind==='note'?'批注':'高亮'}{note.sourceRevision!==document?.revision?' · 来源已更新':''}</strong><blockquote>{note.selection.text}</blockquote>{note.text&&<p>{note.text}</p>}<button onClick={()=>void call('annotation-remove',{id:note.id}).then(refreshAnnotations).catch(alert)}>删除</button></div>)}</> : drawer === 'translation' ? currentCards.map(card => <TranslationCard key={card.id} card={card} onPin={() => setCards(old => old.map(item => item.id === card.id ? { ...item, pinned: !item.pinned } : item))} onRetry={() => void translateSelection(card.viewId, card.source, card.sourceRevision, card.locator)} />) : drawer === 'tasks' ? <><div className="side-label">文档译文</div>{translationJobs.slice().reverse().map(job => <div className="job-card" key={job.id}><strong>{job.stage}</strong><span>{job.status === 'running' ? (job.total ? job.completed + ' / ' + job.total : '准备中') : job.status}</span>{job.error && <p>{job.error}</p>}{job.artifact && <button onClick={() => void openUri(job.artifact!.path)}>打开译文 <ExternalLink size={13} /></button>}{job.status === 'running' && <button onClick={() => void call('translation-cancel', { jobId: job.id }).catch(alert)}>取消</button>}{['paused','failed','cancelled'].includes(job.status) && <button onClick={() => void call('translation-resume', { jobId: job.id }).then(refreshTranslations).catch(alert)}>继续</button>}</div>)}<div className="side-label">Harness</div>{task ? <div className="job-card"><strong>{task.prompt}</strong><span>{task.status}</span><pre>{task.text || task.error || '等待回复…'}</pre>{task.status === 'running' && <button onClick={() => void call('harness-cancel', { taskId: task.id }).catch(alert)}>停止</button>}</div> : <p className="side-hint">暂无任务。</p>}</> : <><div className="tool-grid"><button onClick={() => { if (document?.format === 'web') void webTranslate('selection'); else if (view && context?.selection.text) void translateSelection(view.id, context.selection.text, context.contentRevision, context.selection.locator); else setToast('请先选择文档文字。'); }}><Languages size={19} />翻译选区</button><button title={document?.format === 'pdf' && !pdfEngineAvailable ? '需要 BabelDOC 引擎' : undefined} onClick={() => void fullTranslation()} disabled={!document || document.format === 'web' || (document.format === 'pdf' && !pdfEngineAvailable)}><FilePlus2 size={19} />生成全文译文</button><button onClick={() => void fixContext()}><Pin size={19} />固定上下文</button></div><AIReadingTools context={context} snapshot={fixed?.context.viewId === view?.id ? fixed : undefined} format={document?.format} busy={aiPending} onRun={runAIReadingTool} /><div className="side-label">当前阅读位置</div><div className="context-summary"><Check size={15} /> {locationText}</div>{context?.selection.text && <><div className="side-label">已选中</div><blockquote className="selection-preview">{context.selection.text}</blockquote></>}<div className="side-label">Harness</div><div className="harness-line"><span className={'connection-dot ' + (driver ? 'ready' : '')} />{driver ? driver + ' · 已连接' : <button className="ai-connect-entry" onClick={() => void openSettings('模型与连接')}>连接模型</button>}</div></>}</div>{drawer === 'ai' && <form className="prompt-box" onSubmit={e => { e.preventDefault(); void send(); }}><textarea placeholder="基于当前选区或阅读位置提问…" value={prompt} onChange={e => setPrompt(e.target.value)} /><button className="button primary" disabled={!prompt.trim()}><Send size={15} />发送</button></form>}</aside>}</MotionPresence>
      <nav className="ai-rail material-host"><LiquidGlassSurface variant="panel" /><button onMouseDown={event => event.preventDefault()} aria-expanded={drawer === 'annotations'} aria-controls="ai-tools" className={drawer === 'annotations' ? 'selected' : ''} title="批注与高亮" aria-label="批注与高亮" onClick={() => setDrawer(drawer === 'annotations' ? null : 'annotations')}><MessageSquare size={20}/></button><button onMouseDown={event => event.preventDefault()} aria-expanded={drawer === 'ai'} aria-controls="ai-tools" className={drawer === 'ai' ? 'selected' : ''} title="AI 工具" onClick={() => setDrawer(drawer === 'ai' ? null : 'ai')}><Sparkles size={20} /></button><button onMouseDown={event => event.preventDefault()} aria-expanded={drawer === 'translation'} aria-controls="ai-tools" className={drawer === 'translation' ? 'selected' : ''} title="选区译文" onClick={() => setDrawer(drawer === 'translation' ? null : 'translation')}><Languages size={20} />{newestCard && <span className="rail-dot" />}</button><button onMouseDown={event => event.preventDefault()} aria-expanded={drawer === 'tasks'} aria-controls="ai-tools" className={drawer === 'tasks' ? 'selected' : ''} title="任务" onClick={() => setDrawer(drawer === 'tasks' ? null : 'tasks')}><ListTodo size={20} />{activeJob && <span className="rail-dot" />}</button><div className="rail-spacer" /><button title="帮助" onClick={() => setToast('阅读位置、选区和视图身份会随任务固定；Ctrl+, 打开设置。')}><CircleHelp size={20} /></button></nav>
      <MotionPresence show={!drawer && !showingAIResult && !!newestCard && val('translation.selectionPresentation', 'popover') === 'popover'} surface="right" duration={180} identity={motionIdentity}>{!drawer && !showingAIResult && newestCard && val('translation.selectionPresentation', 'popover') === 'popover' && <div className="translation-popover material-host"><LiquidGlassSurface variant="panel" effect="refractive" strength={.82} specularOpacity={.24} /><TranslationCard card={newestCard} onPin={() => setCards(old => old.map(item => item.id === newestCard.id ? { ...item, pinned: !item.pinned } : item))} onRetry={() => void translateSelection(newestCard.viewId, newestCard.source, newestCard.sourceRevision, newestCard.locator)} /><button className="popover-expand" onClick={() => setDrawer('translation')}>展开译文 <ChevronRight size={14} /></button></div>}</MotionPresence><MotionPresence show={!drawer && document?.format !== 'web' && !!readingTask && aiResult?.viewId === view?.id} surface="right" duration={200} identity={motionIdentity}>{readingTask && aiResult && <AIResultPopover task={readingTask} label={aiResult.label} source={aiResult.source} onClose={() => setAIResult(undefined)} onCancel={() => void call('harness-cancel', { taskId: readingTask.id }).catch(alert)} onSave={() => void saveAIResult(readingTask)} />}</MotionPresence></div>}
    <FileDropHost beforeOpen={() => flushDrafts()} onOpened={result => void handleFilesOpened(result)} reportError={alert} />
    <MotionPresence show={!!toast} surface="toast" duration={180} keyboardImmediate={false}>{toast && <div role="status" className="toast material-host" onClick={() => setToast('')}><LiquidGlassSurface variant="capsule" /><span className="motion-swap" key={toast}>{toast}</span></div>}</MotionPresence>
    <MotionPresence show={!!closing} surface="modal" duration={200}>{closing && <div className="modal-backdrop"><div className="modal confirm-dialog material-host" role="dialog" aria-modal="true" aria-labelledby="close-title"><LiquidGlassSurface variant="panel" /><div className="modal-heading"><h2 id="close-title">保存文档更改？</h2><button className="icon-button" aria-label="取消关闭" disabled={closingBusy} onClick={()=>setClosing(undefined)}><X size={18}/></button></div><p>“{workspace.documents.find(d=>d.id===closing.documentId)?.title}”有尚未保存的更改。</p><p className="dialog-hint">保留草稿会保存恢复点，原文件保持原样。</p><div className="dialog-actions"><button className="button" disabled={closingBusy} onClick={()=>setClosing(undefined)}>取消</button><button className="button" disabled={closingBusy} onClick={()=>void performClose(closing)}>保留草稿并关闭</button><button className="button primary" disabled={closingBusy} onClick={()=>void saveAndClose()}>{closingBusy?'保存中…':'保存并关闭'}</button></div></div></div>}</MotionPresence>
    <MotionPresence show={!!modal} surface="modal" duration={200}>{modal && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}><div className="modal material-host" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title"><LiquidGlassSurface variant="panel" /><div className="modal-heading"><h2 id="action-dialog-title">{({ new: '新建文档', open: '打开文件或网页', save: '另存文件' })[modal]}</h2><button className="icon-button" onClick={() => setModal(null)}><X size={18} /></button></div>{modal === 'new' ? <div className="new-format-list">{formats.map(f => <button key={f.id} onClick={() => void call<ViewInfo>('new-document', { format: f.id, windowId }).then(next => activate(next, true, true)).then(() => setModal(null)).catch(alert)}><FileIcon format={f.id} /><span>{f.title}</span><small>.{f.extension}</small></button>)}</div> : <form onSubmit={event => { event.preventDefault(); if (modal === 'save' && document) void call('save', { documentId: document.id, path: address }).then(refresh).then(() => setModal(null)).catch(alert); else void openUri(address); }}><label>{modal === 'save' ? '目标完整路径' : '本机文件路径或 HTTP(S) 地址'}</label><input autoFocus className="modal-input" value={address} onChange={e => setAddress(e.target.value)} /><button className="button primary">{modal === 'save' ? '保存' : '打开'}</button></form>}</div></div>}</MotionPresence>
  </div>;
}

function TranslationCard({ card, onPin, onRetry }: { card: Card; onPin(): void; onRetry(): void }) {
  return <div className="translation-card"><div className="translation-card-top"><span><Languages size={15} /> 翻译 · {sourceName(card)}</span><button title={card.pinned ? '取消固定' : '固定'} onClick={onPin}><Pin size={15} fill={card.pinned ? 'currentColor' : 'none'} /></button></div>{card.status === 'loading' ? <p className="translation-loading">正在翻译选中内容…</p> : card.status === 'error' ? <p className="translation-error">{card.error}</p> : <div className="translation-result">{card.result}</div>}<AnimatedDisclosure label="查看原文"><p>{card.source}</p></AnimatedDisclosure><div className="translation-actions"><button disabled={card.status !== 'ready'} onClick={() => void navigator.clipboard.writeText(card.result)}>复制译文</button><button disabled={card.status !== 'ready'} onClick={() => void navigator.clipboard.writeText(card.source + '\n\n' + card.result)}>复制双语</button><button onClick={onRetry}>重译</button></div></div>;
}

function AgentTargetHighlight({ event }: { event: EventItem }) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number }>();
  useEffect(() => {
    const target = event.data.target, reader = window.document.querySelector<HTMLElement>('.reader-panel');
    if (!target || !reader) return;
    let element: HTMLElement | null = null;
    if (target.blockId || target.shapeId) element = reader.querySelector<HTMLElement>('[data-block-id="' + (target.blockId ?? target.shapeId) + '"]');
    else if (target.address) element = reader.querySelector<HTMLElement>('.sheet-grid input[aria-label="' + target.address + '"]');
    else if (target.pageIndex !== undefined) element = reader.querySelectorAll<HTMLElement>('.pdf-page')[target.pageIndex] ?? null;
    if (!element) return;
    const box = element.getBoundingClientRect(), host = reader.getBoundingClientRect();
    setRect({ left: box.left - host.left, top: box.top - host.top, width: box.width, height: box.height });
  }, [event.seq]);
  return rect ? <div className="agent-target-highlight" style={rect} /> : null;
}
