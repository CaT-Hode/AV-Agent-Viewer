import type { LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Asterisk, Bold, Code, Code2, Columns3,
  FileCode2, Focus, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Highlighter,
  Image, Italic, Link, List, ListOrdered, ListTodo, ListTree, Minus, Pilcrow, Plus, Quote,
  Redo2, RemoveFormatting, Replace, Rows3, Search, Sigma, Strikethrough, Subscript,
  Superscript, Table2, TextCursorInput, Underline, Undo2,
} from 'lucide-react';
import type { MarkdownCommandEventDetail, MarkdownToolCommandName } from '../../../../../packages/markdown/src/commands';
import { loadMarkdownEmoji } from '../lib/markdown-emoji';
import type { Gemoji } from 'gemoji';
import '../markdown-tools.css';

type Tool = { command: MarkdownToolCommandName; label: string; description: string; icon: LucideIcon; shortcut?: string; badge?: 'add' | 'remove'; value?: unknown };
type ToolGroup = { label: string; tools: Tool[] };
const groups: ToolGroup[] = [
  { label: '文字', tools: [
    { command: 'bold', label: '粗体', description: '添加或移除选中文字的粗体格式', icon: Bold, shortcut: 'Ctrl+B' },
    { command: 'italic', label: '斜体', description: '添加或移除选中文字的斜体格式', icon: Italic, shortcut: 'Ctrl+I' },
    { command: 'strike', label: '删除线', description: '添加或移除删除线', icon: Strikethrough, shortcut: 'Alt+Shift+5' },
    { command: 'underline', label: '下划线', description: '添加或移除下划线', icon: Underline, shortcut: 'Ctrl+U' },
    { command: 'code', label: '行内代码', description: '添加或移除行内代码格式', icon: Code, shortcut: 'Ctrl+Shift+`' },
    { command: 'highlight', label: '高亮', description: '添加或移除高亮标记', icon: Highlighter },
    { command: 'sub', label: '下标', description: '添加或移除下标格式', icon: Subscript },
    { command: 'super', label: '上标', description: '添加或移除上标格式', icon: Superscript },
    { command: 'clear', label: '清除格式', description: '清除选区或当前行的文字格式', icon: RemoveFormatting, shortcut: 'Ctrl+\\' },
  ] },
  { label: '段落', tools: [
    { command: 'heading0', label: '正文段落', description: '把当前段落转换为正文', icon: Pilcrow, shortcut: 'Ctrl+0' },
    { command: 'heading1', label: '一级标题', description: '把当前段落转换为一级标题', icon: Heading1, shortcut: 'Ctrl+1' },
    { command: 'heading2', label: '二级标题', description: '把当前段落转换为二级标题', icon: Heading2, shortcut: 'Ctrl+2' },
    { command: 'heading3', label: '三级标题', description: '把当前段落转换为三级标题', icon: Heading3, shortcut: 'Ctrl+3' },
    { command: 'heading4', label: '四级标题', description: '把当前段落转换为四级标题', icon: Heading4, shortcut: 'Ctrl+4' },
    { command: 'heading5', label: '五级标题', description: '把当前段落转换为五级标题', icon: Heading5, shortcut: 'Ctrl+5' },
    { command: 'heading6', label: '六级标题', description: '把当前段落转换为六级标题', icon: Heading6, shortcut: 'Ctrl+6' },
    { command: 'quote', label: '引用', description: '添加或移除段落引用', icon: Quote, shortcut: 'Ctrl+Shift+Q' },
    { command: 'bullet', label: '无序列表', description: '添加或移除无序列表', icon: List },
    { command: 'ordered', label: '有序列表', description: '添加或移除有序列表', icon: ListOrdered },
    { command: 'task', label: '任务列表', description: '添加或移除可勾选的任务列表', icon: ListTodo },
  ] },
  { label: '插入', tools: [
    { command: 'link', label: '链接', description: '插入链接并选中待填写的网址', icon: Link, shortcut: 'Ctrl+K' },
    { command: 'referenceLink', label: '引用链接', description: '插入引用形式的链接与定义', icon: Link },
    { command: 'image', label: '图片', description: '插入图片并选中待填写的图片地址', icon: Image, shortcut: 'Ctrl+Shift+I' },
    { command: 'codeBlock', label: '代码块', description: '插入或移除围栏代码块', icon: Code2, shortcut: 'Ctrl+Shift+K' },
    { command: 'mathBlock', label: '公式块', description: '插入或移除独立数学公式块', icon: Sigma, shortcut: 'Ctrl+Shift+M' },
    { command: 'mathInline', label: '行内公式', description: '插入或移除行内数学公式', icon: Sigma },
    { command: 'mermaid', label: 'Mermaid 图表', description: '插入可编辑的 Mermaid 图表源码', icon: ListTree },
    { command: 'sequence', label: '时序图', description: '插入 JS Sequence Diagram 官方语法', icon: ListTree },
    { command: 'flow', label: '流程图', description: '插入 Flowchart.js 官方语法', icon: ListTree },
    { command: 'callout', label: '提示块', description: '插入带类型标记的提示块', icon: Quote },
    { command: 'table', label: '表格', description: '插入三列、三行的 Markdown 表格', icon: Table2, value: { rows: 3, columns: 3 }, shortcut: 'Ctrl+T' },
    { command: 'rule', label: '分隔线', description: '插入段落分隔线', icon: Minus },
    { command: 'toc', label: '目录', description: '插入文档目录标记', icon: ListTree },
    { command: 'frontmatter', label: '文档信息', description: '插入或定位 YAML 文档信息', icon: FileCode2 },
    { command: 'footnote', label: '脚注', description: '插入脚注引用与定义', icon: Asterisk },
  ] },
  { label: '表格编辑', tools: [
    { command: 'tableAddRow', label: '插入行', description: '在当前表格行之后插入一行', icon: Rows3, badge: 'add' },
    { command: 'tableDeleteRow', label: '删除行', description: '删除当前表格行', icon: Rows3, badge: 'remove' },
    { command: 'tableAddColumn', label: '插入列', description: '在当前表格列之后插入一列', icon: Columns3, badge: 'add' },
    { command: 'tableDeleteColumn', label: '删除列', description: '删除当前表格列', icon: Columns3, badge: 'remove' },
    { command: 'tableMoveRowUp', label: '上移行', description: '把当前表格正文行向上移动', icon: ArrowUp },
    { command: 'tableMoveRowDown', label: '下移行', description: '把当前表格正文行向下移动', icon: ArrowDown },
    { command: 'tableMoveColumnLeft', label: '左移列', description: '把当前表格列向左移动', icon: ArrowLeft },
    { command: 'tableMoveColumnRight', label: '右移列', description: '把当前表格列向右移动', icon: ArrowRight },
    { command: 'tableAlignLeft', label: '列左对齐', description: '把当前表格列设为左对齐', icon: AlignLeft },
    { command: 'tableAlignCenter', label: '列居中', description: '把当前表格列设为居中对齐', icon: AlignCenter },
    { command: 'tableAlignRight', label: '列右对齐', description: '把当前表格列设为右对齐', icon: AlignRight },
    { command: 'tableAlignNone', label: '默认列对齐', description: '移除当前表格列的指定对齐方式', icon: AlignJustify },
  ] },
  { label: '编辑与阅读', tools: [
    { command: 'find', label: '查找', description: '查找文档中的文字', icon: Search, shortcut: 'Ctrl+F' },
    { command: 'replace', label: '替换', description: '查找并替换文档中的文字', icon: Replace, shortcut: 'Ctrl+H' },
    { command: 'undo', label: '撤销', description: '撤销最近的编辑', icon: Undo2, shortcut: 'Ctrl+Z' },
    { command: 'redo', label: '重做', description: '重做已撤销的编辑', icon: Redo2, shortcut: 'Ctrl+Shift+Z' },
    { command: 'focus', label: '专注模式', description: '切换当前段落的专注阅读模式', icon: Focus, shortcut: 'F8' },
    { command: 'typewriter', label: '打字机模式', description: '切换保持当前编辑行居中的打字机模式', icon: TextCursorInput, shortcut: 'F9' },
    { command: 'spellcheck', label: '拼写检查', description: '切换系统浏览器提供的拼写检查', icon: Underline },
    { command: 'autoPair', label: '自动配对', description: '切换括号与引号自动配对', icon: Code },
  ] },
];

