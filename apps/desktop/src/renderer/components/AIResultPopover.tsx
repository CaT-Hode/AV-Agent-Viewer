import { Check, Copy, ExternalLink, RotateCw, StopCircle, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HarnessTask } from '../../../../../packages/contracts/src/index';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import type { NavigationBackdropSample, NavigationBounds } from '../lib/navigation-optics';
import '../ai-reading-tools.css';
import '../ai-result-content.css';

// Backdrop frames and polling must not reparse an unchanged answer.
const ResultMarkdown = memo(function ResultMarkdown({ text }: { text: string }) {
  return <div className="ai-result-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="ai-image-description">{alt ? `[图片：${alt}]` : '[图片]'}</span>, a: ({ children, href }) => <span title={href}>{children}</span> }}>{text}</ReactMarkdown></div>;
});

export function AIResultPopover({ task, label, source, sourceText, sourceUpdated, onClose, onCancel, onSave, onRetry, native = false, backdropImage, backdropSample, bounds, onGeometry, style, ...presentation }: {
  task: HarnessTask; label: string; source: string;
  sourceText?: string; sourceUpdated?: boolean; onRetry?(): void;
  onClose(): void; onCancel(): void; onSave(): void;
  native?: boolean; backdropImage?: string; backdropSample?: NavigationBackdropSample; bounds?: NavigationBounds; onGeometry?(bounds: NavigationBounds): void;
} & HTMLAttributes<HTMLElement>) {
  const host = useRef<HTMLElement>(null), [surface, setSurface] = useState<'light' | 'dark'>();
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState(''), [showSource, setShowSource] = useState(false);
  useEffect(() => { setCopied(false); setCopyError(''); setShowSource(false); }, [task.id]);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); } }, [copied]);
  const copy = async () => { try { await navigator.clipboard.writeText(task.text); setCopied(true); setCopyError(''); } catch { setCopyError('复制失败，请选中结果手动复制。'); } };
  useEffect(() => {
    if (!native || !backdropImage) return;
    let alive = true; const image = new Image();
    image.onload = () => { if (!alive) return; const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 8; const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return; context.drawImage(image, 0, 0, 16, 8); const pixels = context.getImageData(0, 0, 16, 8).data; let light = 0, weight = 0; for (let i = 0; i < pixels.length; i += 4) { const alpha = pixels[i + 3] / 255; light += (.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]) * alpha; weight += alpha; } if (weight) setSurface(light / weight > 145 ? 'light' : 'dark'); };
    image.src = backdropImage; return () => { alive = false; image.onload = null; };
  }, [native, backdropImage]);
  useLayoutEffect(() => {
    if (!onGeometry || !host.current) return;
    const measure = () => { const rect = host.current!.getBoundingClientRect(); onGeometry({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); };
    const observer = new ResizeObserver(measure); observer.observe(host.current); window.addEventListener('resize', measure); measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [onGeometry]);
  return <section {...presentation} ref={host} className={'ai-result-popover material-host' + (native ? ' native-ai-result-popover' : '')} style={style as CSSProperties} data-surface={surface} data-native-waiting={native && !backdropImage || undefined} aria-label={label + '结果'}>
    <LiquidGlassSurface variant="panel" effect="refractive" strength={.82} specularOpacity={.24} backdropImage={backdropImage} backdropSample={backdropSample} bounds={bounds} />
    <header><div><strong>{label}</strong><small>{source}</small></div><button className="icon-button" aria-label="关闭分析结果" title="关闭分析结果" onClick={onClose}><X size={16} /></button></header>
    {sourceText !== undefined && <div className="ai-source-bar"><button aria-expanded={showSource} onClick={() => setShowSource(value => !value)}>{showSource ? '返回结果' : '查看本次来源'}</button>{sourceUpdated && <span>来源已更新</span>}</div>}
    <div className="ai-result-body" aria-busy={task.status === 'running'}>
      {showSource ? <p className="ai-source-text">{sourceText}</p> : task.text ? <ResultMarkdown text={task.text} /> : <span className="side-hint">{task.status === 'running' ? '正在分析这份固定来源…' : task.status === 'cancelled' ? '已停止，可以使用同一来源重试。' : '暂无结果'}</span>}
      {task.error && <p className="ai-result-error" role="alert">{task.error}</p>}
      {copyError && <p className="ai-result-error" role="alert">{copyError}</p>}
    </div>
    <footer><span role="status">{copied ? '已复制' : ({ running: '分析中', completed: '已完成', failed: '失败', cancelled: '已取消' })[task.status]}</span>
      <button className="icon-button" aria-label="复制分析结果" title={copied ? '已复制' : '复制分析结果'} disabled={!task.text} onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
      <button className="icon-button" aria-label="保存分析为独立文档" title="保存分析为独立文档" disabled={!task.text || task.status === 'running'} onClick={onSave}><ExternalLink size={15} /></button>
      {onRetry && <button className="icon-button" aria-label="使用本次来源重新分析" title="使用本次来源重新分析" disabled={task.status === 'running'} onClick={onRetry}><RotateCw size={15} /></button>}
      {task.status === 'running' && <button className="icon-button" aria-label="取消分析" title="取消分析" onClick={onCancel}><StopCircle size={15} /></button>}
    </footer>
  </section>;
}
