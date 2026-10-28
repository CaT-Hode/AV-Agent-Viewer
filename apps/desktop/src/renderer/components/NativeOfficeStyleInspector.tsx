import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, RefreshCw, RotateCcw } from 'lucide-react';
import type { NativeOfficeFormat, NativeOfficeState, NativeOfficeStyleInspection, NativeOfficeStyleTarget, NativeOfficeStyleValues } from '../../../../../packages/contracts/src/native-office';
import { nativeOfficeInteractionBlocked } from '../../../../../packages/contracts/src/native-office';
import type { OfficeToolboxCategory } from './office/toolbox-contributions';
import { latestNativeOfficeRead, nativeOfficeOwnedState, nativeOfficeStateVersionOrder, nativeOfficeStyleSourceKey, type NativeOfficeRequest } from '../lib/native-office-tools';
import { nativeStyleControls, nativeStyleTargets, parseNativeStyleValues, type NativeStyleControl } from '../lib/native-office-style';
import { call } from '../lib/transport';
import { nativeOfficeStyleIcons } from './office/native-command-icons';
import { NativeOfficeToolGlyph } from './office/NativeOfficeToolGlyph';

export type NativeOfficeStyleInspectorProps = {
  documentId: string; viewId: string; format: NativeOfficeFormat; category: OfficeToolboxCategory; state?: NativeOfficeState; busy?: boolean; request?: NativeOfficeRequest;
  onApply(target: NativeOfficeStyleTarget, values: NativeOfficeStyleValues, source: NativeOfficeState): Promise<void>;
  onInspect?(state: NativeOfficeState): void;
};
const names = { text: '文字', paragraph: '段落', cells: '单元格', shape: '对象' };
type Draft = { identity: string; lease: string; values: Record<string, string | boolean> };

