import type { OfficeToolProps } from './office/OfficeShared';
import { WordTools } from './office/WordTools';
import { PresentationTools } from './office/PresentationTools';
import { SpreadsheetTools } from './office/SpreadsheetTools';
import { ExternalLink, RefreshCw } from 'lucide-react';
import '../office-editing.css';

export type { OfficeTarget, OfficeToolProps } from './office/OfficeShared';
export { WordTools, PresentationTools, SpreadsheetTools };

/** Format tools share command routing, while their controls remain independent. */
export function OfficeTools(props: OfficeToolProps & { openFullEditor?(): Promise<void>; reload?(): Promise<void>; fullEditorAvailable?: boolean }) {
  const tools = props.document.format === 'docx' ? <WordTools {...props} /> : props.document.format === 'pptx' ? <PresentationTools {...props} /> : props.document.format === 'xlsx' ? <SpreadsheetTools {...props} /> : null;
  if (!tools) return null;
  const saved = !!props.document.path && !props.document.dirty;
  return <>{tools}{props.placement !== 'ribbon' && props.openFullEditor && <div className="office-engine-actions"><button className="tool-row" disabled={!props.fullEditorAvailable || !saved} title={!props.fullEditorAvailable ? '内置 LibreOffice 尚未就绪' : !saved ? '请先保存文档，再打开完整编辑器' : '使用内置 LibreOffice 编辑复杂排版'} onClick={() => void props.openFullEditor!()}><ExternalLink size={15} />完整 Office 编辑器</button>{props.reload && <button className="tool-row" disabled={!saved} title="完整编辑器保存后，读取最新磁盘内容" onClick={() => void props.reload!()}><RefreshCw size={15} />读取最新文件</button>}</div>}</>;
}
