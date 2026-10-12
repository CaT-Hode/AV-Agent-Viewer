import { useEffect, useRef, useState } from 'react';
import { Move } from 'lucide-react';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { useGlassElasticity } from '../lib/glass-elasticity';
import { KUBE_GLASS_PRESETS } from '../lib/glass-presets';

/** Explicit optics demonstration. Other settings surfaces remain frosted. */
export function GlassMaterialPreview() {
  const geometry = KUBE_GLASS_PRESETS.lens;
  const scene = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState({ x: 188, y: 40 });
  const drag = useRef<{ id: number; x: number; y: number; origin: { x: number; y: number } } | undefined>(undefined);
  const elastic = useGlassElasticity<HTMLDivElement>({ preset: 'lens' });
  useEffect(() => { const blur = () => { drag.current = undefined; }; window.addEventListener('blur', blur); return () => window.removeEventListener('blur', blur); }, []);
  return <section className="glass-material-preview" aria-label="玻璃材质预览">
    <div className="glass-preview-heading"><span>材质预览</span><small>拖动透镜查看边缘折射、放大与弹性变化</small></div>
    <div className="glass-preview-scene" ref={scene}>
      <div className="glass-preview-copy"><span>READ · THINK · CREATE</span><strong>让内容透过界面。</strong><p>玻璃边缘折射背景，中央透镜放大内容。</p></div>
      <div className="glass-preview-lines" aria-hidden="true" />
      <div ref={elastic.ref} className={'glass-preview-lens material-host ' + elastic.className} role="slider" tabIndex={0} aria-label="预览材质位置" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(point.x / Math.max(1, (scene.current?.clientWidth ?? 480) - geometry.width) * 100)}
        aria-valuetext="使用方向键移动玻璃" style={{ left: point.x, top: point.y }}
        onPointerDown={event => {
          if (event.isPrimary === false || event.button !== 0) return;
          elastic.bindings.onPointerDown(event);
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: point }; event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          elastic.bindings.onPointerMove(event);
          if (!drag.current || drag.current.id !== event.pointerId || !scene.current) return;
          setPoint({ x: Math.max(0, Math.min(scene.current.clientWidth - geometry.width, drag.current.origin.x + event.clientX - drag.current.x)), y: Math.max(0, Math.min(scene.current.clientHeight - geometry.height, drag.current.origin.y + event.clientY - drag.current.y)) });
        }}
        onPointerUp={event => { elastic.bindings.onPointerUp(event); if (drag.current?.id === event.pointerId) drag.current = undefined; }} onPointerCancel={event => { elastic.bindings.onPointerCancel(event); if (drag.current?.id === event.pointerId) drag.current = undefined; }}
        onLostPointerCapture={event => { elastic.bindings.onLostPointerCapture(event); if (drag.current?.id === event.pointerId) drag.current = undefined; }}
        onKeyUp={elastic.bindings.onKeyUp} onBlur={() => { elastic.bindings.onBlur(); drag.current = undefined; }}
        onKeyDown={event => {
          elastic.bindings.onKeyDown(event);
          const delta = ({ ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] } as Record<string, number[]>)[event.key];
          if (!delta || !scene.current) return;
          event.preventDefault();
          const bounds = scene.current.getBoundingClientRect();
          setPoint(previous => ({ x: Math.max(0, Math.min(bounds.width - geometry.width, previous.x + delta[0])), y: Math.max(0, Math.min(bounds.height - geometry.height, previous.y + delta[1])) }));
        }}>
        <LiquidGlassSurface variant="lens" effect="refractive" />
        <Move className="glass-preview-handle" size={14} aria-hidden="true" />
      </div>
    </div>
  </section>;
}
