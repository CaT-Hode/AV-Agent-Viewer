import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { OFFICE_SURFACE_METHODS, isOfficeSurfaceState, type OfficeInputModifiers, type OfficeSurfaceInputEvent, type OfficeSurfaceInputReply, type OfficeSurfaceState, type OfficeSurfaceWindow, type OfficeSurfaceWindowClipboardReply, type OfficeSurfaceWindowIdentity, type OfficeSurfaceWindowInputEvent, type OfficeSurfaceWindowPaintReply } from '../../../../../packages/contracts/src/office-surface';
import { call } from '../lib/transport';
import { OfficeSurfaceInputController } from '../lib/office-surface-controller';
import { officeTileRgba } from '../lib/office-surface-pixels';
import { OfficePointerClickTracker, type OfficePointerCapture } from '../lib/office-surface-pointer';
import { officeSurfaceStaleRead } from '../lib/office-surface-errors';
import { officeSurfaceWindowOwned, officeWindowPoint } from '../lib/office-surface-window';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { MotionPresence } from './MotionPresence';
import '../embedded-office-dialog.css';

export type EmbeddedOfficeDialogHostProps = { state?: OfficeSurfaceState; obscured?: boolean; request?: typeof call; onState(state: OfficeSurfaceState): void; onError(error: unknown): void; returnFocus?: () => void };
const neutral: OfficeInputModifiers = { shift: false, control: false, alt: false, meta: false };
const modifiers = (event: Pick<KeyboardEvent, 'shiftKey'|'ctrlKey'|'altKey'|'metaKey'>): OfficeInputModifiers => ({ shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey });
const sourceKey = (state: OfficeSurfaceState) => state.sessionId + ':' + state.engineEpoch + ':' + state.viewId;
type WindowProps = { request:typeof call; window: OfficeSurfaceWindow; identity: OfficeSurfaceWindowIdentity; active: boolean; modal: boolean; index: number; getState(): OfficeSurfaceState | undefined; onState(state: OfficeSurfaceState): void; onError(error: unknown): void };

