import { Check, Copy, FilePlus2, Languages, Pin, RotateCw, StopCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Locator } from '../../../../../packages/contracts/src/index';
import { AnimatedDisclosure } from './MotionPresence';
import '../translation-card.css';

export type TranslationCardState = {
  id: string; requestId?: string; viewId: string; source: string; result: string; sourceRevision: number;
  locator?: Locator; pinned: boolean; status: 'loading' | 'ready' | 'error' | 'cancelled'; error?: string;
  targetLanguage?: string; model?: string; connectionId?: string;
};
export const translationLanguages = [ ['zh-CN', '简体中文'], ['en', '英语'], ['ja', '日语'], ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'], ['ko', '韩语'] ] as const;
function sourceName(card: TranslationCardState) {
  if (card.locator?.pageIndex !== undefined) return `第 ${card.locator.pageIndex + 1} 页`;
  if (card.locator?.cell) return card.locator.cell;
  if (card.locator?.slideId) return '幻灯片选区';
  return '当前选区';
}
export function TranslationCard({ card, sourceUpdated, models, onModel, onPin, onRetry, onClose, onCancel, onSave }: {
  card: TranslationCardState; sourceUpdated?: boolean; onPin(): void; onRetry(language: string): void;
  models: { id: string; name: string; modelId: string }[]; onModel(connectionId: string): void;
  onClose(): void; onCancel(): void; onSave(): void;
}) {
  const [copied, setCopied] = useState(''), [copyError, setCopyError] = useState('');
  useEffect(() => { setCopied(''); setCopyError(''); }, [card.requestId, card.id]);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(''), 1600); return () => clearTimeout(timer); } }, [copied]);
  const copy = async (bilingual: boolean) => { try { await navigator.clipboard.writeText(bilingual ? card.source + '\n\n' + card.result : card.result); setCopied(bilingual ? '双语已复制' : '译文已复制'); setCopyError(''); } catch { setCopyError('复制失败，请选中文字手动复制。'); } };
  return <section className="translation-card" aria-label="选区译文" onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
    <div className="translation-card-top"><span><Languages size={15} />翻译 · {sourceName(card)}</span><div className="translation-card-controls">
      <button className="icon-button" aria-label={card.pinned ? '取消固定译文' : '固定译文'} title={card.pinned ? '取消固定译文' : '固定译文'} aria-pressed={card.pinned} onClick={onPin}><Pin size={15} fill={card.pinned ? 'currentColor' : 'none'} /></button>
      <button className="icon-button" aria-label="关闭此译文" title="关闭此译文" onClick={onClose}><X size={15} /></button>
    </div></div>
    <div className="translation-card-meta"><label>译为 <select aria-label="此译文的目标语言" value={card.targetLanguage ?? 'zh-CN'} disabled={card.status === 'loading'} onChange={event => onRetry(event.target.value)}>{translationLanguages.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><span>{sourceUpdated ? '来源已更新' : '版本 ' + card.sourceRevision}</span></div>
    {models.length > 0 && <div className="translation-card-meta translation-model"><label>模型 <select aria-label="此译文的模型" title={card.model} value={card.connectionId ?? ''} disabled={card.status === 'loading'} onChange={event => onModel(event.target.value)}><option value="">跟随翻译设置</option>{card.connectionId && !models.some(model => model.id === card.connectionId) && <option value={card.connectionId} disabled>原连接不可用</option>}{models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.modelId}</option>)}</select></label></div>}
    {card.status === 'loading' ? <p className="translation-loading" role="status">正在翻译选中内容…</p> : card.status === 'error' ? <p className="translation-error" role="alert">{card.error}</p> : card.status === 'cancelled' ? <p className="translation-loading">已停止，可使用同一片段重试。</p> : <div className="translation-result">{card.result}</div>}
    <AnimatedDisclosure label="查看原文"><p className="translation-original">{card.source}</p></AnimatedDisclosure>
    {copyError && <p className="translation-error" role="alert">{copyError}</p>}
    <div className="translation-actions">
      <button className="icon-button" aria-label="复制译文" title="复制译文" disabled={card.status !== 'ready'} onClick={() => void copy(false)}>{copied === '译文已复制' ? <Check size={16} /> : <Copy size={16} />}</button>
      <button className="icon-button" aria-label="复制双语" title="复制双语" disabled={card.status !== 'ready'} onClick={() => void copy(true)}>{copied === '双语已复制' ? <Check size={16} /> : <Languages size={16} />}</button>
      <button className="icon-button" aria-label="保存译文为独立文档" title="保存译文为独立文档" disabled={card.status !== 'ready'} onClick={onSave}><FilePlus2 size={16} /></button>
      {card.status === 'loading' ? <button className="icon-button" aria-label="停止选区翻译" title="停止选区翻译" onClick={onCancel}><StopCircle size={16} /></button> : <button className="icon-button" aria-label="重新翻译此片段" title="重新翻译此片段" onClick={() => onRetry(card.targetLanguage ?? 'zh-CN')}><RotateCw size={16} /></button>}
      <span role="status">{copied || (card.pinned ? '已固定' : '')}</span>
    </div>
  </section>;
}
