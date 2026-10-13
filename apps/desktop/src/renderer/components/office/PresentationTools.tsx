import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bold, Copy, Italic, Plus, TextCursorInput, Trash2, Underline } from 'lucide-react';
import type { OfficeTextStyle } from '../../../../../../packages/contracts/src/index';
import { slidePreviewMetrics } from '../../lib/slide-preview';
import { ActionTool, ColorControl, IconTool, OfficeFeedback, OfficeField, ToolGroup, useOfficeCommands } from './OfficeShared';
import { presentationToolboxSelection, type OfficeToolboxProps } from './toolbox-contributions';

function previewFont(style: OfficeTextStyle): CSSProperties {
  return { fontFamily: style.fontName, fontSize: style.fontSize ? style.fontSize * 4 / 3 : undefined, fontWeight: style.bold ? 700 : undefined, fontStyle: style.italic ? 'italic' : undefined, color: style.color ? '#' + style.color : undefined, textDecoration: [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined };
}

export function PresentationTools(props: OfficeToolboxProps) {
  const { document, viewId, target, category = 'slides' } = props, command = useOfficeCommands(props);
  const slides = document.model.slides ?? [], { slide, shape } = presentationToolboxSelection(document.model, viewId, target), index = slides.findIndex(item => item.id === slide?.id);
  const [bounds, setBounds] = useState({ x: 10, y: 10, width: 80, height: 20 });
  const [text, setText] = useState(''), [size, setSize] = useState(24), [rotation, setRotation] = useState(0), [lineWidth, setLineWidth] = useState(1);
  const [navigating, setNavigating] = useState(false), [navigationError, setNavigationError] = useState('');
  const thumbnails = useRef<HTMLDivElement>(null), [thumbnailWidth, setThumbnailWidth] = useState(208);
  useEffect(() => {
    const element = thumbnails.current; if (!element) return;
    const measure = () => setThumbnailWidth(Math.max(96, Math.min(208, element.clientWidth - 8)));
    const observer = new ResizeObserver(measure); observer.observe(element); measure(); return () => observer.disconnect();
  }, [category]);
  useEffect(() => { setBounds({ x: +(100 * (shape?.x ?? .1)).toFixed(2), y: +(100 * (shape?.y ?? .1)).toFixed(2), width: +(100 * (shape?.width ?? .8)).toFixed(2), height: +(100 * (shape?.height ?? .2)).toFixed(2) }); setSize(shape?.fontSize ?? 24); setRotation(shape?.rotation ?? 0); setLineWidth(shape?.lineWidth ?? 1); }, [shape?.id, shape?.x, shape?.y, shape?.width, shape?.height, shape?.fontSize, shape?.rotation, shape?.lineWidth]);
  const style = (change: Record<string, unknown>) => slide && shape && void command.run('slides.setShapeStyle', { slideId: slide.id, shapeId: shape.id, ...change });
  const busy = command.busy || navigating, disabled = !slide || !shape || busy;
  const go = (slideId: string) => {
    if (!props.onNavigate || busy) return;
    setNavigating(true); setNavigationError('');
    void props.onNavigate({ kind: 'slide', slideId }).catch(cause => setNavigationError(cause instanceof Error ? cause.message : String(cause))).finally(() => setNavigating(false));
  };
  const preview = slidePreviewMetrics(document.model.width, document.model.height, thumbnailWidth);
  return <div className="office-tools-v2 office-presentation-tools">
    {category === 'slides' && <>
      <ToolGroup title="幻灯片">
        {command.supports('slides.addSlide') && <IconTool label="新建幻灯片" icon={Plus} disabled={busy} onClick={() => void command.run('slides.addSlide', { afterSlideId: slide?.id, title: '新幻灯片' })} />}
        {command.supports('slides.duplicateSlide') && <IconTool label="复制幻灯片" icon={Copy} disabled={!slide || busy} onClick={() => slide && void command.run('slides.duplicateSlide', { slideId: slide.id })} />}
        {command.supports('slides.moveSlide') && <><IconTool label="幻灯片前移" icon={ArrowUp} disabled={!slide || index <= 0 || busy} onClick={() => slide && void command.run('slides.moveSlide', { slideId: slide.id, index: index - 1 })} /><IconTool label="幻灯片后移" icon={ArrowDown} disabled={!slide || index === slides.length - 1 || busy} onClick={() => slide && void command.run('slides.moveSlide', { slideId: slide.id, index: index + 1 })} /></>}
        {command.supports('slides.deleteSlide') && <IconTool label="删除幻灯片" icon={Trash2} disabled={!slide || slides.length < 2 || busy} onClick={() => slide && void command.run('slides.deleteSlide', { slideId: slide.id })} />}
      </ToolGroup>
      <div className="office-sidebar-pager" aria-label="幻灯片分页"><IconTool label="上一张" icon={ArrowLeft} disabled={!props.onNavigate || busy || index <= 0} onClick={() => go(slides[index - 1].id)} /><span>{index + 1} / {slides.length}</span><IconTool label="下一张" icon={ArrowRight} disabled={!props.onNavigate || busy || index >= slides.length - 1} onClick={() => go(slides[index + 1].id)} /></div>
      <div className="office-slide-list" ref={thumbnails} aria-label="幻灯片缩略图">{slides.map((item, i) => <button key={item.id} type="button" className={slide?.id === item.id ? 'selected' : ''} aria-label={'第 ' + (i + 1) + ' 张幻灯片'} title={item.blocks.find(block => block.text.trim())?.text.slice(0, 160) || '空白幻灯片'} aria-current={slide?.id === item.id ? 'page' : undefined} disabled={!props.onNavigate || busy} onClick={() => go(item.id)}>
        <span className="office-slide-thumbnail" style={{ width: preview.width, height: preview.height, backgroundColor: item.background ? '#' + item.background : '#fff' }} aria-hidden="true"><span className="office-slide-thumbnail-canvas" style={{ width: preview.logicalWidth, height: preview.logicalHeight, transform: 'scale(' + preview.scale + ')' }}>{item.blocks.map(block => <span key={block.id} className="office-slide-thumbnail-object" style={{ left: (block.x ?? .1) * 100 + '%', top: (block.y ?? .1) * 100 + '%', width: (block.width ?? .8) * 100 + '%', height: (block.height ?? .2) * 100 + '%', backgroundColor: block.fill ? '#' + block.fill : undefined, border: block.lineColor ? (block.lineWidth ?? 1) * 4 / 3 + 'px solid #' + block.lineColor : undefined, transform: block.rotation ? 'rotate(' + block.rotation + 'deg)' : undefined }}><span className="office-slide-thumbnail-text" style={{ ...(block.runs?.length ? {} : previewFont(block)), textAlign: block.alignment as CSSProperties['textAlign'] }}>{(block.runs?.length ? block.runs : [{ text: block.text }]).map((run, n) => <span key={n} style={previewFont(run)}>{run.text}</span>)}</span></span>)}</span></span><span className="office-slide-number">{i + 1}</span>
      </button>)}</div>
    </>}
    {category === 'home' && command.supports('slides.setShapeStyle') && <ToolGroup title="文字与对齐">
      {!shape && <p className="office-capability-note">选中画布上的对象后编辑文字属性。</p>}
      <select aria-label="PPT 字体" value={shape?.fontName ?? 'Arial'} disabled={disabled} onChange={event => style({ fontName: event.target.value })}>{[...new Set([shape?.fontName ?? 'Arial', 'Arial', 'Calibri', 'Times New Roman', '微软雅黑', '等线', '宋体'])].map(name => <option key={name}>{name}</option>)}</select>
      <input aria-label="PPT 字号" type="number" min="1" max="400" className="office-font-size" disabled={disabled} value={size} onChange={event => setSize(Number(event.target.value))} onBlur={() => size >= 1 && size <= 400 && size !== (shape?.fontSize ?? 24) && style({ fontSize: size })} />
      <IconTool label="粗体" icon={Bold} disabled={disabled} selected={!!shape?.bold} onClick={() => style({ bold: !shape?.bold })} /><IconTool label="斜体" icon={Italic} disabled={disabled} selected={!!shape?.italic} onClick={() => style({ italic: !shape?.italic })} /><IconTool label="下划线" icon={Underline} disabled={disabled} selected={!!shape?.underline} onClick={() => style({ underline: !shape?.underline })} />
      {([['left', AlignLeft, '左对齐'], ['center', AlignCenter, '居中'], ['right', AlignRight, '右对齐']] as const).map(([alignment, icon, label]) => <IconTool key={alignment} label={label} icon={icon} disabled={disabled} selected={shape?.alignment === alignment} onClick={() => style({ alignment })} />)}
      <ColorControl label="文字颜色" value={shape?.color} disabled={disabled} onChange={color => style({ color })} />
    </ToolGroup>}
    {category === 'insert' && command.supports('slides.addTextShape') && <ToolGroup title="文本框"><input aria-label="新文本对象内容" placeholder="文本框内容" value={text} onChange={event => setText(event.target.value)} /><IconTool label="插入文本框" icon={TextCursorInput} disabled={!slide || busy || !text.trim()} onClick={() => slide && void command.run('slides.addTextShape', { slideId: slide.id, text, x: .1, y: .25, width: .8, height: .2 }).then(ok => { if (ok) setText(''); })} /></ToolGroup>}
    {category === 'design' && <>
      {command.supports('slides.setBackground') && <ToolGroup title="幻灯片背景"><ColorControl label="幻灯片背景" value={slide?.background ?? 'FFFFFF'} disabled={!slide || busy} onChange={color => slide && void command.run('slides.setBackground', { slideId: slide.id, color })} /></ToolGroup>}
      {command.supports('slides.setShapeStyle') && <ToolGroup title="对象外观">
        {!shape && <p className="office-capability-note">选中对象后设置填充与边框。</p>}
        <ColorControl label="填充色" value={shape?.fill ?? 'FFFFFF'} disabled={disabled} onChange={fill => style({ fill })} /><ColorControl label="边框色" value={shape?.lineColor} disabled={disabled} onChange={lineColor => style({ lineColor })} />
        <OfficeField label="边框（磅）"><input aria-label="对象边框宽度" type="number" min="0" max="30" step=".25" disabled={disabled} value={lineWidth} onChange={event => setLineWidth(Number(event.target.value))} /></OfficeField><ActionTool disabled={disabled || !Number.isFinite(lineWidth) || lineWidth < 0 || lineWidth > 30} onClick={() => style({ lineWidth })}>应用边框</ActionTool>
      </ToolGroup>}
    </>}
    {category === 'arrange' && <>
      {command.supports('slides.setShapeBounds') && <ToolGroup title="位置与尺寸">
        {!shape && <p className="office-capability-note">选中画布上的对象后调整位置与尺寸。</p>}
        {(['x', 'y', 'width', 'height'] as const).map((key, i) => <OfficeField key={key} label={['横向（%）', '纵向（%）', '宽度（%）', '高度（%）'][i]}><input aria-label={['横向位置', '纵向位置', '对象宽度', '对象高度'][i]} type="number" min={key === 'width' || key === 'height' ? .1 : 0} max="100" step=".1" disabled={disabled} value={bounds[key]} onChange={event => setBounds(old => ({ ...old, [key]: Number(event.target.value) }))} /></OfficeField>)}
        <ActionTool disabled={disabled || !Object.values(bounds).every(Number.isFinite) || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.x + bounds.width > 100 || bounds.y + bounds.height > 100} onClick={() => slide && shape && void command.run('slides.setShapeBounds', { slideId: slide.id, shapeId: shape.id, x: bounds.x / 100, y: bounds.y / 100, width: bounds.width / 100, height: bounds.height / 100 })}>应用位置与尺寸</ActionTool>
      </ToolGroup>}
      {command.supports('slides.setShapeStyle') && <ToolGroup title="旋转"><OfficeField label="旋转（度）"><input aria-label="对象旋转" type="number" min="-360" max="360" disabled={disabled} value={rotation} onChange={event => setRotation(Number(event.target.value))} /></OfficeField><ActionTool disabled={disabled || !Number.isFinite(rotation) || Math.abs(rotation) > 360} onClick={() => style({ rotation })}>应用旋转</ActionTool></ToolGroup>}
    </>}
    <OfficeFeedback busy={busy} error={command.error || navigationError} />
  </div>;
}
