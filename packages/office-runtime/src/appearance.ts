/** Trusted application display preferences; these never become document styles. */
export interface NativeOfficeAppearance {
  theme: 'light' | 'dark';
  canvasColor: number;
}

export function validateNativeOfficeAppearance(value: NativeOfficeAppearance): NativeOfficeAppearance {
  if (!value || !['light', 'dark'].includes(value.theme) || !Number.isInteger(value.canvasColor) || value.canvasColor < 0 || value.canvasColor > 0xffffff) throw new Error('INVALID_NATIVE_APPEARANCE');
  return { theme: value.theme, canvasColor: value.canvasColor };
}

/** Match the base colour of the surrounding CSS canvas, without inverting pages. */
export function nativeOfficeAppearance(theme: unknown, background: unknown, systemDark: boolean): NativeOfficeAppearance {
  const dark = theme === 'dark' || theme === 'system' && systemDark;
  const lightCanvas: Record<string, number> = { paper: 0xf7f5f2, mist: 0xf6f8f8, aurora: 0xf8f8fa, dusk: 0xfaf8f6, solid: 0xf8f8f7 };
  const darkCanvas: Record<string, number> = { paper: 0x262626, mist: 0x242424, aurora: 0x262626, dusk: 0x282828, solid: 0x262626 };
  return { theme: dark ? 'dark' : 'light', canvasColor: (dark ? darkCanvas : lightCanvas)[String(background)] ?? (dark ? darkCanvas.paper : lightCanvas.paper) };
}
