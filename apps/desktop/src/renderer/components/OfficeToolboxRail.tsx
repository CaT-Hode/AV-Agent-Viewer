import { BookOpen, Eye, FilePlus2, Filter, GalleryHorizontalEnd, GalleryVerticalEnd, Layers3, LayoutTemplate, MessageSquare, NotebookPen, Palette, Play, Presentation, Printer, Sigma, Sparkles, Table2, Type } from 'lucide-react';
import type { Format } from '../../../../../packages/contracts/src/index';
import { useRef } from 'react';
import { PanelScrollHints } from './PanelScrollHints';
import { officeToolboxContribution, type OfficeToolboxCategory } from './office/toolbox-contributions';

export const officeToolboxRailIcons = { home: Type, insert: FilePlus2, table: Table2, layout: LayoutTemplate, references: BookOpen, review: MessageSquare, view: Eye, formulas: Sigma, data: Filter, worksheet: GalleryVerticalEnd, print: Printer, design: Palette, arrange: Layers3, slides: Presentation, transitions: GalleryHorizontalEnd, animation: Sparkles, presentation: Play, notes: NotebookPen } satisfies Record<OfficeToolboxCategory, typeof Type>;
export function OfficeToolboxRail({ format, section, open, onSelect }: { format: Format; section: string; open: boolean; onSelect(category: OfficeToolboxCategory): void }) {
  const viewport=useRef<HTMLDivElement>(null);
  return <div className="office-toolbox-rail-host"><div className="office-toolbox-rail" ref={viewport} role="group" aria-label="Office 工具分类" onKeyDown={event => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next < 0 || !buttons.length) return;
    event.preventDefault(); buttons[next].focus({ preventScroll: true });
    const item = buttons[next], top = item.offsetTop, bottom = top + item.offsetHeight, rail = event.currentTarget;
    if (top < rail.scrollTop) rail.scrollTop = top; else if (bottom > rail.scrollTop + rail.clientHeight) rail.scrollTop = bottom - rail.clientHeight;
  }}>{officeToolboxContribution(format)?.categories.map(category => {
    const Icon = officeToolboxRailIcons[category.id], selected = open && section === 'office:' + category.id;
    return <button key={category.id} type="button" data-office-category={category.id} aria-label={category.label} aria-pressed={selected} title={category.label} className={selected ? 'selected' : ''} onMouseDown={event => event.preventDefault()} onClick={() => onSelect(category.id)}><Icon size={20} /></button>;
  })}</div><PanelScrollHints viewport={viewport} /></div>;
}
