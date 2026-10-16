import { LiquidGlassSurface } from './components/LiquidGlassSurface';
import { HomeSearch } from './components/HomeSearch';
import { buildHomeSearchCandidates, type HomeSearchCandidate } from './lib/home-search';
import { replaceHomeTabSlot } from './lib/home-tabs';
import { documentOutlineItems, type DocumentOutlineItem, type SharedOutlineItem } from './lib/document-outline';
import { AgentOperationCapsule } from './components/AgentOperationCapsule';
import { AIReadingTools } from './components/AIReadingTools';
import { AIResultPopover } from './components/AIResultPopover';
import { TranslationCard, type TranslationCardState as Card } from './components/TranslationCard';
import type { AIReadingToolDefinition, AIReadingScope } from './lib/ai-reading-tools';
import { FileDropHost } from './components/FileDropHost';
import { AGENT_OPERATION_METRICS, NAVIGATION_METRICS } from './lib/navigation-optics';
import { clearSidebarNavigationReservation, observeNavigationLane, readNavigationTargetLane, syncSidebarNavigationReservation } from './lib/navigation-lane';
import { MotionPresence, usePresence } from './components/MotionPresence';
import { NavigationToolbar, type NavigationAction } from './components/NavigationToolbar';
import { useNavigationVisibility } from './lib/navigation-visibility';
import { useNativeSelectionTools } from './lib/use-native-selection-tools';
import { MARKDOWN_EXTERNAL_EDIT_EVENT, MARKDOWN_SELECTION_EDITS, type MarkdownExternalEdit } from './lib/markdown-external-edit';
import { subscribeNativeOfficeState } from './lib/native-office-observer';
import { motionDuration, navigationMotionDuration, useMotionSnapshot } from './lib/motion';
import { scrollReadingTarget } from './lib/reading-scroll';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MessageSquare, BookOpen, Braces, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ExternalLink, FileCode2, FilePlus2, FileText, FolderOpen, Globe, Highlighter, Languages, ListTree, ListTodo, Minus, Pause, Pilcrow, Pin, Plus, Presentation, RotateCw, Search, Send, Settings2, Sparkles, Square, StopCircle, Table2, X } from 'lucide-react';
import { DocumentPane, type PdfToolsState } from './components/DocumentPane';
import { OfficeTools, type OfficeTarget, type OfficeToolboxCategory, type OfficeToolboxController } from './components/OfficeTools';
import { OfficeToolboxRail } from './components/OfficeToolboxRail';
import { NativeOfficeTools } from './components/NativeOfficeTools';
import { MarkdownTools } from './components/MarkdownTools';
import { MarkdownWorkspace } from './components/MarkdownWorkspace';
import { MarkdownPreferences } from './components/MarkdownPreferences';
import { MarkdownResources } from './components/MarkdownResources';
import type { MarkdownPreferences as MarkdownPreferencesValue } from '../../../../packages/markdown/src/preferences';
import { subscribeWorkspaceEvents } from './lib/workspace-events';
import { DocumentSessions } from '../../../../packages/document-core/src/document-session';
import { NativeSidebarPortal } from './components/NativeSidebarPortal';
import { AdaptivePanel } from './components/AdaptivePanel';
import { ReaderPanelResizeHandle, useReaderPanelLayout } from './components/ReaderPanelResize';
import { ReaderPanelGeometryHost } from './components/ReaderPanelGeometryHost';
import { officeToolboxCategory, officeToolboxContribution } from './components/office/toolbox-contributions';
import './reader-polish.css';
import './reader-panels.css';
import './reading-background.css';
import type { OfficeDraftController } from './components/OfficeDocument';
import { parseOfficeNavigationRequest, type OfficeNavigationRequest, type OfficeNavigationResult } from './lib/office-navigation';
import { call, desktop, samples, state, windowId } from './lib/transport';
import type { DocumentInfo, EditOperation, HarnessTask, PreparedPatch, ReadingSnapshot, Receipt, ViewInfo, WorkspaceState } from '../../../../packages/contracts/src/index';
import type { NativeOfficeState } from '../../../../packages/contracts/src/native-office';
import { normalizeWebAddress } from '../../../../packages/contracts/src/index';
import type { SettingsSnapshot, SettingValue } from '../../../../packages/settings/src/index';
import type { TranslationArtifact, TranslationJob } from '../../../../packages/translation/src/index';
import { applyAppearance } from './lib/appearance';
import { sharePolledValue } from './lib/polled-state';
import { WorkspaceZoomProjection } from './lib/workspace-zoom-projection';
import { mergeTextDraft, textEditorBarrier, type TextDraft, type TextEditorChange, type TextEditorState } from './lib/text-drafts';
import logoMark from './assets/agentviewer-logo.svg';

const emptyState: WorkspaceState = { protocolVersion: '1.0', documents: [], views: [], tasks: [], eventsSeq: 0 };
const emptyPdfTools: PdfToolsState = { note: '', highlight: false, ocrBusy: false };
const formats = [{ id: 'markdown', title: 'Markdown', extension: 'md' }, { id: 'docx', title: 'Word', extension: 'docx' }, { id: 'pptx', title: 'PowerPoint', extension: 'pptx' }, { id: 'xlsx', title: 'Excel', extension: 'xlsx' }, { id: 'pdf', title: 'PDF', extension: 'pdf' }, { id: 'html', title: 'HTML', extension: 'html' }];
const formatName: Record<string, string> = { markdown: 'Markdown', html: 'HTML', docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel', pdf: 'PDF', web: '网页' };
type EventItem = { seq: number; type: string; data: { viewId?: string; documentId?: string; kind?: string; point?: { x: number; y: number }; actor?: string; controlReleased?: boolean; target?: { kind: string; blockId?: string; shapeId?: string; address?: string; pageIndex?: number } }; time: string };
function eventForView(event: EventItem | undefined, view: ViewInfo | undefined) { return !!event && !!view && event.data.viewId === view.id; }
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
function alreadyTarget(text: string, target: string) { const letters = [...text].filter(char => /[\p{L}]/u.test(char)); if (letters.length < 5) return false; const kana = letters.some(char => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)); if (target === 'zh-CN') return !kana && letters.filter(char => /\p{Script=Han}/u.test(char)).length / letters.length > .72; if (target === 'ja') return kana; return false; }

