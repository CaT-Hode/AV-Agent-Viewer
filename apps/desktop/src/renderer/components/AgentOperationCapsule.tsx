import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { Pause, RotateCw, StopCircle } from 'lucide-react';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { AGENT_OPERATION_METRICS as metrics, type NavigationBackdropSample, type NavigationBounds } from '../lib/navigation-optics';
import '../agent-operation.css';

export const agentOperationLabels: Record<string, string> = { click: '点击', move: '移动光标', drag: '拖动选择', scroll: '滚动', press: '按键', type: '输入文字', analysis: '阅读分析', reading: '阅读此页', editing: '编辑此页' };
export type AgentOperationStatus = 'running' | 'paused' | 'stopped';

/** One presentation for document and trusted native webpage overlays. Only its
 * background uses optics; controls keep their normal input and text rendering. */
export function AgentOperationCapsule({ kind, status = 'running', target, native = false, backdropImage, backdropSample, onGeometry, onControl, style: motionStyle, ...presentation }: { kind?: string; status?: AgentOperationStatus; target?: string; native?: boolean; backdropImage?: string; backdropSample?: NavigationBackdropSample; onGeometry?(bounds: NavigationBounds): void; onControl(status: AgentOperationStatus): void } & HTMLAttributes<HTMLDivElement>) {
  const host = useRef<HTMLDivElement>(null), [bounds, setBounds] = useState<NavigationBounds>(), [surface, setSurface] = useState<'light' | 'dark'>();
  useLayoutEffect(() => {
    const element = host.current; if (!element) return;
    const measure = () => { const rect = element.getBoundingClientRect(), value = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; setBounds(previous => previous && ['x', 'y', 'width', 'height'].every(key => previous[key as keyof NavigationBounds] === value[key as keyof NavigationBounds]) ? previous : value); onGeometry?.(value); };
    const observer = new ResizeObserver(measure); observer.observe(element); window.addEventListener('resize', measure); measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [onGeometry, native, target, status]);
  useEffect(() => {
    if (!backdropImage) { setSurface(undefined); return; }
    let alive = true; const image = new Image();
    image.onload = () => { if (!alive) return; const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 2; const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return; context.drawImage(image, 0, 0, 16, 2); const pixels = context.getImageData(0, 0, 16, 2).data; let light = 0; for (let i = 0; i < pixels.length; i += 4) light += .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]; setSurface(light / 32 > 145 ? 'light' : 'dark'); };
    image.src = backdropImage; return () => { alive = false; image.onload = null; };
  }, [backdropImage]);
  const style = { '--agent-height': metrics.height + 'px', '--agent-radius': metrics.radius + 'px', '--agent-bottom': metrics.bottom + 'px', '--agent-button-size': metrics.buttonSize + 'px', ...motionStyle } as CSSProperties;
  return <div {...presentation} ref={host} className={'agent-capsule agent-operation-capsule material-host' + (native ? ' native-agent-capsule' : '')} style={style} data-surface={surface} data-agent-status={status} data-native-waiting={native && !backdropImage || undefined} role="status" aria-live="polite">
    <LiquidGlassSurface variant="capsule" effect="refractive" bezelWidth={metrics.bezelWidth} glassThickness={metrics.glassThickness} refractiveIndex={metrics.refractiveIndex} blur={metrics.blur} strength={metrics.refraction} specularOpacity={metrics.specularOpacity} specularSaturation={metrics.specularSaturation} backdropImage={backdropImage} backdropSample={backdropSample} bounds={bounds} />
    <span className="agent-operation-pulse" /><span className="agent-operation-label">Agent · {status === 'paused' ? '已暂停' : status === 'stopped' ? '已停止' : agentOperationLabels[kind ?? ''] ?? '编辑文档'}{target ? ' · ' + target : ''}</span>
    <button className="icon-button" onClick={() => onControl(status === 'running' ? 'paused' : 'running')} title={status === 'running' ? '暂停 Agent' : '继续 Agent'} aria-label={status === 'running' ? '暂停 Agent' : '继续 Agent'}>{status === 'running' ? <Pause size={14} /> : <RotateCw size={14} />}</button>
    <button className="icon-button" onClick={() => onControl('stopped')} title="停止 Agent" aria-label="停止 Agent" disabled={status === 'stopped'}><StopCircle size={15} /></button>
  </div>;
}
