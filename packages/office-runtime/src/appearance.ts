/** Trusted application display preferences; these never become document styles. */
export interface NativeOfficeAppearance {
  theme: 'light' | 'dark';
  canvasColor: number;
  /** Reading paper only; never written into page/cell/slide styles. */
  paperColor?: number;
}

export function validateNativeOfficeAppearance(value: NativeOfficeAppearance): NativeOfficeAppearance {
  if (!value || !['light', 'dark'].includes(value.theme) || !Number.isInteger(value.canvasColor) || value.canvasColor < 0 || value.canvasColor > 0xffffff) throw new Error('INVALID_NATIVE_APPEARANCE');
  if (value.paperColor !== undefined && (!Number.isInteger(value.paperColor) || value.paperColor < 0 || value.paperColor > 0xffffff)) throw new Error('INVALID_NATIVE_APPEARANCE');
  return { theme: value.theme, canvasColor: value.canvasColor, ...(value.paperColor === undefined ? {} : { paperColor: value.paperColor }) };
}

/** Match the base colour of the surrounding CSS canvas, without inverting pages. */
export function nativeOfficeAppearance(theme: unknown, background: unknown, systemDark: boolean, paper?: unknown): NativeOfficeAppearance {
  const dark = theme === 'dark' || theme === 'system' && systemDark;
  const lightCanvas: Record<string, number> = { paper: 0xf7f5f2, mist: 0xf6f8f8, aurora: 0xf8f8fa, dusk: 0xfaf8f6, spectrum: 0xd7bfea, lagoon: 0xc3d6e9, iris: 0xd5c8df, champagne: 0xe5d5c8, opal: 0xded1e7, solid: 0xf8f8f7 };
  const darkCanvas: Record<string, number> = { paper: 0x262626, mist: 0x242424, aurora: 0x262626, dusk: 0x282828, spectrum: 0x352d49, lagoon: 0x293a52, iris: 0x49364f, champagne: 0x483834, opal: 0x413b51, solid: 0x262626 };
  const paperColor = typeof paper === 'string' && /^#[\da-f]{6}$/i.test(paper) ? parseInt(paper.slice(1), 16) : paper === undefined ? undefined : 0xffffff;
  return { theme: dark ? 'dark' : 'light', canvasColor: (dark ? darkCanvas : lightCanvas)[String(background)] ?? (dark ? darkCanvas.paper : lightCanvas.paper), ...(paperColor === undefined ? {} : { paperColor }) };
}
