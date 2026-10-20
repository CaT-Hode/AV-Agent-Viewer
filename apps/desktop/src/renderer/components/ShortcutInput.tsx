import { useState } from 'react';
import { selectionShortcutFromKey } from '../../../../../packages/contracts/src/selection-shortcut';

export function ShortcutInput({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange(value: string): void }) {
  const [error, setError] = useState('');
  return <div className="shortcut-recorder"><input aria-label={label} aria-invalid={!!error} disabled={disabled} readOnly value={value} title="点击并按下新的组合键" onFocus={event => event.currentTarget.select()} onKeyDown={event => {
    if (event.key === 'Tab') return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setError(''); event.currentTarget.blur(); return; }
    if (event.nativeEvent.isComposing || event.repeat || ['Control','Shift','Alt','Meta'].includes(event.key)) return;
    const next = selectionShortcutFromKey(event.nativeEvent);
    if (!next) { setError('此组合键不可用，请换一个。'); return; }
    setError(''); onChange(next);
  }} />{error && <small role="alert">{error}</small>}</div>;
}