/** Source editing stays in the active view. Tool clicks retain its selection;
 * the command event also supports the same explicit target from other UIs. */
export function MarkdownTools({ viewId }: { viewId: string }) {
  const [state, setState] = useState<Record<string, boolean>>({ spellcheck: true, autoPair: true }), [error, setError] = useState('');
  const [emojiQuery, setEmojiQuery] = useState(''), [emojiCatalog, setEmojiCatalog] = useState<Gemoji[]>([]);
  useEffect(() => { if (!emojiQuery || emojiCatalog.length) return; let active = true; void loadMarkdownEmoji().then(module => { if (active) setEmojiCatalog(module.gemoji); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }); return () => { active = false; }; }, [emojiQuery, emojiCatalog.length]);
  useEffect(() => {
    setState({ spellcheck: true, autoPair: true }); setError('');
    const history = (event: Event) => { const detail = (event as CustomEvent<{ viewId: string } & Record<string, boolean | string>>).detail; if (detail?.viewId === viewId) setState(previous => ({ ...previous, ...Object.fromEntries(Object.entries(detail).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean> })); };
    const failure = (event: Event) => { const detail = (event as CustomEvent<{ viewId: string; message: string }>).detail; if (detail?.viewId === viewId) setError(detail.message); };
    window.addEventListener('agentviewer:markdown-editor-history', history); window.addEventListener('agentviewer:markdown-error', failure);
    return () => { window.removeEventListener('agentviewer:markdown-editor-history', history); window.removeEventListener('agentviewer:markdown-error', failure); };
  }, [viewId]);
  const execute = (tool: Tool) => {
    setError('');
    const detail: MarkdownCommandEventDetail = { viewId, command: tool.command, ...(tool.value === undefined ? {} : { value: tool.value }) };
    window.dispatchEvent(new CustomEvent<MarkdownCommandEventDetail>('agentviewer:markdown-command', { detail }));
  };
  return <div className="markdown-tools" aria-label="Markdown 编辑工具">
    {groups.map(group => <section className="markdown-tool-group" key={group.label}>
      <h3>{group.label}</h3>
      <div className="markdown-tool-grid" role="group" aria-label={group.label}>
        {group.tools.map(tool => {
          const Icon = tool.icon, tooltip = tool.label + (tool.shortcut ? ' · ' + tool.shortcut : '') + '\n' + tool.description;
          return <button key={tool.command} type="button" className="markdown-tool-button icon-button" aria-label={tool.label} title={tooltip} data-markdown-command={tool.command} aria-pressed={['focus', 'typewriter', 'spellcheck', 'autoPair'].includes(tool.command) ? !!state[tool.command] : undefined} disabled={tool.command === 'undo' ? !state.canUndo : tool.command === 'redo' ? !state.canRedo : false} onMouseDown={event => event.preventDefault()} onClick={() => execute(tool)}>
            <span className="markdown-tool-glyph"><Icon size={17} aria-hidden="true" />{tool.badge && (tool.badge === 'add' ? <Plus className="markdown-tool-badge" size={10} aria-hidden="true" /> : <Minus className="markdown-tool-badge" size={10} aria-hidden="true" />)}</span>
          </button>;
        })}
      </div>
    </section>)}
    <section className="markdown-tool-group"><h3>Emoji</h3><input aria-label="搜索 Emoji 名称" placeholder="搜索名称，如 smile、rocket" value={emojiQuery} onChange={event => setEmojiQuery(event.target.value)} /><div className="markdown-emoji-picker" role="group" aria-label="插入 Emoji">{(emojiQuery ? emojiCatalog.filter(item => [...item.names, ...item.tags, item.description].some(name => name.includes(emojiQuery.toLowerCase()))).slice(0, 48).map(item => ({ emoji: item.emoji, label: item.names[0] })) : ['🙂', '😀', '😉', '🥳', '🤔', '👍', '👎', '👏', '🙏', '❤️', '✅', '❌', '⚠️', '💡', '📌', '📎', '📝', '🚀', '🐛', '🎯', '🔧', '📊', '🔥', '✨'].map(emoji => ({ emoji, label: emoji }))).map(({ emoji, label }) => <button key={label} type="button" aria-label={'插入 ' + label} title={label} onMouseDown={event => event.preventDefault()} onClick={() => execute({ command: 'emoji', value: emoji, label: 'Emoji', description: '', icon: Code })}>{emoji}</button>)}</div></section>
    <section className="markdown-tool-group"><h3>代码语言</h3><select aria-label="当前代码块语言" defaultValue="" onChange={event => execute({ command: 'codeLanguage', value: event.target.value, label: '代码语言', description: '', icon: Code2 })}>{['', 'javascript', 'typescript', 'python', 'cpp', 'c', 'csharp', 'java', 'go', 'rust', 'sql', 'json', 'yaml', 'html', 'css', 'bash', 'powershell', 'mermaid'].map(language => <option key={language} value={language}>{language || '纯文本'}</option>)}</select></section>
    <section className="markdown-tool-group"><h3>导入与导出</h3><button type="button" className="markdown-import-button" onClick={() => window.dispatchEvent(new CustomEvent('agentviewer:markdown-import', { detail: { viewId } }))}>导入为 Markdown</button><div className="markdown-export-formats">{(['markdown', 'html', 'pdf', 'png', 'docx', 'odt', 'rtf', 'epub', 'latex'] as const).map(format => <button key={format} type="button" onMouseDown={event => event.preventDefault()} onClick={() => window.dispatchEvent(new CustomEvent('agentviewer:markdown-export', { detail: { viewId, format } }))}>{format === 'markdown' ? 'Markdown' : format.toUpperCase()}</button>)}</div></section>
    {error && <p role="status" className="markdown-tool-error">{error}</p>}
  </div>;
}
