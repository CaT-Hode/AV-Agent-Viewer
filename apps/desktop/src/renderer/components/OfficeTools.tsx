import { useEffect, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, ExternalLink, Italic, Plus, RotateCw } from 'lucide-react';
import type { DocumentInfo, EditOperation } from '../../../../../packages/contracts/src/index';

export type OfficeTarget = { viewId: string; blockId?: string; slideId?: string; shapeId?: string; sheetId?: string; address?: string };

export function OfficeTools({ document, viewId, target, edit, openFullEditor, reload, fullEditorAvailable }: {
  document: DocumentInfo; viewId: string; target?: OfficeTarget; edit(operation: EditOperation): Promise<void>;
  openFullEditor(): Promise<void>; reload(): Promise<void>; fullEditorAvailable: boolean;
}) {
  const active = target?.viewId === viewId ? target : undefined;
  const block = document.model.blocks?.find(item => item.id === active?.blockId) ?? document.model.blocks?.[0];
  const slide = document.model.slides?.find(item => item.id === active?.slideId) ?? document.model.slides?.[0];
  const shape = slide?.blocks.find(item => item.id === active?.shapeId) ?? slide?.blocks[0];
  const sheet = document.model.sheets?.find(item => item.id === active?.sheetId) ?? document.model.sheets?.[0];
  const address = active?.sheetId === sheet?.id ? active?.address ?? 'A1' : 'A1';
  const cell = sheet?.rows.flat().find(item => item.address === address);
  const [paragraph, setParagraph] = useState('');
  const [sheetName, setSheetName] = useState('');
  const [rename, setRename] = useState('');
  const [value, setValue] = useState('');
  const [valueType, setValueType] = useState<'text' | 'number' | 'boolean'>('text');
  const [bounds, setBounds] = useState({ x: 10, y: 10, width: 80, height: 20 });
  useEffect(() => { setRename(sheet?.name ?? ''); }, [sheet?.id, sheet?.name]);
  useEffect(() => { setValue(cell?.formula ? '=' + cell.formula : cell?.value ?? ''); }, [sheet?.id, address, cell?.value, cell?.formula]);
  useEffect(() => { setBounds({ x: Math.round((shape?.x ?? .1) * 100), y: Math.round((shape?.y ?? .1) * 100), width: Math.round((shape?.width ?? .8) * 100), height: Math.round((shape?.height ?? .2) * 100) }); }, [slide?.id, shape?.id, shape?.x, shape?.y, shape?.width, shape?.height]);
  const run = (operation: EditOperation) => void edit(operation);
  const cellFormat = (change: Omit<Extract<EditOperation, { kind: 'sheets.setCellFormat' }>, 'kind' | 'sheetId' | 'address'>) => { if (sheet) run({ kind: 'sheets.setCellFormat', sheetId: sheet.id, address, ...change }); };

  return <div className="office-tools">
    {document.format === 'docx' && <>
      <div className="side-label">段落</div>
      <p className="side-hint">{block ? `当前段落 · ${block.text.slice(0, 28) || '空白'}` : '点击正文中的段落'}</p>
      <label className="office-field">样式<select aria-label="段落样式" disabled={!block} value={['Heading1', 'Heading2', 'Heading3'].includes(block?.style ?? '') ? block!.style : 'Normal'} onChange={event => block && run({ kind: 'word.setParagraphFormat', blockId: block.id, style: event.target.value as 'Normal' | 'Heading1' | 'Heading2' | 'Heading3' })}><option value="Normal">正文</option><option value="Heading1">标题 1</option><option value="Heading2">标题 2</option><option value="Heading3">标题 3</option></select></label>
      <div className="office-segment" aria-label="段落对齐">{([['left', AlignLeft, '左对齐'], ['center', AlignCenter, '居中'], ['right', AlignRight, '右对齐']] as const).map(([alignment, Icon, label]) => <button key={alignment} aria-label={label} title={label} className={(block?.alignment ?? 'left') === alignment ? 'selected' : ''} disabled={!block} onClick={() => block && run({ kind: 'word.setParagraphFormat', blockId: block.id, alignment })}><Icon size={16} /></button>)}<button className={(block?.alignment ?? 'left') === 'both' ? 'selected' : ''} disabled={!block} onClick={() => block && run({ kind: 'word.setParagraphFormat', blockId: block.id, alignment: 'both' })}>两端</button></div>
      <div className="side-label">插入</div>
      <label className="office-field">新段落<input aria-label="新段落文字" value={paragraph} onChange={event => setParagraph(event.target.value)} placeholder="在当前段落后插入" /></label>
      <button className="tool-row office-action" disabled={!block || !paragraph.trim()} onClick={() => { if (block && paragraph.trim()) { run({ kind: 'word.insertParagraph', afterBlockId: block.id, text: paragraph, style: 'Normal' }); setParagraph(''); } }}><Plus size={15} /> 插入段落</button>
    </>}
    {document.format === 'pptx' && <>
      <div className="side-label">幻灯片对象</div>
      <p className="side-hint">{shape ? `当前对象 · ${shape.text.slice(0, 28) || '无文字'}` : '点击幻灯片中的文字对象'}</p>
      <div className="office-bounds">{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label className="office-field" key={key}>{['横向位置', '纵向位置', '宽度', '高度'][index]}<input aria-label={['横向位置', '纵向位置', '宽度', '高度'][index]} type="number" min={key === 'width' || key === 'height' ? 1 : 0} max="100" value={bounds[key]} onChange={event => setBounds(old => ({ ...old, [key]: Number(event.target.value) }))} /></label>)}</div>
      <button className="tool-row office-action" disabled={!slide || !shape || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.x + bounds.width > 100 || bounds.y + bounds.height > 100} onClick={() => slide && shape && run({ kind: 'slides.setShapeBounds', slideId: slide.id, shapeId: shape.id, x: bounds.x / 100, y: bounds.y / 100, width: bounds.width / 100, height: bounds.height / 100 })}>应用位置与尺寸</button>
      <p className="side-hint">正文中的文字可直接修改。位置与尺寸使用幻灯片百分比。</p>
    </>}
    {document.format === 'xlsx' && <>
      <div className="side-label">单元格 · {sheet?.name ?? '工作表'}!{address}</div>
      <label className="office-field">内容<input aria-label="单元格内容" value={value} onChange={event => setValue(event.target.value)} /></label>
      <label className="office-field">数据类型<select aria-label="单元格数据类型" value={valueType} onChange={event => setValueType(event.target.value as typeof valueType)}><option value="text">文本</option><option value="number">数字</option><option value="boolean">布尔值</option></select></label>
      <button className="tool-row office-action" disabled={!sheet || (!value.startsWith('=') && valueType === 'number' && (value.trim() === '' || !Number.isFinite(Number(value))))} onClick={() => sheet && run({ kind: 'sheets.setCell', sheetId: sheet.id, address, value: value.startsWith('=') ? '' : value, formula: value.startsWith('=') ? value.slice(1) : undefined, valueType })}>应用内容或公式</button>
      <div className="side-label">文字与对齐</div>
      <div className="office-segment"><button aria-label="粗体" className={cell?.bold ? 'selected' : ''} disabled={!sheet} onClick={() => cellFormat({ bold: !cell?.bold })}><Bold size={16} /></button><button aria-label="斜体" className={cell?.italic ? 'selected' : ''} disabled={!sheet} onClick={() => cellFormat({ italic: !cell?.italic })}><Italic size={16} /></button>{([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([horizontal, Icon]) => <button key={horizontal} aria-label={horizontal === 'left' ? '左对齐' : horizontal === 'center' ? '居中' : '右对齐'} className={cell?.horizontal === horizontal ? 'selected' : ''} disabled={!sheet} onClick={() => cellFormat({ horizontal })}><Icon size={16} /></button>)}</div>
      <label className="office-field">数字格式<select aria-label="数字格式" value={['General', '0', '0.00', '0%', 'yyyy-mm-dd', '#,##0.00'].includes(cell?.numberFormat ?? 'General') ? cell?.numberFormat ?? 'General' : 'custom'} disabled={!sheet} onChange={event => cellFormat({ numberFormat: event.target.value })}><option value="General">常规</option><option value="0">整数</option><option value="0.00">两位小数</option><option value="0%">百分比</option><option value="#,##0.00">千分位</option><option value="yyyy-mm-dd">日期</option><option value="custom" disabled>自定义格式</option></select></label>
      <label className="office-field">填充色<input aria-label="填充色" type="color" value={'#' + (cell?.fill ?? 'FFFFFF')} disabled={!sheet} onChange={event => cellFormat({ fill: event.target.value.slice(1) })} /></label>
      <div className="side-label">工作表</div>
      <label className="office-field">重命名<input aria-label="工作表新名称" value={rename} onChange={event => setRename(event.target.value)} /></label>
      <button className="tool-row office-action" disabled={!sheet || !rename.trim() || rename === sheet.name} onClick={() => sheet && run({ kind: 'sheets.renameWorksheet', sheetId: sheet.id, name: rename.trim() })}>重命名工作表</button>
      <label className="office-field">新工作表<input aria-label="新工作表名称" value={sheetName} onChange={event => setSheetName(event.target.value)} placeholder="输入名称" /></label>
      <button className="tool-row office-action" disabled={!sheetName.trim()} onClick={() => { if (sheetName.trim()) { run({ kind: 'sheets.addWorksheet', name: sheetName.trim() }); setSheetName(''); } }}><Plus size={15} /> 新建工作表</button>
    </>}
    <div className="side-label">完整编辑</div>
    <button className="tool-row office-action" disabled={!fullEditorAvailable || !document.path || document.dirty} title={document.dirty || !document.path ? '先保存文档' : undefined} onClick={() => void openFullEditor()}><ExternalLink size={15} /> 使用内置 LibreOffice 编辑</button>
    <button className="tool-row office-action" disabled={!document.path || document.dirty} onClick={() => void reload()}><RotateCw size={15} /> 从磁盘重新载入</button>
    <p className="side-hint">完整编辑器中保存后，返回此处重新载入。未保存的本地修改不会被覆盖。</p>
  </div>;
}
