import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, SlidersHorizontal, Table2, X } from 'lucide-react';
import { OFFICE_SURFACE_METHODS, isOfficeSurfaceState, type OfficeInputModifiers, type OfficeSurfaceInputEvent, type OfficeSurfaceInputReply, type OfficeSurfaceState, type OfficeSurfaceWindow, type OfficeSurfaceWindowClipboardReply, type OfficeSurfaceWindowIdentity, type OfficeSurfaceWindowInputEvent, type OfficeSurfaceWindowPaintReply } from '../../../../../packages/contracts/src/office-surface';
import { call } from '../lib/transport';
import { OfficeSurfaceInputController } from '../lib/office-surface-controller';
import { officeTileRgba } from '../lib/office-surface-pixels';
import { OfficePointerClickTracker, type OfficePointerCapture } from '../lib/office-surface-pointer';
import { officeSurfaceStaleRead } from '../lib/office-surface-errors';
import { officeSurfaceWindowOwned, officeWindowPoint } from '../lib/office-surface-window';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { MotionPresence } from './MotionPresence';
import { OfficeDialogForm, officeDialogCaption, type OfficeDialogFormHandle } from './OfficeDialogForm';
import '../embedded-office-dialog.css';

export type EmbeddedOfficeDialogHostProps = { state?: OfficeSurfaceState; obscured?: boolean; request?: typeof call; onState(state: OfficeSurfaceState): void; onError(error: unknown): void; returnFocus?: () => void };
const neutral: OfficeInputModifiers = { shift: false, control: false, alt: false, meta: false };
const modifiers = (event: Pick<KeyboardEvent, 'shiftKey'|'ctrlKey'|'altKey'|'metaKey'>): OfficeInputModifiers => ({ shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey });
const sourceKey = (state: OfficeSurfaceState) => state.sessionId + ':' + state.engineEpoch + ':' + state.viewId;
const dialogFocusables=(root:HTMLElement|null)=>[...(root?.querySelectorAll<HTMLElement>('button,input,select,textarea,[tabindex]')??[])].filter(node=>node.tabIndex>=0&&!node.matches(':disabled')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden');
type WindowProps = { request:typeof call; window: OfficeSurfaceWindow; identity: OfficeSurfaceWindowIdentity; active: boolean; modal: boolean; index: number; getState(): OfficeSurfaceState | undefined; onState(state: OfficeSurfaceState): void; onError(error: unknown): void; onStructured?():void };

function EmbeddedOfficeWindow(props:WindowProps){
  const titleId=useId(),shell=useRef<HTMLDivElement>(null),form=useRef<OfficeDialogFormHandle>(null),closing=useRef(false),latest=useRef(props);latest.current=props;
  const [dialog,setDialog]=useState(props.window.dialog),[loading,setLoading]=useState(!props.window.dialog),[error,setError]=useState(''),[compatibility,setCompatibility]=useState(false),[switching,setSwitching]=useState(false),[isClosing,setClosing]=useState(false),[readAttempt,setReadAttempt]=useState(0);
  useEffect(()=>{
    if(props.window.kind!=='dialog')return;
    let active=true;
    setLoading(true);setError('');
    void props.request<{state:OfficeSurfaceState;dialog?:OfficeSurfaceWindow['dialog']}>(OFFICE_SURFACE_METHODS.windowControls,props.identity).then(reply=>{
      if(!active)return;
      const state=latest.current.getState();if(!state||sourceKey(reply.state)!==sourceKey(state))return;
      setDialog(previous=>previous&&reply.dialog&&previous.revision>reply.dialog.revision?previous:reply.dialog);setLoading(false);
    }).catch(cause=>{if(active){setError(cause instanceof Error?cause.message:String(cause));setLoading(false);}});
    return()=>{active=false;};
  },[props.window.instanceId,props.window.generation,props.window.kind,readAttempt]);
  const currentDialog=props.window.dialog&&(!dialog||props.window.dialog.revision>=dialog.revision)?props.window.dialog:dialog;
  const tableDialog=currentDialog?.root.nativeId==='InsertTableDialog';
  useLayoutEffect(()=>{
    if(!props.active||!props.modal||compatibility)return;
    let previous:HTMLElement|undefined;
    const within=(target:HTMLElement)=>shell.current?.contains(target)||target.closest('[data-office-dialog-portal]')?.getAttribute('data-office-dialog-portal')===props.window.instanceId;
    const contain=(event:FocusEvent)=>{
      const target=event.target;if(!(target instanceof HTMLElement))return;
      if(within(target)){previous=target;return;}
      const fallback=dialogFocusables(shell.current)[0]??shell.current;
      const saved=previous?.isConnected&&within(previous)&&!previous.matches(':disabled')&&previous.getClientRects().length>0?previous:undefined;
      (saved??fallback)?.focus({preventScroll:true});
    };
    document.addEventListener('focusin',contain,true);return()=>document.removeEventListener('focusin',contain,true);
  },[props.active,props.modal,props.window.instanceId,compatibility]);
  useEffect(()=>{
    if(!props.active||props.window.kind!=='dialog')return;
    const focus=()=>{const targets=dialogFocusables(shell.current),target=targets.find(node=>node.matches('input,select,textarea'))??targets[0]??shell.current;target?.focus({preventScroll:true});};
    const frame=requestAnimationFrame(focus);return()=>cancelAnimationFrame(frame);
  },[props.active,props.window.instanceId,!!currentDialog]);
  const close=async()=>{
    const current=latest.current;
    if(closing.current||!current.active||!officeSurfaceWindowOwned(current.getState(),current.identity))return;
    closing.current=true;setClosing(true);
    try{
      const dismiss=async()=>{
        // A queued confirmation may already have completed and removed this
        // exact native window. Never send its close to a replacement window.
        if(!officeSurfaceWindowOwned(latest.current.getState(),current.identity))return;
        const result=await current.request<OfficeSurfaceState>(OFFICE_SURFACE_METHODS.windowClose,current.identity);
        if(shell.current)latest.current.onState(result);
      };
      if(form.current)await form.current.dismiss(dismiss);else await dismiss();
    }catch(cause){if(shell.current){latest.current.onError(cause);setError(cause instanceof Error?cause.message:String(cause));}}
    finally{closing.current=false;if(shell.current)setClosing(false);}
  };
  const showCompatibility=async()=>{
    if(switching)return;setSwitching(true);setError('');
    try{
      const current=form.current;if(currentDialog&&!current)throw new Error('文档选项尚未准备好。');
      await current?.flush();
      if(shell.current&&officeSurfaceWindowOwned(latest.current.getState(),latest.current.identity))setCompatibility(true);
    }catch(cause){if(shell.current){latest.current.onError(cause);setError(cause instanceof Error?cause.message:String(cause));}}
    finally{if(shell.current)setSwitching(false);}
  };
  const keyboard=(event:React.KeyboardEvent<HTMLDivElement>)=>{
    event.stopPropagation();if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;if(event.key==='Escape'){event.preventDefault();void close();return;}
    if(event.key==='Tab'&&props.modal&&shell.current){const focusable=dialogFocusables(shell.current);const first=focusable[0],last=focusable.at(-1);if(!first){event.preventDefault();shell.current.focus();}else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  };
  if(props.window.kind!=='dialog'||compatibility)return <CanvasOfficeWindow {...props} onStructured={currentDialog?()=>setCompatibility(false):undefined}/>;
  return <div ref={shell} tabIndex={-1} className="modal material-host embedded-office-dialog-window office-structured-dialog" role="dialog" aria-modal={props.modal||undefined} aria-labelledby={titleId} aria-hidden={!props.active||undefined} inert={!props.active||undefined} data-office-window-id={props.window.id} data-office-window-instance={props.window.instanceId} style={{zIndex:80+props.index}} onKeyDown={keyboard}>
    <LiquidGlassSurface variant="panel"/>
    <div className="modal-heading embedded-office-window-heading"><span className="office-dialog-heading-icon" aria-hidden="true">{tableDialog?<Table2 size={21}/>:<SlidersHorizontal size={21}/>}</span><div className="office-dialog-heading-text"><h2 id={titleId}>{officeDialogCaption(props.window.title)||'文档设置'}</h2>{tableDialog&&<p>设置行列、标题行与分页方式</p>}</div><button type="button" className="icon-button embedded-office-window-close" aria-label="关闭文档对话框" title="关闭" disabled={isClosing} onClick={()=>void close()}><X size={17}/></button></div>
    {currentDialog?<OfficeDialogForm ref={form} {...props} window={{...props.window,dialog:currentDialog}} onState={state=>{const next=state.windows?.find(window=>window.instanceId===props.window.instanceId)?.dialog;if(next)setDialog(next);props.onState(state);}} onClose={()=>void close()}/>:loading?<div className="office-dialog-loading" role="status">正在读取文档选项…</div>:<div className="office-dialog-unavailable"><p>暂时无法读取这个窗口的表单。</p><div><button type="button" className="button" onClick={()=>setReadAttempt(value=>value+1)}>重新读取</button><button type="button" className="button" disabled={switching} onClick={()=>void showCompatibility()}>使用原始选项</button></div></div>}
    {currentDialog&&!currentDialog.complete&&<div className="office-dialog-compatibility"><span>这个窗口还包含特殊控件。</span><button type="button" disabled={switching} onClick={()=>void showCompatibility()}>打开完整选项</button></div>}
    {error&&<p className="office-dialog-error" role="alert">{error}</p>}
  </div>;
}

function CanvasOfficeWindow(props: WindowProps) {
  const titleId = useId(), caption = props.window.title || '文档设置';
  const canvas = useRef<HTMLCanvasElement>(null), input = useRef<HTMLTextAreaElement>(null), shell = useRef<HTMLDivElement>(null), bitmap = useRef<ImageBitmap | undefined>(undefined), mounted = useRef(false), paintSequence = useRef(0);
  const latest = useRef(props); latest.current = props;
  const request=useCallback(<T=unknown,>(method:string,args:Record<string,unknown>={})=>latest.current.request<T>(method,args),[]);
  const composition = useRef<{ id: string; text: string } | undefined>(undefined), recentCommit = useRef<{ text: string; at: number } | undefined>(undefined), pointer = useRef<OfficePointerCapture | undefined>(undefined), clicks = useRef(new OfficePointerClickTracker());
  const [error, setError] = useState(''), [closing, setClosing] = useState(false), [returning, setReturning] = useState(false), [, inputRevision] = useState(0);
  const returnPending = useRef(false);
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
  const post = (event: OfficeSurfaceInputEvent) => { if (!returnPending.current) void controller.post(event).catch(report); };
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
      target.width = width; target.height = height; context.clearRect(0, 0, width, height); context.drawImage(next, 0, 0); bitmap.current?.close(); bitmap.current = next;
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
    if (!props.active || closing || returnPending.current || controller.failure || composition.current) return;
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
    if (closing || returnPending.current || !owns()) return; setClosing(true);
    try {
      const ime = composition.current; if (ime) { composition.current = undefined; await controller.post({ kind: 'composition', compositionId: ime.id, phase: 'cancel', text: '' }); }
      await controller.barrier(); if (!owns()) return;
      const reply = await request<OfficeSurfaceState>(OFFICE_SURFACE_METHODS.windowClose, latest.current.identity);
      const state = latest.current.getState(); if (!state || !isOfficeSurfaceState(reply) || sourceKey(reply) !== sourceKey(state)) throw new Error('关闭对话框的回执属于旧会话。');
      latest.current.onState(reply);
    } catch (cause) { report(cause); } finally { if (mounted.current) setClosing(false); }
  };
  const returnStructured = async () => {
    if (returnPending.current || closing || !latest.current.active || !owns() || !latest.current.onStructured) return;
    if (composition.current || controller.compositionActive) { report(new Error('请先完成输入法组合输入，再返回文档选项。')); input.current?.focus({ preventScroll: true }); return; }
    returnPending.current = true; setReturning(true); setError('');
    try {
      await controller.barrier();
      if (!mounted.current) return;
      if (!latest.current.active || !owns()) throw new Error('文档对话框已关闭或被替换，无法返回文档选项。');
      latest.current.onStructured?.();
    } catch (cause) { report(cause); }
    finally { returnPending.current = false; if (mounted.current) setReturning(false); }
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
    <div className="modal-heading embedded-office-window-heading">{props.onStructured&&<button type="button" className="icon-button" aria-label="返回文档选项" title="返回" disabled={!props.active||closing||returning||!!controller.failure} onClick={()=>void returnStructured()}><ArrowLeft size={17}/></button>}<h2 id={titleId}>{officeDialogCaption(caption)}</h2><button type="button" className="icon-button embedded-office-window-close" aria-label="关闭文档对话框" title="关闭" disabled={closing||returning} onClick={() => void close()}><X size={17} /></button></div>
    <div className="embedded-office-window-viewport" onScroll={() => clicks.current.reset()}><div className="embedded-office-window-body" style={{ width: props.window.width, height: props.window.height }}>
      <canvas ref={canvas} style={{ width: props.window.width, height: props.window.height }} aria-hidden="true" onPointerDown={event => mouse(event, 'down')} onPointerMove={event => mouse(event, 'move')} onPointerUp={event => mouse(event, 'up')} onPointerCancel={event => mouse(event, 'cancel')} onContextMenu={event => event.preventDefault()} />
      <textarea ref={input} className="embedded-office-window-input" aria-label={caption + ' 输入'} spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" disabled={!props.active || closing || returning || !!controller.failure} style={{ left: props.window.cursor?.x ?? 0, top: props.window.cursor?.y ?? 0 }} onKeyDown={event => keyboard(event, 'down')} onKeyUp={event => keyboard(event, 'up')} onCompositionStart={() => { const ime = { id: crypto.randomUUID(), text: '' }; composition.current = ime; post({ kind: 'composition', compositionId: ime.id, phase: 'start', text: '' }); }} onCompositionUpdate={event => { const ime = composition.current; if (ime) { ime.text = event.data; post({ kind: 'composition', compositionId: ime.id, phase: 'update', text: event.data }); } }} onCompositionEnd={event => { const ime = composition.current; if (!ime) return; composition.current = undefined; recentCommit.current = { text: event.data, at: performance.now() }; post({ kind: 'composition', compositionId: ime.id, phase: event.data ? 'end' : 'cancel', text: event.data }); event.currentTarget.value = ''; }} onInput={event => { if (!composition.current) event.currentTarget.value = ''; }} onPaste={event => { event.preventDefault(); event.stopPropagation(); if (composition.current) return; const encoder = new TextEncoder(), text = event.clipboardData.getData('text/plain'); post({ kind: 'paste', items: [{ mimeType: 'text/plain;charset=utf-8', data: encoder.encode(text) }] }); }} onCopy={event => { event.preventDefault(); event.stopPropagation(); void copy(false); }} onCut={event => { event.preventDefault(); event.stopPropagation(); void copy(true); }} />
    </div></div>
    {error && <p className="embedded-office-window-error" role="alert">{error}</p>}
    {closing && <span className="embedded-office-window-status" role="status">正在关闭…</span>}
    {returning && <span className="embedded-office-window-status" role="status">正在确认输入…</span>}
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
