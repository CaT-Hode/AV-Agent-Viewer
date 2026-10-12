import { useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { editOperationSchema, type DocumentInfo, type EditOperation, type OfficeTextStyle, type ReadingContext, type TextBlock } from '../../../../../../packages/contracts/src/index';

export type OfficeTarget = { viewId: string; blockId?: string; slideId?: string; shapeId?: string; sheetId?: string; address?: string; range?: string; from?: number; to?: number; selectedText?: string };
export type OfficeToolProps = { document: DocumentInfo; viewId: string; target?: OfficeTarget; edit(operation: EditOperation): Promise<void>; placement?: 'ribbon' | 'sidebar' };
export type RichBlock = TextBlock;

export function useOfficeCommands({ document, edit }: OfficeToolProps) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const supports = (kind: string) => document.capabilities.editKinds.includes(kind);
  const run = async (kind: string, args: Record<string, unknown>) => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError('');
    try { await edit(editOperationSchema.parse({ kind, ...args })); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  return { busy, error, supports, run };
}

export function ToolGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="office-tool-group" aria-label={title}><div className="office-group-controls">{children}</div><span className="office-group-title">{title}</span></section>;
}
export function IconTool({ label, icon: Icon, onClick, disabled, selected }: { label: string; icon: LucideIcon; onClick(): void; disabled?: boolean; selected?: boolean }) {
  return <button type="button" className={'office-icon-tool icon-button' + (selected ? ' selected' : '')} title={label} aria-label={label} aria-pressed={selected} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}><Icon size={16} /></button>;
}
export function ActionTool({ children, onClick, disabled }: { children: ReactNode; onClick(): void; disabled?: boolean }) {
  return <button type="button" className="office-action-tool" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}>{children}</button>;
}
export function OfficeField({ label, children }: { label: string; children: ReactNode }) { return <label className="office-property-field"><span>{label}</span>{children}</label>; }
export function ColorControl({ label, value, onChange, disabled }: { label: string; value?: string; onChange(value: string): void; disabled?: boolean }) {
  const color = /^[0-9a-f]{6}$/i.test(value ?? '') ? '#' + value : '#303642';
  return <OfficeField label={label}><input aria-label={label} type="color" value={color} disabled={disabled} onChange={event => onChange(event.target.value.slice(1))} /></OfficeField>;
}
export function OfficeFeedback({ error, busy }: { error: string; busy: boolean }) { return <>{busy && <span className="office-edit-status" role="status">正在应用…</span>}{error && <p className="office-edit-error" role="alert">{error}</p>}</>; }

export function columnName(index: number) { let n = index + 1, result = ''; while (n > 0) { result = String.fromCharCode(65 + (n - 1) % 26) + result; n = Math.floor((n - 1) / 26); } return result; }
export function addressPosition(address: string) { const match = /^([A-Z]+)([1-9]\d*)$/.exec(address.toUpperCase()); if (!match) return { row: 1, column: 1 }; let column = 0; for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64; return { row: Number(match[2]), column }; }
export function normalizedRange(start: string, end = start) { const a = addressPosition(start), b = addressPosition(end); return `${columnName(Math.min(a.column, b.column) - 1)}${Math.min(a.row, b.row)}:${columnName(Math.max(a.column, b.column) - 1)}${Math.max(a.row, b.row)}`; }
export function rangeContains(range: string, address: string) { const [start, end] = range.split(':'), a = addressPosition(start), b = addressPosition(end ?? start), p = addressPosition(address); return p.row >= a.row && p.row <= b.row && p.column >= a.column && p.column <= b.column; }

export type OfficeSelection = ReadingContext['selection'];

/** A focus change to a property field must not replace the actual text range. */
export function textRange(block: TextBlock, target?: OfficeTarget) {
  const selected = (target?.blockId === block.id || target?.shapeId === block.id) && target?.from !== undefined && target?.to !== undefined && target.to > target.from;
  const from = selected ? target!.from! : 0;
  const to = selected ? target!.to! : block.text.length;
  return { from, to, expectedText: selected && target?.selectedText !== undefined ? target.selectedText : block.text.slice(from, to) };
}
export function textStyle(block?: TextBlock, target?: OfficeTarget): OfficeTextStyle {
  if (!block) return {};
  let offset = 0;
  const from = target?.from ?? 0;
  // Scalar block font fields summarize its first run. They must not bleed into
  // the selected run's toolbar state or make Ctrl+B toggle in the wrong direction.
  for (const run of block.runs ?? []) { if (offset + run.text.length > from) return run; offset += run.text.length; }
  return block;
}

/** Clipboard grids quote embedded tabs/newlines, as spreadsheet applications do. */
export function serializeGrid(rows: string[][]) { return rows.map(row => row.map(value => /[\t\n\r"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value).join('\t')).join('\n'); }
export function parseClipboardGrid(source: string) {
  const rows: string[][] = [], row: string[] = []; let field = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"' && (quoted || field === '')) { if (quoted && source[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (char === '\t' || char === '\n' || char === '\r')) { row.push(field); field = ''; if (char !== '\t') { rows.push(row.splice(0)); if (char === '\r' && source[i + 1] === '\n') i++; } }
    else field += char;
  }
  if (quoted) throw new Error('粘贴内容中有未闭合的引号');
  if (field || row.length || !rows.length) { row.push(field); rows.push(row); }
  const columns = Math.max(...rows.map(item => item.length));
  if (rows.length * columns > 10000) throw new Error('一次最多粘贴 10000 个单元格');
  return rows.map(item => [...item, ...Array.from({ length: columns - item.length }, () => '')]);
}
