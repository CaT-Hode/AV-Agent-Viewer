import type { SettingsSnapshot } from '../../../../../packages/settings/src/index';
import { documentPaperAppearance } from '../../../../../packages/settings/src/document-paper';

export function applyAppearance(snapshot?: SettingsSnapshot) {
  if (!snapshot) return;
  const root = document.documentElement, values = snapshot.values;
  const dataset = (name: string, value: string) => { if (root.dataset[name] !== value) root.dataset[name] = value; };
  const property = (name: string, value: string) => { if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value); };
  const preferredDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  dataset('theme', values['appearance.theme'] === 'system' ? preferredDark ? 'dark' : 'light' : String(values['appearance.theme']));
  dataset('density', String(values['appearance.density'] ?? 'standard'));
  dataset('glass', values['appearance.reduceTransparency'] ? 'off' : String(values['appearance.glass'] ?? 'standard'));
  dataset('documentBackground', String(values['appearance.documentBackground'] ?? 'paper'));
  const paper = documentPaperAppearance(values['appearance.documentPaperColor']);
  dataset('documentPaper', paper.color);
  property('--document-paper', paper.color);
  property('--document-paper-ink', paper.ink);
  property('--document-paper-muted', paper.muted);
  dataset('backgroundMotion', String(values['appearance.backgroundMotion'] ?? 'slow'));
  dataset('motion', String(values['appearance.motion'] ?? 'standard'));
  dataset('contrast', values['appearance.highContrast'] ? 'high' : 'standard');
}
