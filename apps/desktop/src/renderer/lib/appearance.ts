import type { SettingsSnapshot } from '../../../../../packages/settings/src/index';

export function applyAppearance(snapshot?: SettingsSnapshot) {
  if (!snapshot) return;
  const root = document.documentElement, values = snapshot.values;
  const preferredDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = values['appearance.theme'] === 'system' ? preferredDark ? 'dark' : 'light' : String(values['appearance.theme']);
  root.dataset.density = String(values['appearance.density'] ?? 'standard');
  root.dataset.glass = values['appearance.reduceTransparency'] ? 'off' : String(values['appearance.glass'] ?? 'standard');
  root.dataset.documentBackground = String(values['appearance.documentBackground'] ?? 'paper');
  root.dataset.motion = String(values['appearance.motion'] ?? 'standard');
  root.dataset.contrast = values['appearance.highContrast'] ? 'high' : 'standard';
}
