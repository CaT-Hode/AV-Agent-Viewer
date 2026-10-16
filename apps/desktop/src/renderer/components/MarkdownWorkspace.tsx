import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, FileText, FilePlus2, Folder, FolderInput, FolderOpen, FolderPlus, Pencil, RefreshCw, Search, Trash2, Undo2, X } from 'lucide-react';
import { call } from '../lib/transport';
import '../markdown-workspace.css';

type Entry = { path: string; name: string; kind: 'directory' | 'file'; size?: number };
type Listing = { rootPath: string; relativePath: string; entries: Entry[]; limitReached: boolean };
type SearchResult = { path: string; uri: string; line: number; preview: string };
type SearchResponse = { results: SearchResult[]; limitReached: boolean };
type ChangeAction = 'new-file' | 'new-folder' | 'rename' | 'move' | 'trash' | 'undo';
type ChangeResponse = { transactionId?: string; uri?: string };
type EditForm = { action: Exclude<ChangeAction, 'undo'>; path: string; value: string };
type Props = { documentId: string; onOpen(uri: string, line?: number): void; onError(error: unknown): void };
const parentPath = (path: string) => path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
const baseName = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
const joinPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const actionLabel = { 'new-file': '新建文档', 'new-folder': '新建文件夹', rename: '重命名', move: '移动', trash: '移入回收区' };
const workspaceUndo = new Map<string, string[]>();
function rememberUndo(rootPath: string, transactions: string[]) {
  const next = transactions.slice(-50); workspaceUndo.delete(rootPath); workspaceUndo.set(rootPath, next);
  if (workspaceUndo.size > 20) workspaceUndo.delete(workspaceUndo.keys().next().value!);
  return next;
}
function fileUri(root: string, path: string) {
  const absolute = root.replace(/\\/g, '/').replace(/\/$/, '') + '/' + path.replace(/\\/g, '/');
  if (absolute.startsWith('//')) {
    const [host, ...parts] = absolute.slice(2).split('/');
    return `file://${host}/${parts.map(encodeURIComponent).join('/')}`;
  }
  const encoded = absolute.split('/').map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join('/');
  return 'file://' + (encoded.startsWith('/') ? '' : '/') + encoded;
}

/** Filesystem operations stay in the trusted workspace service. The view only
 * expands requested folders and uses bounded server searches for quick open. */
