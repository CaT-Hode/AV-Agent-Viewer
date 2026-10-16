/** Electron invoke preserves Error.message, but not ViewerError.code. Keep the
 * machine code in that surviving field at the Office IPC boundary. This only
 * encodes a rejection; callers still decide whether their read is retryable. */
export function officeIpcError(cause: unknown): Error {
  const error = cause as { code?: unknown; message?: unknown } | null | undefined;
  const candidateCode = cause instanceof Error ? (cause as Error & { code?: unknown }).code : undefined;
  const code = typeof candidateCode === 'string' && /^[A-Z_]+$/.test(candidateCode) ? candidateCode : undefined;
  const message = typeof error?.message === 'string' ? error.message : 'Office 内嵌操作失败。';
  return new Error((code ? code + ': ' : '') + message);
}