function EmbeddedOfficeWindow(props: WindowProps) {
  const titleId = useId(), caption = props.window.title || '文档设置';
  const canvas = useRef<HTMLCanvasElement>(null), input = useRef<HTMLTextAreaElement>(null), shell = useRef<HTMLDivElement>(null), bitmap = useRef<ImageBitmap | undefined>(undefined), mounted = useRef(false), paintSequence = useRef(0);
  const latest = useRef(props); latest.current = props;
  const request=useCallback(<T=unknown,>(method:string,args:Record<string,unknown>={})=>latest.current.request<T>(method,args),[]);
  const composition = useRef<{ id: string; text: string } | undefined>(undefined), recentCommit = useRef<{ text: string; at: number } | undefined>(undefined), pointer = useRef<OfficePointerCapture | undefined>(undefined), clicks = useRef(new OfficePointerClickTracker());
  const [error, setError] = useState(''), [closing, setClosing] = useState(false), [, inputRevision] = useState(0);
  const [dpr, setDpr] = useState(() => globalThis.window.devicePixelRatio || 1);
  const key = JSON.stringify(props.identity);
  const owns = () => officeSurfaceWindowOwned(latest.current.getState(), latest.current.identity);
  const report = useCallback((cause: unknown) => { if (!mounted.current) return; setError(cause instanceof Error ? cause.message : String(cause)); latest.current.onError(cause); }, []);
  const controller = useMemo(() => new OfficeSurfaceInputController(props.identity.viewId, {
    state: () => latest.current.getState(), beforeInput: async () => { if (!owns()) throw new Error('文档对话框已关闭或被替换。'); },
    request: async <T,>(_method: string, args: Record<string, unknown> = {}): Promise<T> => {
      const event = args.event as OfficeSurfaceInputEvent;
      if (!owns()) throw new Error('文档对话框身份已失效。');
      const normalized: OfficeSurfaceWindowInputEvent = event.kind === 'pointer' ? { ...event, pointCss: event.pointTwips } : event.kind === 'selection-handle' ? (() => { throw new Error('文档对话框不接受正文选区端点。'); })() : event;
      if ('pointTwips' in normalized) delete (normalized as unknown as Record<string, unknown>).pointTwips;
      const reply = await request<OfficeSurfaceInputReply>(OFFICE_SURFACE_METHODS.windowInput, { ...latest.current.identity, streamId: args.streamId, sequence: args.sequence, event: normalized });
      // The closing keystroke may legitimately remove this window, but never its document identity.
      const state = latest.current.getState(); if (!state || state.sessionId !== reply.state.sessionId || state.engineEpoch !== reply.state.engineEpoch || state.viewId !== reply.state.viewId) throw new Error('文档对话框回执属于旧编辑会话。');
      return reply as T;
    },
    accept: state => latest.current.onState(state), changed: () => { if (mounted.current) inputRevision(value => value + 1); },
  }), [key]);
  const post = (event: OfficeSurfaceInputEvent) => { void controller.post(event).catch(report); };
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; paintSequence.current++; controller.dispose(); bitmap.current?.close(); bitmap.current = undefined; }; }, [controller]);
  useEffect(() => { if (props.active) { const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); return () => cancelAnimationFrame(frame); } }, [props.active, key]);
  useEffect(() => { const resized = () => setDpr(globalThis.window.devicePixelRatio || 1); globalThis.window.addEventListener('resize', resized); return () => globalThis.window.removeEventListener('resize', resized); }, []);
  useEffect(() => {
    if (!props.active || !props.modal) return;
    const trap = (event: FocusEvent) => { if (event.target instanceof Node && !shell.current?.contains(event.target)) input.current?.focus({ preventScroll: true }); };
    document.addEventListener('focusin', trap); return () => document.removeEventListener('focusin', trap);
  }, [props.active, props.modal]);
  useEffect(() => {
    const window = props.window, state = props.getState(); if (!window.visible || !state) return;
    const ticket = ++paintSequence.current, identity = props.identity;
    const width = Math.max(1, Math.ceil(window.width * dpr)), height = Math.max(1, Math.ceil(window.height * dpr));
    void request<OfficeSurfaceWindowPaintReply>(OFFICE_SURFACE_METHODS.windowPaint, { ...identity, generation: window.generation, width, height, deviceScaleFactor: dpr }).then(async reply => {
      if (!mounted.current || ticket !== paintSequence.current) return;
      const live = owns();
      if (!live || live.generation !== window.generation || !isOfficeSurfaceState(reply.state) || sourceKey(reply.state) !== sourceKey(state) || reply.windowId !== window.id || reply.windowInstanceId !== window.instanceId || reply.generation !== window.generation || reply.tile.width !== width || reply.tile.height !== height) return;
      const next = await createImageBitmap(new ImageData(officeTileRgba(reply.tile), width, height));
      if (!mounted.current || ticket !== paintSequence.current || owns()?.generation !== window.generation) { next.close(); return; }
      const target = canvas.current, context = target?.getContext('2d'); if (!target || !context) { next.close(); throw new Error('文档对话框 Canvas 不可用。'); }
      target.width = width; target.height = height; context.clearRect(0, 0, width, height); context.drawImage(next, 0, 0); bitmap.current?.close(); bitmap.current = next; setError('');
    }).catch(async cause => {
      if (!officeSurfaceStaleRead(cause, 'window')) { report(cause); return; }
      if(!latest.current.active)return;
      // A resized or just-closed native dialog is a normal paint race, never an input replay.
      try { const fresh = await request<OfficeSurfaceState>(OFFICE_SURFACE_METHODS.state, { viewId: identity.viewId }); if (mounted.current && isOfficeSurfaceState(fresh)) latest.current.onState(fresh); } catch (failure) { report(failure); }
    });
    return () => { paintSequence.current++; };
  }, [key, props.window.generation, props.window.width, props.window.height, props.window.visible, dpr, report]);
  useEffect(() => {
    const textarea = input.current; if (!textarea) return;
    const before = (event: InputEvent) => {
      if (composition.current || event.isComposing || event.inputType === 'insertCompositionText') return;
      if (['insertText', 'insertReplacementText', 'insertFromComposition'].includes(event.inputType) && event.data) { event.preventDefault(); const recent = recentCommit.current; if (!recent || recent.text !== event.data || performance.now() - recent.at > 150) post({ kind: 'text', text: event.data }); recentCommit.current = undefined; }
      const key = event.inputType === 'deleteContentBackward' ? 'Backspace' : event.inputType === 'deleteContentForward' ? 'Delete' : event.inputType === 'insertLineBreak' ? 'Enter' : undefined;
      if (key) { event.preventDefault(); post({ kind: 'key', phase: 'down', key, code: key, repeat: false, modifiers: neutral }); post({ kind: 'key', phase: 'up', key, code: key, repeat: false, modifiers: neutral }); }
    };
    textarea.addEventListener('beforeinput', before); return () => textarea.removeEventListener('beforeinput', before);
  }, [controller]);
  const keyboard = (event: React.KeyboardEvent<HTMLTextAreaElement>, phase: 'down'|'up') => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || composition.current || event.keyCode === 229 || event.key === 'Dead') return;
    // Window keys must not bubble to the application's document save/new-tab shortcuts.
    if ((event.ctrlKey || event.metaKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase())) return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault(); post({ kind: 'key', phase, key: event.key, code: event.code, repeat: event.repeat, modifiers: modifiers(event) });
  };
  const mouse = (event: React.PointerEvent<HTMLCanvasElement>, phase: 'down'|'move'|'up'|'cancel') => {
    if (!props.active || closing || controller.failure || composition.current) return;
    event.preventDefault(); event.stopPropagation();
    if (phase === 'down') { pointer.current = { id: event.pointerId, button: event.button, clickCount: clicks.current.down(event) }; event.currentTarget.setPointerCapture(event.pointerId); input.current?.focus({ preventScroll: true }); }
    if (phase !== 'down' && pointer.current?.id !== event.pointerId && event.buttons) return;
    if (phase !== 'down' && phase !== 'move' && pointer.current?.id !== event.pointerId) return;
    if (phase === 'move') clicks.current.move(event); if (phase === 'cancel') clicks.current.reset();
    const bounds = event.currentTarget.getBoundingClientRect(), point = officeWindowPoint({ x: event.clientX, y: event.clientY }, bounds, props.window);
    post({ kind: 'pointer', phase, pointTwips: point, button: pointer.current?.button ?? event.button, buttons: phase === 'up' || phase === 'cancel' ? 0 : event.buttons, clickCount: phase === 'move' ? 0 : pointer.current?.clickCount ?? 1, modifiers: modifiers(event) });
    if (phase === 'up' || phase === 'cancel') { pointer.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
  };
  const close = async () => {
    if (closing || !owns()) return; setClosing(true);
    try {
      const ime = composition.current; if (ime) { composition.current = undefined; await controller.post({ kind: 'composition', compositionId: ime.id, phase: 'cancel', text: '' }); }
      await controller.barrier(); if (!owns()) return;
      const reply = await request<OfficeSurfaceState>(OFFICE_SURFACE_METHODS.windowClose, latest.current.identity);
      const state = latest.current.getState(); if (!state || !isOfficeSurfaceState(reply) || sourceKey(reply) !== sourceKey(state)) throw new Error('关闭对话框的回执属于旧会话。');
      latest.current.onState(reply);
    } catch (cause) { report(cause); } finally { if (mounted.current) setClosing(false); }
  };
  const copy = async (cut: boolean) => {
    try {
      await controller.post({ kind: 'key', phase: 'down', key: cut ? 'x' : 'c', code: cut ? 'KeyX' : 'KeyC', repeat: false, modifiers: { ...neutral, control: true } });
      await controller.post({ kind: 'key', phase: 'up', key: cut ? 'x' : 'c', code: cut ? 'KeyX' : 'KeyC', repeat: false, modifiers: { ...neutral, control: true } }); await controller.barrier();
      const reply = await request<OfficeSurfaceWindowClipboardReply>(OFFICE_SURFACE_METHODS.windowClipboard, latest.current.identity);
      if (!mounted.current || !owns() || reply.windowId !== props.window.id || reply.windowInstanceId !== props.window.instanceId || sourceKey(reply.state) !== sourceKey(latest.current.getState()!)) return;
      const text = reply.items.find(item => item.mimeType.startsWith('text/plain')); if (!text) throw new Error('文档对话框没有提供可复制的文字。'); await navigator.clipboard.writeText(new TextDecoder().decode(text.data));
    } catch (cause) { report(cause); }
  };
  const popup = props.window.kind === 'child', deck = props.window.kind === 'deck';
  const popupPosition: CSSProperties = props.window.positionCss ? { position: 'fixed', left: props.window.positionCss.x, top: props.window.positionCss.y, right: 'auto' } : {};
  return <div ref={shell} className={'modal material-host embedded-office-dialog-window' + (popup ? ' is-popup' : '') + (deck ? ' is-deck' : '')} style={{ ...popupPosition, zIndex: 80 + props.index, maxWidth: 'calc(100vw - 64px)' }} role="dialog" aria-modal={props.modal && props.active || undefined} aria-labelledby={titleId} aria-hidden={!props.active || undefined} inert={!props.active || undefined} data-office-window-id={props.window.id} data-office-window-instance={props.window.instanceId} onKeyDown={event => { event.stopPropagation(); if (event.target === shell.current?.querySelector('.embedded-office-window-close') && event.key === 'Tab') { event.preventDefault(); input.current?.focus({ preventScroll: true }); } }}>
    <LiquidGlassSurface variant="panel" />
    <div className="modal-heading embedded-office-window-heading"><h2 id={titleId}>{caption}</h2><button type="button" className="icon-button embedded-office-window-close" aria-label="关闭文档对话框" title="关闭" disabled={closing} onClick={() => void close()}><X size={17} /></button></div>
    <div className="embedded-office-window-viewport" onScroll={() => clicks.current.reset()}><div className="embedded-office-window-body" style={{ width: props.window.width, height: props.window.height }}>
      <canvas ref={canvas} style={{ width: props.window.width, height: props.window.height }} aria-hidden="true" onPointerDown={event => mouse(event, 'down')} onPointerMove={event => mouse(event, 'move')} onPointerUp={event => mouse(event, 'up')} onPointerCancel={event => mouse(event, 'cancel')} onContextMenu={event => event.preventDefault()} />
      <textarea ref={input} className="embedded-office-window-input" aria-label={caption + ' 输入'} spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" disabled={!props.active || closing || !!controller.failure} style={{ left: props.window.cursor?.x ?? 0, top: props.window.cursor?.y ?? 0 }} onKeyDown={event => keyboard(event, 'down')} onKeyUp={event => keyboard(event, 'up')} onCompositionStart={() => { const ime = { id: crypto.randomUUID(), text: '' }; composition.current = ime; post({ kind: 'composition', compositionId: ime.id, phase: 'start', text: '' }); }} onCompositionUpdate={event => { const ime = composition.current; if (ime) { ime.text = event.data; post({ kind: 'composition', compositionId: ime.id, phase: 'update', text: event.data }); } }} onCompositionEnd={event => { const ime = composition.current; if (!ime) return; composition.current = undefined; recentCommit.current = { text: event.data, at: performance.now() }; post({ kind: 'composition', compositionId: ime.id, phase: event.data ? 'end' : 'cancel', text: event.data }); event.currentTarget.value = ''; }} onInput={event => { if (!composition.current) event.currentTarget.value = ''; }} onPaste={event => { event.preventDefault(); event.stopPropagation(); if (composition.current) return; const encoder = new TextEncoder(), text = event.clipboardData.getData('text/plain'); post({ kind: 'paste', items: [{ mimeType: 'text/plain;charset=utf-8', data: encoder.encode(text) }] }); }} onCopy={event => { event.preventDefault(); event.stopPropagation(); void copy(false); }} onCut={event => { event.preventDefault(); event.stopPropagation(); void copy(true); }} />
    </div></div>
    {error && <p className="embedded-office-window-error" role="alert">{error}</p>}
    {closing && <span className="embedded-office-window-status" role="status">正在关闭…</span>}
  </div>;
}

