import { useState } from 'react';
import { WordTools } from './office/WordTools';
import { PresentationTools } from './office/PresentationTools';
import { SpreadsheetTools } from './office/SpreadsheetTools';
import { officeToolboxCategory, officeToolboxContribution, type OfficeToolboxProps } from './office/toolbox-contributions';
import '../office-editing.css';

export type { OfficeTarget, OfficeToolProps } from './office/OfficeShared';
export type { OfficeToolboxCategory, OfficeToolboxTarget, OfficeToolboxController, OfficeToolboxProps } from './office/toolbox-contributions';
export { officeToolboxContribution, officeToolboxCategory } from './office/toolbox-contributions';
export { WordTools, PresentationTools, SpreadsheetTools };

/** Format tools share command routing, while their controls remain independent. */
export function OfficeTools(props: OfficeToolboxProps) {
  const contribution = officeToolboxContribution(props.document.format);
  const [local, setLocal] = useState<{ viewId: string; category: OfficeToolboxProps['category'] }>();
  const category = officeToolboxCategory(props.document.format, props.category ?? (local?.viewId === props.viewId ? local.category : undefined));
  const change = (next: NonNullable<OfficeToolboxProps['category']>) => { setLocal({ viewId: props.viewId, category: next }); props.onCategoryChange?.(next); };
  const shared = { ...props, category };
  const categoryDefinition = contribution?.categories.find(item => item.id === category);
  const requiresNative = category !== 'review' && !categoryDefinition?.commands.length;
  const tools = props.document.format === 'docx' ? <WordTools {...shared} /> : props.document.format === 'pptx' ? <PresentationTools {...shared} /> : props.document.format === 'xlsx' ? <SpreadsheetTools {...shared} /> : null;
  if (!tools) return null;
  return <div className="office-tools-v3 office-sidebar" data-office-category={category}>
    {props.category === undefined && <div className="office-categories" role="tablist" aria-label="Office 工具分类" onKeyDown={event => {
      const categories = contribution!.categories, index = categories.findIndex(item => item.id === category);
      const next = event.key === 'ArrowRight' ? (index + 1) % categories.length : event.key === 'ArrowLeft' ? (index + categories.length - 1) % categories.length : event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : -1;
      if (next < 0) return; event.preventDefault(); change(categories[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus({ preventScroll: true });
    }}>{contribution!.categories.map(item => <button key={item.id} type="button" role="tab" aria-selected={item.id === category} aria-controls={'office-category-' + props.viewId} tabIndex={item.id === category ? 0 : -1} className={item.id === category ? 'selected' : ''} onMouseDown={event => event.preventDefault()} onClick={() => change(item.id)}>{item.label}</button>)}</div>}
    <div className="office-category-panel" role="tabpanel" id={'office-category-' + props.viewId} data-office-category={category} aria-label={categoryDefinition!.label}>{requiresNative ? <p className="office-capability-note">{categoryDefinition!.label}工具需要桌面端的内置 LibreOffice 引擎。当前基础编辑视图没有接入此分类。</p> : tools}</div>
  </div>;
}
