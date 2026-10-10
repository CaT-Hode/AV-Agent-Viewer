import { useEffect, useState } from 'react';
import { call } from './lib/transport';

export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean }>();
  useEffect(() => {
    let target: HTMLElement | null = null, original = '', titleBefore: string|null = null, timer: ReturnType<typeof setTimeout>;
    const native = location.hash.includes('-toolbar');
    const hide = () => { clearTimeout(timer); if (target) { if(titleBefore===null)target.removeAttribute('title');else target.title=titleBefore; target.removeAttribute('aria-describedby'); } target = null; setTip(undefined); if (native) void call('toolbar-tooltip', { open: false }); };
    const show = (event: Event) => {
      const next = (event.target as HTMLElement)?.closest<HTMLElement>('[title],button[aria-label]');
      if (next === target) return;
      hide(); if (!next || !(next.title || next.getAttribute('aria-label'))?.trim()) return;
      target = next; titleBefore=next.getAttribute('title'); original = next.title || next.getAttribute('aria-label') || ''; if (!next.hasAttribute('aria-label') && !next.textContent?.trim()) next.setAttribute('aria-label', original); next.title = '';
      timer = setTimeout(() => { if (!target?.isConnected) return; const rect = target.getBoundingClientRect(); const above = !native && rect.bottom > window.innerHeight - 65; target.setAttribute('aria-describedby', 'app-tooltip'); if (native) void call('toolbar-tooltip', { open: true }); setTip({ text: original, x: Math.min(window.innerWidth - 150, Math.max(150, rect.x + rect.width / 2)), y: native ? 62 : above ? rect.top - 9 : rect.bottom + 9, above }); }, event.type === 'focusin' ? 150 : 420);
    };
    const leave = (event: Event) => { if (target && !target.contains((event as MouseEvent).relatedTarget as Node)) hide(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    document.addEventListener('pointerover', show); document.addEventListener('focusin', show);
    document.addEventListener('pointerout', leave); document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide); document.addEventListener('scroll', hide, true); document.addEventListener('keydown', escape);
    return () => { hide(); document.removeEventListener('pointerover', show); document.removeEventListener('focusin', show); document.removeEventListener('pointerout', leave); document.removeEventListener('focusout', hide); document.removeEventListener('pointerdown', hide); document.removeEventListener('scroll', hide, true); document.removeEventListener('keydown', escape); };
  }, []);
  return tip && <div id="app-tooltip" role="tooltip" className={'app-tooltip ' + (tip.above ? 'above' : '')} style={{ left: tip.x, top: tip.y }}>{tip.text}</div>;
}
