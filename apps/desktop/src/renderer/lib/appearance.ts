import type { SettingsSnapshot } from '../../../../../packages/settings/src/index';
import { documentPaperAppearance } from '../../../../../packages/settings/src/document-paper';

export function applyAppearance(snapshot?: SettingsSnapshot) {
  if (!snapshot) return;
  const root = document.documentElement, values = snapshot.values;
  const preferredDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = values['appearance.theme'] === 'system' ? preferredDark ? 'dark' : 'light' : String(values['appearance.theme']);
  root.dataset.density = String(values['appearance.density'] ?? 'standard');
  root.dataset.glass = values['appearance.reduceTransparency'] ? 'off' : String(values['appearance.glass'] ?? 'standard');
  root.dataset.documentBackground = String(values['appearance.documentBackground'] ?? 'paper');
  const paper = documentPaperAppearance(values['appearance.documentPaperColor']);
  root.dataset.documentPaper = paper.color;
  root.style.setProperty('--document-paper', paper.color);
  root.style.setProperty('--document-paper-ink', paper.ink);
  root.style.setProperty('--document-paper-muted', paper.muted);
  root.dataset.backgroundMotion = String(values['appearance.backgroundMotion'] ?? 'slow');
  root.dataset.motion = String(values['appearance.motion'] ?? 'standard');
  root.dataset.contrast = values['appearance.highContrast'] ? 'high' : 'standard';
}
