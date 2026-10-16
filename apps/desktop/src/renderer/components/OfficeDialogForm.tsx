import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import type { OfficeSurfaceDialogNode, OfficeSurfaceWindowIdentity, OfficeSurfaceState, OfficeSurfaceWindow } from '../../../../../packages/contracts/src/office-surface';
import { OFFICE_SURFACE_METHODS } from '../../../../../packages/contracts/src/office-surface';
import { call } from '../lib/transport';
import { GlassSwitch } from './GlassControls';
import { GlassSegmentedControl } from './GlassSegmentedControl';
import { OfficeDialogChoice } from './OfficeDialogChoice';
import { OfficeDialogIntents, type OfficeDialogAction } from '../lib/office-dialog-intents';
import { CircleHelp } from 'lucide-react';

const captions: Record<string,string> = {
  'insert table':'插入表格','general':'基本设置','options':'表格选项','name':'表格名称','columns':'列数','rows':'行数',
  'header':'标题行','repeat header rows on new pages':'在新页重复标题行','header rows':'标题行数',
  "don’t split table over pages":'禁止表格跨页拆分',"don't split table over pages":'禁止表格跨页拆分',
  'styles':'样式','warning : large tables may adversely affect performance and compatibility':'表格过大可能影响性能和兼容性',
  'help':'帮助','cancel':'取消','insert':'插入','ok':'确定','apply':'应用','close':'关闭','yes':'是','no':'否',
  'font':'字体','font effects':'字体效果','position':'位置','alignment':'对齐','borders':'边框','background':'背景','area':'区域',
  'character':'文字设置','paragraph':'段落设置','style':'字形','size':'字号','language':'语言','font family':'字体',
  'western text font':'西文字体','asian text font':'亚洲语言字体','complex text layout font':'复杂文字字体',
  'hyperlink':'链接','highlighting':'文字底色','indents & spacing':'缩进与间距','text flow':'分页与换行',
  'outline & list':'大纲与列表','tabs':'制表位','drop caps':'首字下沉','transparency':'透明度',
  'spacing':'间距','indent':'缩进','before text':'文本之前','after text':'文本之后','first line':'首行',
  'above paragraph':'段落上方','below paragraph':'段落下方','line spacing':'行距','automatic':'自动',
  'preview':'预览','reset':'重置','standard':'标准','default':'默认','none':'无','left':'左侧','right':'右侧','center':'居中',
  'border':'边框','asian layout':'亚洲文字排版','font color':'文字颜色','text decoration':'文字装饰',
  'overlining':'上划线','strikethrough':'删除线','underlining':'下划线','individual words':'仅单词',
  'case':'大小写','relief':'浮雕','outline':'空心','shadow':'阴影','blinking':'闪烁','hidden':'隐藏文字',
  '(without)':'无','single':'单线','double':'双线','bold':'粗体','regular':'常规','italic':'斜体',
  'dotted':'点线','dash':'短划线','long dash':'长划线','dot dash':'点划线','dot dot dash':'双点划线','wave':'波浪线',
  'description':'描述','title':'标题','subject':'主题','keywords':'关键词','comments':'说明','custom properties':'自定义属性','security':'安全','statistics':'统计',
  'contributor':'贡献者','coverage':'覆盖范围','identifier':'标识','publisher':'发布者','relation':'关联','rights':'权利','source':'来源','type':'类型',
  'dotted (bold)':'粗点线','dash (bold)':'粗短划线','long dash (bold)':'粗长划线','dot dash (bold)':'粗点划线','dot dot dash (bold)':'粗双点划线','wave (bold)':'粗波浪线',
};
export function officeDialogCaption(value:string|undefined,fallback='') {
  const text=(value??'').replace(/~|_(?=\p{L})/gu,'').replace(/\s*:\s*$/,'').trim();
  // The engine opens a managed snapshot whose basename is an internal UUID.
  // Keep that storage identity out of the user-facing document properties title.
  if(/^Properties of [“"].+[”"]$/i.test(text))return '文档属性';
  return captions[text.toLowerCase()]??(text||fallback);
}
type Props={window:OfficeSurfaceWindow;identity:OfficeSurfaceWindowIdentity;request:typeof call;active:boolean;onState(state:OfficeSurfaceState):void;onError(error:unknown):void;onClose():void};
type Action=OfficeDialogAction;
export type OfficeDialogFormHandle={flush():Promise<void>;dismiss(operation:()=>Promise<void>):Promise<void>};
type Reply={state:OfficeSurfaceState;windowId:number;windowInstanceId:string;dialog?:NonNullable<OfficeSurfaceWindow['dialog']>};
const nodes=(root:OfficeSurfaceDialogNode):OfficeSurfaceDialogNode[]=>[root,...(root.children??[]).flatMap(nodes)];
const buttonToken=(node:OfficeSurfaceDialogNode)=>/^(ok|cancel|help|apply|close|insert|yes|no)$/i.test(node.nativeId??'')?node.nativeId!.toLowerCase():(node.text??'').replace(/~|_/g,'').trim().toLowerCase();
const footerButton=(node:OfficeSurfaceDialogNode)=>node.visible&&node.kind==='button'&&/^(ok|cancel|help|apply|close|insert|yes|no)$/.test(buttonToken(node));
const footerOrder=(node:OfficeSurfaceDialogNode)=>buttonToken(node)==='help'?0:/^(ok|insert|apply|yes)$/.test(buttonToken(node))?2:1;

