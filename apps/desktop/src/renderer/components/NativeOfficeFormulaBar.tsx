import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Sigma, X } from 'lucide-react';
import type { NativeOfficeState } from '../../../../../packages/contracts/src/native-office';
import type { OfficeDraftController } from './office/OfficeDrafts';
import { NativeOfficeCellDraft, nativeOfficeSingleCell } from '../lib/native-office-cell-draft';
import { nativeOfficeOwnedState, nativeOfficeStatusKey, type NativeOfficeRequest } from '../lib/native-office-tools';
import { call } from '../lib/transport';
import '../native-office-tools.css';
import { NAVIGATION_CONTENT_EVENT } from '../lib/useNavigationLayout';

export const NATIVE_OFFICE_FORMULA_BAR_HEIGHT = 32;
export type NativeOfficeFormulaBarProps = {
  documentId: string; viewId: string; state?: NativeOfficeState; request?: NativeOfficeRequest;
  active?: boolean;
  onState?(state: NativeOfficeState): void; onError?(error: unknown): void;
  onDraftController?(controller: OfficeDraftController | undefined): void; onDraftChange?(dirty: boolean): void;
};

/** A compact editor for the exact native cell; no mirror cell IDs or cached calculations. */
export function NativeOfficeFormulaBar(props: NativeOfficeFormulaBarProps) {
  const latest = useRef(props); latest.current = props;
  const current = useRef(props.state); current.current = props.state;
  const input = useRef<HTMLInputElement>(null), identity = props.documentId + '\0' + props.viewId;
  const liveIdentity = useRef(identity); liveIdentity.current = identity;
  const [, redraw] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const notify = () => redraw(value => value + 1);
  const request: NativeOfficeRequest = useMemo(() => (method, args) => (latest.current.request ?? call)(method, args), []);
  const draft = useMemo(() => new NativeOfficeCellDraft(props.viewId, props.documentId, { current: () => current.current, request, accept: state => { if (nativeOfficeOwnedState(state, latest.current)) { current.current = state; latest.current.onState?.(state); } }, changed: () => { notify(); }, }), [props.documentId, props.viewId, request]);
  useLayoutEffect(() => { latest.current.onDraftController?.(draft); return () => { draft.dispose(); latest.current.onDraftController?.(undefined); }; }, [draft]);
  const dirty = draft.hasDrafts();
  useEffect(() => { setBusy(false); setError(''); }, [identity]);
  useEffect(() => { latest.current.onDraftChange?.(dirty); }, [identity, dirty]);
  const state = nativeOfficeOwnedState(props.state, props) ? props.state : undefined;
  const cell = nativeOfficeSingleCell(state), key = state ? nativeOfficeStatusKey(state) : '';
  useEffect(() => {
    if (props.active === false) return;
    if (!state || !cell || state.status !== 'ready') { draft.clear(); return; }
    if (draft.hasDrafts()) return;
    draft.clear();
    let disposed = false;
    void request<{ state: NativeOfficeState; data: { values?: unknown[][]; formulas?: unknown[][] } }>('office-query', { viewId: props.viewId, target: { kind: 'cell-range', sheetName: cell.sheetName, range: cell.address } }).then(response => {
      if (disposed || liveIdentity.current !== identity || !nativeOfficeOwnedState(response.state, props) || nativeOfficeStatusKey(response.state) !== key || nativeOfficeStatusKey(current.current!) !== key) return;
      const formula = response.data?.formulas?.[0]?.[0], value = response.data?.values?.[0]?.[0];
      if (typeof formula !== 'string' || !(value === undefined || value === null || ['string', 'number', 'boolean'].includes(typeof value))) throw new Error('引擎未返回有效的单元格内容。');
      draft.load(response.state, formula.startsWith('=') ? formula : String(value ?? '')); setError('');
    }).catch(cause => { if (!disposed && liveIdentity.current === identity) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [key, draft, request, dirty, props.active]);
  const target = draft.target, editable = !!target && !!state && state.status === 'ready' && !state.pendingInput;
  // React updates input.value as a property, which MutationObserver cannot
  // observe. Notify the single navigation host without replacing this editor.
  useLayoutEffect(() => { input.current?.dispatchEvent(new Event(NAVIGATION_CONTENT_EVENT, { bubbles: true })); }, [draft.value]);
  const stale = dirty && (!cell || cell.sheetName !== target?.sheetName || cell.address !== target?.address);
  const flush = async () => {
    if (busy) return; const origin = identity; setBusy(true); setError('');
    try { await draft.flush(); }
    catch (cause) { if (liveIdentity.current === origin) { setError(cause instanceof Error ? cause.message : String(cause)); latest.current.onError?.(cause); } }
    finally { if (liveIdentity.current === origin) setBusy(false); }
  };
  return <div className="native-office-formula-bar" data-native-formula-bar={props.viewId} data-dirty={dirty} data-stale={stale || undefined}>
    <span className="native-office-cell-address" title={target ? target.sheetName + ' · ' + target.address : '请选择一个单元格'}>{target?.address ?? (state?.selection?.kind === 'cells' ? '多选' : '—')}</span>
    <Sigma size={14} aria-hidden="true" />
    <input ref={input} aria-label="单元格内容或公式" value={draft.value} readOnly={!editable} placeholder={stale ? '原单元格草稿' : state?.selection?.kind === 'cells' && !cell ? '多单元格选区，请选中一个单元格后编辑' : '输入内容或公式'} title={error || (stale && target ? '此草稿属于 ' + target.sheetName + '!' + target.address + '，请返回原单元格后提交。' : '当前单元格的实际内容与公式')} aria-invalid={!!error || stale} onChange={event => draft.setValue(event.target.value)} onCompositionStart={() => draft.setComposing(true)} onCompositionEnd={event => { draft.setComposing(false); draft.setValue(event.currentTarget.value); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); void flush(); }
      else if (event.key === 'Escape') { event.preventDefault(); draft.discard(); setError(''); }
    }} />
    <button type="button" className="icon-button" aria-label="取消公式草稿" title="取消公式草稿" disabled={!dirty || busy || draft.isPending} onMouseDown={event => event.preventDefault()} onClick={() => { draft.discard(); setError(''); }}><X size={14} /></button>
    <button type="button" className="icon-button" aria-label="提交单元格内容" title={error || '提交单元格内容'} disabled={!editable || !dirty || busy || draft.isPending || stale} onMouseDown={event => event.preventDefault()} onClick={() => void flush()}><Check size={14} /></button>
    {error && <span className="native-office-formula-error" role="alert" title={error}>未提交</span>}
  </div>;
}
