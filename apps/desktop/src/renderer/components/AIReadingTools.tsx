import { useState } from 'react';
import { GlassSegmentedControl } from './GlassSegmentedControl';
import { BookOpen, CircleHelp, FileText, Layers, Lightbulb, ListChecks, ListTree, Quote, ShieldCheck, Sigma, Table2 } from 'lucide-react';
import type { Format, ReadingContext, ReadingSnapshot } from '../../../../../packages/contracts/src/index';
import { AI_READING_TOOLS, getAIReadingScopeState, type AIReadingIcon, type AIReadingScope, type AIReadingToolDefinition } from '../lib/ai-reading-tools';

export type AIReadingToolsProps = {
  context?: ReadingContext; snapshot?: ReadingSnapshot; format?: Format; busy?: boolean; allowDocumentScope?: boolean;
  onRun(tool: AIReadingToolDefinition, scope: AIReadingScope): void | Promise<void>;
};
const icons: Record<AIReadingIcon, typeof FileText> = { summary: FileText, explain: Lightbulb, terms: BookOpen, 'key-points': ListChecks, questions: CircleHelp, evidence: Quote, outline: ListTree, review: ShieldCheck, formula: Sigma, table: Table2, flashcards: Layers };
const groups: AIReadingToolDefinition['group'][] = ['理解', '分析', '学习'];

/** UI only. The owner freezes the source, selects the model and runs the tool. */
export function AIReadingTools({ context, snapshot, format, busy = false, allowDocumentScope = false, onRun }: AIReadingToolsProps) {
  const [scope, setScope] = useState<AIReadingScope>(() => getAIReadingScopeState(context, snapshot, 'selection').available ? 'selection' : 'visible');
  const [running, setRunning] = useState<string>(), [error, setError] = useState('');
  const scopes: AIReadingScope[] = allowDocumentScope ? ['selection', 'visible', 'document'] : ['selection', 'visible'];
  const source = getAIReadingScopeState(context, snapshot, scope, allowDocumentScope), pending = busy || !!running;
  const run = async (tool: AIReadingToolDefinition) => {
    if (pending || !source.available || !tool.scopes.includes(scope)) return;
    setRunning(tool.id); setError('');
    try { await onRun(tool, scope); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRunning(undefined); }
  };
  return <section className="ai-reading-tools" aria-label="AI 阅读工具" data-reading-format={format} aria-busy={pending}>
    <div className="side-label">来源范围</div>
    <div className="ai-reading-scopes" onMouseDown={event => event.preventDefault()}>
      <GlassSegmentedControl label="选择阅读来源" value={scope} disabled={pending} options={scopes.map(value => { const state = getAIReadingScopeState(context, snapshot, value, allowDocumentScope); return { value, label: state.label, reason: state.available ? `只分析${state.label}，不会自动扩大来源` : state.reason }; })} onChange={value => { setScope(value as AIReadingScope); setError(''); }} />
    </div>
    <p className="side-hint ai-reading-source" role="status">{source.available ? `${snapshot ? '已固定来源 · ' : ''}${source.label}${source.textLength !== undefined ? ' · ' + source.textLength + ' 个字符' : ''}` : source.reason}</p>
    {groups.map(group => <section className="ai-reading-group" key={group} aria-label={group}><div className="side-label">{group}</div><div className="tool-grid">
      {AI_READING_TOOLS.filter(tool => tool.group === group).map(tool => { const Icon = icons[tool.icon]; return <button type="button" key={tool.id} data-ai-tool={tool.id} title={source.available ? tool.description : source.reason} disabled={pending || !source.available || !tool.scopes.includes(scope)} onMouseDown={event => event.preventDefault()} onClick={() => void run(tool)}><Icon size={19} /><span>{running === tool.id ? '分析中…' : tool.label}</span></button>; })}
    </div></section>)}
    {error && <p className="side-hint ai-reading-error" role="alert">{error}</p>}
  </section>;
}
