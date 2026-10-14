/** Reading-only paper appearance. Never serialize these values into a file. */
export const DEFAULT_DOCUMENT_PAPER_COLOR = '#ffffff';
export const DOCUMENT_PAPER_PALETTE = ['#ffffff', '#fffaf0', '#f3efe7', '#eaf2ec', '#edf1f7', '#25282f'] as const;

export function normalizeDocumentPaperColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const match = value.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return;
  const hex = match[1].toLowerCase();
  return '#' + (hex.length === 3 ? [...hex].map(channel => channel + channel).join('') : hex);
}

function luminance(color: string) {
  const channels = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

/** The paper, rather than the application's theme, decides default prose ink.
 * Explicit document text/fill colors retain their own rendering semantics. */
export function documentPaperAppearance(value: unknown) {
  const color = normalizeDocumentPaperColor(value) ?? DEFAULT_DOCUMENT_PAPER_COLOR;
  const light = '#f7f9fb', dark = '#24303b';
  let ink = contrast(color, dark) >= contrast(color, light) ? dark : light;
  if (contrast(color, ink) < 4.5) ink = contrast(color, '#000000') >= contrast(color, '#ffffff') ? '#000000' : '#ffffff';
  const muted = ink === dark || ink === '#000000' ? '#52606d' : '#c2cbd5';
  return { color, ink, muted: contrast(color, muted) >= 4.5 ? muted : ink };
}
