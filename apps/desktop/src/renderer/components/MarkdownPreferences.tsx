import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, RefreshCw, Save } from 'lucide-react';
import { MARKDOWN_COMMANDS } from '../../../../../packages/markdown/src/commands';
import { call } from '../lib/transport';
import '../markdown-configuration.css';

export type MarkdownPreferencesValue = {
  themeCss: string;
  keybindings: Record<string, string>;
  imageRoot: string;
  upload: { command: string; args: string[] } | null;
  export: { header: string; footer: string; templatePath: string };
};
type Props = { documentId: string; viewId: string; onError(error: unknown): void };
type Draft = { themeCss: string; keybindings: string; imageRoot: string; uploadEnabled: boolean; uploadCommand: string; uploadArgs: string; header: string; footer: string; templatePath: string };
const empty: MarkdownPreferencesValue = { themeCss: '', keybindings: {}, imageRoot: '', upload: null, export: { header: '', footer: '', templatePath: '' } };
const knownCommands = new Set<string>([...MARKDOWN_COMMANDS, 'find', 'replace', 'undo', 'redo', 'focus', 'typewriter', 'spellcheck', 'autoPair']);
const draftFor = (value: MarkdownPreferencesValue): Draft => ({ themeCss: value.themeCss, keybindings: JSON.stringify(value.keybindings, null, 2), imageRoot: value.imageRoot, uploadEnabled: !!value.upload, uploadCommand: value.upload?.command ?? '', uploadArgs: JSON.stringify(value.upload?.args ?? [], null, 2), header: value.export.header, footer: value.export.footer, templatePath: value.export.templatePath });
function json(value: string, label: string): unknown { try { return JSON.parse(value); } catch (error) { throw new Error(`${label}不是有效的 JSON：${error instanceof Error ? error.message : String(error)}`); } }
function preferencesFor(draft: Draft): MarkdownPreferencesValue {
  const parsed = json(draft.keybindings.trim() || '{}', '快捷键配置');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('快捷键配置应为 JSON 对象，例如 {"bold":"Mod-b"}。');
  const keybindings: Record<string, string> = {}, used = new Map<string, string>();
  for (const [command, binding] of Object.entries(parsed)) {
    if (!knownCommands.has(command)) throw new Error(`未知命令“${command}”。请使用下方列出的命令名。`);
    if (typeof binding !== 'string') throw new Error(`命令“${command}”的快捷键必须是字符串；空字符串表示禁用默认键。`);
    if (binding && !/^(?:(?:Mod|Ctrl|Control|Alt|Shift|Meta|Cmd)-)*[^\s]+$/.test(binding)) throw new Error(`“${binding}”不是有效的快捷键写法，请使用 Mod-b、Mod-Shift-k 或 F8。`);
    const normalized = binding.toLowerCase().replace(/\b(?:control|ctrl|cmd|meta)-/g, 'mod-');
    if (binding && used.has(normalized)) throw new Error(`“${binding}”同时分配给了“${used.get(normalized)}”和“${command}”。`);
    if (binding) used.set(normalized, command);
    keybindings[command] = binding;
  }
  const args = draft.uploadEnabled ? json(draft.uploadArgs.trim() || '[]', '上传参数') : [];
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('上传参数应为字符串数组，例如 ["--file","{file}"]。');
  if (draft.uploadEnabled && !draft.uploadCommand.trim()) throw new Error('启用上传时，需要填写可执行文件或命令路径。');
  if (draft.uploadCommand.includes('\0') || args.some(value => value.includes('\0'))) throw new Error('上传命令和参数不能包含空字符。');
  return { themeCss: draft.themeCss, keybindings, imageRoot: draft.imageRoot.trim(), upload: draft.uploadEnabled ? { command: draft.uploadCommand.trim(), args } : null, export: { header: draft.header, footer: draft.footer, templatePath: draft.templatePath.trim() } };
}

/** Saving config is independent of document source edits. Upload commands are
 * stored here and run only by the explicit upload action in resource tools. */