export function MarkdownWorkspace(props: Props) {
  const { documentId } = props, current = useRef(props); current.current = props;
  const [rootPath, setRootPath] = useState(''), [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set()), [loading, setLoading] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Entry>(), [mode, setMode] = useState<'tree' | 'filename' | 'content'>('tree');
  const [query, setQuery] = useState(''), [caseSensitive, setCaseSensitive] = useState(false), [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<SearchResponse>({ results: [], limitReached: false }), [activeResult, setActiveResult] = useState(0);
  const [form, setForm] = useState<EditForm>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<string[]>([]);
  const generation = useRef(0), searchGeneration = useRef(0), live = useRef(false), pending = useRef(new Map<string, Promise<Listing | undefined>>());
  const nodes = useRef(new Map<string, HTMLButtonElement>()), input = useRef<HTMLInputElement>(null), queryField = useRef<HTMLInputElement>(null);
  const resultId = useId().replace(/:/g, ''), tabId = useId().replace(/:/g, '');
  useEffect(() => { document.getElementById(`${resultId}-${activeResult}`)?.scrollIntoView({ block: 'nearest' }); }, [resultId, activeResult]);
  const valid = (owner: number, id = documentId) => live.current && owner === generation.current && id === current.current.documentId;
  const failure = (cause: unknown, notify = false) => { setError(cause instanceof Error ? cause.message : String(cause)); if (notify) current.current.onError(cause); };
  const load = useCallback((path: string, owner = generation.current): Promise<Listing | undefined> => {
    const key = `${owner}:${path}`, existing = pending.current.get(key); if (existing) return existing;
    setLoading(previous => new Set(previous).add(path));
    const task = call<Listing>('markdown-workspace-list', { documentId, ...(path ? { path } : {}) }).then(value => {
      if (!valid(owner)) return;
      setRootPath(value.rootPath); setUndo(workspaceUndo.get(value.rootPath) ?? []); setListings(previous => ({ ...previous, [path]: value })); return value;
    }).catch(cause => { if (valid(owner)) failure(cause); return undefined; }).finally(() => {
      pending.current.delete(key);
      if (valid(owner)) setLoading(previous => { const next = new Set(previous); next.delete(path); return next; });
    });
    pending.current.set(key, task); return task;
  }, [documentId]);
  const refresh = useCallback(() => {
    const owner = ++generation.current; searchGeneration.current++;
    setListings({}); setExpanded(new Set()); setSelected(undefined); setLoading(new Set()); setError(''); setNotice('');
    return load('', owner);
  }, [load]);
  useEffect(() => {
    live.current = true; setRootPath(''); setForm(undefined); setUndo([]); setQuery(''); setMode('tree'); setBusy(false); setMatches({ results: [], limitReached: false });
    void refresh();
    return () => { live.current = false; generation.current++; searchGeneration.current++; };
  }, [documentId, refresh]);
  useEffect(() => { if (form && form.action !== 'trash') { input.current?.focus(); input.current?.select(); } }, [form?.action, form?.path]);
  useEffect(() => { if (mode !== 'tree') queryField.current?.focus(); }, [mode]);
  useEffect(() => {
    const changeMode = (event: Event) => {
      const detail = (event as CustomEvent<{ documentId: string; mode: 'quick' | 'search' | 'tree' }>).detail;
      if (detail?.documentId !== documentId || !['quick', 'search', 'tree'].includes(detail.mode)) return;
      setMode(detail.mode === 'quick' ? 'filename' : detail.mode === 'search' ? 'content' : 'tree'); setError('');
      requestAnimationFrame(() => { queryField.current?.focus(); queryField.current?.select(); });
    };
    window.addEventListener('agentviewer:markdown-workspace-mode', changeMode);
    return () => window.removeEventListener('agentviewer:markdown-workspace-mode', changeMode);
  }, [documentId]);
  useEffect(() => {
    const sequence = ++searchGeneration.current, owner = generation.current;
    setMatches({ results: [], limitReached: false }); setActiveResult(0);
    if (mode === 'tree' || !query.trim() || !rootPath) { setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void call<SearchResponse>('markdown-workspace-search', { documentId, query: query.trim(), mode, caseSensitive }).then(value => {
        if (valid(owner) && searchGeneration.current === sequence) setMatches(value);
      }).catch(cause => { if (valid(owner) && searchGeneration.current === sequence) failure(cause); }).finally(() => {
        if (valid(owner) && searchGeneration.current === sequence) setSearching(false);
      });
    }, mode === 'filename' ? 150 : 250);
    return () => { clearTimeout(timer); if (searchGeneration.current === sequence) searchGeneration.current++; };
  }, [documentId, mode, query, caseSensitive, rootPath, listings['']]);
  const rows = useMemo(() => {
    const visible: { entry: Entry; depth: number }[] = [];
    const walk = (path: string, depth: number) => {
      const entries = [...(listings[path]?.entries ?? [])].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      for (const entry of entries) { visible.push({ entry, depth }); if (entry.kind === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1); }
    };
    walk('', 1); return visible;
  }, [listings, expanded]);
  const toggle = (entry: Entry) => {
    setSelected(entry);
    if (entry.kind === 'file') { current.current.onOpen(fileUri(rootPath, entry.path)); return; }
    setExpanded(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
    if (!expanded.has(entry.path) && !listings[entry.path]) void load(entry.path);
  };
  const focusEntry = (entry?: Entry) => { if (entry) { setSelected(entry); nodes.current.get(entry.path)?.focus(); } };
  const navigateTree = (event: KeyboardEvent<HTMLButtonElement>, entry: Entry) => {
    const index = rows.findIndex(row => row.entry.path === entry.path);
    if (event.key === 'ArrowDown') focusEntry(rows[Math.min(rows.length - 1, index + 1)]?.entry);
    else if (event.key === 'ArrowUp') focusEntry(rows[Math.max(0, index - 1)]?.entry);
    else if (event.key === 'Home') focusEntry(rows[0]?.entry);
    else if (event.key === 'End') focusEntry(rows.at(-1)?.entry);
    else if (event.key === 'ArrowRight' && entry.kind === 'directory') { if (!expanded.has(entry.path)) toggle(entry); else focusEntry(rows[index + 1]?.entry); }
    else if (event.key === 'ArrowLeft') { if (entry.kind === 'directory' && expanded.has(entry.path)) toggle(entry); else focusEntry(rows.find(row => row.entry.path === parentPath(entry.path))?.entry); }
    else if (event.key === 'F2') begin('rename', entry);
    else if (event.key === 'Delete') begin('trash', entry);
    else return;
    event.preventDefault();
  };
  const choose = async () => {
    if (busy) return;
    const owner = generation.current; setBusy(true); setError('');
    try {
      const pending: Promise<void>[] = []; window.dispatchEvent(new CustomEvent('agentviewer:markdown-workspace-before', { detail: { documentId, waitUntil: (promise: Promise<void>) => pending.push(promise) } })); await Promise.all(pending);
      const choice = await call<{ rootPath: string } | null>('markdown-workspace-choose', { documentId });
      if (choice && valid(owner)) { setRootPath(choice.rootPath); setUndo([]); setForm(undefined); await refresh(); }
    } catch (cause) { if (valid(owner)) failure(cause, true); }
    finally { if (live.current && current.current.documentId === documentId) setBusy(false); }
  };
  const begin = (action: EditForm['action'], entry = selected) => {
    if (busy || !rootPath || (['rename', 'move', 'trash'].includes(action) && !entry)) return;
    const directory = entry?.kind === 'directory' ? entry.path : parentPath(entry?.path ?? '');
    const path = action === 'new-file' || action === 'new-folder' ? directory : entry!.path;
    setForm({ action, path, value: action === 'new-file' ? '新文档.md' : action === 'new-folder' ? '新建文件夹' : action === 'move' ? path : baseName(path) });
    setError(''); setNotice('');
  };
  const mutate = async (event?: FormEvent, reverting = false) => {
    event?.preventDefault(); if (busy || (!reverting && !form)) return;
    const edit = form, transactionId = undo.at(-1); if (reverting && !transactionId) return;
    const action = reverting ? 'undo' : edit!.action;
    const value = edit?.value.trim() ?? '';
    if (!reverting && action !== 'trash' && (!value || action !== 'move' && /[\\/]/.test(value))) { setError(action === 'move' ? '请输入目标相对路径。' : '请输入名称，名称中不能包含路径分隔符。'); input.current?.focus(); return; }
    const owner = generation.current; setBusy(true); setError('');
    try {
      const destination = action === 'rename' ? joinPath(parentPath(edit!.path), value) : action === 'new-file' || action === 'new-folder' ? joinPath(edit!.path, value) : value;
      const result = await call<ChangeResponse>('markdown-workspace-change', { documentId, action, ...(reverting ? { transactionId } : action === 'new-file' || action === 'new-folder' ? { path: destination } : { path: edit!.path, ...(action === 'rename' || action === 'move' ? { destination } : {}) }) });
      if (!valid(owner)) return;
      if (reverting) setUndo(rememberUndo(rootPath, undo.slice(0, -1))); else if (result.transactionId) setUndo(rememberUndo(rootPath, [...undo, result.transactionId]));
      setForm(undefined); await refresh();
      if (live.current && current.current.documentId === documentId) {
        setNotice(reverting ? '已撤销文件操作。' : action === 'trash' ? '已移入回收区，可撤销。' : '文件操作已完成。');
        if (result.uri && action === 'new-file') current.current.onOpen(result.uri);
      }
    } catch (cause) { if (valid(owner)) failure(cause, true); }
    finally { if (live.current && current.current.documentId === documentId) setBusy(false); }
  };
  const openResult = (index: number) => { const result = matches.results[index]; if (result) current.current.onOpen(result.uri, mode === 'content' ? result.line : undefined); };
  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveResult(index => Math.min(Math.max(0, matches.results.length - 1), index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveResult(index => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); openResult(activeResult); }
    else if (event.key === 'Escape') { event.preventDefault(); setQuery(''); setMode('tree'); }
  };
  const selectedPath = selected?.path ?? '';
  const tabLabel = { tree: '文件树', filename: '快速打开', content: '全文搜索' };
  return <section className="markdown-workspace" aria-label="Markdown 工作区文件">
    <div className="markdown-workspace-heading"><span title={rootPath || '请选择文件夹'}><FolderOpen size={15} aria-hidden="true" />{baseName(rootPath) || '工作区文件'}</span><button className="icon-button" type="button" aria-label="选择工作区文件夹" title={rootPath ? `更换文件夹\n${rootPath}` : '选择工作区文件夹'} disabled={busy} onClick={() => void choose()}><FolderInput size={15} /></button><button className="icon-button" type="button" aria-label="刷新工作区文件" title="刷新文件" disabled={busy || loading.has('')} onClick={() => void refresh()}><RefreshCw size={14} /></button></div>
    <div className="markdown-workspace-tabs" role="tablist" aria-label="工作区浏览方式">{(['tree', 'filename', 'content'] as const).map(tab => <button type="button" key={tab} role="tab" id={`${tabId}-${tab}`} aria-selected={mode === tab} aria-controls={`${tabId}-panel`} tabIndex={mode === tab ? 0 : -1} onClick={() => { setMode(tab); setError(''); }} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const tabs = ['tree', 'filename', 'content'] as const, index = tabs.indexOf(tab), next = tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; setMode(next); document.getElementById(`${tabId}-${next}`)?.focus(); }}>{tabLabel[tab]}</button>)}</div>
    <div className="markdown-workspace-actions" role="group" aria-label="文件操作">
      <button className="icon-button" type="button" aria-label="新建 Markdown 文档" title="新建文档" disabled={busy || !rootPath} onClick={() => begin('new-file')}><FilePlus2 size={15} /></button>
      <button className="icon-button" type="button" aria-label="新建工作区文件夹" title="新建文件夹" disabled={busy || !rootPath} onClick={() => begin('new-folder')}><FolderPlus size={15} /></button>
      <button className="icon-button" type="button" aria-label="重命名所选文件" title="重命名 · F2" disabled={busy || !selected} onClick={() => begin('rename')}><Pencil size={14} /></button>
      <button className="icon-button" type="button" aria-label="移动所选文件" title="移动到工作区内的其他路径" disabled={busy || !selected} onClick={() => begin('move')}><FolderInput size={15} /></button>
      <button className="icon-button" type="button" aria-label="将所选文件移入回收区" title="移入回收区 · Delete" disabled={busy || !selected} onClick={() => begin('trash')}><Trash2 size={14} /></button>
      <button className="icon-button" type="button" aria-label="撤销最近文件操作" title="撤销最近文件操作" disabled={busy || !undo.length} onClick={() => void mutate(undefined, true)}><Undo2 size={15} /></button>
    </div>
    {form && <form className="markdown-workspace-form" onSubmit={event => void mutate(event)}>
      {form.action === 'trash' ? <p>将“{baseName(form.path)}”移入工作区回收区？可撤销此操作。</p> : <label>{actionLabel[form.action]}{form.action === 'move' && <small>目标相对路径，包含文件名</small>}<input ref={input} aria-label={form.action === 'move' ? '文件目标相对路径' : '文件或文件夹名称'} value={form.value} disabled={busy} onChange={event => setForm({ ...form, value: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setForm(undefined); } }} autoComplete="off" spellCheck={false} /></label>}
      <div><button type="submit" className="button" disabled={busy}>{busy ? '处理中…' : form.action === 'trash' ? '移入回收区' : '确定'}</button><button type="button" className="icon-button" aria-label="取消文件操作" title="取消" disabled={busy} onClick={() => setForm(undefined)}><X size={14} /></button></div>
    </form>}
    <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${mode}`}>
      {mode === 'tree' ? <>
        <div className="markdown-workspace-tree" role="tree" aria-label="工作区目录">{rows.map(({ entry, depth }, index) => {
          const directory = entry.kind === 'directory', open = expanded.has(entry.path), Icon = directory ? open ? FolderOpen : Folder : FileText;
          return <button key={entry.path} ref={node => { if (node) nodes.current.set(entry.path, node); else nodes.current.delete(entry.path); }} type="button" role="treeitem" aria-level={depth} aria-expanded={directory ? open : undefined} aria-selected={entry.path === selectedPath} aria-busy={loading.has(entry.path) || undefined} className="markdown-workspace-entry" style={{ paddingLeft: 5 + (depth - 1) * 14 }} title={entry.path} tabIndex={selected ? selectedPath === entry.path ? 0 : -1 : index === 0 ? 0 : -1} onFocus={() => setSelected(entry)} onClick={() => toggle(entry)} onKeyDown={event => navigateTree(event, entry)}>
            {directory ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="markdown-workspace-indent" />}<Icon size={14} /><span>{entry.name}</span>{loading.has(entry.path) && <small>…</small>}
          </button>;
        })}</div>
        {loading.has('') && <p className="markdown-workspace-note" role="status">正在读取文件夹…</p>}
        {!loading.has('') && rootPath && !rows.length && !error && <p className="markdown-workspace-note">文件夹为空。</p>}
        {Object.values(listings).some(listing => listing.limitReached) && <p className="markdown-workspace-note">目录列表已达上限，请使用快速打开查找文件。</p>}
      </> : <>
        <label className="markdown-workspace-search"><Search size={14} aria-hidden="true" /><input ref={queryField} type="search" aria-label={mode === 'filename' ? '按文件名快速打开' : '搜索工作区全文'} placeholder={mode === 'filename' ? '按文件名查找' : '搜索文件内容'} value={query} onChange={event => { setQuery(event.target.value); setError(''); }} onKeyDown={searchKey} autoComplete="off" spellCheck={false} role="combobox" aria-autocomplete="list" aria-expanded={!!matches.results.length} aria-controls={`${resultId}-results`} aria-activedescendant={matches.results[activeResult] ? `${resultId}-${activeResult}` : undefined} />{mode === 'content' && <button type="button" className="icon-button" aria-label="区分大小写" aria-pressed={caseSensitive} title="区分大小写" onClick={() => setCaseSensitive(value => !value)}>Aa</button>}</label>
        <div className="markdown-workspace-results" id={`${resultId}-results`} role="listbox" aria-label={mode === 'filename' ? '匹配的文件' : '全文搜索结果'}>{matches.results.map((result, index) => <button id={`${resultId}-${index}`} key={`${result.path}:${result.line}:${index}`} type="button" role="option" aria-selected={activeResult === index} title={result.path} onMouseEnter={() => setActiveResult(index)} onClick={() => openResult(index)}><span><FileText size={13} aria-hidden="true" />{baseName(result.path)}{mode === 'content' && result.line > 0 && <small>:{result.line}</small>}</span><small>{result.path}</small>{mode === 'content' && <p>{result.preview}</p>}</button>)}</div>
        {searching && <p className="markdown-workspace-note" role="status">正在搜索…</p>}
        {!searching && query.trim() && !matches.results.length && !error && <p className="markdown-workspace-note">没有找到匹配内容。</p>}
        {matches.limitReached && <p className="markdown-workspace-note">结果已达上限，请缩小搜索范围。</p>}
      </>}
    </div>
    {!rootPath && !loading.has('') && <button className="button markdown-workspace-choose" type="button" disabled={busy} onClick={() => void choose()}><FolderOpen size={14} />选择文件夹</button>}
    {error && <p className="markdown-workspace-error" role="alert">{error}</p>}
    <p className="markdown-workspace-note markdown-workspace-status" role="status" aria-live="polite">{notice}</p>
  </section>;
}
