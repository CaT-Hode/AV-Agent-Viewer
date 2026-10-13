import { NativeOfficeError, type NativeOfficeDispatch, type NativeOfficeLayout } from './types';
import { nativeOfficeCommandPolicy } from '../../contracts/src/native-office-policy';

export function validateNativeOfficeLayout(value: NativeOfficeLayout): NativeOfficeLayout {
  if (!/^[1-9]\d{0,19}$/.test(value.ownerHwnd) || BigInt(value.ownerHwnd) > 0xffffffffffffffffn) throw new NativeOfficeError('INVALID_NATIVE_OWNER', '原生窗口身份无效。');
  const { x, y, width, height } = value.bounds;
  const viewport = value.ownerViewport;
  if (!viewport || ![viewport.width, viewport.height].every(Number.isFinite) || viewport.width < 1 || viewport.height < 1 || viewport.width > 20000 || viewport.height > 20000) throw new NativeOfficeError('INVALID_NATIVE_BOUNDS', '阅读器视口尺寸无效。');
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 1 || height < 1 || x > 20000 || y > 20000 || width > 20000 || height > 20000) throw new NativeOfficeError('INVALID_NATIVE_BOUNDS', '原生编辑器区域无效。');
  if (typeof value.visible !== 'boolean') throw new NativeOfficeError('INVALID_NATIVE_BOUNDS', '原生编辑器显示状态无效。');
  if (value.visible && (x + width > viewport.width + 2 || y + height > viewport.height + 2)) throw new NativeOfficeError('INVALID_NATIVE_BOUNDS', '原生编辑器区域超出阅读器视口。');
  return { ownerHwnd: value.ownerHwnd, ownerViewport: { width: viewport.width, height: viewport.height }, bounds: { x, y, width, height }, visible: value.visible };
}
export function validateNativeOfficeDispatch(value: NativeOfficeDispatch): NativeOfficeDispatch {
  if (!/^\.uno:[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value.command) || nativeOfficeCommandPolicy(value.command).blocked) throw new NativeOfficeError('INVALID_NATIVE_COMMAND', '此命令必须通过应用的文件或授权接口执行。');
  if (!Number.isSafeInteger(value.expectedEngineRevision) || value.expectedEngineRevision < 0 || value.expectedSelectionEpoch !== undefined && (!Number.isSafeInteger(value.expectedSelectionEpoch) || value.expectedSelectionEpoch < 0)) throw new NativeOfficeError('INVALID_NATIVE_REVISION', '原生编辑版本无效。');
  const args: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value.args ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(key) || typeof item === 'string' && item.length > 100000 || typeof item === 'number' && !Number.isFinite(item) || !['string', 'number', 'boolean'].includes(typeof item)) throw new NativeOfficeError('INVALID_NATIVE_ARGUMENT', '原生命令参数无效。');
    args[key] = item;
  }
  return { command: value.command, args, expectedEngineRevision: value.expectedEngineRevision, expectedSelectionEpoch: value.expectedSelectionEpoch };
}

/** Incremental JSONL framing. Limits each message without retaining an unbounded queue. */
export class NativeOfficeProtocolReader {
  private buffered = '';
  constructor(readonly receive: (value: unknown) => void, readonly limit = 160 * 1024 * 1024) {}
  feed(chunk: string) {
    this.buffered += chunk;
    let newline: number;
    while ((newline = this.buffered.indexOf('\n')) >= 0) {
      const line = this.buffered.slice(0, newline).replace(/\r$/, ''); this.buffered = this.buffered.slice(newline + 1);
      if (line.length > this.limit) { this.buffered = ''; throw new NativeOfficeError('NATIVE_PROTOCOL_LIMIT', '原生编辑器响应过大。'); }
      if (!line) continue;
      let parsed: unknown; try { parsed = JSON.parse(line); } catch { throw new NativeOfficeError('NATIVE_PROTOCOL_ERROR', '原生编辑器返回了无效响应。'); }
      this.receive(parsed);
    }
    if (this.buffered.length > this.limit) { this.buffered = ''; throw new NativeOfficeError('NATIVE_PROTOCOL_LIMIT', '原生编辑器响应过大。'); }
  }
  clear() { this.buffered = ''; }
}
