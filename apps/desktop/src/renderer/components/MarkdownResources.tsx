import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudUpload, Copy, FileImage, Image, Link, RefreshCw } from 'lucide-react';
import { call } from '../lib/transport';
import type { MarkdownPreferencesValue } from './MarkdownPreferences';
import '../markdown-configuration.css';

type Resource = { source: string; path?: string; bytes?: number; embedded?: boolean; remote?: boolean };
type Resources = { revision: number; resources: Resource[]; unresolved: string[] };
type Props = { documentId: string; viewId: string; onError(error: unknown): void };
type Action = 'copy-local' | 'embed' | 'upload';
const actionLabel: Record<Action, string> = { 'copy-local': '复制到本地', embed: '嵌入文档', upload: '上传图片' };
const sizeLabel = (bytes?: number) => bytes === undefined ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
function resourceName(resource: Resource, index: number) {
  if (resource.embedded || /^data:/i.test(resource.source)) return `内嵌图片 ${index + 1}`;
  const file = (resource.path ?? resource.source).replace(/\\/g, '/').split('/').at(-1)?.split(/[?#]/)[0];
  if (!file) return resource.source;
  try { return decodeURIComponent(file); } catch { return file; }
}
async function flushResourceDraft(viewId: string) {
  const pending: Promise<void>[] = [];
  window.dispatchEvent(new CustomEvent('agentviewer:markdown-resources-before', { detail: { viewId, waitUntil(promise: Promise<void>) { pending.push(promise); } } }));
  await Promise.all(pending);
}

/** Batch actions are explicit source edits checked against the listed content
 * revision. Reading a document/list or saving upload config never uploads. */
export function MarkdownResources(props: Props) {
  const { documentId, viewId } = props, current = useRef(props); current.current = props;
  const [loadedData, setData] = useState<{ documentId: string; value: Resources }>(), [selected, setSelected] = useState<Set<string>>(new Set());
  const data = loadedData?.documentId === documentId ? loadedData.value : undefined;
  const [loading, setLoading] = useState(true), [action, setAction] = useState<Action>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [uploadConfigured, setUploadConfigured] = useState(false), sequence = useRef(0), live = useRef(false), revision = useRef<number | undefined>(undefined);
  const [retry, setRetry] = useState(0);
  const load = useCallback(async () => {
    const owner = ++sequence.current; setLoading(true); setError('');
    try {
      await flushResourceDraft(current.current.viewId);
      const next = await call<Resources>('markdown-resources-list', { documentId });
      if (!live.current || owner !== sequence.current || current.current.documentId !== documentId) return;
      if (!Number.isInteger(next.revision) || next.revision < 0) throw new Error('图片资源列表缺少有效的文档版本，请刷新后重试。');
      revision.current = next.revision; setData({ documentId, value: next });
      const available = new Set(next.resources.map(resource => resource.source).filter(source => !next.unresolved.includes(source)));
      setSelected(previous => new Set([...previous].filter(source => available.has(source))));
    } catch (cause) { if (live.current && owner === sequence.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current && owner === sequence.current) setLoading(false); }
  }, [documentId]);
  useEffect(() => {
    live.current = true; setData(undefined); revision.current = undefined; setSelected(new Set()); setAction(undefined); setNotice(''); void load();
    return () => { live.current = false; sequence.current++; };
  }, [documentId, load, retry]);
  useEffect(() => {
    let active = true; setUploadConfigured(false);
    void call<{ preferences: MarkdownPreferencesValue }>('markdown-preferences-read', { documentId }).then(value => { if (active) setUploadConfigured(!!value.preferences.upload?.command.trim()); }).catch(() => {});
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ documentId?: string; viewId: string; preferences: MarkdownPreferencesValue }>).detail;
      if (detail?.viewId === current.current.viewId && (!detail.documentId || detail.documentId === documentId)) setUploadConfigured(!!detail.preferences.upload?.command.trim());
    };
    const applied = (event: Event) => {
      const detail = (event as CustomEvent<{ documentId: string; revision: number }>).detail;
      if (detail?.documentId === documentId && detail.revision !== revision.current) void load();
    };
    window.addEventListener('agentviewer:markdown-preferences', changed); window.addEventListener('agentviewer:markdown-resources-applied', applied);
    return () => { active = false; window.removeEventListener('agentviewer:markdown-preferences', changed); window.removeEventListener('agentviewer:markdown-resources-applied', applied); };
  }, [documentId, viewId, load]);
  const resources = useMemo(() => [...new Map((data?.resources ?? []).map(resource => [resource.source, resource])).values()], [data]);
  const unresolved = useMemo(() => new Set(data?.unresolved ?? []), [data]);
  const available = resources.filter(resource => !unresolved.has(resource.source));
  const busy = loading || !!action, allSelected = !!available.length && available.every(resource => selected.has(resource.source));
  const execute = async (requested: Action) => {
    if (busy || !data || !selected.size || requested === 'upload' && !uploadConfigured) return;
    const owner = sequence.current, sources = [...selected]; setAction(requested); setError(''); setNotice('');
    try {
      await flushResourceDraft(current.current.viewId);
      const fresh = await call<Resources>('markdown-resources-list', { documentId });
      if (!live.current || owner !== sequence.current || current.current.documentId !== documentId) return;
      if (fresh.revision !== data.revision) { revision.current = fresh.revision; setData({ documentId, value: fresh }); setSelected(previous => new Set([...previous].filter(source => fresh.resources.some(resource => resource.source === source) && !fresh.unresolved.includes(source)))); throw new Error('正文版本已变化，图片列表已刷新。请确认选择后重新执行。'); }
      if (sources.some(source => !fresh.resources.some(resource => resource.source === source) || fresh.unresolved.includes(source))) { setData({ documentId, value: fresh }); throw new Error('部分所选图片已变化或无法读取，列表已刷新，请重新选择。'); }
      const result = await call<{ revision: number }>('markdown-resources-apply', { documentId, expectedRevision: fresh.revision, action: requested, sources });
      if (!live.current || owner !== sequence.current || current.current.documentId !== documentId) return;
      setSelected(new Set()); await load();
      if (!live.current || current.current.documentId !== documentId) return;
      setNotice(`${actionLabel[requested]}已完成，处理 ${sources.length} 个资源。`);
      window.dispatchEvent(new CustomEvent('agentviewer:markdown-resources-applied', { detail: { documentId, viewId: current.current.viewId, revision: result.revision } }));
    } catch (cause) {
      if (live.current && owner === sequence.current) { setError(cause instanceof Error ? cause.message : String(cause)); current.current.onError(cause); }
    } finally { if (live.current && current.current.documentId === documentId) setAction(undefined); }
  };
  return <section className="markdown-configuration markdown-resources" aria-label="Markdown 图片资源">
    <div className="markdown-configuration-heading"><h3>图片资源{data ? ` · ${resources.length}` : ''}</h3><button className="icon-button" type="button" aria-label="刷新 Markdown 图片资源" title="刷新图片资源" disabled={busy} onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} /></button></div>
    {loading && <p className="markdown-configuration-note" role="status">正在读取图片资源…</p>}
    {resources.length > 0 && <>
      <div className="markdown-resources-select"><label><input type="checkbox" aria-label="选择全部可用图片资源" checked={allSelected} disabled={busy || !available.length} onChange={event => setSelected(event.target.checked ? new Set(available.map(resource => resource.source)) : new Set())} />全选可用资源</label><span>已选 {selected.size}</span></div>
      <div className="markdown-resources-list" role="group" aria-label="文档中的图片">{resources.map((resource, index) => {
        const Icon = resource.remote ? Link : resource.embedded ? Image : FileImage, name = resourceName(resource, index), missing = unresolved.has(resource.source);
        const subtitle = [resource.embedded ? '内嵌' : resource.remote ? '远程' : '本地', sizeLabel(resource.bytes), missing ? '无法解析' : ''].filter(Boolean).join(' · ');
        return <label className="markdown-resources-item" key={index} title={resource.embedded ? name : resource.path ?? resource.source.slice(0, 2000)}><input type="checkbox" aria-label={`选择图片 ${name}`} checked={selected.has(resource.source)} disabled={busy || missing} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(resource.source); else next.delete(resource.source); return next; })} /><span><span className="markdown-resources-title"><Icon size={14} aria-hidden="true" /><span>{name}</span></span><small>{subtitle}</small>{!resource.embedded && <small>{resource.path ?? resource.source}</small>}</span></label>;
      })}</div>
    </>}
    {!loading && !resources.length && !error && <p className="markdown-configuration-note">正文中没有图片资源。</p>}
    <div className="markdown-configuration-footer" role="group" aria-label="批量处理图片资源">
      <button className="button" type="button" disabled={busy || !selected.size} onClick={() => void execute('copy-local')}><Copy size={13} />复制到本地</button>
      <button className="button" type="button" disabled={busy || !selected.size} onClick={() => void execute('embed')}><Image size={13} />嵌入文档</button>
      <button className="button" type="button" title={uploadConfigured ? '执行已配置的上传命令' : '请先在写作偏好中配置上传命令'} disabled={busy || !selected.size || !uploadConfigured} onClick={() => void execute('upload')}><CloudUpload size={13} />上传图片</button>
    </div>
    <p className="markdown-configuration-note">批处理会更新正文中的图片地址。{uploadConfigured ? '上传仅在点击“上传图片”时执行已配置的命令。' : '上传前请先在写作偏好中配置上传命令。'}</p>
    {action && <p className="markdown-configuration-note" role="status">正在{actionLabel[action]}…</p>}
    {!!data?.unresolved.length && <details><summary>无法解析的图片 · {data.unresolved.length}</summary><ul className="markdown-resources-unresolved">{data.unresolved.map((source, index) => <li key={index}>{/^data:/i.test(source) ? '内嵌图片数据无效' : source}</li>)}</ul><p className="markdown-configuration-note">请检查路径、图片根目录或网络地址，修正后刷新列表。</p></details>}
    {error && <p className="markdown-configuration-error" role="alert">{error}</p>}
    {notice && <p className="markdown-configuration-note" role="status">{notice}</p>}
  </section>;
}