export function App() {
  const [workspace, setWorkspace] = useState(emptyState), stateRef = useRef(workspace);
  const [zoomProjection] = useState(() => new WorkspaceZoomProjection(windowId));
  const [settings, setSettings] = useState<SettingsSnapshot>(), [sampleFiles, setSampleFiles] = useState<{ name: string; format: string; path: string }[]>([]);
  const [selectionProfile, setSelectionProfile] = useState(''), [chatProfile, setChatProfile] = useState('');
  const [connectionProfiles, setConnectionProfiles] = useState<{ id: string; name: string; modelId: string; enabled: boolean }[]>([]);
  const [pdfEngineAvailable, setPdfEngineAvailable] = useState(false);
  const [pdfTools, setPdfTools] = useState<PdfToolsState>(emptyPdfTools);
  const [officeTarget, setOfficeTarget] = useState<OfficeTarget>();
  const [homeTabs, setHomeTabs] = useState<string[]>([]), [homeTabId, setHomeTabId] = useState<string>(), [tabOrder, setTabOrder] = useState<string[]>([]);
  const [home, setHome] = useState(false), [activeId, setActiveId] = useState<string>(), [address, setAddress] = useState('');
  // Restored web tabs must not allocate a native page before the initial Home
  // preference has been applied. An explicit tab action wins a late settings
  // reply; other document previews remain available while it settles.
  const initialPageDecided = useRef(!desktop);
  const navigationIntent = useRef(0);
  const [webStartupReady, setWebStartupReady] = useState(!desktop);
  function chooseInitialPage() { initialPageDecided.current = true; return ++navigationIntent.current; }
  const [homeQueries, setHomeQueries] = useState<Record<string, string>>({});
  const homeFocus = useRef<string | undefined>(undefined);
  // Request identity belongs to the tab, and survives its search component
  // unmounting when the user reads another tab during a slow open.
  const homeTabsRef = useRef<string[]>([]), homeRequests = useRef(new Set<string>());
  const foreground = useRef<{ homeId?: string; viewId?: string }>({});
  const [pendingHomes, setPendingHomes] = useState<Record<string, boolean>>({});
  const [closing, setClosing] = useState<ViewInfo>(), [closingBusy, setClosingBusy] = useState(false);
  const [annotations, setAnnotations] = useState<any[]>([]);
  const [htmlOutline, setHtmlOutline] = useState<{ documentId: string; revision: number; items: SharedOutlineItem[] }>();
  const [markdownOutline, setMarkdownOutline] = useState<{ documentId: string; viewId: string; items: DocumentOutlineItem[] }>();
  const markdownActions = useRef<{ openUri: typeof openUri; runForegroundOpen: typeof runForegroundOpen; refresh: () => Promise<WorkspaceState>; flushDrafts: typeof flushDrafts; revealMarkdown: typeof revealMarkdown } | null>(null);
  const [markdownPreferences, setMarkdownPreferences] = useState<{ documentId: string; value: MarkdownPreferencesValue }>();
  const [nativeToolbarState, setNativeToolbarState] = useState<NativeOfficeState>();
  const [textHistory, setTextHistory] = useState<{viewId:string;canUndo:boolean}>();
  const [modal, setModal] = useState<'new' | 'open' | 'save' | null>(null), [toast, setToast] = useState(''), [prompt, setPrompt] = useState('');
  const [driver, setDriver] = useState(''), [drivers, setDrivers] = useState<{ id: string }[]>([]), [drawer, setDrawer] = useState<'ai' | 'translation' | 'tasks' | 'annotations' | null>(null);
  const [leftOpen, setLeftOpen] = useState(true), [leftSection, setLeftSection] = useState('outline');
  const workbench = useRef<HTMLDivElement>(null);
  const { layout: panelLayout, commitWidth: commitPanelWidth } = useReaderPanelLayout();
  const leftPanelViews = useRef(new Map<string, { section: string; open: boolean }>());
  const leftPanelView = useRef<string | undefined>(undefined);
  type ResultIdentity = { taskId: string; label: string; source: string; viewId: string; snapshotId: string; sourceText: string; sourceRevision: number; retryable: boolean };
  const [aiResult, setAIResult] = useState<ResultIdentity>();
  const [aiHistory, setAIHistory] = useState<ResultIdentity[]>([]);
  const [aiPending, setAIPending] = useState(false);
  const [fixed, setFixed] = useState<ReadingSnapshot>(), [drafts, setDrafts] = useState<Record<string, string>>({}), [cards, setCards] = useState<Card[]>([]);
  const cardsRef = useRef<Card[]>([]);
  const latestTranslationRequest = useRef(new Map<string, string>());
  const updateCards = (change: (previous: Card[]) => Card[]) => { const next = change(cardsRef.current); cardsRef.current = next; setCards(next); };
  const [selectionInteracting, setSelectionInteracting] = useState(false);
  const autoTranslationSources = useRef(new Map<string, string>());
  const [translationJobs, setTranslationJobs] = useState<TranslationJob[]>([]), [artifacts, setArtifacts] = useState<TranslationArtifact[]>([]);
  const homeCandidates = useMemo(() => buildHomeSearchCandidates({ documents: workspace.documents, samples: sampleFiles, artifacts }), [workspace.documents, sampleFiles, artifacts]);
  const [webTranslated, setWebTranslated] = useState<Record<string, boolean>>({}), [webBusy, setWebBusy] = useState(false);
  const [agentEvent, setAgentEvent] = useState<EventItem>(), eventSeq = useRef(0), selectionSeq = useRef(0);
  const [officeNavigation, setOfficeNavigation] = useState<OfficeNavigationRequest>();
  const navigationRequests = useRef(new Set<string>());
  const [agentStatuses, setAgentStatuses] = useState<Record<string, 'running' | 'paused' | 'stopped'>>({});
  const autoOpenedJobs = useRef(new Set<string>());
  const editQueue = useRef(new DocumentSessions()), lastTransactions = useRef(new Map<string, string>()), history = useRef<string[]>([]), future = useRef<string[]>([]), mounted = useRef(true);
  const textDrafts = useRef(new Map<string, TextDraft>()), textDraftQueued = useRef(new Set<string>());
  const textCompositions = useRef(new Map<string, TextEditorState>());
  const officeControllers = useRef(new Map<string, OfficeDraftController>());
  const officeToolboxes = useRef(new Map<string, OfficeToolboxController>());
  const onOfficeToolboxController = useCallback((controller: OfficeToolboxController | undefined) => { if (controller) officeToolboxes.current.set(controller.viewId, controller); else officeToolboxes.current.clear(); }, []);
  const [officeDraftDirty, setOfficeDraftDirty] = useState<Record<string, boolean>>({});
  const onOfficeDraftController = useCallback((controller: OfficeDraftController | undefined) => { if (controller) officeControllers.current.set(controller.viewId, controller); else officeControllers.current.clear(); }, []);
  const onOfficeDraftChange = useCallback(({ viewId, dirty }: { viewId: string; dirty: boolean }) => setOfficeDraftDirty(previous => previous[viewId] === dirty ? previous : { ...previous, [viewId]: dirty }), []);
  const onOfficeNavigationResult = useCallback((result: OfficeNavigationResult) => {
    if (result.status === 'failed') setToast(result.error ?? 'Agent 未跳转到目标位置。');
    setOfficeNavigation(previous => previous?.requestId === result.requestId ? undefined : previous);
  }, []);
  async function flushDrafts(viewId?: string, options?: { preserveSelection?: boolean }) {
    const documentId = viewId ? stateRef.current.views.find(item => item.id === viewId)?.documentId : undefined;
    if (viewId && !documentId) throw new Error('页面已关闭，无法确认输入内容。');
    await textEditorBarrier({ viewId, documentId, checkOnly: false });
    if ([...textCompositions.current.values()].some(item => !documentId || item.documentId === documentId)) throw new Error('请先完成输入法输入，再继续此操作。');
    for (const controller of officeControllers.current.values()) if (!viewId || controller.viewId === viewId) {
      if (!controller.hasDrafts(options)) continue;
      await controller.flush(options);
      if (controller.hasDrafts(options)) throw new Error('输入内容仍在变化，请完成输入后重试。');
    }
    for (const draft of textDrafts.current.values()) if (!documentId || draft.documentId === documentId) queueTextDraft(draft.documentId);
    await editQueue.current.drain(documentId);
    const remaining = [...textDrafts.current.values()].find(draft => !documentId || draft.documentId === documentId);
    if (remaining) throw new Error(remaining.conflict ?? '文本仍在同步，请稍后重试；本地草稿已保留。');
  }
  const viewList = workspace.views.filter(v => v.windowId === windowId);
  const view = viewList.find(v => v.id === activeId) ?? viewList.find(v => v.id === workspace.activeViewId) ?? viewList[0];
  useEffect(() => { setTabOrder(order => [...order, ...viewList.map(v => v.id).filter(id => !order.includes(id))]); }, [viewList.map(v => v.id).join(',')]);
  function addHomeTab(focusSearch = false) { setWebStartupReady(true); const id = 'home:' + crypto.randomUUID(); if (focusSearch) homeFocus.current = id; homeTabsRef.current = [...homeTabsRef.current, id]; setHomeTabs(homeTabsRef.current); setTabOrder(order => [...order, id]); foreground.current = { ...foreground.current, homeId: id }; setHomeTabId(id); setHome(true); }
  async function newHomeTab(focusSearch = false) { const intent = chooseInitialPage(); try { await flushDrafts(); if (intent !== navigationIntent.current) return; addHomeTab(focusSearch); } catch (error) { alert(error); } }
  async function switchHomeTab(id: string) { const intent = chooseInitialPage(); try { await flushDrafts(); if (intent !== navigationIntent.current || !homeTabsRef.current.includes(id)) return; setWebStartupReady(true); foreground.current = { ...foreground.current, homeId: id }; setHomeTabId(id); setHome(true); } catch (error) { alert(error); } }
  function closeHomeTab(id: string) { chooseInitialPage(); setWebStartupReady(true); const remaining = homeTabsRef.current.filter(tab => tab !== id); homeTabsRef.current = remaining; setHomeTabs(remaining); setTabOrder(order => order.filter(tab => tab !== id)); setHomeQueries(previous => { const next = { ...previous }; delete next[id]; return next; }); if (foreground.current.homeId === id) { foreground.current = { ...foreground.current, homeId: remaining.at(-1) }; setHomeTabId(remaining.at(-1)); setHome(remaining.length > 0); } }
  useEffect(() => {
    if (!home || homeFocus.current !== homeTabId) return;
    homeFocus.current = undefined;
    const frame = requestAnimationFrame(() => window.document.querySelector<HTMLInputElement>('.home-search-input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [home, homeTabId]);
  const original = workspace.documents.find(d => d.id === view?.documentId);
  const currentDraft = original ? drafts[original.id] : undefined;
  const document = useMemo(() => original && currentDraft !== undefined ? { ...original, dirty: true, model: { ...original.model, text: currentDraft } } : original, [original, currentDraft]);
  const officeContribution = document && officeToolboxContribution(document.format);
  const canUndo = document && view ? desktop && officeContribution ? nativeToolbarState?.viewId === view.id && (nativeToolbarState.inputState?.editing === 'text' ? !!nativeToolbarState.textHistory?.canUndo : !!nativeToolbarState.undo?.canUndo) : ['markdown','html'].includes(document.format) ? textHistory?.viewId === view.id && textHistory.canUndo : lastTransactions.current.has(document.id) : false;
  useEffect(() => {
    if (!desktop || !officeContribution || !document || !view) { setNativeToolbarState(undefined); return; }
    return subscribeNativeOfficeState(call, view.id, document.id, { state: value => setNativeToolbarState(value) });
  }, [document?.id, view?.id, !!officeContribution]);
  useEffect(() => { const changed=(event:Event)=>{const detail=(event as CustomEvent<{viewId:string;canUndo:boolean}>).detail;if(detail?.viewId)setTextHistory({viewId:detail.viewId,canUndo:detail.canUndo});};window.addEventListener('agentviewer:markdown-editor-history',changed);return()=>window.removeEventListener('agentviewer:markdown-editor-history',changed);},[]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{documentId:string;viewId:string;items:DocumentOutlineItem[]}>).detail;
      if (detail && Array.isArray(detail.items) && stateRef.current.views.some(view => view.id === detail.viewId && view.documentId === detail.documentId)) setMarkdownOutline(detail);
    };
    window.addEventListener('agentviewer:markdown-outline', changed);
    return () => window.removeEventListener('agentviewer:markdown-outline', changed);
  }, []);
  useEffect(() => {
    if (document?.format !== 'markdown' || !view) return;
    const frame = requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('agentviewer:markdown-outline-request', {detail:{viewId:view.id}})));
    return () => cancelAnimationFrame(frame);
  }, [document?.id, document?.format, view?.id]);
  const officeCategory = officeToolboxCategory(document?.format ?? 'markdown', leftSection.startsWith('office:') ? leftSection.slice(7) as OfficeToolboxCategory : undefined);
  useEffect(() => {
    if (!view || !document || leftPanelView.current === view.id) return;
    if (leftPanelView.current) leftPanelViews.current.set(leftPanelView.current, { section: leftSection, open: leftOpen });
    const contribution = officeToolboxContribution(document.format);
    const panel = leftPanelViews.current.get(view.id) ?? { section: contribution ? 'office:' + contribution.defaultCategory : 'outline', open: true };
    const section = contribution && panel.section.startsWith('office:') ? 'office:' + officeToolboxCategory(document.format, panel.section.slice(7) as OfficeToolboxCategory) : panel.section;
    leftPanelView.current = view.id; setLeftSection(section); setLeftOpen(panel.open);
  }, [view?.id, document?.format]);
  const motionIdentity = home ? 'home' : view?.id;
  const modalMotion = usePresence(!!modal || !!closing, { duration: 200 });
  const context = fixed && fixed.context.viewId === view?.id ? fixed.context : view?.context;
  const val = (id: string, fallback: SettingValue) => settings?.values[id] ?? fallback;
  const navigation = useNavigationVisibility({ enabled: !!val('appearance.autoHideToolbar', false), delayMs: Number(val('appearance.toolbarDelayMs', 2500)), identity: motionIdentity });
  const motionSnapshot = useMotionSnapshot();
  const navigationDuration = navigationMotionDuration(navigation.durationMs, motionSnapshot);
  const aiPopoverDuration = motionDuration(300, motionSnapshot, false);
  const onReaderScroll = navigation.onScroll;
  const alert = (error: unknown) => setToast(error instanceof Error ? error.message : String(error));
  async function revealMarkdown(viewId: string, target: { line?: number; anchor?: string }) {
    for (let attempt = 0; attempt < 50 && mounted.current; attempt++) {
      if (!stateRef.current.views.some(view => view.id === viewId)) return;
      if (window.document.querySelector(`[data-markdown-view="${CSS.escape(viewId)}"] .cm-editor`)) {
        window.dispatchEvent(new CustomEvent(target.line ? 'agentviewer:markdown-reveal-line' : 'agentviewer:markdown-anchor', { detail: { viewId, ...target } })); return;
      }
      await new Promise<void>(done => setTimeout(done, 80));
    }
  }
  useEffect(() => {
    if (document?.format !== 'markdown' || !view) return;
    let stopped = false; const documentId = document.id, viewId = view.id;
    const publish = (value: MarkdownPreferencesValue) => { if (stopped) return; setMarkdownPreferences({ documentId, value }); window.dispatchEvent(new CustomEvent('agentviewer:markdown-preferences', { detail: { viewId, preferences: value } })); };
    void call<{ preferences: MarkdownPreferencesValue }>('markdown-preferences-read', { documentId }).then(result => publish(result.preferences)).catch(alert);
    const request = (event: Event) => { if ((event as CustomEvent<{viewId:string}>).detail?.viewId === viewId) void call<{preferences:MarkdownPreferencesValue}>('markdown-preferences-read', {documentId}).then(result=>publish(result.preferences)).catch(alert); };
    const received = (event: Event) => { const detail = (event as CustomEvent<{viewId:string;preferences:MarkdownPreferencesValue}>).detail; if (detail?.viewId === viewId) setMarkdownPreferences({documentId,value:detail.preferences}); };
    window.addEventListener('agentviewer:markdown-preferences-request', request); window.addEventListener('agentviewer:markdown-preferences', received);
    return () => { stopped = true; window.removeEventListener('agentviewer:markdown-preferences-request', request); window.removeEventListener('agentviewer:markdown-preferences', received); };
  }, [document?.id, document?.format, view?.id]);
  useEffect(() => {
    const link = (event: Event) => {
      const detail = (event as CustomEvent<{documentId:string;viewId:string;href:string}>).detail;
      if (!detail || stateRef.current.views.find(view => view.id === detail.viewId)?.documentId !== detail.documentId) return;
      void call<{uri?:string;anchor?:string}>('markdown-resolve-link', {documentId:detail.documentId,href:detail.href}).then(async result => {
        if (!result.uri) { if(result.anchor) await markdownActions.current!.revealMarkdown(detail.viewId,{anchor:result.anchor}); return; }
        const next = await markdownActions.current!.openUri(result.uri); if(next && result.anchor) await markdownActions.current!.revealMarkdown(next.id,{anchor:result.anchor});
      }).catch(alert);
    };
    const exportDocument = (event: Event) => {
      const detail = (event as CustomEvent<{viewId:string;format:string}>).detail;
      const view = stateRef.current.views.find(view=>view.id===detail?.viewId); if(!view)return;
      void (async()=>{ await markdownActions.current!.flushDrafts(view.id); const fresh=await markdownActions.current!.refresh(),document=fresh.documents.find(document=>document.id===view.documentId);if(!document||document.format!=='markdown')return;
        setToast('正在生成完整文档…');
        const result=await call<{paths:string[]}|null>('markdown-export',{documentId:document.id,expectedRevision:document.revision,format:detail.format});
        if(result)setToast(result.paths.length===1?'已导出：'+result.paths[0]:detail.format==='png'?'已导出 '+result.paths.length+' 张完整分页图片。':'已导出 '+result.paths.length+' 个文件。');else setToast('');
      })().catch(alert);
    };
    const resourcesApplied = () => { void markdownActions.current!.refresh().catch(alert); };
    const importDocument = () => { void markdownActions.current!.runForegroundOpen(()=>call<ViewInfo|null>('markdown-import',{windowId})).catch(alert); };
    const beforeResources = (event: Event) => { const detail=(event as CustomEvent<{viewId?:string;documentId?:string;waitUntil(promise:Promise<void>):void}>).detail;if(detail?.waitUntil){const viewId=detail.viewId??stateRef.current.views.find(view=>view.documentId===detail.documentId&&view.windowId===windowId)?.id;detail.waitUntil(markdownActions.current!.flushDrafts(viewId));} };
    window.addEventListener('agentviewer:markdown-link',link);window.addEventListener('agentviewer:markdown-export',exportDocument);window.addEventListener('agentviewer:markdown-import',importDocument);window.addEventListener('agentviewer:markdown-resources-applied',resourcesApplied);window.addEventListener('agentviewer:markdown-resources-before',beforeResources);window.addEventListener('agentviewer:markdown-workspace-before',beforeResources);
    return()=>{window.removeEventListener('agentviewer:markdown-link',link);window.removeEventListener('agentviewer:markdown-export',exportDocument);window.removeEventListener('agentviewer:markdown-import',importDocument);window.removeEventListener('agentviewer:markdown-resources-applied',resourcesApplied);window.removeEventListener('agentviewer:markdown-resources-before',beforeResources);window.removeEventListener('agentviewer:markdown-workspace-before',beforeResources);};
  }, []);
  useEffect(() => {
    if (document?.format !== 'html') return;
    let disposed = false; const documentId = document.id, revision = document.revision;
    void call<SharedOutlineItem[]>('outline', { documentId }).then(items => { if (!disposed) setHtmlOutline({ documentId, revision, items }); }).catch(alert);
    return () => { disposed = true; };
  }, [document?.id, document?.revision, document?.format]);
  useEffect(() => window.agentViewer?.onBeforeClose(async options => {
    try {
      if (options.checkOnly) {
        await textEditorBarrier({ documentId: options.documentId, checkOnly: true });
        if ([...textDrafts.current.values()].some(draft => !options.documentId || draft.documentId === options.documentId) || [...textCompositions.current.values()].some(item => !options.documentId || item.documentId === options.documentId)) throw new Error('当前文档有未提交文本或输入法输入，请完成输入后重试。');
        if ([...officeControllers.current.values()].some(controller => (!options.documentId || stateRef.current.views.find(view => view.id === controller.viewId)?.documentId === options.documentId) && controller.hasDrafts())) throw new Error('当前文档有未提交输入，请完成输入后重试。');
        return;
      }
      await flushDrafts();
    } catch (error) { alert(error); throw error; }
  }), []);
  useEffect(() => {
    const update = (event: Event) => {
      const value = (event as CustomEvent<TextEditorState>).detail;
      if (!value || typeof value.viewId !== 'string' || typeof value.documentId !== 'string' || typeof value.composing !== 'boolean') return;
      if (value.composing) textCompositions.current.set(value.viewId, value);
      else { textCompositions.current.delete(value.viewId); queueTextDraft(value.documentId); }
    };
    window.addEventListener('agentviewer:text-editor-state', update);
    return () => window.removeEventListener('agentviewer:text-editor-state', update);
  }, []);
  const refresh = async () => { const previous = stateRef.current, result = desktop ? await call<WorkspaceState>('state', { knownDocuments: Object.fromEntries(previous.documents.map(item => [item.id, item.revision])) }) : await state();
    result.documents = result.documents.map(item => { const old = previous.documents.find(value => value.id === item.id); if ((item as DocumentInfo & {displayMetadataOnly?:boolean}).displayMetadataOnly && old && old.revision === item.revision) return {...item,model:old.model}; return item; });
    const next = zoomProjection.snapshot(previous, result); const ownActive=next.views.find(v=>v.id===next.activeViewId&&v.windowId===windowId); if (ownActive && previous.activeViewId !== next.activeViewId && !textDrafts.current.size && !textCompositions.current.size && ![...officeControllers.current.values()].some(controller => controller.hasDrafts())) { setActiveId(ownActive.id); if (!foreground.current.homeId) foreground.current = { viewId: ownActive.id }; } if (next !== previous) { stateRef.current = next; if (mounted.current) setWorkspace(next); } return next; };
  markdownActions.current = {openUri, runForegroundOpen, refresh, flushDrafts, revealMarkdown};
  useEffect(() => {
    if (!officeNavigation) return;
    const request = officeNavigation, targetView = workspace.views.find(item => item.id === request.viewId), source = workspace.documents.find(item => item.id === request.documentId);
    if (!targetView || !source || source.revision < request.expectedRevision) return;
    if (targetView.windowId !== windowId) { setOfficeNavigation(undefined); return; }
    if (source.revision !== request.expectedRevision || targetView.documentId !== request.documentId) { onOfficeNavigationResult({ requestId: request.requestId, status: 'failed', error: '文档版本已变化，Agent 未跳转。' }); return; }
    const format = request.target.kind === 'paragraph' ? 'docx' : request.target.kind === 'slide' ? 'pptx' : request.target.kind === 'html-heading' ? 'html' : 'xlsx';
    if (source.format !== format) { onOfficeNavigationResult({ requestId: request.requestId, status: 'failed', error: '导航目标与文档类型不匹配，Agent 未跳转。' }); return; }
    if ([...officeControllers.current.values()].some(controller => controller.hasDrafts())) { onOfficeNavigationResult({ requestId: request.requestId, status: 'failed', error: '当前文档有未提交输入，Agent 未跳转。请完成或取消输入后重试。' }); return; }
    if (format === 'html' && drafts[request.documentId] !== undefined) { onOfficeNavigationResult({ requestId: request.requestId, status: 'failed', error: 'HTML 文档有未提交源码输入，Agent 未跳转。' }); return; }
    if (format === 'html' && (htmlOutline?.documentId !== request.documentId || htmlOutline?.revision !== request.expectedRevision)) return;
    if (workspace.activeViewId !== request.viewId || modal || closing) return;
    foreground.current = { viewId: request.viewId }; setHome(false); setActiveId(request.viewId);
  }, [officeNavigation, workspace, modal, closing, officeDraftDirty, htmlOutline, drafts, onOfficeNavigationResult]);
  useEffect(() => {
    if (!officeNavigation) return;
    const timer = setTimeout(() => onOfficeNavigationResult({ requestId: officeNavigation.requestId, status: 'failed', error: '目标视图未准备就绪，Agent 未跳转。' }), 10000);
    return () => clearTimeout(timer);
  }, [officeNavigation?.requestId, onOfficeNavigationResult]);
  const refreshTranslations = async () => { if (!desktop) return; const result = await call<{ jobs: TranslationJob[]; artifacts: TranslationArtifact[] }>('translation-list'); setTranslationJobs(previous => sharePolledValue(previous, result.jobs)); setArtifacts(previous => sharePolledValue(previous, result.artifacts)); };
  useEffect(() => {
    mounted.current = true;
    let disposed = false, invalidated = false, refreshingInvalidation = false;
    const refreshInvalidated = async () => {
      invalidated = true; if (refreshingInvalidation) return;
      refreshingInvalidation = true;
      try { while (invalidated && !disposed) { invalidated = false; try { await refresh(); } catch { /* The 650ms fallback also retries a failed read. */ } } }
      finally { refreshingInvalidation = false; }
    };
    // Subscribe before the initial snapshot, and keep the listener independent
    // of the active tab. MCP commands may target a background view.
    const offZoom = window.agentViewer?.onToolbar(event => {
      if (zoomProjection.invalidate(stateRef.current, event)) { void refreshInvalidated(); return; }
      const previous = stateRef.current, next = zoomProjection.receive(previous, event);
      if (next !== previous) { stateRef.current = next; if (mounted.current) setWorkspace(next); }
    });
    void refresh().catch(alert); void samples().then(setSampleFiles).catch(alert); void call<{ id: string }[]>('harness-list').then(setDrivers).catch(alert);
    if (desktop) { void call<{ snapshot: SettingsSnapshot }>('settings-read').then(data => { if (!mounted.current) return; setSettings(data.snapshot); if (!initialPageDecided.current) { initialPageDecided.current = true; if (data.snapshot.values['general.startPage'] === 'home') addHomeTab(); } setWebStartupReady(true); }).catch(error => { if (!mounted.current) return; initialPageDecided.current = true; setWebStartupReady(true); alert(error); }); void call<{ routes: { selection: string; chat: string }; profiles: { id: string; name: string; modelId: string; enabled: boolean }[] }>('connections-read').then(data => { setSelectionProfile(data.profiles.some(profile => profile.id === data.routes.selection && profile.enabled) ? data.routes.selection : ''); setChatProfile(data.profiles.some(profile => profile.id === data.routes.chat && profile.enabled) ? data.routes.chat : ''); setConnectionProfiles(previous => sharePolledValue(previous, data.profiles.filter(profile => profile.enabled))); }).catch(() => {}); void call<{ babeldoc: { available: boolean }; libreoffice: { available: boolean } }>('engine-status').then(data => { setPdfEngineAvailable(data.babeldoc.available);  }).catch(() => {}); void refreshTranslations().catch(alert); }
    const off = window.agentViewer?.onSettingsChanged(value => setSettings(value as SettingsSnapshot));
    const timer = setInterval(() => { void refresh().catch(() => {}); void refreshTranslations().catch(() => {}); if (desktop) void call<{ routes: { selection: string; chat: string }; profiles: { id: string; name: string; modelId: string; enabled: boolean }[] }>('connections-read').then(data => { setSelectionProfile(data.profiles.some(profile => profile.id === data.routes.selection && profile.enabled) ? data.routes.selection : ''); setChatProfile(data.profiles.some(profile => profile.id === data.routes.chat && profile.enabled) ? data.routes.chat : ''); setConnectionProfiles(previous => sharePolledValue(previous, data.profiles.filter(profile => profile.enabled))); }).catch(() => {}); }, 5000);
    return () => { disposed = true; mounted.current = false; clearInterval(timer); off?.(); offZoom?.(); };
  }, []);
  useEffect(() => {
    let refreshing=false,again=false;
    const resync=()=>{again=true;if(refreshing)return;refreshing=true;void(async()=>{try{while(again&&mounted.current){again=false;await refresh();}}catch{}finally{refreshing=false;}})();};
    return subscribeWorkspaceEvents<EventItem>({after:()=>eventSeq.current,resync,receive:events=>{
    for (const event of events) { eventSeq.current = Math.max(eventSeq.current, event.seq); if (event.type === 'reader.navigate') { const request = parseOfficeNavigationRequest(event.data); if (request && !navigationRequests.current.has(request.requestId) && Date.now() - Date.parse(event.time) < 15000) { navigationRequests.current.add(request.requestId); if (navigationRequests.current.size > 256) navigationRequests.current.delete(navigationRequests.current.values().next().value!); setOfficeNavigation(request); void refresh().catch(alert); } } if ((event.type === 'browser.input' || event.type === 'office.input' || event.type === 'office.executed' || event.type === 'document.changed' || event.type === 'ai.reading') && event.data.actor === 'agent' && event.data.viewId && !event.data.controlReleased) setAgentEvent({...event,data:{...event.data,kind:event.data.kind ?? (event.data as {action?:string}).action}}); if (event.type === 'agent.released') setAgentEvent(previous => previous && previous.data.viewId === event.data.viewId ? undefined : previous); if (event.type === 'agent.control' && event.data.viewId) setAgentStatuses(old => ({ ...old, [event.data.viewId!]: (event.data as { status: 'running' | 'paused' | 'stopped' }).status })); if (event.type === 'browser.translation' && event.data.viewId) setWebTranslated(old => ({ ...old, [event.data.viewId!]: true })); if (event.type === 'browser.translation-restored' && event.data.viewId) setWebTranslated(old => ({ ...old, [event.data.viewId!]: false })); }
      if(events.some(event=>!event.type.startsWith('harness.output')))resync();
      if(events.some(event=>event.type.startsWith('translation.')))void refreshTranslations().catch(()=>{});
    }});
  }, []);
  useEffect(() => { if (!agentEvent) return; const timer = setTimeout(() => setAgentEvent(current => current?.seq === agentEvent.seq ? undefined : current), 2600); return () => clearTimeout(timer); }, [agentEvent, agentStatuses]);
  useEffect(() => { for (const job of translationJobs) if (job.status === 'completed' && job.artifact && !autoOpenedJobs.current.has(job.id)) { autoOpenedJobs.current.add(job.id); if (val('translation.openArtifact', false)) void openUri(job.artifact.path); } }, [translationJobs, settings?.revision]);
  useEffect(() => { setAddress(document?.model.url ?? document?.path ?? document?.title ?? ''); setFixed(undefined); }, [view?.id, document?.model.url]);
  useEffect(() => setPdfTools(emptyPdfTools), [view?.id]);
  useEffect(() => { applyAppearance(settings); }, [settings?.revision]);
  useEffect(() => { const configured = chatProfile ? 'provider' : String(val('ai.defaultDriver', 'none')); setDriver(drivers.some(item => item.id === configured) ? configured : ''); }, [settings?.revision, drivers, chatProfile]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 6000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const shortcut = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if(document?.format==='markdown'&&(event.key.toLowerCase()==='p'||event.shiftKey&&event.key.toLowerCase()==='f')){event.preventDefault();setLeftSection('files');setLeftOpen(true);setTimeout(()=>window.dispatchEvent(new CustomEvent('agentviewer:markdown-workspace-mode',{detail:{documentId:document.id,mode:event.shiftKey?'search':'quick'}})),80);return;}
    if (event.key.toLowerCase() === 's') { event.preventDefault(); void save(event.shiftKey); }
    else if (event.key.toLowerCase() === 't') { event.preventDefault(); void newHomeTab(true); }
    else if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openFile(); }
    else if (event.key.toLowerCase() === 'l') { event.preventDefault(); if (home) window.document.querySelector<HTMLInputElement>('.home-search-input')?.select(); else if (document?.format === 'web') { revealToolbar(); if (desktop) void call('toolbar-focus'); else window.document.querySelector<HTMLInputElement>('.address-input')?.select(); } else setModal('open'); }
    else if (event.key === ',') { event.preventDefault(); void openSettings(); }
  }; window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut); }, [document, view, home, homeTabId]);
  useEffect(() => {
    let dragging = false, composing = false;
    const publish = () => setSelectionInteracting(dragging || composing);
    const start = (event: Event) => { if ((event.target as HTMLElement)?.closest?.('.document-content')) { if (event.type === 'compositionstart') composing = true; else dragging = true; publish(); } };
    const end = (event: Event) => { if (event.type === 'compositionend') composing = false; else if (event.type === 'blur') { dragging = false; composing = false; } else dragging = false; publish(); };
    window.addEventListener('pointerdown', start); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('compositionstart', start); window.addEventListener('compositionend', end); window.addEventListener('blur', end);
    return () => { window.removeEventListener('pointerdown', start); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('compositionstart', start); window.removeEventListener('compositionend', end); window.removeEventListener('blur', end); };
  }, []);
  useEffect(() => {
    if (selectionInteracting || !view || document?.format === 'web' || !context?.selection.text || context.selection.kind === 'none' || context.actor !== 'human' || !val('translation.selectionAuto', true) || alreadyTarget(context.selection.text, String(val('translation.targetLanguage', 'zh-CN'))) || (val('ai.defaultDriver', 'none') === 'none' && !selectionProfile)) return;
    const text = context.selection.text, viewId = view.id, revision = context.contentRevision, sequence = ++selectionSeq.current;
    const signature = JSON.stringify([text, revision, val('translation.targetLanguage', 'zh-CN'), context.selection.locator]);
    if (autoTranslationSources.current.get(viewId) === signature) return;
    if (cardsRef.current.some(card => card.viewId === viewId && card.source === text && card.sourceRevision === revision && card.targetLanguage === val('translation.targetLanguage', 'zh-CN'))) return;
    const timer = setTimeout(() => { if (selectionSeq.current === sequence) { autoTranslationSources.current.set(viewId, signature); void translateSelection(viewId, text, revision, context.selection.locator); } }, Number(val('translation.selectionDelayMs', 500)));
    return () => clearTimeout(timer);
  }, [view?.id, context?.selection.text, context?.contentRevision, context?.actor, settings?.revision, selectionProfile, selectionInteracting]);
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
    if(event.action==='geometry'&&document?.format==='web'){
      const reader=window.document.querySelector<HTMLElement>('.reader-panel'),bounds=event.bounds as {x:number;width:number}|undefined;
      if(reader&&bounds&&Number.isFinite(bounds.x)&&Number.isFinite(bounds.width)&&bounds.width>0&&navigation.visible){const origin=reader.getBoundingClientRect().left;syncSidebarNavigationReservation(reader,bounds.x-origin,bounds.x+bounds.width-origin);}
      return;
    }
    if(event.action==='native-save'){void save();return;}
    if(event.action==='native-save-as'){void save(true);return;}
    if(event.action==='native-open'){void openFile();return;}
    if(event.action==='native-new'){setModal('new');return;}
    if(event.action==='native-close'){if(view)void closeTab(view);return;}
    if(event.action==='native-quit'){void call('window-control',{action:'close'});return;}
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
    else if (['back', 'forward', 'reload', 'copy', 'translate', 'undo', 'save'].includes(String(event.action))) void navigationAction({ type: event.action as 'back' | 'forward' | 'reload' | 'copy' | 'translate' | 'undo' | 'save' });
  }), [view?.id, view?.zoom, document?.format, home, homeTabId, webTranslated, webBusy, navigation.onFocus, navigation.onBlur, navigation.onHover, navigation.onLeave, navigation.visible, navigation.reveal, navigation.revealFromEdge, navigation.dismiss, navigation.onScroll]);
  useEffect(() => {
    if (!desktop) return;
    if (home || modalMotion.present || closing || document?.format !== 'web' || !view) { const reader=window.document.querySelector<HTMLElement>('.reader-panel');if(reader&&(home||document?.format==='web'))clearSidebarNavigationReservation(reader);void call('toolbar-layout', { visible: false }); return; }
    const reader = window.document.querySelector<HTMLElement>('.reader-panel'); if (!reader) return;
    const update = () => { const box = reader.getBoundingClientRect(), lane = readNavigationTargetLane(reader), gutter=NAVIGATION_METRICS.shadowGutter;if(!navigation.visible)clearSidebarNavigationReservation(reader);void call('toolbar-layout', { viewId: view.id, visible: navigation.visible, manualHidden: navigation.manualHidden, hideProgress: navigation.progress, hideDurationMs: navigationDuration, format: document.format, title: document.title, canUndo:!!lastTransactions.current.get(document.id), address: document.model.url, translated: webTranslated[view.id], busy: webBusy, settings, zoom: view.zoom ?? 1, laneBounds:{...lane,left:lane.left+gutter,right:lane.right+gutter,center:lane.center+gutter}, bounds: { x: box.x-gutter, y: box.y + NAVIGATION_METRICS.top - gutter, width:box.width+2*gutter, height: NAVIGATION_METRICS.height + 2*gutter } }).catch(alert); };
    const dispose=observeNavigationLane(reader,update);return()=>{dispose();clearSidebarNavigationReservation(reader);};
  }, [home, modalMotion.present, closing, view?.id, view?.zoom, document?.model.url, navigation.visible, navigation.manualHidden, navigation.progress, navigationDuration, settings, webBusy, webTranslated, leftOpen, drawer]);
  useEffect(() => {
    if (!desktop) return;
    const visible = !home && !modalMotion.present && !closing && document?.format === 'web' && !!view && (eventForView(agentEvent, view) || !!view.agentState);
    if (!visible || !view || !document) { const sameTarget = !home && !modalMotion.present && !closing && document?.format === 'web' && !!view; void call('agent-layout', { visible: false, viewId: sameTarget ? view.id : undefined, animate: sameTarget, hideDurationMs: motionDuration(200, undefined, false) }).catch(alert); return; }
    const reader = window.document.querySelector('.reader-panel'); if (!reader) return;
    const update = () => { const box = reader.getBoundingClientRect(), width = Math.min(AGENT_OPERATION_METRICS.maxSlotWidth, box.width - 2 * AGENT_OPERATION_METRICS.shadowGutter); void call('agent-layout', { viewId: view.id, visible: true, kind: eventForView(agentEvent, view) ? agentEvent?.data.kind : view.agentState?.phase, status: agentStatuses[view.id] ?? 'running', target: val('agent.capsuleDetail', 'minimal') === 'target' ? document.title : undefined, settings, bounds: { x: box.x + (box.width - width) / 2, y: box.bottom - AGENT_OPERATION_METRICS.bottom - AGENT_OPERATION_METRICS.height - AGENT_OPERATION_METRICS.shadowGutter, width, height: AGENT_OPERATION_METRICS.height + 2 * AGENT_OPERATION_METRICS.shadowGutter } }).catch(alert); };
    const observer = new ResizeObserver(update); observer.observe(reader); update();
    return () => observer.disconnect();
  }, [home, modalMotion.present, closing, view?.id, document?.id, document?.format, document?.title, agentEvent?.seq, view?.agentState?.controlId, view?.agentState?.phase, agentStatuses, settings?.revision, leftOpen, drawer]);
  useEffect(() => { window.dispatchEvent(new Event('agentviewer:selection-clear')); }, [view?.id, home, document?.id]);
  useEffect(() => {
    // A tiled Office mirror can advance the library revision while the native
    // selection is unchanged. Its bridge owns engine/selection invalidation.
    if (!desktop || !['docx','pptx','xlsx'].includes(document?.format ?? '')) window.dispatchEvent(new Event('agentviewer:selection-clear'));
  }, [document?.id, document?.format, document?.revision]);
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
    const markdownEdit = (phase: 'pending' | 'committed' | 'canceled', detail: any) => {
      const {snapshot,requestId,action}=detail;
      if(snapshot?.document?.format!=='markdown'||!MARKDOWN_SELECTION_EDITS.has(action)||typeof requestId!=='string'||!Number.isSafeInteger(snapshot.document.revision)||!snapshot.context?.viewId)return;
      const identity={documentId:snapshot.document.id,viewId:snapshot.context.viewId,requestId,baseRevision:snapshot.document.revision,action};
      const receipt=detail.result?.receipt;
      const committed=phase==='committed'&&receipt?.status==='applied'&&receipt.documentId===identity.documentId&&receipt.idempotencyKey===requestId+':edit'&&receipt.revision===identity.baseRevision+1&&typeof receipt.transactionId==='string';
      const update:MarkdownExternalEdit=committed?{...identity,phase:'committed',revision:receipt.revision,transactionId:receipt.transactionId}:{...identity,phase:phase==='pending'?'pending':'canceled'};
      window.dispatchEvent(new CustomEvent<MarkdownExternalEdit>(MARKDOWN_EXTERNAL_EDIT_EVENT,{detail:update}));
    };
    const result = (event: Event) => { const detail=(event as CustomEvent<any>).detail; const {action,result,snapshot}=detail;
      markdownEdit('committed',detail);
      if(result.receipt) { lastTransactions.current.set(result.receipt.documentId, result.receipt.transactionId);void refresh(); }
      if(result.view) void activate(result.view);
      if(result.annotation){refreshAnnotations();setToast(action==='note'?'批注已独立保存。':'高亮已保存在阅读器中。');}
      if(action==='translate' && snapshot.document.format!=='web') { if (result.requestId !== latestTranslationRequest.current.get(snapshot.context.viewId)) return; for(const card of cardsRef.current) if(card.viewId===snapshot.context.viewId && !card.pinned && card.status==='loading') void cancelTranslation(card); updateCards(old=>[...old.filter(c=>c.pinned||c.viewId!==snapshot.context.viewId),{id:crypto.randomUUID(),requestId:result.requestId,viewId:snapshot.context.viewId,source:snapshot.context.selection.text,result:result.text,sourceRevision:snapshot.document.revision,locator:snapshot.context.selection.locator,pinned:false,status:'ready',targetLanguage:result.targetLanguage,model:result.model}]); if(val('translation.selectionPresentation','popover')==='drawer' && foreground.current.viewId===snapshot.context.viewId && !foreground.current.homeId)setDrawer('translation');}
      if(action==='translate'&&snapshot.document.format==='web')setWebTranslated(old=>({...old,[snapshot.context.viewId]:true}));
      if(result.task)setDrawer('tasks');
      if(action==='copy'||action==='citation')setToast('已复制。');
    };
    const started = (event: Event) => { const detail=(event as CustomEvent<any>).detail; const { action, requestId, snapshot } = detail; markdownEdit('pending',detail); if (action === 'translate' && snapshot.document.format !== 'web') latestTranslationRequest.current.set(snapshot.context.viewId, requestId); };
    const failed = (event: Event) => markdownEdit('canceled',(event as CustomEvent<any>).detail);
    window.addEventListener('agentviewer:selection-start', started); window.addEventListener('agentviewer:selection-result', result); window.addEventListener('agentviewer:selection-failed',failed);
    return () => { window.removeEventListener('agentviewer:selection-start', started); window.removeEventListener('agentviewer:selection-result', result); window.removeEventListener('agentviewer:selection-failed',failed); };
  },[view?.id,document?.id,home,homeTabId]);
  useEffect(()=>window.agentViewer?.onSelectionTool(event=>{if(event.action==='result')window.dispatchEvent(new CustomEvent('agentviewer:selection-result',{detail:event.detail}));}),[]);
  useNativeSelectionTools(desktop && !home && !modal && !closing && document?.format === 'web', view?.context, settings, alert,navigation.visible);
  useEffect(()=>{
    if(!modal&&!closing)return;
    const previous=window.document.activeElement as HTMLElement|null,dialog=window.document.querySelector<HTMLElement>('.modal-backdrop:not([inert]) .modal');dialog?.setAttribute('role','dialog');dialog?.setAttribute('aria-modal','true');dialog?.setAttribute('tabindex','-1');dialog?.querySelector<HTMLElement>('input,button')?.focus();
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){if(!closingBusy){setModal(null);setClosing(undefined);}event.preventDefault();}if(event.key==='Tab'&&dialog){const controls=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,[tabindex="0"]')];const first=controls[0],last=controls.at(-1);if(event.shiftKey&&window.document.activeElement===first){last?.focus();event.preventDefault();}else if(!event.shiftKey&&window.document.activeElement===last){first?.focus();event.preventDefault();}}};window.addEventListener('keydown',key);return()=>{window.removeEventListener('keydown',key);previous?.focus();};
  },[modal,closing,closingBusy]);
  function revealToolbar() { navigation.reveal(); }
  async function navigationAction(action: NavigationAction, explicit = true) {
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
      else if (action.type === 'mode') { await flushDrafts(view.id); await call('mode', { viewId: view.id, mode: action.mode }); await refresh(); }
      else if (action.type === 'zoom') {
        if (explicit) window.dispatchEvent(new CustomEvent('agentviewer:office-manual-zoom', { detail: { viewId: view.id } }));
        await call('zoom', { viewId: view.id, factor: action.factor }); await refresh();
      }
      else if (action.type === 'undo') {
        if (document.format === 'markdown' || document.format === 'html') {
          await textEditorBarrier({ viewId: view.id, documentId: document.id, checkOnly: false });
          const detail = { viewId: view.id, command: 'undo' as const, handled: false };
          window.dispatchEvent(new CustomEvent('agentviewer:markdown-command', { detail }));
          if (detail.handled) { await flushDrafts(view.id); return; }
          // The editor's history owns text Undo. A destroyed/hidden editor must
          // never fall through to the unrelated whole-document Core history.
          return;
        }
        if (officeContribution && desktop && await officeControllers.current.get(view.id)?.history?.('undo')) return;
        await flushDrafts(view.id);
        if (officeContribution && desktop) {
          const native = await call<import('../../../../packages/contracts/src/index').NativeOfficeState>('office-status',{viewId:view.id});
          if (!native.undo?.canUndo || !native.undo.token) return;
          await call('office-undo',{viewId:view.id,expectedEngineEpoch:native.engineEpoch,expectedEngineRevision:native.engineRevision,undoToken:native.undo.token,idempotencyKey:crypto.randomUUID()});await refresh();return;
        }
        const documentId = view.documentId;
        await editQueue.current.run(documentId, async () => { const transactionId = lastTransactions.current.get(documentId); if (!transactionId) return; await call('undo', { transactionId }); lastTransactions.current.delete(documentId); await refresh(); });
      }
      else if (action.type === 'save' || action.type === 'copy') await save();
      else if (action.type === 'translate' && !webBusy) { if(webTranslated[view.id]) await webRestore(); else await webTranslate('page'); }
    } catch(error) { alert(error); }
  }
  async function openSettings(category?: string) { if (!desktop) return setToast('设置窗口仅在桌面应用中提供。'); try { await call('settings-open', { category }); } catch (e) { alert(e); } }
  async function activate(next: ViewInfo, record = true, replaceHome = false, requestHomeId?: string, expectedIntent?: number) {
    const intent = expectedIntent ?? (requestHomeId ? navigationIntent.current : chooseInitialPage());
    await flushDrafts();
    if (intent !== navigationIntent.current) return;
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
    setWebStartupReady(true); setHomeTabId(undefined); setHome(false); setActiveId(next.id); setFixed(undefined);
    await call('activate', { viewId: next.id }); await refresh();
  }
  async function runForegroundOpen(load: () => Promise<ViewInfo | null>, replaceHome = true, closeDialog = false) {
    const intent = chooseInitialPage();
    try {
      await flushDrafts(); if (intent !== navigationIntent.current) return;
      // UI loaders register a background result. Activation belongs only to
      // this intent, never to an older picker/network/create completion.
      const next = await load(); if (!next) return;
      if (intent !== navigationIntent.current) { await refresh(); return; }
      await activate(next, true, replaceHome, undefined, intent);
      if (closeDialog && intent === navigationIntent.current) setModal(null);
      return next;
    } catch (error) { alert(error); }
  }
  async function openUri(uri: string) { return runForegroundOpen(() => call<ViewInfo>('open', { uri, windowId, activate: false }), true, true); }
  async function createDocument(format: string) { return runForegroundOpen(() => call<ViewInfo>('new-document', { format, windowId, activate: false }), true, true); }
  async function openHomeUri(uri: string) {
    const normalized = uri.replaceAll('\\', '/').toLowerCase();
    const existing = homeCandidates.find(candidate => candidate.documentId && candidate.path?.replaceAll('\\', '/').toLowerCase() === normalized);
    return runHomeOpen(() => existing?.documentId ? call<ViewInfo>('document-open-view', { documentId: existing.documentId, windowId, activate: false, preload: true }) : call<ViewInfo>('open', { uri, windowId, activate: false, preload: true }));
  }
  async function openHomeCandidate(candidate: HomeSearchCandidate) {
    if (candidate.documentId) await openHomeDocument(candidate.documentId);
    else if (candidate.path) await openHomeUri(candidate.path);
  }
  async function openHomeDocument(documentId: string) {
    return runHomeOpen(() => call<ViewInfo>('document-open-view', { documentId, windowId, activate: false, preload: true }));
  }
  async function runHomeOpen(load: () => Promise<ViewInfo>) {
    chooseInitialPage();
    const origin = foreground.current.homeId;
    if (!origin || homeRequests.current.has(origin)) return;
    homeRequests.current.add(origin); setPendingHomes(previous => ({ ...previous, [origin]: true }));
    try { await flushDrafts(); const next = await load(); await activate(next, true, true, origin); }
    finally { homeRequests.current.delete(origin); setPendingHomes(previous => { const remaining = { ...previous }; delete remaining[origin]; return remaining; }); }
  }
  async function openFile() { if (desktop) await runForegroundOpen(() => call<ViewInfo | null>('choose-file', { windowId, activate: false })); else { chooseInitialPage(); setModal('open'); } }
  async function handleFilesOpened(result: { views: ViewInfo[]; errors: string[] }) {
    const intent = chooseInitialPage();
    await refresh();
    for (let index = 0; index < result.views.length && intent === navigationIntent.current; index++) await activate(result.views[index], true, index === 0, undefined, intent);
    if (result.errors.length) setToast(result.errors.join('；'));
    else if (result.views.length > 1) setToast('已打开 ' + result.views.length + ' 个文档');
  }
  async function save(as = false) { if (!document) return; try { await flushDrafts(view?.id); if (document.format === 'web') { const copy = await call<ViewInfo>('browser-copy', { viewId: view!.id }); await activate(copy); setToast('已建立本地阅读副本。'); return; } if (desktop && (!document.path || as)) { if (!await call('choose-save', { documentId: document.id })) return; } else if (!document.path || as) { setModal('save'); return; } else await call('save', { documentId: document.id }); await refresh(); setToast('文件已保存。'); } catch (e) { alert(e); } }
  async function edit(operation: EditOperation) {
    if (!document) return; const id = document.id;
    if (['word.insertParagraph', 'word.deleteParagraph', 'word.insertTable', 'slides.addSlide', 'slides.deleteSlide', 'slides.duplicateSlide', 'slides.moveSlide', 'slides.deleteShape', 'sheets.addWorksheet', 'sheets.deleteWorksheet', 'sheets.insertRows', 'sheets.deleteRows', 'sheets.insertColumns', 'sheets.deleteColumns', 'sheets.mergeCells', 'sheets.unmergeCells', 'sheets.sortRange'].includes(operation.kind)) await flushDrafts(view?.id);
    const pending = editQueue.current.run(id, async () => { const current = stateRef.current.documents.find(d => d.id === id)!; const patch = await call<PreparedPatch>('prepare', { documentId: id, expectedRevision: current.revision, operation }); const receipt = await call<Receipt>('commit', { patchId: patch.id, idempotencyKey: crypto.randomUUID() }); lastTransactions.current.set(receipt.documentId, receipt.transactionId); await refresh(); });
    void pending.catch(alert); return pending;
  }
  function publishTextDraft(documentId: string) {
    const draft = textDrafts.current.get(documentId);
    setDrafts(previous => { const next = { ...previous }; if (draft) next[documentId] = draft.text; else delete next[documentId]; return next; });
  }
  function queueTextDraft(documentId: string) {
    const draft = textDrafts.current.get(documentId);
    if (!draft || draft.conflict || textDraftQueued.current.has(documentId) || [...textCompositions.current.values()].some(item => item.documentId === documentId)) return;
    textDraftQueued.current.add(documentId);
    let compositionPaused = false;
    const pending = editQueue.current.run(documentId, () => drainTextDraft(documentId)).catch(error => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'TEXT_COMPOSING') { compositionPaused = true; return; }
      const remaining = textDrafts.current.get(documentId);
      if (remaining) { remaining.conflict = error instanceof Error ? error.message : String(error); publishTextDraft(documentId); }
      alert(error);
    }).finally(() => {
      textDraftQueued.current.delete(documentId);
      if (!compositionPaused) queueTextDraft(documentId);
    });
    void pending;
  }
  async function drainTextDraft(documentId: string) {
    // Yield between bounded batches so text typing cannot starve other queued
    // reader actions. Each request is based on a frozen source/version pair.
    for (let turn = 0; turn < 8; turn++) {
      const waiting = textDrafts.current.get(documentId); if (!waiting || waiting.conflict) return;
      if ([...textCompositions.current.values()].some(item => item.documentId === documentId)) return;
      await textEditorBarrier({ documentId, checkOnly: false });
      if ([...textCompositions.current.values()].some(item => item.documentId === documentId)) return;
      await refresh();
      if ([...textCompositions.current.values()].some(item => item.documentId === documentId)) return;
      const draft = textDrafts.current.get(documentId); if (!draft || draft.conflict) return;
      const frozen = { ...draft }, current = stateRef.current.documents.find(item => item.id === documentId);
      if (!current || !['markdown', 'html'].includes(current.format)) throw new Error('文档已关闭或格式已变化；本地文本草稿已保留。');
      const merged = mergeTextDraft(frozen.baseText, frozen.text, current.model.text ?? '');
      if (!merged) throw new Error('本地输入与其他修改重叠，未覆盖任何内容。本地草稿已保留，请撤销本地冲突修改后重试。');
      let revision = current.revision;
      if (merged.operation) {
        let patch: PreparedPatch;
        try { patch = await call<PreparedPatch>('prepare', { documentId, expectedRevision: revision, viewId: frozen.viewId, operation: { kind: 'text.replace', ...merged.operation } }); }
        catch (error) { if (turn < 7 && isTextVersionConflict(error)) continue; throw error; }
        if ([...textCompositions.current.values()].some(item => item.documentId === documentId)) return;
        const idempotencyKey = crypto.randomUUID();
        let receipt: Receipt;
        try { receipt = await call<Receipt>('commit', { patchId: patch.id, idempotencyKey }); }
        catch (error) {
          // A lost response may follow a successful commit. Retry its exact
          // receipt identity once before considering any newly based operation.
          try { receipt = await call<Receipt>('commit', { patchId: patch.id, idempotencyKey }); }
          catch (retryError) { if (turn < 7 && isTextVersionConflict(error) && isTextVersionConflict(retryError)) continue; throw retryError; }
        }
        revision = receipt.revision;
        lastTransactions.current.set(documentId, receipt.transactionId);
      }
      // Keep the draft visible until the workspace covers the acknowledged
      // commit. Removing it first briefly feeds old source back to CodeMirror,
      // whose external-change mapping can erase the user's undo history.
      const synchronized = await refresh(), observed = synchronized.documents.find(item => item.id === documentId);
      if (!observed || observed.revision < revision) continue;
      const remaining = textDrafts.current.get(documentId);
      if (!remaining) return;
      if (remaining.generation === frozen.generation) textDrafts.current.delete(documentId);
      else {
        const next = mergeTextDraft(frozen.text, remaining.text, merged.text);
        if (!next) throw new Error('同步期间的新输入与其他修改重叠。本地草稿已保留，请处理冲突后重试。');
        remaining.baseText = merged.text; remaining.baseRevision = revision; remaining.text = next.text;
      }
      publishTextDraft(documentId);
    }
  }
  function isTextVersionConflict(error: unknown) {
    return !!error && (typeof error === 'object' && 'code' in error && error.code === 'VERSION_CONFLICT' || /\bVERSION_CONFLICT\b/.test(error instanceof Error ? error.message : String(error)));
  }
  function editText(text: string, change?: TextEditorChange) {
    const id = change?.documentId ?? document?.id, editorViewId = change?.viewId ?? view?.id;
    if (!id || !editorViewId) return;
    const source = stateRef.current.documents.find(item => item.id === id);
    if (!source || !['markdown', 'html'].includes(source.format)) return;
    let draft = textDrafts.current.get(id);
    if (!draft) {
      draft = { documentId: id, viewId: editorViewId, baseRevision: change?.baseRevision ?? source.revision, baseText: change?.fromText ?? source.model.text ?? '', text, generation: 1 };
      textDrafts.current.set(id, draft);
    } else {
      const merged = change && change.fromText !== draft.text ? mergeTextDraft(change.fromText, text, draft.text) : { text };
      draft.text = merged?.text ?? text; draft.generation++; draft.viewId = editorViewId;
      draft.conflict = merged ? undefined : '同步时编辑位置已变化，本地输入已保留，请处理冲突后重试。';
    }
    publishTextDraft(id); queueTextDraft(id);
  }
  async function performClose(target: ViewInfo) { try { await flushDrafts(target.id); await call('close', { viewId: target.id, retainRecovery: true }); setTabOrder(order => order.filter(id => id !== target.id)); if (activeId === target.id) setActiveId(undefined); setClosing(undefined); await refresh(); setWebStartupReady(true); } catch(e) { alert(e); } }
  async function closeTab(target: ViewInfo) { chooseInitialPage(); try { await flushDrafts(target.id); const fresh = await refresh(), d = fresh.documents.find(item => item.id === target.documentId); if(d?.dirty) setClosing(target); else await performClose(target); } catch (error) { alert(error); } }
  async function saveAndClose() { if(!closing)return;setClosingBusy(true);try{await flushDrafts(closing.id); const doc=stateRef.current.documents.find(d=>d.id===closing.documentId)!;if(desktop){if(!await call('choose-save',{documentId:doc.id}))return;}else{if(!doc.path)throw new Error('请先另存文档。');await call('save',{documentId:doc.id});}await performClose(closing);}catch(e){alert(e);}finally{setClosingBusy(false);} }
  async function navigate(direction: 'back' | 'forward') { if (document?.format === 'web' && desktop) { await call('browser-navigate', { viewId: view!.id, action: direction }); return; } const source = direction === 'back' ? history : future, dest = direction === 'back' ? future : history; const id = source.current.pop(); const next = workspace.views.find(v => v.id === id); if (next) { if (view) dest.current.push(view.id); await activate(next, false); } }
  function presentAIResult(result: ResultIdentity) {
    setAIHistory(previous => [result, ...previous.filter(item => item.taskId !== result.taskId)].slice(0, 50));
    if (foreground.current.viewId === result.viewId && !foreground.current.homeId) { setAIResult(result); setDrawer(null); }
  }
  async function send(message = prompt) {
    if (!message.trim() || !view || aiPending) return;
    const targetView = view.id;
    if (!driver) { setToast('请先通过“连接模型”配置问答模型。'); return; }
    setAIPending(true);
    try {
      await flushDrafts(targetView);
      const source = fixed?.context.viewId === targetView ? fixed : await call<ReadingSnapshot>('snapshot', { viewId: targetView });
      const scope = source.context.selection.text ? 'selection' : 'visible';
      const task = await call<HarnessTask>('harness-submit', { driverId: driver, prompt: message.trim(), viewId: targetView, snapshotId: source.id, sourceScope: scope });
      presentAIResult({ taskId: task.id, label: '阅读问答', viewId: targetView, snapshotId: source.id, sourceText: scope === 'selection' ? source.context.selection.text : source.context.visibleText, sourceRevision: source.document.revision, source: source.document.title + ' · ' + (scope === 'selection' ? '选中内容' : '当前可见') + ' · 版本 ' + source.document.revision, retryable: false });
      if (foreground.current.viewId === targetView && !foreground.current.homeId) setPrompt(current => current === message ? '' : current);
      await refresh();
    } catch (error) { alert(error); } finally { setAIPending(false); }
  }
  async function runAIReadingTool(tool: AIReadingToolDefinition, scope: AIReadingScope) {
    if (!view || aiPending || scope === 'document') return;
    const targetView = view.id, sourceTitle = document?.title ?? '当前文档';
    setAIPending(true);
    try {
      await flushDrafts(targetView);
      const source = fixed?.context.viewId === targetView ? fixed : await call<ReadingSnapshot>('snapshot', { viewId: targetView });
      const result = await call<{ task: HarnessTask }>('ai-reading-run', { viewId: targetView, snapshotId: source.id, toolId: tool.id, scope, idempotencyKey: crypto.randomUUID() });
      presentAIResult({ taskId: result.task.id, label: tool.label, source: sourceTitle + ' · ' + (scope === 'selection' ? '选中内容' : '当前可见') + ' · 版本 ' + source.document.revision, viewId: targetView, snapshotId: source.id, sourceText: scope === 'selection' ? source.context.selection.text : source.context.visibleText, sourceRevision: source.document.revision, retryable: true });
      await refresh();
    } catch (error) { throw error; }
    finally { setAIPending(false); }
  }
  async function saveAIResult(task: HarnessTask) {
    try {
      const identity = aiHistory.find(item => item.taskId === task.id) ?? aiResult;
      const text = identity?.retryable ? (await call<{ markdown: string }>('ai-reading-result', { taskId: task.id })).markdown : task.text;
      const next = await call<ViewInfo>('create-text', { title: (identity?.label ?? 'AI 分析') + '.md', text, windowId }); await activate(next, true); setAIResult(undefined);
    }
    catch (error) { alert(error); }
  }
  async function retryAIResult() {
    if (!aiResult?.retryable || aiPending) return;
    const previous = aiResult; setAIPending(true);
    try { const result = await call<{ task: HarnessTask }>('ai-reading-retry', { taskId: previous.taskId, idempotencyKey: crypto.randomUUID() }); presentAIResult({ ...previous, taskId: result.task.id }); await refresh(); }
    catch (error) { alert(error); } finally { setAIPending(false); }
  }
  async function fixContext() { if (!view) return; try { await flushDrafts(view.id); setFixed(await call<ReadingSnapshot>('snapshot', { viewId: view.id })); } catch (error) { alert(error); } }
  async function translateSelection(viewId: string, text: string, sourceRevision: number, locator?: Card['locator'], retry?: Card, language = String(val('translation.targetLanguage', 'zh-CN')), connectionId = retry?.connectionId ?? selectionProfile) {
    if (!text.trim()) return;
    const card: Card = { id: retry?.id ?? crypto.randomUUID(), requestId: crypto.randomUUID(), viewId, source: text, result: '', sourceRevision, locator, pinned: retry?.pinned ?? false, status: 'loading', targetLanguage: language, connectionId };
    if (!retry?.pinned) latestTranslationRequest.current.set(viewId, card.requestId!);
    for (const previous of cardsRef.current) if (previous.status === 'loading' && previous.viewId === viewId && (previous.id === card.id || (!retry && !previous.pinned))) void cancelTranslation(previous);
    updateCards(old => retry ? old.map(item => item.id === retry.id ? card : item) : [...old.filter(item => item.pinned || item.viewId !== viewId), card]);
    if (val('translation.selectionPresentation', 'popover') === 'drawer' && foreground.current.viewId === viewId) setDrawer('translation');
    try {
      const result = await call<{ text: string; model?: string }>('translation-selection', { viewId, text, sourceRevision, requestId: card.requestId, retryOf: retry?.requestId, targetLanguage: language, connectionId: connectionId || undefined });
      updateCards(old => old.map(item => item.requestId === card.requestId && item.status === 'loading' ? { ...item, result: result.text, model: result.model, status: 'ready' } : item));
    } catch (error) { updateCards(old => old.map(item => item.requestId === card.requestId && item.status === 'loading' ? { ...item, error: String(error), status: 'error' } : item)); }
  }
  async function cancelTranslation(card: Card) {
    updateCards(old => old.map(item => item.id === card.id ? { ...item, status: 'cancelled' } : item));
    if (card.requestId) await call('translation-selection-cancel', { requestId: card.requestId, viewId: card.viewId }).catch(() => {});
  }
  function closeTranslation(card: Card) { if (card.status === 'loading') void cancelTranslation(card); updateCards(old => old.filter(item => item.id !== card.id)); }
  async function saveTranslation(card: Card) {
    try { const text = `# 选区译文\n\n${card.result}\n\n---\n\n目标语言：${card.targetLanguage ?? 'zh-CN'} · 来源版本：${card.sourceRevision}\n\n## 原文\n\n${card.source}`; const next = await call<ViewInfo>('create-text', { title: '选区译文.md', text, windowId }); await activate(next, true); }
    catch (error) { alert(error); }
  }
  function translationCard(card: Card) {
    const sourceView = workspace.views.find(item => item.id === card.viewId), sourceDocument = workspace.documents.find(item => item.id === sourceView?.documentId);
    return <TranslationCard key={card.id} card={card} models={connectionProfiles} onModel={connectionId => void translateSelection(card.viewId, card.source, card.sourceRevision, card.locator, card, card.targetLanguage, connectionId)} sourceUpdated={sourceDocument?.revision !== card.sourceRevision} onPin={() => updateCards(old => old.map(item => item.id === card.id ? { ...item, pinned: !item.pinned } : item))} onRetry={language => void translateSelection(card.viewId, card.source, card.sourceRevision, card.locator, card, language)} onCancel={() => void cancelTranslation(card)} onClose={() => closeTranslation(card)} onSave={() => void saveTranslation(card)} />;
  }
  async function fullTranslation() { if (!document) return; try { await flushDrafts(view?.id); const job = await call<TranslationJob>('translation-start', { documentId: document.id, windowId }); setTranslationJobs(old => [...old.filter(item => item.id !== job.id), job]); setDrawer('tasks'); setToast('已在后台生成独立译文。'); } catch (e) { alert(e); } }
  async function webTranslate(scope: 'page' | 'selection') { if (!view) return; setWebBusy(true); try { const result = await call<{ translated: number; skipped: number }>('web-translation-apply', { viewId: view.id, scope }); setWebTranslated(old => ({ ...old, [view.id]: true })); setToast('已在当前网页替换 ' + result.translated + ' 处文字；跳过 ' + result.skipped + ' 处。'); } catch (e) { alert(e); } finally { setWebBusy(false); } }
  async function webRestore() { if (!view) return; try { const result = await call<{ restored: number; skipped: number }>('web-translation-restore', { viewId: view.id }); setWebTranslated(old => ({ ...old, [view.id]: false })); setToast('恢复 ' + result.restored + ' 处原文；' + result.skipped + ' 处因页面更新而保留。'); } catch (e) { alert(e); } }
  async function controlAgent(status: 'running' | 'paused' | 'stopped') { if (!view) return; try { await call('agent-control', { viewId: view.id, status }); if (status === 'stopped' && view.agentState) await call('agent-release', { viewId: view.id, controlId: view.agentState.controlId }); setAgentStatuses(old => ({ ...old, [view.id]: status })); if (status === 'stopped') { setAgentEvent(previous => eventForView(previous, view) ? undefined : previous); setToast('已停止并释放此页面的 Agent 操作。'); await refresh(); } } catch (e) { alert(e); } }
  const outline = useMemo(() => document?.format === 'markdown' && markdownOutline?.documentId === document.id && markdownOutline.viewId === view?.id ? markdownOutline.items : documentOutlineItems(document, htmlOutline && htmlOutline.documentId === document?.id && htmlOutline.revision === document?.revision ? htmlOutline.items : []), [document?.id, document?.format, document?.model, document?.revision, view?.id, htmlOutline, markdownOutline]);
  const currentCards = cards.filter(card => card.viewId === view?.id), newestCard = currentCards.at(-1), activeJob = translationJobs.find(job => job.status === 'running');
  const readingTask = aiResult ? workspace.tasks.find(item => item.id === aiResult.taskId) : undefined;
  const showingAIResult = !!readingTask && aiResult?.viewId === view?.id;
  useEffect(() => window.agentViewer?.onToolbar(event => {
    if (event.action === 'ai-result-dismiss') setAIResult(previous => previous?.taskId === event.taskId ? undefined : previous);
    if (event.action === 'ai-result-retry' && aiResult?.taskId === event.taskId) void retryAIResult();
    if (event.action === 'ai-result-save' && aiResult?.taskId === event.taskId) {
      const result = workspace.tasks.find(item => item.id === event.taskId); if (result) void saveAIResult(result);
    }
  }), [aiResult, workspace.tasks, aiPending]);
  useEffect(() => {
    if (!desktop) return;
    if (home || modalMotion.present || closing || drawer || document?.format !== 'web' || !view || !readingTask || aiResult?.viewId !== view.id) {
      const animate = !home && !modalMotion.present && !closing && document?.format === 'web' && !!view;
      void call('ai-result-layout', { visible: false, animate, hideDurationMs: aiPopoverDuration, viewId: animate ? view.id : undefined }).catch(alert); return;
    }
    const reader = window.document.querySelector('.reader-panel'); if (!reader) return;
    const update = () => {
      const box = reader.getBoundingClientRect(), width = Math.min(402, box.width - 24), height = Math.min(362, box.height - 24);
      void call('ai-result-layout', { viewId: view.id, taskId: readingTask.id, visible: true, label: aiResult.label, source: aiResult.source, retryable: aiResult.retryable && !aiPending, settings,
        bounds: { x: Math.max(box.x + 12, box.right - width - 12), y: Math.min(box.y + 78, box.bottom - height - 12), width, height } }).catch(alert);
    };
    const observer = new ResizeObserver(update); observer.observe(reader); window.addEventListener('resize', update); update();
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [home, modalMotion.present, closing, drawer, document?.format, document?.revision, view?.id, readingTask?.id, readingTask?.text, readingTask?.status, aiResult, aiPending, aiPopoverDuration, settings?.revision, leftOpen, officeContribution]);
  const openSample = (path: string) => { void openHomeUri(path).catch(alert); };
  const openWebFixture = () => { const existing = viewList.find(v => workspace.documents.find(d => d.id === v.documentId)?.format === 'web'); void (existing ? openHomeDocument(existing.documentId) : openHomeUri(new URL('/fixtures/interaction.html', window.location.href).href)).catch(alert); };
  const locationText = context?.locator.pageIndex !== undefined ? '第 ' + (context.locator.pageIndex + 1) + ' 页' : context?.locator.cell ?? context?.locator.quote?.slice(0, 52) ?? '正在确认阅读位置';
  const pdfCommand = (action: 'note' | 'highlight' | 'rotate' | 'add-page' | 'ocr' | 'clear-ocr', text?: string) => {
    if (!view || document?.format !== 'pdf') return;
    window.dispatchEvent(new CustomEvent('agentviewer:pdf-tool', { detail: { viewId: view.id, action, text } }));
  };
  const openReference = (event: React.MouseEvent) => { const anchor=(event.target as HTMLElement).closest<HTMLAnchorElement>('a'); if(!anchor?.href.startsWith('agentviewer://document/'))return;event.preventDefault();const url=new URL(anchor.href);void runForegroundOpen(() => call<ViewInfo>('document-open-view',{documentId:url.pathname.slice(1),windowId,activate:false}), false); };
  const officeSidebarTools = document && view && officeContribution && leftSection !== 'search' ? <div className="format-scroll motion-swap" key={'office:' + view.id}>{desktop ? <NativeOfficeTools documentId={document.id} viewId={view.id} format={document.format as "docx"|"pptx"|"xlsx"} category={officeCategory} beforeAction={async()=>{await flushDrafts(view.id,{preserveSelection:true});return call("office-status",{viewId:view.id});}} onError={alert} /> : <OfficeTools document={document} viewId={view.id} target={officeTarget?.viewId === view.id ? officeTarget : undefined} category={officeCategory} edit={edit} onNavigate={async target => { const controller = officeToolboxes.current.get(view.id); if (!controller || controller.documentId !== document.id) throw new Error('编辑视图尚未准备就绪。'); await controller.navigate(target); }} onFocusFormula={() => { try { officeToolboxes.current.get(view.id)?.focusFormula?.(); } catch (error) { alert(error); } }} canAnnotate={!!context?.selection.text && context.contentRevision === document.revision} onReviewAction={action => { if (action === 'annotations') setDrawer('annotations'); else window.dispatchEvent(new CustomEvent('agentviewer:selection-open', { detail: { viewId: view.id, action: 'note' } })); }} />}</div> : undefined;
  return <div onClickCapture={openReference} className={'app-shell ' + (home ? 'show-home' : '')}>
    <header className="tab-strip"><div className="brand brand-static" aria-label="AgentViewer"><span className="brand-mark"><img src={logoMark} alt="AgentViewer" /></span></div><div className="tabs">{tabOrder.map(id => { if (homeTabs.includes(id)) return <div className={'tab ' + (home && homeTabId === id ? 'active' : '')} key={id} data-home-tab-id={id}><button className="tab-select" onClick={() => void switchHomeTab(id)}><FilePlus2 size={17} /><span>新标签页</span></button><button className="icon-button tab-close" aria-label="关闭 新标签页" onClick={() => closeHomeTab(id)}><X size={14}/></button></div>; const v = viewList.find(v => v.id === id); if (!v) return null; const d = workspace.documents.find(item => item.id === v.documentId)!; return <div className={'tab ' + (!home && v.id === view?.id ? 'active' : '')} key={v.id} data-view-id={v.id} data-agent-phase={v.agentState?.phase}><button className="tab-select" aria-label={d.title} onClick={() => void activate(v)}><FileIcon format={d.format} /><span>{d.title}</span>{v.agentState && <span className="tab-agent-indicator" title={v.agentState.phase === "editing" ? "Agent 正在编辑此页" : "Agent 正在阅读此页"}>Agent</span>}{(d.dirty || officeDraftDirty[v.id]) && <span className="dirty-dot" />}</button><button className="icon-button tab-close" aria-label={'关闭 ' + d.title} onClick={() => void closeTab(v)}><X size={14} /></button></div>; })}<button className="icon-button new-tab" aria-label="新建标签页" title="新建标签页 · Ctrl+T" onClick={() => void newHomeTab()}><Plus size={18} /></button></div><div className="top-utility"><button className="icon-button" title="设置" onClick={() => void openSettings()}><Settings2 size={17} /></button></div><div className="window-controls">{desktop && <><button onClick={() => void call('window-control', { action: 'minimize' })} aria-label="最小化"><Minus size={16} /></button><button onClick={() => void call('window-control', { action: 'maximize' })} aria-label="最大化"><Square size={13} /></button><button onClick={() => void call('window-control', { action: 'close' })} aria-label="关闭窗口"><X size={17} /></button></>}</div></header>
    {home ? <div className="home-layout"><aside className="home-sidebar material-host"><LiquidGlassSurface variant="panel" /><div className="home-sidebar-head"><span>资源管理器</span></div><div className="home-tree"><div className="tree-caption"><ChevronDown size={14} /> 最近打开</div>{workspace.documents.map(d => <button key={d.id} className="file-row" onClick={() => void openHomeDocument(d.id).catch(alert)}><FileIcon format={d.format} /><span>{d.title}</span></button>)}<div className="tree-caption"><ChevronDown size={14} /> 示例文件</div>{sampleFiles.map(f => <button className="file-row" key={f.path} onClick={() => openSample(f.path)}><FileIcon format={f.format} /><span>{f.name}</span></button>)}<button className="file-row" onClick={openWebFixture}><Globe size={17} /><span>交互测试页</span></button>{artifacts.length > 0 && <><div className="tree-caption"><ChevronDown size={14} /> 生成的译文</div>{artifacts.map(a => <button className="file-row" key={a.id} onClick={() => void openHomeUri(a.path).catch(alert)}><Languages size={17} /><span>{a.path.split(/[\\/]/).at(-1)}</span></button>)}</>}</div></aside><main className="home-main"><div className="home-hero"><div className="home-kicker">YOUR READING WORKSPACE</div><h1>从这里继续阅读。</h1><p>打开文档、网页或最近的工作，把当前阅读位置直接交给 AI。</p><HomeSearch key={homeTabId} pending={!!pendingHomes[homeTabId ?? ""]} query={homeQueries[homeTabId ?? ""] ?? ""} onQueryChange={query => { if (homeTabId) setHomeQueries(previous => ({ ...previous, [homeTabId]: query })); }} candidates={homeCandidates} onOpenUri={openHomeUri} onOpenCandidate={openHomeCandidate} /><div className="home-actions"><button className="button primary" onClick={() => void openFile()}><FolderOpen size={17} />打开文件</button><button className="button" onClick={() => setModal('new')}><FilePlus2 size={17} />新建文档</button></div></div><div className="home-columns"><section><div className="home-section-title"><h2>继续阅读</h2><span>{viewList.length} 个标签</span></div><div className="recent-grid">{viewList.slice(-6).reverse().map(v => { const d = workspace.documents.find(item => item.id === v.documentId)!; return <button key={v.id} className="recent-card material-host" onClick={() => void openHomeDocument(v.documentId).catch(alert)}><LiquidGlassSurface variant="button" /><span className="recent-icon"><FileIcon format={d.format} /></span><strong>{d.title}</strong><small>{tone(d.format)} · {v.context?.locator.quote?.slice(0, 28) ?? '打开文档'}</small><ChevronRight size={16} /></button>; })}</div></section><section><div className="home-section-title"><h2>生成文档</h2><span>{artifacts.length} 个译文</span></div><p className="home-muted">文档全文翻译会在后台生成独立文件，原文保持原样。</p>{artifacts.slice(-3).reverse().map(a => <button className="artifact-row" key={a.id} onClick={() => void openHomeUri(a.path).catch(alert)}><Languages size={18} /><span>{a.sourceTitle} → {a.targetLanguage}</span><ChevronRight size={15} /></button>)}</section></div></main></div> :
    <div ref={workbench} className="workbench motion-layout overlay-reading" style={{ '--reader-left-inset': document?.format === 'web' ? '12px' : '73px', '--reader-left-width': panelLayout.leftWidth + 'px', '--reader-right-width': panelLayout.rightWidth + 'px' } as CSSProperties}>
      {document?.format !== 'web' && <nav className="activity-rail material-host" aria-label="文档工具"><LiquidGlassSurface variant="panel" />{document?.format==='markdown'&&<button aria-label="文件与快速打开" title="文件与快速打开 · Ctrl+P" className={leftSection==='files'&&leftOpen?'selected':''} onClick={()=>{setLeftSection('files');setLeftOpen(true);}}><FolderOpen size={20}/></button>}{officeContribution && document ? <OfficeToolboxRail format={document.format} section={leftSection} open={leftOpen} onSelect={category => { const key = 'office:' + category; setLeftOpen(leftSection === key ? !leftOpen : true); setLeftSection(key); }} /> : <button className={leftSection === 'outline' && leftOpen ? 'selected' : ''} aria-label="目录与结构" aria-pressed={leftSection === 'outline' && leftOpen} title="目录与结构" onClick={() => { setLeftOpen(leftSection === 'outline' ? !leftOpen : true); setLeftSection('outline'); }}><ListTree size={21} /></button>}<button className={leftSection === 'search' && leftOpen ? 'selected' : ''} aria-label="查找" aria-pressed={leftSection === 'search' && leftOpen} title="查找" onClick={() => { setLeftOpen(leftSection === 'search' ? !leftOpen : true); setLeftSection('search'); }}><Search size={20} /></button>{!officeContribution && <button className={leftSection === 'tools' && leftOpen ? 'selected' : ''} aria-label={tone(document?.format) + '工具'} aria-pressed={leftSection === 'tools' && leftOpen} title={tone(document?.format) + '工具'} onClick={() => { setLeftOpen(leftSection === 'tools' ? !leftOpen : true); setLeftSection('tools'); }}><FormatToolIcon format={document?.format} /></button>}</nav>}
      <MotionPresence show={!home && leftOpen && document?.format !== 'web'} surface="left" duration={220} identity={motionIdentity}><NativeSidebarPortal enabled={false} viewId={view?.id} side="left">{<AdaptivePanel availableHost={workbench} contentIdentity={String(view?.id) + ':' + leftSection} bodyClassName="format-scroll" className="format-sidebar floating-side-panel material-host" data-side="left" id="format-tools"><LiquidGlassSurface variant="panel" /><ReaderPanelResizeHandle side="left" width={panelLayout.leftWidth} workbench={workbench} onCommit={commitPanelWidth} /><div className="format-heading"><span>{tone(document?.format)}工具</span></div>
      {officeSidebarTools ?? (document?.format === 'markdown' && leftSection === 'files' ? <MarkdownWorkspace documentId={document.id} onOpen={(uri,line)=>{void openUri(uri).then(next=>{if(next&&line)void revealMarkdown(next.id,{line});}).catch(alert);}} onError={alert}/> : leftSection === 'outline' ? <div className="format-scroll motion-swap" key={leftSection}><div className="side-label">当前位置</div><div className="location-chip"><span className="connection-dot ready" />{locationText}</div><div className="side-label">结构导航</div>{outline.map(item => <button className="outline-item" key={item.id ?? item.index} onClick={() => { if (document?.format === 'markdown' && view && item.from !== undefined) window.dispatchEvent(new CustomEvent('agentviewer:markdown-navigate', {detail:{viewId:view.id,from:item.from}})); else if (document?.format === 'pdf') scrollReadingTarget(window.document.querySelectorAll<HTMLElement>('.pdf-page')[item.index]); else if (document?.format === 'html' && view) window.dispatchEvent(new CustomEvent('agentviewer:html-navigate', { detail: { viewId: view.id, documentId: document.id, revision: document.revision, index: item.index, title: item.title, blockId: item.id, actor: 'human' } })); else window.dispatchEvent(new CustomEvent('agentviewer:navigate-structure', { detail: { index: item.index } })); }}>{item.title}</button>)}{!outline.length && <p className="side-hint">当前文档暂无可用大纲。</p>}</div> : leftSection === 'search' ? <div className="format-scroll motion-swap" key={leftSection}><label className="search-field material-host"><LiquidGlassSurface variant="search" /><Search size={16} /><input placeholder="查找当前文档" onKeyDown={e => { if (e.key === 'Enter' && document) void call<{ results: unknown[] }>('search', { documentId: document.id, query: e.currentTarget.value }).then(result => setToast('找到 ' + result.results.length + ' 处；当前引擎提供文本定位结果。')).catch(alert); }} /></label><p className="side-hint">按 Enter 搜索。源文件中的查找范围由格式引擎决定。</p></div> : <div className="format-scroll motion-swap" key={leftSection}><div className="side-label">阅读与编辑</div>{document?.format === 'markdown' && view && <><MarkdownTools viewId={view.id} /><MarkdownResources documentId={document.id} viewId={view.id} onError={alert}/><MarkdownPreferences documentId={document.id} viewId={view.id} onError={alert}/></>}{['markdown','html'].includes(document?.format ?? '') && <p className="side-hint">源码与分栏模式可在顶部操作胶囊中切换。</p>}{document?.format === 'pdf' && <div className="pdf-side-tools"><p className="side-hint">选中文字后，在浮窗中高亮、标记或添加批注。</p><button className="tool-row" onClick={() => pdfCommand('rotate')}>旋转当前页</button><button className="tool-row" onClick={() => pdfCommand('add-page')}>增加页面</button><div className="side-label">扫描文字</div><button className="tool-row" disabled={pdfTools.ocrBusy} onClick={() => pdfCommand('ocr')}>{pdfTools.ocrBusy ? '识别中…' : '识别本页'}</button>{pdfTools.ocrResult && <section className="pdf-side-result" aria-live="polite"><div><strong>第 {pdfTools.ocrResult.pageIndex + 1} 页 · {pdfTools.ocrResult.confidence}%</strong><button onClick={() => pdfCommand('clear-ocr')}>关闭</button></div><p>{pdfTools.ocrResult.text || '未识别出文字。'}</p></section>}<p className="side-hint">扫描文字仅显示在工具栏，不写入原 PDF。</p></div>}</div>)}</AdaptivePanel>}</NativeSidebarPortal></MotionPresence>
      <main className={"reader-panel reader-format-" + (document?.format ?? "none")} onMouseMove={event => navigation.revealFromEdge(event.clientY - event.currentTarget.getBoundingClientRect().top)}>
        {document && (!desktop || document.format !== 'web') && <NavigationToolbar key={'navigation:' + view?.id}
          state={{ format: document.format, zoom: view?.zoom ?? 1, title: document.title, titleIcon: <FileIcon format={document.format} />, address: document.model.url, mode: view?.mode, canUndo, busy: webBusy, translated: view ? webTranslated[view.id] : false }}
          dispatch={action => void navigationAction(action)} progress={navigation.progress} durationMs={navigationDuration} manualHidden={navigation.manualHidden}
          onHover={navigation.onHover} onLeave={navigation.onLeave} onFocus={navigation.onFocus} onBlur={navigation.onBlur} />}
      {document?.format === 'web' && !webStartupReady ? <div className="native-web-placeholder" role="status">正在恢复阅读位置…</div> : document && view ? <DocumentPane key={view.id} document={document} view={view} draftPending={drafts[document.id]!==undefined} edit={edit} onTextChange={editText} reportError={alert} onPdfToolsChange={setPdfTools} onOfficeTargetChange={setOfficeTarget} onOfficeDraftController={onOfficeDraftController} onOfficeDraftChange={onOfficeDraftChange} onOfficeToolboxController={onOfficeToolboxController} htmlOutline={htmlOutline?.documentId === document.id && htmlOutline?.revision === document.revision ? htmlOutline.items : []} navigationRequest={officeNavigation?.viewId === view.id && officeNavigation.documentId === document.id && officeNavigation.expectedRevision === document.revision && !(document.format === 'html' && drafts[document.id] !== undefined) ? officeNavigation : undefined} onOfficeNavigationResult={onOfficeNavigationResult} onReaderScroll={onReaderScroll} onZoomChange={factor => void navigationAction({ type: 'zoom', factor }, false)} obscured={modalMotion.present || !!closing} annotations={annotations} /> : <div className="empty-workspace"><BookOpen size={40} /><h1>打开文档，开始阅读</h1><button className="button primary" onClick={() => void openFile()}>打开文件</button></div>}
      <MotionPresence show={(eventForView(agentEvent, view) || !!view?.agentState) && document?.format !== 'web'} surface="agent" duration={200} identity={view?.id} keyboardImmediate={false}>{view && <AgentOperationCapsule kind={eventForView(agentEvent, view) ? agentEvent?.data.kind : view.agentState?.phase} status={agentStatuses[view!.id] ?? 'running'} target={val('agent.capsuleDetail', 'minimal') === 'target' ? document?.title : undefined} onControl={status => void controlAgent(status)} />}</MotionPresence>
      {agentEvent && eventForView(agentEvent, view) && <>{val('agent.pointer', true) && agentEvent.data.point && document?.format !== 'web' && <ReaderAgentPointer point={agentEvent.data.point} eventSeq={agentEvent.seq} />}{agentEvent.data.target && <AgentTargetHighlight event={agentEvent} />}</>}
      {document && !officeContribution && document.warnings.length > 0 && <div className="engine-notice" title={[...document.warnings, ...document.capabilities.limitations].join('\n')}>{document.warnings[0]}</div>}</main>
      <MotionPresence show={!!drawer} surface="right" duration={220} identity={motionIdentity}><NativeSidebarPortal enabled={desktop && document?.format === 'web'} viewId={view?.id} side="right">{<AdaptivePanel availableHost={workbench} contentIdentity={String(view?.id) + ':' + drawer} bodyClassName="drawer-content" className="ai-drawer floating-side-panel material-host" data-side="right" id="ai-tools"><LiquidGlassSurface variant="panel" /><ReaderPanelResizeHandle side="right" width={panelLayout.rightWidth} workbench={workbench} onCommit={commitPanelWidth} /><div className="drawer-heading"><div><span className="eyebrow">ASSISTANT</span><h2>{drawer === 'annotations' ? '批注与高亮' : drawer === 'translation' ? '选区译文' : drawer === 'tasks' ? '后台任务' : 'AI 工具'}</h2></div><button className="icon-button" aria-label="关闭 AI 抽屉" onClick={() => setDrawer(null)}><X size={17} /></button></div><div className="drawer-content motion-swap" key={drawer}>{drawer === 'annotations' ? <>{annotations.length===0&&<p className="side-hint">选中文字后添加批注或高亮。</p>}{annotations.map(note=><div className="job-card" key={note.id}><strong>{note.kind==='note'?'批注':'高亮'}{note.sourceRevision!==document?.revision?' · 来源已更新':''}</strong><blockquote>{note.selection.text}</blockquote>{note.text&&<p>{note.text}</p>}<button onClick={()=>void call('annotation-remove',{id:note.id}).then(refreshAnnotations).catch(alert)}>删除</button></div>)}</> : drawer === 'translation' ? currentCards.length ? currentCards.map(translationCard) : <p className="side-hint">选择文档中的文字，即可在这里阅读独立译文。</p> : drawer === 'tasks' ? <><div className="side-label">文档译文</div>{translationJobs.slice().reverse().map(job => <div className="job-card" key={job.id}><strong>{job.stage}</strong><span>{job.status === 'running' ? (job.total ? job.completed + ' / ' + job.total : '准备中') : job.status}</span>{job.error && <p>{job.error}</p>}{job.artifact && <button onClick={() => void openUri(job.artifact!.path)}>打开译文 <ExternalLink size={13} /></button>}{job.status === 'running' && <button onClick={() => void call('translation-cancel', { jobId: job.id }).catch(alert)}>取消</button>}{['paused','failed','cancelled'].includes(job.status) && <button onClick={() => void call('translation-resume', { jobId: job.id }).then(refreshTranslations).catch(alert)}>继续</button>}</div>)}<div className="side-label">Harness</div>{workspace.tasks.length ? workspace.tasks.slice().reverse().map(task => <div className="job-card" key={task.id}><strong>{aiHistory.find(item => item.taskId === task.id)?.label ?? task.prompt}</strong><span>{({ running: "进行中", completed: "已完成", failed: "失败", cancelled: "已停止" })[task.status]}</span><pre>{task.text || task.error || "等待回复…"}</pre>{aiHistory.some(item => item.taskId === task.id && item.viewId === view?.id) && <button onClick={() => { setAIResult(aiHistory.find(item => item.taskId === task.id)); setDrawer(null); }}>查看结果</button>}{task.status === "running" && <button onClick={() => void call("harness-cancel", { taskId: task.id }).catch(alert)}>停止</button>}</div>) : <p className="side-hint">暂无任务。</p>}</> : <><div className="tool-grid"><button onClick={() => { if (document?.format === 'web') void webTranslate('selection'); else if (view && context?.selection.text) void translateSelection(view.id, context.selection.text, context.contentRevision, context.selection.locator); else setToast('请先选择文档文字。'); }}><Languages size={19} />翻译选区</button><button title={document?.format === 'pdf' && !pdfEngineAvailable ? '需要 BabelDOC 引擎' : undefined} onClick={() => void fullTranslation()} disabled={!document || document.format === 'web' || (document.format === 'pdf' && !pdfEngineAvailable)}><FilePlus2 size={19} />生成全文译文</button><button aria-pressed={fixed?.context.viewId === view?.id} onClick={() => { if (fixed?.context.viewId === view?.id) setFixed(undefined); else void fixContext(); }}><Pin size={19} />{fixed?.context.viewId === view?.id ? '解除固定来源' : '固定上下文'}</button></div><AIReadingTools context={context} snapshot={fixed?.context.viewId === view?.id ? fixed : undefined} format={document?.format} busy={aiPending} onRun={runAIReadingTool} />{aiHistory.some(item => item.viewId === view?.id) && <><div className="side-label">本页最近结果</div>{aiHistory.filter(item => item.viewId === view?.id).slice(0, 8).map(item => <button key={item.taskId} className="ai-history-item" onClick={() => { setAIResult(item); setDrawer(null); }}><strong>{item.label}</strong><small>{({ running: "进行中", completed: "已完成", failed: "失败，可重试", cancelled: "已停止" })[workspace.tasks.find(task => task.id === item.taskId)?.status ?? "running"]} · {item.source}</small></button>)}</>}<div className="side-label">当前阅读位置</div><div className="context-summary"><Check size={15} /> {locationText}</div>{context?.selection.text && <><div className="side-label">已选中</div><blockquote className="selection-preview">{context.selection.text}</blockquote></>}<div className="side-label">Harness</div><div className="harness-line"><span className={'connection-dot ' + (driver ? 'ready' : '')} />{driver ? driver + ' · 已配置' : <button className="ai-connect-entry" onClick={() => void openSettings('模型与连接')}>连接模型</button>}</div></>}</div>{drawer === 'ai' && <form className="prompt-box" onSubmit={e => { e.preventDefault(); void send(); }}><textarea placeholder="基于当前选区或阅读位置提问…" value={prompt} onChange={e => setPrompt(e.target.value)} /><button className="button primary" disabled={!prompt.trim() || aiPending}><Send size={15} />发送</button></form>}</AdaptivePanel>}</NativeSidebarPortal></MotionPresence>
      <nav className="ai-rail material-host"><LiquidGlassSurface variant="panel" /><button onMouseDown={event => event.preventDefault()} aria-expanded={drawer === 'annotations'} aria-controls="ai-tools" className={drawer === 'annotations' ? 'selected' : ''} title="批注与高亮" aria-label="批注与高亮" onClick={() => setDrawer(drawer === 'annotations' ? null : 'annotations')}><MessageSquare size={20}/></button><button onMouseDown={event => event.preventDefault()} aria-expanded={drawer === 'ai'} aria-controls="ai-tools" className={drawer === 'ai' ? 'selected' : ''} title="AI 工具" onClick={() => setDrawer(drawer === 'ai' ? null : 'ai')}><Sparkles size={20} /></button><button onMouseDown={event => event.preventDefault()} aria-expanded={drawer === 'translation'} aria-controls="ai-tools" className={drawer === 'translation' ? 'selected' : ''} title="选区译文" onClick={() => setDrawer(drawer === 'translation' ? null : 'translation')}><Languages size={20} />{newestCard && <span className="rail-dot" />}</button><button onMouseDown={event => event.preventDefault()} aria-expanded={drawer === 'tasks'} aria-controls="ai-tools" className={drawer === 'tasks' ? 'selected' : ''} title="任务" onClick={() => setDrawer(drawer === 'tasks' ? null : 'tasks')}><ListTodo size={20} />{activeJob && <span className="rail-dot" />}</button><div className="rail-spacer" /><button title="帮助" onClick={() => setToast('阅读位置、选区和视图身份会随任务固定；Ctrl+, 打开设置。')}><CircleHelp size={20} /></button></nav>
      <MotionPresence show={!drawer && !showingAIResult && !!newestCard && val('translation.selectionPresentation', 'popover') === 'popover'} surface="ai-popover" duration={300} keyboardImmediate={false} identity={motionIdentity}>{!drawer && !showingAIResult && newestCard && val('translation.selectionPresentation', 'popover') === 'popover' && <div className="translation-popover material-host"><LiquidGlassSurface variant="panel" effect="refractive" strength={.82} specularOpacity={.24} />{translationCard(newestCard)}<button className="popover-expand" onClick={() => setDrawer('translation')}>展开译文 <ChevronRight size={14} /></button></div>}</MotionPresence><MotionPresence show={!drawer && document?.format !== 'web' && !!readingTask && aiResult?.viewId === view?.id} surface="ai-popover" duration={300} keyboardImmediate={false} identity={motionIdentity}>{readingTask && aiResult && <AIResultPopover task={readingTask} label={aiResult.label} source={aiResult.source} sourceText={aiResult.sourceText} sourceUpdated={document?.revision !== aiResult.sourceRevision} onRetry={aiResult.retryable && !aiPending ? () => void retryAIResult() : undefined} onClose={() => setAIResult(undefined)} onCancel={() => void call('harness-cancel', { taskId: readingTask.id }).catch(alert)} onSave={() => void saveAIResult(readingTask)} />}</MotionPresence></div>}
    <ReaderPanelGeometryHost workbench={workbench} viewId={view?.id} active={!home && !!view && document?.format === 'web' && !modalMotion.present && !closing} identity={String(motionIdentity) + ':' + leftOpen + ':' + drawer} reportError={alert} />
    {document?.format==='markdown'&&markdownPreferences?.documentId===document.id&&markdownPreferences.value.themeCss&&<style>{'@scope (.document-content) {'+markdownPreferences.value.themeCss+'}'}</style>}<FileDropHost beforeOpen={() => flushDrafts()} onOpened={result => void handleFilesOpened(result)} reportError={alert} />
    <MotionPresence show={!!toast} surface="toast" duration={180} keyboardImmediate={false}>{toast && <div role="status" className="toast material-host" onClick={() => setToast('')}><LiquidGlassSurface variant="capsule" /><span className="motion-swap" key={toast}>{toast}</span></div>}</MotionPresence>
    <MotionPresence show={!!closing} surface="modal" duration={200}>{closing && <div className="modal-backdrop"><div className="modal confirm-dialog material-host" role="dialog" aria-modal="true" aria-labelledby="close-title"><LiquidGlassSurface variant="panel" /><div className="modal-heading"><h2 id="close-title">保存文档更改？</h2><button className="icon-button" aria-label="取消关闭" disabled={closingBusy} onClick={()=>setClosing(undefined)}><X size={18}/></button></div><p>“{workspace.documents.find(d=>d.id===closing.documentId)?.title}”有尚未保存的更改。</p><p className="dialog-hint">保留草稿会保存恢复点，原文件保持原样。</p><div className="dialog-actions"><button className="button" disabled={closingBusy} onClick={()=>setClosing(undefined)}>取消</button><button className="button" disabled={closingBusy} onClick={()=>void performClose(closing)}>保留草稿并关闭</button><button className="button primary" disabled={closingBusy} onClick={()=>void saveAndClose()}>{closingBusy?'保存中…':'保存并关闭'}</button></div></div></div>}</MotionPresence>
    <MotionPresence show={!!modal} surface="modal" duration={200}>{modal && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}><div className="modal material-host" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title"><LiquidGlassSurface variant="panel" /><div className="modal-heading"><h2 id="action-dialog-title">{({ new: '新建文档', open: '打开文件或网页', save: '另存文件' })[modal]}</h2><button className="icon-button" onClick={() => setModal(null)}><X size={18} /></button></div>{modal === 'new' ? <div className="new-format-list">{formats.map(f => <button key={f.id} onClick={() => void createDocument(f.id)}><FileIcon format={f.id} /><span>{f.title}</span><small>.{f.extension}</small></button>)}</div> : <form onSubmit={event => { event.preventDefault(); if (modal === 'save' && document) void call('save', { documentId: document.id, path: address }).then(refresh).then(() => setModal(null)).catch(alert); else void openUri(address); }}><label>{modal === 'save' ? '目标完整路径' : '本机文件路径或 HTTP(S) 地址'}</label><input autoFocus className="modal-input" value={address} onChange={e => setAddress(e.target.value)} /><button className="button primary">{modal === 'save' ? '保存' : '打开'}</button></form>}</div></div>}</MotionPresence>
  </div>;
}



function ReaderAgentPointer({ point, eventSeq }: { point: { x: number; y: number }; eventSeq: number }) {
  const [position, setPosition] = useState<{left:number;top:number}>();
  useEffect(() => {
    const reader = window.document.querySelector<HTMLElement>('.reader-panel'), body = reader?.querySelector<HTMLElement>('.document-content');
    if (!reader || !body) return;
    const update = () => { const outer = reader.getBoundingClientRect(), viewport = body.getBoundingClientRect(); setPosition({ left: viewport.x - outer.x + point.x, top: viewport.y - outer.y + point.y }); };
    const resize = new ResizeObserver(update); resize.observe(reader); resize.observe(body); update();
    window.addEventListener('resize', update); return () => { resize.disconnect(); window.removeEventListener('resize', update); };
  }, [eventSeq, point.x, point.y]);
  return position ? <div className="agent-pointer" style={position}><Sparkles size={18}/></div> : null;
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
