import { ViewerError } from '../../contracts/src/index';
import type { NativeOfficeDriver } from '../../contracts/src/native-office';

const methods = new Set(['open','state','snapshot','commands','commandStatus','query','inspect','execute','undo','navigate','exportCopy','ackSaved','close','detachView','input','captureNative','zoom']);
/** Only documented errors from a registered native driver cross the public error boundary. */
const nativeCodes = new Set([
  'ENGINE_EPOCH_CHANGED','IDEMPOTENCY_CONFLICT','INVALID_CAPTURE_RECT','INVALID_INPUT_TARGET','INVALID_NATIVE_ARGUMENT','INVALID_NATIVE_BOUNDS','INVALID_NATIVE_COMMAND','INVALID_NATIVE_DOCUMENT','INVALID_NATIVE_INPUT','INVALID_NATIVE_KEY','INVALID_NATIVE_OPERATION','INVALID_NATIVE_OVERLAY','INVALID_NATIVE_OWNER','INVALID_NATIVE_REVISION','INVALID_NATIVE_ZOOM','MERGE_WOULD_DISCARD_DATA',
  'NATIVE_CAPTURE_FAILED','NATIVE_CLOSE_VETO','NATIVE_COMMAND_DISABLED','NATIVE_CONNECTION_LOST','NATIVE_DPI_CHANGED','NATIVE_DUPLICATE_WRITER','NATIVE_ENGINE_ERROR','NATIVE_ENGINE_EXITED','NATIVE_ENGINE_TIMEOUT','NATIVE_ENGINE_UNAVAILABLE','NATIVE_EXPORT_UNSUPPORTED','NATIVE_FORMAT_UNSUPPORTED','NATIVE_IMPORT_INTERACTION','NATIVE_INPUT_FAILED','NATIVE_INPUT_FOCUS','NATIVE_INPUT_TIMEOUT','NATIVE_LAST_VIEW','NATIVE_METHOD_UNSUPPORTED','NATIVE_OPEN_FAILED','NATIVE_OPERATION_UNSUPPORTED','NATIVE_OUTCOME_UNKNOWN','NATIVE_PENDING_INPUT','NATIVE_PLATFORM_UNSUPPORTED','NATIVE_PROTOCOL_ERROR','NATIVE_PROTOCOL_LIMIT','NATIVE_QUERY_LIMIT','NATIVE_QUERY_UNSUPPORTED','NATIVE_REQUEST_TIMEOUT','NATIVE_RUNTIME_CLOSED','NATIVE_SELECTION_UNSUPPORTED','NATIVE_SESSION_MISMATCH','NATIVE_SESSION_NOT_FOUND','NATIVE_STARTUP_FAILED','NATIVE_STARTUP_TIMEOUT','NATIVE_TARGET_UNSUPPORTED','NATIVE_UNO_UNAVAILABLE','NATIVE_UNSAVED_CHANGES','NATIVE_VIEW_HIDDEN','NATIVE_VIEW_NOT_FOUND','NATIVE_VIEW_UNSUPPORTED','NATIVE_WINDOW_GONE','NATIVE_WORKER_EXITED','NATIVE_WORKER_FAILED',
  'NOTHING_TO_UNDO','REVISION_CONFLICT','SELECTION_CHANGED','SNAPSHOT_BUSY','STALE_COORDINATES','UNDO_CONFLICT',
  'INVALID_NATIVE_STYLE','NATIVE_STYLE_TARGET_UNAVAILABLE','NATIVE_STYLE_FIELD_UNSUPPORTED','NATIVE_STYLE_APPLY_FAILED','NATIVE_STYLE_ROLLBACK_FAILED','NATIVE_STYLE_ROLLBACK_UNVERIFIED','NATIVE_UNDO_BUSY','NATIVE_INPUT_RESTORE_FAILED',
  'INVALID_NATIVE_QUERY','INVALID_TARGET','STALE_NATIVE_THUMBNAIL','NATIVE_THUMBNAIL_UNAVAILABLE',
]);

/** This wrapper belongs to the driver trust boundary, never generic HTTP/user data. */
export function normalizeNativeOfficeDriver(driver: NativeOfficeDriver): NativeOfficeDriver {
  const cache = new Map<string, { original: Function; wrapped: (...args: unknown[]) => Promise<unknown> }>();
  return new Proxy(driver, { get(target, key) {
    const value: unknown = Reflect.get(target, key, target);
    if (typeof key !== 'string' || !methods.has(key) || typeof value !== 'function') return value;
    const existing = cache.get(key); if (existing?.original === value) return existing.wrapped;
    const wrapped = async (...args: unknown[]) => {
      try { return await Reflect.apply(value, target, args); }
      catch (error) {
        if (error instanceof ViewerError) throw error;
        if (error instanceof Error) {
          const code: unknown = (error as Error & { code?: unknown }).code;
          if (typeof code === 'string' && nativeCodes.has(code)) throw new ViewerError(code, error.message);
        }
        throw error;
      }
    };
    cache.set(key, { original: value, wrapped }); return wrapped;
  } });
}
