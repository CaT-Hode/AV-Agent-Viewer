import { useEffect, useId, useRef, useState } from 'react';
import { DOCUMENT_PAPER_PALETTE, normalizeDocumentPaperColor } from '../../../../../packages/settings/src/document-paper';
import { LiquidGlassSurface } from './LiquidGlassSurface';

const names = ['白纸', '暖白', '米纸', '浅绿', '浅灰蓝', '深灰'];
export function DocumentPaperColorControl({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  const [draft, setDraft] = useState(value), [error, setError] = useState(''), [open, setOpen] = useState(false);
  const well = useRef<HTMLButtonElement>(null), palette = useRef<HTMLDivElement>(null), errorId = useId();
  useEffect(() => { setDraft(value); setError(''); }, [value]);
  const choose = (next: string, explicit = false) => { setDraft(next); setError(''); palette.current?.hidePopover(); setOpen(false); if (explicit || next !== value) onChange(next); };
  const commit = () => { const next = normalizeDocumentPaperColor(draft); if (!next) { setError('请输入 #RGB 或 #RRGGBB'); return; } choose(next); };
  return <div className="document-paper-color-control">
    <button ref={well} type="button" className="document-paper-color-well" style={{ backgroundColor: value }} aria-label={label + '预设'} title="选择纸面颜色" aria-expanded={open} onClick={() => {
      const popup = palette.current, bounds = well.current?.getBoundingClientRect(); if (!popup || !bounds) return;
      if (popup.matches(':popover-open')) popup.hidePopover();
      else { popup.style.left = Math.max(12,Math.min(window.innerWidth - 220,bounds.right - 208)) + 'px'; popup.style.top = (bounds.bottom + 60 > window.innerHeight ? bounds.top - 60 : bounds.bottom + 8) + 'px'; popup.showPopover(); }
    }} />
    <input aria-label={label} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} value={draft} maxLength={7} spellCheck={false} onChange={event => { setDraft(event.target.value); setError(''); }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } else if (event.key === 'Escape') { setDraft(value); setError(''); setOpen(false); } }} />
    {error && <span id={errorId} className="document-paper-color-error" role="alert">{error}</span>}
    <div ref={palette} popover="auto" className="document-paper-palette material-host" role="radiogroup" aria-label="纸面颜色预设" onToggle={event => setOpen(event.currentTarget.matches(':popover-open'))}><LiquidGlassSurface variant="panel" />{DOCUMENT_PAPER_PALETTE.map((color,index) => <button type="button" key={color} role="radio" aria-label={names[index]} title={names[index]} aria-checked={color === value} style={{ backgroundColor: color }} onClick={() => choose(color,true)} />)}</div>
  </div>;
}