/** Community LOK windows are real engine pixels and inputs, presented in the application's modal shell. */
export function EmbeddedOfficeDialogHost(props: EmbeddedOfficeDialogHostProps) {
  const current = useRef(props); current.current = props;
  const previousFocus = useRef<HTMLElement | undefined>(undefined), hadWindow = useRef(false);
  const windows = props.state?.windows?.filter(window => window.visible && window.kind !== 'tooltip' && window.width > 0 && window.height > 0 && !!window.instanceId) ?? [];
  const modal = windows.some(window => window.modal === true);
  const open = windows.length > 0 && !props.obscured, state = props.state;
  useLayoutEffect(() => {
    if (open && !hadWindow.current) { const active = window.document.activeElement; previousFocus.current = active instanceof HTMLElement ? active : undefined; }
    if (!open && hadWindow.current) { const previous = previousFocus.current; if (!current.current.obscured) { if (previous?.isConnected) previous.focus({ preventScroll: true }); else current.current.returnFocus?.(); } previousFocus.current = undefined; }
    hadWindow.current = open;
  }, [open]);
  useEffect(() => () => { if (hadWindow.current && !current.current.obscured) { const previous = previousFocus.current; if (previous?.isConnected) previous.focus({ preventScroll: true }); } }, []);
  if (!state) return null;
  return createPortal(<MotionPresence show={open} surface="modal" duration={220} identity={sourceKey(state)}><div className={'modal-backdrop embedded-office-dialog-backdrop' + (modal ? '' : ' is-modeless')} data-office-dialog-owner={state.viewId}>
    {windows.map((window, index) => <EmbeddedOfficeWindow key={window.instanceId} window={window} request={props.request??call} identity={{ viewId: state.viewId, sessionId: state.sessionId, engineEpoch: state.engineEpoch, windowId: window.id, windowInstanceId: window.instanceId }} active={open && (!modal || index === windows.length - 1)} modal={modal} index={index} getState={() => current.current.state} onState={value => current.current.onState(value)} onError={cause => current.current.onError(cause)} />)}
  </div></MotionPresence>, window.document.body);
}