export function MarkdownPreferences(props: Props) {
  const { documentId, viewId } = props, current = useRef(props); current.current = props;
  const [draft, setDraft] = useState(() => draftFor(empty)), [baseline, setBaseline] = useState(() => draftFor(empty));
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0), saved = useRef<{ documentId: string; preferences: MarkdownPreferencesValue } | undefined>(undefined), sequence = useRef(0), live = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const loaded = saved.current?.documentId === documentId;
  const publish = (preferences: MarkdownPreferencesValue) => window.dispatchEvent(new CustomEvent('agentviewer:markdown-preferences', { detail: { documentId: current.current.documentId, viewId: current.current.viewId, preferences } }));
  useEffect(() => {
    live.current = true; const owner = ++sequence.current;
    saved.current = undefined; setLoading(true); setError(''); setNotice(''); setSaving(false);
    void call<{ preferences: MarkdownPreferencesValue }>('markdown-preferences-read', { documentId }).then(result => {
      if (!live.current || sequence.current !== owner || current.current.documentId !== documentId) return;
      saved.current = { documentId, preferences: result.preferences }; const next = draftFor(result.preferences); setDraft(next); setBaseline(next); publish(result.preferences);
    }).catch(cause => { if (live.current && sequence.current === owner) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (live.current && sequence.current === owner) setLoading(false); });
    return () => { live.current = false; sequence.current++; };
  }, [documentId, retry]);
  useEffect(() => {
    const value = saved.current; if (value?.documentId === documentId) publish(value.preferences);
    const requested = (event: Event) => {
      const detail = (event as CustomEvent<{ viewId: string }>).detail, value = saved.current;
      if (detail?.viewId === current.current.viewId && value?.documentId === current.current.documentId) publish(value.preferences);
    };
    window.addEventListener('agentviewer:markdown-preferences-request', requested);
    return () => window.removeEventListener('agentviewer:markdown-preferences-request', requested);
  }, [documentId, viewId]);
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => { setDraft(previous => ({ ...previous, [key]: value })); setNotice(''); setError(''); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (loading || saving || !loaded) return;
    let preferences: MarkdownPreferencesValue;
    try { preferences = preferencesFor(draft); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    const owner = sequence.current; setSaving(true); setError(''); setNotice('');
    try {
      const result = await call<{ preferences: MarkdownPreferencesValue }>('markdown-preferences-save', { documentId, preferences });
      if (!live.current || sequence.current !== owner || current.current.documentId !== documentId) return;
      saved.current = { documentId, preferences: result.preferences }; const next = draftFor(result.preferences); setDraft(next); setBaseline(next); publish(result.preferences); setNotice('配置已保存并应用。');
    } catch (cause) { if (live.current && sequence.current === owner) { setError(cause instanceof Error ? cause.message : String(cause)); current.current.onError(cause); } }
    finally { if (live.current && sequence.current === owner) setSaving(false); }
  };
  return <form className="markdown-configuration markdown-preferences" aria-label="Markdown 偏好配置" onSubmit={event => void save(event)}>
    <div className="markdown-configuration-heading"><h3>写作偏好</h3><button className="icon-button" type="button" aria-label="重新读取 Markdown 配置" title={loaded && dirty ? '先保存或还原草稿，再重新读取配置' : '重新读取配置'} disabled={loading || saving || loaded && dirty} onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} /></button></div>
    {loading ? <p className="markdown-configuration-note" role="status">正在读取配置…</p> : !loaded ? <p className="markdown-configuration-note">读取配置后即可编辑。请使用右上角按钮重试。</p> : <fieldset disabled={saving}>
      <details open><summary>编辑外观与快捷键</summary>
        <label>主题 CSS<textarea aria-label="Markdown 主题 CSS" className="markdown-configuration-code" rows={5} value={draft.themeCss} onChange={event => change('themeCss', event.target.value)} placeholder={'.markdown-live { font-size: 17px; }'} spellCheck={false} /></label>
        <p className="markdown-configuration-note">保存后应用于 Markdown 编辑区域。</p>
        <label>快捷键覆盖<textarea aria-label="Markdown 快捷键配置" className="markdown-configuration-code" rows={4} value={draft.keybindings} onChange={event => change('keybindings', event.target.value)} spellCheck={false} /></label>
        <p className="markdown-configuration-note">JSON 对象：命令名对应按键，例如 {`{"bold":"Mod-b","focus":"F8"}`}。Windows 中 Mod 为 Ctrl；空字符串禁用该命令的默认快捷键，未填写的保留默认。</p>
        <details className="markdown-configuration-help"><summary>可用命令名</summary><p>{[...knownCommands].join(' · ')}</p></details>
      </details>
      <details><summary>图片目录与上传</summary>
        <label>图片根目录<input aria-label="Markdown 图片根目录" value={draft.imageRoot} onChange={event => change('imageRoot', event.target.value)} placeholder="留空使用文档所在目录" spellCheck={false} /></label>
        <label className="markdown-configuration-toggle"><input type="checkbox" checked={draft.uploadEnabled} onChange={event => change('uploadEnabled', event.target.checked)} />配置图片上传命令</label>
        {draft.uploadEnabled && <><label>可执行文件<input aria-label="图片上传命令" value={draft.uploadCommand} onChange={event => change('uploadCommand', event.target.value)} placeholder="可执行文件或完整路径" spellCheck={false} /></label><label>参数 JSON<textarea aria-label="图片上传命令参数" className="markdown-configuration-code" rows={3} value={draft.uploadArgs} onChange={event => change('uploadArgs', event.target.value)} spellCheck={false} /></label><p className="markdown-configuration-note">参数使用字符串数组，{`{file}`} 表示本地图片路径。保存配置不会上传；仅在图片资源中点击上传时执行。</p></>}
      </details>
      <details><summary>导出页眉页脚与模板</summary>
        <label>页眉模板<textarea aria-label="Markdown 导出页眉模板" rows={3} value={draft.header} onChange={event => change('header', event.target.value)} /></label>
        <label>页脚模板<textarea aria-label="Markdown 导出页脚模板" rows={3} value={draft.footer} onChange={event => change('footer', event.target.value)} /></label>
        <label>导出模板路径<input aria-label="Markdown 导出模板路径" value={draft.templatePath} onChange={event => change('templatePath', event.target.value)} placeholder="留空使用默认模板" spellCheck={false} /></label>
        <p className="markdown-configuration-note">模板适用格式和变量以导出选项为准。</p>
      </details>
    </fieldset>}
    {error && <p className="markdown-configuration-error" role="alert">{error}</p>}
    <div className="markdown-configuration-footer"><button className="button" type="submit" disabled={loading || saving || !loaded || !dirty}><Save size={13} />{saving ? '保存中…' : '保存配置'}</button><button className="button quiet" type="button" disabled={loading || saving || !loaded || !dirty} onClick={() => { setDraft(baseline); setError(''); setNotice(''); }}>还原草稿</button></div>
    {notice && <p className="markdown-configuration-note" role="status"><Check size={12} aria-hidden="true" />{notice}</p>}
  </form>;
}
