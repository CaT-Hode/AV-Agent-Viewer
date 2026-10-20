import { useEffect, useState, type CSSProperties } from 'react';
import './selection-translation.css';
import './translation-card.css';

type Backdrop = { image?: string; rect?: { x: number; y: number; width: number; height: number } };
/** Bootstrap only: business components are portalled by the owning App. */
export function ReaderPanelWindow() {
  const translation = new URLSearchParams(location.hash.split('?')[1]).get('side') === 'translation';
  const [backdrop, setBackdrop] = useState<Backdrop>({});
  useEffect(() => {
    document.documentElement.classList.add('reader-panel-window');
    const receive = (value: Record<string, unknown>) => {
      if (value.action === 'reader-panel-backdrop') setBackdrop({ image: typeof value.image === 'string' ? value.image : undefined, rect: value.rect as Backdrop['rect'] });
    };
    const unsubscribe = window.agentViewer?.onToolbar(receive);
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || !['s','t','o','l',','].includes(event.key.toLowerCase())) return;
      // A portal preserves React events but native Window keyboard events
      // belong to the child. Route only the owner's existing app shortcuts.
      const owner = window.opener; if (!owner || owner.closed) return;
      const forwarded = new owner.KeyboardEvent('keydown', { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, cancelable: true });
      owner.dispatchEvent(forwarded); if (forwarded.defaultPrevented) event.preventDefault();
    };
    window.addEventListener('keydown', shortcut);
    void window.agentViewer?.call('reader-panel-ready').catch(() => {});
    return () => { unsubscribe?.(); window.removeEventListener('keydown', shortcut); };
  }, []);
  const rect = backdrop.rect;
  return <div id="reader-panel-content" className="workbench reader-panel-workbench">{!translation && <div className="reader-panel-backdrop" style={{ backgroundImage: backdrop.image ? `url("${backdrop.image}")` : undefined, backgroundSize: rect ? `${rect.width}px ${rect.height}px` : undefined, backgroundPosition: rect ? `${rect.x}px ${rect.y}px` : undefined } as CSSProperties} />}</div>;
}
