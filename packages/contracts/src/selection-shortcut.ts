export const DEFAULT_SELECTION_SHORTCUT = 'Ctrl+Shift+Y';
type ShortcutKey = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; isComposing?: boolean; getModifierState?(key: string): boolean };
const modifiers = ['Ctrl', 'Meta', 'Alt', 'Shift'] as const;
// App/editor shortcuts must keep their existing meaning, including in native pages.
const reserved = new Set(['Ctrl+S','Ctrl+Shift+S','Ctrl+T','Ctrl+O','Ctrl+L','Ctrl+W','Ctrl+P','Ctrl+Shift+F','Ctrl+F','Ctrl+H','Ctrl+Z','Ctrl+Shift+Z','Ctrl+Y','Ctrl+A','Ctrl+C','Ctrl+V','Ctrl+X','Ctrl+B','Ctrl+I','Ctrl+U','Ctrl+K','Ctrl+Shift+K','Ctrl+Shift+I','Ctrl+Shift+M','Ctrl+Shift+Q','Alt+F4']);
export function normalizeSelectionShortcut(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const parts = value.split('+').map(part => part.trim()), key = parts.pop()?.toUpperCase();
  if (!key || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key) || !parts.length || new Set(parts).size !== parts.length || parts.some(part => !(modifiers as readonly string[]).includes(part))) return;
  if (!parts.some(part => ['Ctrl','Meta','Alt'].includes(part)) || parts.includes('Ctrl') && parts.includes('Meta')) return;
  const normalized = [...modifiers.filter(modifier => parts.includes(modifier)), key].join('+');
  if (reserved.has(normalized.replace('Meta+', 'Ctrl+'))) return;
  return normalized;
}
export function selectionShortcutFromKey(event: ShortcutKey) {
  if (event.repeat || event.isComposing || event.getModifierState?.('AltGraph')) return;
  return normalizeSelectionShortcut([event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift', event.key.toUpperCase()].filter(Boolean).join('+'));
}
export function matchesSelectionShortcut(value: unknown, event: ShortcutKey) {
  const expected = normalizeSelectionShortcut(value);
  return !!expected && expected === selectionShortcutFromKey(event);
}
