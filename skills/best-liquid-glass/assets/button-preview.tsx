import { useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Lock, Pencil, Save, Settings } from 'lucide-react';
import { GlassInteractionHost } from '@agentviewer/components/GlassInteractionHost';
import { GlassSegmentedControl } from '@agentviewer/components/GlassSegmentedControl';
import { NavigationGlass } from '@agentviewer/components/NavigationGlass';
import { glassOpticsCacheStats } from '@agentviewer/lib/liquid-glass-optics';
import '@agentviewer/preview-style-order';

// Preview layout/state only. All button CSS, optical geometry, pointer capture,
// drag arbitration, cancellation and spring equations come from the app imports.
const options = [
  { value: 'reading', label: '阅读' },
  { value: 'source', label: '源码' },
  { value: 'split', label: '分栏' },
  { value: 'locked', label: '锁定', disabled: true },
];

function Preview() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [motion, setMotion] = useState('standard');
  const [value, setValue] = useState('reading');
  const [disabled, setDisabled] = useState(false);
  const [selected, setSelected] = useState(false);
  const [actions, setActions] = useState(0);
  const [changes, setChanges] = useState(0);
  const [surface, setSurface] = useState<'light' | 'dark'>();
  const [optics, setOptics] = useState({ total: 0, ready: 0, failed: 0 });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.motion = motion;
  }, [theme, motion]);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const nodes = [...document.querySelectorAll<HTMLElement>('.preview-designs .liquid-glass-surface')];
      const next = { total: nodes.length, ready: nodes.filter(node => node.dataset.glassEffect === 'refractive' && !node.hasAttribute('data-glass-pending') && node.dataset.glassFallback !== 'true' && !!node.querySelector('feDisplacementMap')).length, failed: nodes.filter(node => node.dataset.glassFallback === 'true').length };
      setOptics(previous => previous.total === next.total && previous.ready === next.ready && previous.failed === next.failed ? previous : next);
    };
    const update = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new MutationObserver(update);
    observer.observe(document.querySelector('.preview-designs')!, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-glass-pending', 'data-glass-fallback'] });
    window.addEventListener('agentviewer:glass-optics', update); update();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('agentviewer:glass-optics', update); };
  }, []);
  const ready = optics.total > 0 && optics.ready === optics.total && !optics.failed;
  return <main className="button-preview" data-preview-ready={ready} data-preview-failed={!!optics.failed}>
    <header className="preview-header"><div><h1>项目原生液态玻璃按钮</h1><p>原组件 · 原样式 · 原拖动与弹簧</p></div><div className="preview-options">
      <button type="button" className="button" aria-label="切换深浅色" onClick={() => setTheme(previous => previous === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '切到浅色' : '切到深色'}</button>
      <label>运动 <select aria-label="运动模式" value={motion} onChange={event => setMotion(event.currentTarget.value)}><option value="standard">标准</option><option value="elegant">舒缓</option><option value="reduced">减少</option><option value="off">关闭</option></select></label>
      <label><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.currentTarget.checked)} />禁用控件</label>
    </div></header>
    <div className="preview-designs">
      <section className="preview-section"><h2>操作 / 图标按钮</h2><p>SelectionTools 的操作胶囊与 NavigationGlass，交互由 GlassInteractionHost 驱动。</p>
        <div className="preview-scene"><div className="preview-copy" aria-hidden="true"><span>READ · THINK · CREATE</span><strong>内容透过真实折射的边缘。</strong><span>0123456789　光学背景与原生控件</span></div>
          <div className="preview-control-row"><div className="selection-tool-icons material-host floating-capsule navigation-capsule" data-navigation-surface={surface} role="toolbar" aria-label="操作按钮" onMouseDown={event => event.preventDefault()}>
            <NavigationGlass softness="selection" onSurface={setSurface} />
            <div className="selection-tool-row">
              <button type="button" className="icon-button" aria-label="保存文档" title="保存文档" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => setActions(previous => previous + 1)}><Save size={16} /></button>
              <button type="button" className={'icon-button ' + (selected ? 'selected' : '')} aria-label="标记选区" title="标记选区" aria-pressed={selected} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { setSelected(previous => !previous); setActions(previous => previous + 1); }}><Pencil size={16} /></button>
              <button type="button" className="icon-button" aria-label="打开设置" title="打开设置" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => setActions(previous => previous + 1)}><Settings size={16} /></button>
              <button type="button" className="icon-button" aria-label="锁定操作" title="锁定操作" disabled><Lock size={16} /></button>
            </div>
          </div></div>
        </div><output aria-live="polite" data-action-count={actions}>操作已触发 {actions} 次</output>
      </section>
      <section className="preview-section"><h2>分段选择按钮</h2><p>直接挂载 GlassSegmentedControl：按住拖动镜片，松开提交；保留原生键盘和取消语义。</p>
        <div className="preview-scene"><div className="preview-copy" aria-hidden="true"><span>READER　SOURCE　SPLIT</span><strong>一个值，一次提交。</strong><span>0123456789　原生按钮与锁定项</span></div>
          <div className="preview-control-row"><GlassSegmentedControl label="阅读模式" value={value} options={options} disabled={disabled} onChange={next => { setValue(next); setChanges(previous => previous + 1); }} /></div>
        </div><output aria-live="polite" data-selection-value={value} data-change-count={changes}>已选择 {options.find(option => option.value === value)?.label} · 提交 {changes} 次</output>
      </section>
    </div>
    <p className="preview-status" role="status">{optics.failed ? '真实折射不可用：请检查当前浏览器的 Worker / OffscreenCanvas / Blob 支持；本预览不将降级表面计为成功。' : ready ? `真实折射已就绪 ${optics.ready}/${optics.total}` : `正在生成真实折射 ${optics.ready}/${optics.total}`}</p>
    <p className="preview-note">按钮样式与交互直接编译当前项目源码，未另写近似控制器。仅此页面的布局、说明、示例值与 Worker 的离线 Blob 地址属于预览适配。</p>
    <GlassInteractionHost />
  </main>;
}

Object.defineProperty(window, '__agentViewerButtonPreview', { value: Object.freeze({ optics: glassOpticsCacheStats }), configurable: false });
createRoot(document.getElementById('root')!).render(<Preview />);
