import { useEffect, useState } from 'react';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, Plus, Strikethrough, Table2, Trash2, Underline } from 'lucide-react';
import { ActionTool, ColorControl, IconTool, OfficeFeedback, OfficeField, ToolGroup, textRange, textStyle, useOfficeCommands, type OfficeToolProps } from './OfficeShared';

export function WordTools(props: OfficeToolProps) {
  const { document, target, viewId, placement = 'sidebar' } = props;
  const active = target?.viewId === viewId ? target : undefined;
  const block = document.model.blocks?.find(item => item.id === active?.blockId) ?? document.model.blocks?.[0];
  const style = textStyle(block, active), command = useOfficeCommands(props), disabled = !block || command.busy;
  const [paragraph, setParagraph] = useState(''), [tableSize, setTableSize] = useState({ rows: 3, columns: 3 });
  const [fontSize, setFontSize] = useState(12);
  const [format, setFormat] = useState({ spacingBefore: 0, spacingAfter: 0, lineSpacing: 1, indentLeft: 0, indentRight: 0, indentFirstLine: 0 });
  const [margins, setMargins] = useState({ top: 72, right: 72, bottom: 72, left: 72 });
  useEffect(() => { setFontSize(style.fontSize ?? 12); }, [block?.id, style.fontSize]);
  useEffect(() => { setFormat({ spacingBefore: block?.spacingBefore ?? 0, spacingAfter: block?.spacingAfter ?? 0, lineSpacing: block?.lineSpacing ?? 1, indentLeft: block?.indentLeft ?? 0, indentRight: block?.indentRight ?? 0, indentFirstLine: block?.indentFirstLine ?? 0 }); }, [block?.id, block?.spacingBefore, block?.spacingAfter, block?.lineSpacing, block?.indentLeft, block?.indentRight, block?.indentFirstLine]);
  useEffect(() => { if (document.model.pageLayout) setMargins(document.model.pageLayout.margins); }, [document.model.pageLayout?.margins.top, document.model.pageLayout?.margins.right, document.model.pageLayout?.margins.bottom, document.model.pageLayout?.margins.left]);
  const text = (change: Record<string, unknown>) => block && void command.run('office.setTextStyle', { blockId: block.id, ...textRange(block, active), ...change });
  const paragraphFormat = (change: Record<string, unknown>) => block && void command.run('word.setParagraphFormat', { blockId: block.id, ...change });
  const fontTools = command.supports('office.setTextStyle') && <ToolGroup title="字体">
    <select aria-label="Word 字体" className="office-font-select" value={style.fontName ?? 'Calibri'} disabled={disabled} onChange={event => text({ fontName: event.target.value })}>{[...new Set([style.fontName ?? 'Calibri', 'Calibri', 'Arial', 'Times New Roman', '微软雅黑', '宋体', '等线'])].map(name => <option key={name}>{name}</option>)}</select>
    <input aria-label="Word 字号" className="office-font-size" type="number" min="1" max="400" value={fontSize} disabled={disabled} onChange={event => setFontSize(Number(event.target.value))} onBlur={() => fontSize >= 1 && fontSize <= 400 && fontSize !== (style.fontSize ?? 12) && text({ fontSize })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (fontSize !== (style.fontSize ?? 12)) text({ fontSize }); } }} />
    <IconTool label="粗体" icon={Bold} selected={!!style.bold} disabled={disabled} onClick={() => text({ bold: !style.bold })} />
    <IconTool label="斜体" icon={Italic} selected={!!style.italic} disabled={disabled} onClick={() => text({ italic: !style.italic })} />
    <IconTool label="下划线" icon={Underline} selected={!!style.underline} disabled={disabled} onClick={() => text({ underline: !style.underline })} />
    <IconTool label="删除线" icon={Strikethrough} selected={!!style.strike} disabled={disabled} onClick={() => text({ strike: !style.strike })} />
    <ColorControl label="文字颜色" value={style.color} disabled={disabled} onChange={color => text({ color })} />
    <ColorControl label="文字底色" value={style.highlight ?? 'FFF2CC'} disabled={disabled} onChange={highlight => text({ highlight })} />
  </ToolGroup>;
  const alignmentTools = command.supports('word.setParagraphFormat') && <ToolGroup title="段落">
    <select aria-label="段落样式" disabled={disabled} value={['Heading1', 'Heading2', 'Heading3'].includes(block?.style ?? '') ? block!.style : 'Normal'} onChange={event => paragraphFormat({ style: event.target.value })}><option value="Normal">正文</option><option value="Heading1">标题 1</option><option value="Heading2">标题 2</option><option value="Heading3">标题 3</option></select>
    {([['left', AlignLeft, '左对齐'], ['center', AlignCenter, '居中'], ['right', AlignRight, '右对齐'], ['both', AlignJustify, '两端对齐']] as const).map(([alignment, icon, label]) => <IconTool key={alignment} label={label} icon={icon} selected={(block?.alignment ?? 'left') === alignment} disabled={disabled} onClick={() => paragraphFormat({ alignment })} />)}
  </ToolGroup>;
  return <div className={'office-tools-v2 office-word-tools office-' + placement}>
    {placement === 'sidebar' && <p className="office-target-label">{block?.tableId ? '表格单元格' : '当前段落'} · {block?.text.slice(0, 36) || '空白段落'}</p>}
    {fontTools}{alignmentTools}
    {placement === 'sidebar' && command.supports('word.setParagraphFormat') && <ToolGroup title="间距与缩进">
      {([['spacingBefore', '段前（磅）'], ['spacingAfter', '段后（磅）'], ['lineSpacing', '行距（倍）'], ['indentLeft', '左缩进（磅）'], ['indentRight', '右缩进（磅）'], ['indentFirstLine', '首行（磅）']] as const).map(([key, label]) => <OfficeField key={key} label={label}><input type="number" aria-label={label} min={key === 'indentFirstLine' ? -720 : key === 'lineSpacing' ? .5 : 0} max={key === 'lineSpacing' ? 5 : 720} step={key === 'lineSpacing' ? .1 : 1} value={format[key]} disabled={disabled} onChange={event => setFormat(old => ({ ...old, [key]: Number(event.target.value) }))} /></OfficeField>)}
      <ActionTool disabled={disabled} onClick={() => paragraphFormat(format)}>应用段落格式</ActionTool>
    </ToolGroup>}
    <ToolGroup title="插入">
      {command.supports('word.insertParagraph') && <><input aria-label="新段落文字" placeholder="新段落文字" value={paragraph} onChange={event => setParagraph(event.target.value)} /><IconTool label="在当前段落后插入" icon={Plus} disabled={disabled || !paragraph.trim()} onClick={() => { if (block) void command.run('word.insertParagraph', { afterBlockId: block.id, text: paragraph, style: 'Normal' }).then(ok => { if (ok) setParagraph(''); }); }} /></>}
      {command.supports('word.insertTable') && <><OfficeField label="行"><input aria-label="表格行数" type="number" min="1" max="100" value={tableSize.rows} onChange={event => setTableSize(old => ({ ...old, rows: Number(event.target.value) }))} /></OfficeField><OfficeField label="列"><input aria-label="表格列数" type="number" min="1" max="20" value={tableSize.columns} onChange={event => setTableSize(old => ({ ...old, columns: Number(event.target.value) }))} /></OfficeField><IconTool label="插入表格" icon={Table2} disabled={disabled || tableSize.rows < 1 || tableSize.rows > 100 || tableSize.columns < 1 || tableSize.columns > 20} onClick={() => block && void command.run('word.insertTable', { afterBlockId: block.id, rows: Array.from({ length: tableSize.rows }, () => Array.from({ length: tableSize.columns }, () => '')) })} /></>}
    </ToolGroup>
    {command.supports('word.setPageLayout') && <ToolGroup title="页面">
      <select aria-label="页面方向" disabled={command.busy} value={document.model.pageLayout?.orientation ?? 'portrait'} onChange={event => void command.run('word.setPageLayout', { orientation: event.target.value })}><option value="portrait">纵向</option><option value="landscape">横向</option></select>
      {placement === 'sidebar' && <>{(['top', 'right', 'bottom', 'left'] as const).map((key, index) => <OfficeField key={key} label={['上页边距（磅）', '右页边距（磅）', '下页边距（磅）', '左页边距（磅）'][index]}><input aria-label={['上页边距', '右页边距', '下页边距', '左页边距'][index]} type="number" min="0" max="720" value={margins[key]} onChange={event => setMargins(old => ({ ...old, [key]: Number(event.target.value) }))} /></OfficeField>)}<ActionTool disabled={command.busy} onClick={() => void command.run('word.setPageLayout', { margins })}>应用页边距</ActionTool></>}
    </ToolGroup>}
    {placement === 'sidebar' && command.supports('word.deleteParagraph') && <ActionTool disabled={disabled} onClick={() => block && void command.run('word.deleteParagraph', { blockId: block.id })}><Trash2 size={14} /> 删除当前段落</ActionTool>}
    <OfficeFeedback error={command.error} busy={command.busy} />
  </div>;
}