function StyleTarget({ target, ...props }: NativeOfficeStyleInspectorProps & { target: NativeOfficeStyleTarget }) {
  const identity = JSON.stringify([props.documentId, props.viewId, target]);
  const state = nativeOfficeOwnedState(props.state, props) ? props.state : undefined;
  const lease = state ? nativeOfficeStyleSourceKey(state) : '';
  const inspectionBlocked = !!state && nativeOfficeInteractionBlocked(state);
  const inputBlocked = !!state && (state.inputState ? state.inputState.composing || state.inputState.modal : !!state.pendingInput);
  const latest = useRef({ ...props, state, identity, lease }); latest.current = { ...props, state, identity, lease };
  const [record, setRecord] = useState<{ identity: string; lease: string; state: NativeOfficeState; data: NativeOfficeStyleInspection }>();
  const [draft, setDraft] = useState<Draft>(), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [pending, setPending] = useState(false), [composing, setComposing] = useState(false);
  const active = record?.identity === identity ? record : undefined, changes = draft?.identity === identity ? draft : undefined;
  const dirty = !!changes && Object.keys(changes.values).length > 0, stale = dirty && changes.lease !== lease;
  const controls = nativeStyleControls(target), groups = useMemo(() => [...new Set(controls.map(item => item.group))], [controls]);
  useEffect(() => { setError(''); setDraft(undefined); setPending(false); setComposing(false); }, [identity]);
  useEffect(() => {
    if (!state || state.status !== 'ready' || inspectionBlocked || props.busy || pending || dirty) return;
    let stopped = false;
    const timer = setTimeout(() => {
      void latestNativeOfficeRead<{ state: NativeOfficeState; data: NativeOfficeStyleInspection }>(props.request ?? call, identity, 'office-query', { viewId: props.viewId, target: { kind: 'style', target } }).then(response => {
        if (stopped || latest.current.identity !== identity || !nativeOfficeOwnedState(response.state, props) || (nativeOfficeStateVersionOrder(response.state, latest.current.state) ?? -1) < 0) return;
        if (response.data.targetKind !== target || !response.data.fields) throw new Error('引擎未确认当前格式目标。');
        latest.current.onInspect?.(response.state);
        setRecord({ identity, lease: nativeOfficeStyleSourceKey(response.state), state: response.state, data: response.data }); setError('');
      }).catch(cause => { if (!stopped && latest.current.identity === identity && String(cause)!=='Error: OFFICE_READ_SUPERSEDED') setError(cause instanceof Error ? cause.message : String(cause)); });
    }, 0);
    return () => { stopped = true; clearTimeout(timer); };
  }, [identity, lease, inspectionBlocked, refresh, dirty, pending, props.busy, props.request]);
  const available = !!active && controls.some(control => active.data.fields[control.name]?.available);
  const disabled = !!props.busy || pending || !state || state.status !== 'ready' || inputBlocked || active?.lease !== lease || stale;
  const change = (name: string, value: string | boolean) => {
    if (!active || disabled) return;
    setDraft(previous => ({ identity, lease: active.lease, values: { ...(previous?.identity === identity && previous.lease === active.lease ? previous.values : {}), [name]: value } }));
  };
  const apply = async (immediate?: Record<string,string|boolean>) => {
    if (!active || (!changes && !immediate) || disabled || composing) return;
    const submitted = changes, source = active.state;
    let values: NativeOfficeStyleValues;
    try { values = parseNativeStyleValues(target, {...changes?.values,...immediate}); } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); return; }
    setPending(true); setError('');
    try {
      await latest.current.onApply(target, values, source);
      if (latest.current.identity !== identity) return;
      setDraft(previous => previous === submitted ? undefined : previous); setRefresh(value => value + 1);
    } catch (cause) { if (latest.current.identity === identity) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (latest.current.identity === identity) setPending(false); }
  };
  const render = (control: NativeStyleControl) => {
    const field = active?.data.fields[control.name], edited = changes?.values[control.name];
    const value = edited ?? field?.value, enabled = !!field?.available && !disabled;
    const mixed = field?.state === 'mixed' && edited === undefined, placeholder = mixed ? '混合' : field?.value === null ? '自动或未定义' : '';
    const glyph = nativeOfficeStyleIcons[control.name];
    const reason = field?.reason || (!field?.available ? '当前目标不支持此属性。' : stale ? '目标或内容已变化，请重新读取。' : props.busy || pending ? '正在等待引擎回执…' : inputBlocked ? '请先完成中文输入或关闭原生对话框。' : active?.lease !== lease ? '正在读取当前目标属性…' : undefined);
    if (control.kind === 'boolean') return <button key={control.name} type="button" className={glyph ? 'native-office-icon native-office-tool icon-button' : 'native-office-action'} aria-label={control.label} title={control.label + (reason ? '\n' + reason : '')} aria-pressed={mixed ? 'mixed' : value === true} disabled={!enabled} onMouseDown={event => event.preventDefault()} onClick={() => void apply({[control.name]: value !== true})}>{glyph ? <NativeOfficeToolGlyph glyph={glyph} /> : <span>{control.label}</span>}</button>;
    return <label key={control.name} className="native-style-field"><span>{control.label}</span><span className="native-style-input">
      {control.kind === 'select' ? <select aria-label={names[target] + ' · ' + control.label} title={field?.reason} disabled={!enabled} value={typeof value === 'string' && control.options?.some(item => item[0] === value) ? value : ''} onChange={event => void apply({[control.name]:event.target.value})}><option value="" disabled>{placeholder || '请选择'}</option>{control.options?.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select> : <>
        {control.kind === 'color' && <span className="native-style-color" data-mixed={mixed || value === null || undefined} style={typeof value === 'string' && /^[0-9a-f]{6}$/i.test(value) ? { backgroundColor:'#'+value } : undefined}><input type="color" aria-label={'选择'+control.label} disabled={!enabled} value={typeof value==='string'&&/^[0-9a-f]{6}$/i.test(value)?'#'+value:'#000000'} onChange={event=>void apply({[control.name]:event.target.value.slice(1)})}/></span>}
        <input aria-label={names[target] + ' · ' + control.label} title={field?.reason} type={control.kind==='number'?'number':'text'} min={control.min} max={control.max} maxLength={control.maxLength} step={control.kind === 'number' ? 0.1 : undefined} placeholder={placeholder} disabled={!enabled} value={typeof value==='string'||typeof value==='number'?String(value):''} onChange={event=>change(control.name,event.target.value)} onBlur={()=>{if(dirty&&!composing)void apply();}} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();void apply();}}}/>
        {control.unit && <small>{control.unit}</small>}
      </>}
    </span></label>;
  };
  return <section className="native-style-inspector" data-native-style-target={target} data-dirty={dirty} data-stale={stale || undefined} aria-label={names[target]+'属性'} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)}>
    {!active ? <p className="native-office-note">{error || '正在读取'+names[target]+'属性…'}</p> : !available ? <p className="native-office-note">{Object.values(active.data.fields).find(field=>field.reason)?.reason || '请选择需要编辑的'+names[target]+'。'}</p> : groups.map((group,index) => <details className="native-style-group" key={group} open={index===0}><summary>{group}</summary><div className="native-style-fields">{controls.filter(control=>control.group===group&&control.kind!=='boolean').map(render)}<div className="native-style-booleans">{controls.filter(control=>control.group===group&&control.kind==='boolean').map(render)}</div></div></details>)}
    {stale && <p className="native-office-note">目标或内容已变化。输入已保留，请重新读取后编辑。</p>}
    {dirty && !stale && <p className="native-office-note">按 Enter 或离开输入框后应用。</p>}
    {active && error && <p className="native-office-error" role="alert">{error}</p>}
    <div className="native-office-inline native-style-actions"><button type="button" className="native-office-icon native-office-tool icon-button" aria-label={pending?'应用中…':'应用修改'} aria-busy={pending} title={'应用修改'+(pending||props.busy?'\n正在等待引擎回执…':composing?'\n请先完成输入。':stale?'\n目标或内容已变化，请重新读取。':!dirty?'\n请先修改属性。':disabled?'\n正在确认当前目标属性。':'')} disabled={!dirty||disabled||composing} onMouseDown={event=>event.preventDefault()} onClick={()=>void apply()}><Check size={17} aria-hidden="true"/></button><button type="button" className="native-office-icon native-office-tool icon-button" aria-label={dirty?'放弃并重新读取':'重新读取'} title={(dirty?'放弃并重新读取':'重新读取')+(pending||props.busy?'\n正在等待引擎回执…':composing?'\n请先完成输入。':'')} disabled={pending||props.busy||composing} onClick={()=>{setDraft(undefined);setRecord(undefined);setError('');setRefresh(value=>value+1);}}>{dirty?<RotateCcw size={17} aria-hidden="true"/>:<RefreshCw size={17} aria-hidden="true"/>}</button></div>
  </section>;
}
export function NativeOfficeStyleInspector(props: NativeOfficeStyleInspectorProps) {
  return <div className="native-style-inspectors">{nativeStyleTargets(props.format,props.category).map(target=><StyleTarget key={props.documentId+'\0'+props.viewId+'\0'+target} {...props} target={target}/>)}</div>;
}
