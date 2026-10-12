import { useEffect, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, Bold, Copy, Italic, Plus, TextCursorInput, Trash2, Underline } from 'lucide-react';
import { ActionTool, ColorControl, IconTool, OfficeFeedback, OfficeField, ToolGroup, useOfficeCommands, type OfficeToolProps } from './OfficeShared';

export function PresentationTools(props: OfficeToolProps) {
  const { document, viewId, target, placement = 'sidebar' } = props, command = useOfficeCommands(props);
  const active = target?.viewId === viewId ? target : undefined;
  const slides = document.model.slides ?? [], slide = slides.find(item => item.id === active?.slideId) ?? slides[0];
  const shape = slide?.blocks.find(item => item.id === active?.shapeId) ?? slide?.blocks[0], index = slides.findIndex(item => item.id === slide?.id);
  const [bounds, setBounds] = useState({ x: 10, y: 10, width: 80, height: 20 });
  const [text, setText] = useState(''), [size, setSize] = useState(24), [rotation, setRotation] = useState(0), [lineWidth, setLineWidth] = useState(1);
  useEffect(() => { setBounds({ x: +(100 * (shape?.x ?? .1)).toFixed(2), y: +(100 * (shape?.y ?? .1)).toFixed(2), width: +(100 * (shape?.width ?? .8)).toFixed(2), height: +(100 * (shape?.height ?? .2)).toFixed(2) }); setSize(shape?.fontSize ?? 24); setRotation(shape?.rotation ?? 0); setLineWidth(shape?.lineWidth ?? 1); }, [shape?.id, shape?.x, shape?.y, shape?.width, shape?.height, shape?.fontSize, shape?.rotation, shape?.lineWidth]);
  const style = (change: Record<string, unknown>) => slide && shape && void command.run('slides.setShapeStyle', { slideId: slide.id, shapeId: shape.id, ...change });
  const disabled = !slide || !shape || command.busy;
  return <div className={'office-tools-v2 office-presentation-tools office-' + placement}>
    {placement === 'sidebar' && <p className="office-target-label">第 {index + 1} 张 · {shape?.text.slice(0, 36) || '点击对象以编辑属性'}</p>}
    <ToolGroup title="幻灯片">
      {command.supports('slides.addSlide') && <IconTool label="新建幻灯片" icon={Plus} disabled={command.busy} onClick={() => void command.run('slides.addSlide', { afterSlideId: slide?.id, title: '新幻灯片' })} />}
      {command.supports('slides.duplicateSlide') && <IconTool label="复制幻灯片" icon={Copy} disabled={!slide || command.busy} onClick={() => slide && void command.run('slides.duplicateSlide', { slideId: slide.id })} />}
      {command.supports('slides.moveSlide') && <><IconTool label="幻灯片前移" icon={ArrowUp} disabled={!slide || index <= 0 || command.busy} onClick={() => slide && void command.run('slides.moveSlide', { slideId: slide.id, index: index - 1 })} /><IconTool label="幻灯片后移" icon={ArrowDown} disabled={!slide || index === slides.length - 1 || command.busy} onClick={() => slide && void command.run('slides.moveSlide', { slideId: slide.id, index: index + 1 })} /></>}
      {command.supports('slides.deleteSlide') && <IconTool label="删除幻灯片" icon={Trash2} disabled={!slide || slides.length < 2 || command.busy} onClick={() => slide && void command.run('slides.deleteSlide', { slideId: slide.id })} />}
      {command.supports('slides.setBackground') && <ColorControl label="幻灯片背景" value={slide?.background ?? 'FFFFFF'} disabled={!slide || command.busy} onChange={color => slide && void command.run('slides.setBackground', { slideId: slide.id, color })} />}
    </ToolGroup>
    {command.supports('slides.setShapeStyle') && <ToolGroup title="对象文字">
      <select aria-label="PPT 字体" value={shape?.fontName ?? 'Arial'} disabled={disabled} onChange={event => style({ fontName: event.target.value })}>{[...new Set([shape?.fontName ?? 'Arial', 'Arial', 'Calibri', 'Times New Roman', '微软雅黑', '等线', '宋体'])].map(name => <option key={name}>{name}</option>)}</select>
      <input aria-label="PPT 字号" type="number" min="1" max="400" className="office-font-size" disabled={disabled} value={size} onChange={event => setSize(Number(event.target.value))} onBlur={() => size !== (shape?.fontSize ?? 24) && style({ fontSize: size })} />
      <IconTool label="粗体" icon={Bold} disabled={disabled} selected={!!shape?.bold} onClick={() => style({ bold: !shape?.bold })} /><IconTool label="斜体" icon={Italic} disabled={disabled} selected={!!shape?.italic} onClick={() => style({ italic: !shape?.italic })} /><IconTool label="下划线" icon={Underline} disabled={disabled} selected={!!shape?.underline} onClick={() => style({ underline: !shape?.underline })} />
      {([['left', AlignLeft, '左对齐'], ['center', AlignCenter, '居中'], ['right', AlignRight, '右对齐']] as const).map(([alignment, icon, label]) => <IconTool key={alignment} label={label} icon={icon} disabled={disabled} selected={shape?.alignment === alignment} onClick={() => style({ alignment })} />)}
      <ColorControl label="文字颜色" value={shape?.color} disabled={disabled} onChange={color => style({ color })} />
    </ToolGroup>}
    {command.supports('slides.addTextShape') && <ToolGroup title="插入对象"><input aria-label="新文本对象内容" placeholder="文本框内容" value={text} onChange={event => setText(event.target.value)} /><IconTool label="插入文本框" icon={TextCursorInput} disabled={!slide || command.busy || !text.trim()} onClick={() => slide && void command.run('slides.addTextShape', { slideId: slide.id, text, x: .1, y: .25, width: .8, height: .2 }).then(ok => { if (ok) setText(''); })} /></ToolGroup>}
    {placement === 'sidebar' && command.supports('slides.setShapeBounds') && <ToolGroup title="位置与尺寸">
      {(['x', 'y', 'width', 'height'] as const).map((key, i) => <OfficeField key={key} label={['横向（%）', '纵向（%）', '宽度（%）', '高度（%）'][i]}><input aria-label={['横向位置', '纵向位置', '对象宽度', '对象高度'][i]} type="number" min={key === 'width' || key === 'height' ? .1 : 0} max="100" step=".1" disabled={disabled} value={bounds[key]} onChange={event => setBounds(old => ({ ...old, [key]: Number(event.target.value) }))} /></OfficeField>)}
      <ActionTool disabled={disabled || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.x + bounds.width > 100 || bounds.y + bounds.height > 100} onClick={() => slide && shape && void command.run('slides.setShapeBounds', { slideId: slide.id, shapeId: shape.id, x: bounds.x / 100, y: bounds.y / 100, width: bounds.width / 100, height: bounds.height / 100 })}>应用位置与尺寸</ActionTool>
    </ToolGroup>}
    {placement === 'sidebar' && command.supports('slides.setShapeStyle') && <ToolGroup title="对象外观">
      <ColorControl label="填充色" value={shape?.fill ?? 'FFFFFF'} disabled={disabled} onChange={fill => style({ fill })} /><ColorControl label="边框色" value={shape?.lineColor} disabled={disabled} onChange={lineColor => style({ lineColor })} />
      <OfficeField label="边框（磅）"><input aria-label="对象边框宽度" type="number" min="0" max="30" step=".25" value={lineWidth} onChange={event => setLineWidth(Number(event.target.value))} /></OfficeField><OfficeField label="旋转（度）"><input aria-label="对象旋转" type="number" min="-360" max="360" value={rotation} onChange={event => setRotation(Number(event.target.value))} /></OfficeField><ActionTool disabled={disabled} onClick={() => style({ rotation, lineWidth })}>应用对象外观</ActionTool>
    </ToolGroup>}
    {placement === 'sidebar' && command.supports('slides.deleteShape') && <ActionTool disabled={disabled} onClick={() => slide && shape && void command.run('slides.deleteShape', { slideId: slide.id, shapeId: shape.id })}><Trash2 size={14} /> 删除当前对象</ActionTool>}
    <OfficeFeedback busy={command.busy} error={command.error} />
  </div>;
}
