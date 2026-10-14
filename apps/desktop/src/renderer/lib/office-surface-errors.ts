/** Only read/render races are retried. A mutation's uncertain outcome must remain visible. */
export function officeSurfaceStaleRead(error: unknown, scope: 'document' | 'window'): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  const expected = scope === 'window' ? 'STALE_OFFICE_WINDOW' : 'STALE_OFFICE_SURFACE_LAYOUT';
  if (code === expected) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return new RegExp('(?:^|[\\s:])' + expected + '(?:$|[\\s:])').test(message);
}