/** Native controls supply the data and execute every operation. Only their
 * presentation belongs to the reader; no document or dialog state is invented. */
export const OfficeDialogForm=forwardRef<OfficeDialogFormHandle,Props>(function OfficeDialogForm(props,ref){
  const prefix=useId(),latest=useRef(props);latest.current=props;
  const liveDialog=useRef(props.window.dialog);liveDialog.current=props.window.dialog;
  const mounted=useRef(true),dismissing=useRef(false),queueRef=useRef<OfficeDialogIntents|undefined>(undefined);
  const [,renderRevision]=useState(0),[flushing,setFlushing]=useState(false),[error,setError]=useState('');
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  if(!queueRef.current)queueRef.current=new OfficeDialogIntents(async(nodeId,action)=>{
      if(!mounted.current)throw new Error('文档对话框已关闭。');
      const current=latest.current,dialog=liveDialog.current;
      if(!dialog||!nodes(dialog.root).some(value=>value.id===nodeId))throw new Error('这个对话框控件已更新，请重新操作。');
      const reply=await current.request<Reply>(OFFICE_SURFACE_METHODS.windowAction,{...current.identity,revision:dialog.revision,nodeId,action,requestId:crypto.randomUUID()});
      if(!mounted.current)return;
      if(reply.windowInstanceId!==current.identity.windowInstanceId||reply.windowId!==current.identity.windowId||reply.state.sessionId!==current.identity.sessionId||reply.state.engineEpoch!==current.identity.engineEpoch||reply.state.viewId!==current.identity.viewId)throw new Error('对话框操作返回了旧会话结果。');
      liveDialog.current=reply.dialog??reply.state.windows?.find(window=>window.instanceId===current.identity.windowInstanceId)?.dialog;
      current.onState(reply.state);
  },()=>{if(mounted.current){const current=queueRef.current;if(current&&current.pending===0&&!current.hasFailures)setError('');renderRevision(value=>value+1);}});
  const queue=queueRef.current,pending=queue.pending;
  const report=(cause:unknown)=>{if(mounted.current){setError(cause instanceof Error?cause.message:String(cause));latest.current.onError(cause);}};
  const barrier=async(operation?:()=>Promise<void>)=>{
    setFlushing(true);setError('');
    try{await queue.flush();if(operation&&!dismissing.current)await operation();}finally{if(mounted.current&&!dismissing.current)setFlushing(false);}
  };
  useImperativeHandle(ref,()=>({flush:()=>barrier(),dismiss:async operation=>{
    // Cancel shares the native action queue, but must not flush a new draft or
    // let a confirmation waiting on field acknowledgements run after closing.
    if(dismissing.current)return;dismissing.current=true;setFlushing(true);
    try{await queue.settle();await operation();}finally{dismissing.current=false;if(mounted.current)setFlushing(false);}
  }}),[queue]);
  const changeDraft=(node:OfficeSurfaceDialogNode,value:string)=>{
    if(dismissing.current)return;
    const option=node.kind==='select'?node.options?.find(option=>option.text===value||officeDialogCaption(option.text)===value):undefined;
    queue.edit(node.id,value,option?{kind:'select',value:option.id}:{kind:'set-text',value});
  };
  const commit=(node:OfficeSurfaceDialogNode)=>{if(dismissing.current)return;setError('');void queue.commit(node.id).catch(report);};
  const choose=(node:OfficeSurfaceDialogNode,value:string)=>{
    if(dismissing.current)return;
    const option=node.options?.find(option=>option.id===value);
    if(!option){report(new Error('这个原生选项已更新，请重新选择。'));return;}
    queue.edit(node.id,node.kind==='tabs'?option.id:option.text,{kind:'select',value});commit(node);
  };
  const toggle=(node:OfficeSurfaceDialogNode,value:boolean)=>{if(dismissing.current)return;queue.edit(node.id,value);commit(node);};
  const send=(node:OfficeSurfaceDialogNode,action:Action)=>{
    if(dismissing.current)return;
    setError('');
    if(node.kind==='button'&&action.kind==='click'&&/^(cancel|close)$/.test(buttonToken(node))){props.onClose();return;}
    const confirms=node.kind==='button'&&action.kind==='click'&&!/^(cancel|close|no|help)$/.test(buttonToken(node));
    void (confirms?barrier(()=>queue.action(node.id,action)):queue.action(node.id,action)).catch(report);
  };
  const root=props.window.dialog?.root;if(!root)return null;
  const footer=nodes(root).filter(footerButton).sort((a,b)=>footerOrder(a)-footerOrder(b)),footerIds=new Set(footer.map(node=>node.id));
  const render=(node:OfficeSurfaceDialogNode,parentHeading=''):React.ReactNode=>{
    if(!node.visible||footerIds.has(node.id))return null;
    const label=officeDialogCaption(node.text)||({text:'内容',number:'数值',select:'选项',tabs:'设置分类',checkbox:'选项',radio:'选项'} as Record<string,string>)[node.kind]||'';
    const id=prefix+'-'+node.id,disabled=!props.active||!node.enabled||flushing;
    if(node.kind==='label')return <span key={node.id} className="office-dialog-label">{label}</span>;
    if(node.kind==='checkbox'||node.kind==='radio')return <div key={node.id} className="office-dialog-field office-dialog-toggle" data-office-control-id={node.nativeId}><span id={id}>{label}</span>{node.kind==='checkbox'?<GlassSwitch label={label} checked={queue.checked(node.id)??!!node.checked} disabled={disabled||!node.actions.includes('toggle')} onChange={value=>toggle(node,value)}/>:<button type="button" role="radio" aria-checked={!!node.checked} aria-labelledby={id} disabled={disabled||!node.actions.includes('click')} className="office-dialog-radio" onClick={()=>send(node,{kind:'click'})}><span/></button>}</div>;
    if(node.kind==='text'||node.kind==='number'){
      const value=queue.value(node.id)??node.value??'';
      if(node.kind==='text'&&node.multiline)return <label key={node.id} className="office-dialog-field office-dialog-multiline" data-office-control-id={node.nativeId}><span>{label}</span><textarea id={id} aria-label={label} value={value} rows={4} disabled={disabled||!node.actions.includes('set-text')} onChange={event=>changeDraft(node,event.target.value)} onBlur={()=>commit(node)}/></label>;
      return <label key={node.id} className="office-dialog-field" data-office-control-id={node.nativeId}><span>{label}</span><input id={id} aria-label={label} inputMode={node.kind==='number'?'decimal':undefined} value={value} disabled={disabled||!node.actions.includes('set-text')} onChange={event=>changeDraft(node,event.target.value)} onBlur={()=>commit(node)} onKeyDown={event=>{if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;if(event.key==='Enter'){event.preventDefault();commit(node);}}}/></label>;
    }
    if(node.kind==='tabs')return <div key={node.id} className="office-dialog-tabs" data-office-control-id={node.nativeId}>{(node.options?.length??0)>1?<GlassSegmentedControl label={label||'设置分类'} value={queue.value(node.id)??node.options?.find(option=>option.selected)?.id??node.value??''} options={(node.options??[]).map(option=>({value:option.id,label:officeDialogCaption(option.text)}))} disabled={disabled||!node.actions.includes('select')} onChange={value=>choose(node,value)}/>:node.options?.[0]&&<h3>{officeDialogCaption(node.options[0].text)}</h3>}{node.children?.map(child=>render(child,parentHeading))}</div>;
    if(node.kind==='select')return <div key={node.id} className="office-dialog-field" data-office-control-id={node.nativeId}><span>{label}</span><OfficeDialogChoice dialogInstanceId={props.identity.windowInstanceId} selectedOptionId={queue.selectedOption(node.id)??(queue.value(node.id)===undefined?node.options?.find(option=>option.selected)?.id:undefined)} label={label} value={queue.value(node.id)??node.value??''} options={(node.options??[]).map(option=>({...option,sourceText:option.text,text:officeDialogCaption(option.text)}))} editable={node.actions.includes('set-text')} disabled={disabled||!node.actions.some(action=>action==='select'||action==='set-text')} onDraft={value=>changeDraft(node,value)} onSelect={value=>choose(node,value)} onText={()=>commit(node)}/></div>;
    if(node.kind==='button')return <button key={node.id} type="button" className="button office-dialog-action" disabled={disabled||!node.actions.includes('click')} onClick={()=>send(node,{kind:'click'})}>{label}</button>;
    if(node.kind==='unknown'&&!node.children?.length)return label||node.value?<span key={node.id} className="office-dialog-readonly" data-office-control-id={node.nativeId} title="特殊选项，可在完整选项中调整">{label||node.value}</span>:null;
    // A native frame supplies its own section label. Keep its real ordering and
    // controls, while discarding only the presentation of anonymous VCL boxes.
    const heading=node.kind==='container'?node.children?.find(child=>child.visible&&child.kind==='label'&&child.text&&(!label||officeDialogCaption(child.text)===label)):undefined;
    const sectionTitle=label||officeDialogCaption(heading?.text),showHeading=sectionTitle&&sectionTitle!==parentHeading&&node!==root;
    const children=node.children?.filter(child=>child!==heading).map(child=>render(child,sectionTitle||parentHeading));
    return <div key={node.id} data-office-group-id={node.nativeId} className={'office-dialog-group'+(node===root?' is-root':showHeading?' is-section':' is-anonymous')}>{showHeading&&<h3>{sectionTitle}</h3>}{children}</div>;
  };
  return <div className="office-dialog-form" data-office-dialog-source={props.window.dialog!.source} data-office-dialog-kind={root.nativeId} aria-busy={pending>0||flushing}>
    <div className="office-dialog-fields">{render(root)}</div>
    {error&&<p className="office-dialog-error" role="alert">{error}</p>}
    <div className="office-dialog-footer">{footer.map(node=>{const token=buttonToken(node),help=token==='help';return <button key={node.id} type="button" data-office-control-id={node.nativeId} className={'button'+(help?' office-dialog-help':'')+(/^(ok|insert|apply|yes)$/.test(token)?' primary':'')} aria-label={help?officeDialogCaption(node.text):undefined} title={help?officeDialogCaption(node.text):undefined} disabled={!props.active||!node.enabled||!node.actions.includes('click')||flushing&&!/^(cancel|close|no)$/.test(token)} onClick={()=>send(node,{kind:'click'})}>{help?<CircleHelp size={17}/>:officeDialogCaption(node.text)}</button>;})}{!footer.some(node=>/^(cancel|close)$/.test(buttonToken(node)))&&<button type="button" className="button" onClick={props.onClose}>取消</button>}</div>
  </div>;
});
