export type NativeOfficeReadKind = 'poll' | 'catalog' | 'status' | 'navigation';
export type NativeOfficeReadErrors = Partial<Record<NativeOfficeReadKind, { key: string; message: string; awaitingSession: boolean }>>;
export type NativeOfficeReadAction = { kind: NativeOfficeReadKind; key: string; outcome: 'success' } | { kind: NativeOfficeReadKind; key: string; outcome: 'failure'; cause: unknown };

export function nativeOfficeReadNotReady(cause: unknown) {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  return code === 'NATIVE_NOT_READY' || /\bNATIVE_NOT_READY\b/.test(message);
}

/** Read failures belong to a specific request scope, never to an edit transaction. */
export function updateNativeOfficeReadErrors(previous: NativeOfficeReadErrors, action: NativeOfficeReadAction): NativeOfficeReadErrors {
  if (action.outcome === 'success') {
    if (previous[action.kind]?.key !== action.key) return previous;
    const next = { ...previous }; delete next[action.kind]; return next;
  }
  const message = action.cause instanceof Error ? action.cause.message : String(action.cause);
  // Electron's invoke error serialization preserves message but drops ViewerError.code.
  const awaitingSession = nativeOfficeReadNotReady(action.cause);
  return { ...previous, [action.kind]: { key: action.key, message, awaitingSession } };
}

export function nativeOfficeReadMessages(errors: NativeOfficeReadErrors, keys: Record<NativeOfficeReadKind, string>, initializing: boolean): string[] {
  return [...new Set((Object.keys(keys) as NativeOfficeReadKind[]).flatMap(kind => {
    const item = errors[kind];
    return !item || item.key !== keys[kind] || (kind === 'poll' && initializing && item.awaitingSession) ? [] : [item.message];
  }))];
}
