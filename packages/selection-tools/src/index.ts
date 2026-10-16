import { parse } from 'parse5';
import { createHash } from 'node:crypto';
import type { ViewerCore } from '../../document-core/src/index';
import { ViewerError, type Actor, type EditOperation, type ReadingSnapshot, type SelectionContext } from '../../contracts/src/index';
import { selectionActionSchema, type SelectionAction } from './schemas';
import { scopedReadingSnapshot } from '../../ai-reading-tools/src/index';
import { retainedValueBytes } from '../../persistence/src/retained-value';
export { selectionActionSchema, type SelectionAction } from './schemas';

export type Annotation = { id: string; documentId: string; sourceRevision: number; sourceUri?: string; selection: ReadingSnapshot['context']['selection']; kind: 'note' | 'highlight'; text: string; createdAt: string };
const labels: Record<SelectionAction['action'],string> = { copy:'复制选区',citation:'复制引用',extract:'保存为 Markdown 摘录',note:'添加批注',highlight:'高亮选区',underline:'下划线',strike:'删除线',bold:'加粗选区',italic:'斜体选区',code:'行内代码',replace:'替换选中文字',heading:'设为二级标题', 'align-left':'段落左对齐','align-center':'段落居中','center-object':'对象水平居中',translate:'翻译选区',ask:'询问 AI' };
export function actionsFor(snapshot: ReadingSnapshot | SelectionContext, ai: boolean) {
  const {document:d,context:{selection:s,nativeOffice:native}}=snapshot, l=s.locator;
  if(s.kind==='none')return [];
  const actions: SelectionAction['action'][]=['copy','citation','extract','note'];
  if(s.text && ai) actions.push('translate','ask');
  if(d.nativeOffice) {
    actions.push('highlight');
    if(native && Number.isInteger(native.selectionEpoch)) for(const action of ['bold','italic','underline','strike','align-left','align-center','replace'] as const) {
      if(!native.selectionActions?.includes(action)) continue;
      if(action==='replace' && s.kind==='cells' && (!native.sheetName || !/^[A-Z]+[1-9]\d*$/.test(native.range??''))) continue;
      actions.push(action);
    }
    return actions.map(id=>({id,label:labels[id],input:['note','replace','ask'].includes(id)}));
  }
  if(d.format==='pdf') { if(s.pageRects?.length) actions.push('highlight','underline','strike'); }
  else actions.push('highlight');
  if(['markdown','html'].includes(d.format) && s.text) actions.push('bold','italic','strike','code','replace');
  if(d.format==='docx' && l?.blockId) actions.push('bold','italic','underline','strike','replace','heading','align-left','align-center');
  if(d.format==='pptx' && l?.shapeId && l.slideId) actions.push('bold','italic','underline','strike','replace','center-object');
  if(d.format==='xlsx' && l?.cell && l.sheetId) actions.push('bold','italic','underline','strike','align-left','align-center','replace');
  return actions.map(id=>({id,label:labels[id],input:['note','replace','ask'].includes(id)}));
}
const queues=new WeakMap<ViewerCore,Map<string,Promise<unknown>>>();
const selectionPayload=(args:SelectionAction)=>'sha256:'+createHash('sha256').update('selection:'+JSON.stringify({...args,idempotencyKey:undefined})).digest('hex');
export async function selectionAction(core:ViewerCore,input:unknown,actor:Actor) {
  const args=selectionActionSchema.parse(input);
  if(!!args.snapshotId===!!args.selectionContextId)throw new ViewerError('INVALID_ARGUMENT','请指定一个完整快照或轻量选区上下文。');
  const payload=selectionPayload(args),cached=core.receipts.get(args.idempotencyKey);
  if(cached){if(cached.payload!==payload)throw new ViewerError('IDEMPOTENCY_CONFLICT','同一幂等键不能执行不同选区操作。');if(core.lastPersistenceError)await core.persist();return structuredClone(cached.receipt);}
  const source=args.selectionContextId?core.readSelectionContext(args.selectionContextId):core.readSnapshot(args.snapshotId!);
  let documentQueues=queues.get(core);if(!documentQueues){documentQueues=new Map();queues.set(core,documentQueues);}
  const queueKey=source.document.id, previous=documentQueues.get(queueKey)??Promise.resolve();
  const pending=previous.catch(()=>{}).then(async()=>{
    const payload=selectionPayload(args), cached=core.receipts.get(args.idempotencyKey);
    if(cached){if(cached.payload!==payload)throw new ViewerError('IDEMPOTENCY_CONFLICT','同一幂等键不能执行不同选区操作。');if(core.lastPersistenceError)await core.persist();return structuredClone(cached.receipt);}
    const snapshot=source, d=core.getDocument(snapshot.document.id).info,s=snapshot.context.selection,l=s.locator;
    const frozenTextRead=!!args.selectionContextId&&!snapshot.document.nativeOffice&&['copy','citation','translate','ask'].includes(args.action);
    if(args.selectionContextId&&!snapshot.document.nativeOffice&&!frozenTextRead)core.validateTextSelectionContext(snapshot as SelectionContext);
    if(actor==='agent' && ['paused','stopped'].includes(core.agentControl.get(d.id)??core.agentControl.get(snapshot.context.viewId)??''))throw new ViewerError('AGENT_PAUSED','当前页面的 Agent 已暂停。');
    if(!actionsFor(snapshot,!!core.extensions.get('selection-ai')).some(a=>a.id===args.action))throw new ViewerError('CAPABILITY_UNSUPPORTED','此选区不支持该工具。');
    const location=l?.pageIndex!==undefined?'第 '+(l.pageIndex+1)+' 页':l?.cell??l?.blockId??l?.slideId??'';
    const citation=`> ${s.text.replace(/\n/g,'\n> ')}\n\n— ${snapshot.document.title}${location?' · '+location:''} ([返回原文](agentviewer://document/${d.id}?quote=${encodeURIComponent(s.text.slice(0,500))}))`;
    return core.withReceiptCapacity(args.idempotencyKey,d.id,{payload},retainedValueBytes({selection:s,citation,value:args.value,context:snapshot.context})*2+16384,async()=>{
    let result:unknown;
    if(args.action==='copy'||args.action==='citation')result={text:args.action==='copy'?s.text:citation};
    else {
      if(!args.selectionContextId&&d.revision!==snapshot.document.revision)throw new ViewerError('VERSION_CONFLICT','选区所属内容已变化，请重新选择。');
      if(args.selectionContextId&&snapshot.document.nativeOffice){const native=snapshot.context.nativeOffice,current=await core.nativeOfficeState(snapshot.context.viewId);if(!native||current.documentId!==d.id||current.sessionId!==native.sessionId||current.engineEpoch!==native.engineEpoch||current.engineRevision!==native.engineRevision||current.selectionEpoch!==native.selectionEpoch)throw new ViewerError('STALE_SELECTION','原生选区已变化，请重新选择。');}
      if(d.format==='web') { const current=await core.context(snapshot.context.viewId);if(current.viewport?.navigationId!==snapshot.context.viewport?.navigationId || current.viewport?.layoutRevision!==snapshot.context.viewport?.layoutRevision)throw new ViewerError('STALE_NAVIGATION','网页已导航或重新排版，请重新选择。'); }
      if(args.action==='extract') { const view=await core.openBytes(snapshot.document.title.replace(/\.[^.]+$/,'')+' · 摘录.md',new TextEncoder().encode(citation),'markdown',undefined,core.getView(snapshot.context.viewId).windowId);result={view}; }
      else if(args.action==='note'||args.action==='highlight'&&(!!snapshot.document.nativeOffice||!['pdf','xlsx'].includes(d.format))) {
        if(args.action==='note'&&!args.value?.trim())throw new ViewerError('INVALID_ARGUMENT','请填写批注内容。');
        const annotation:Annotation={id:crypto.randomUUID(),documentId:d.id,sourceRevision:d.revision,sourceUri:d.model.url,selection:structuredClone(s),kind:args.action==='note'?'note':'highlight',text:args.value??'',createdAt:new Date().toISOString()};core.annotations.set(annotation.id,annotation);core.event('annotation.added',{annotationId:annotation.id,documentId:d.id,actor}); if(d.format==='web') await core.extensions.get('annotation-display')?.({viewId:snapshot.context.viewId,annotation},actor); result={annotation};
      } else if(args.action==='translate'||args.action==='ask') {
        // Selection AI consumes only its bounded, immutable selected text. A
        // sourceScope receipt never claims to freeze a complete document.
        const sourceRevision=snapshot.document.nativeOffice?d.revision:snapshot.document.revision;
        const frozenSource=args.selectionContextId?scopedReadingSnapshot({id:snapshot.id,schemaVersion:'1.0',createdAt:snapshot.createdAt,context:{...snapshot.context,contentRevision:sourceRevision},document:{...snapshot.document,revision:sourceRevision,model:{format:snapshot.document.format}}},'selection'):undefined;
        result=await core.extensions.get('selection-ai')!({...args,snapshot:frozenSource??snapshot,...(frozenSource?{frozenSource}:{})},actor);
      }
      else if(snapshot.document.nativeOffice) {
        const native=snapshot.context.nativeOffice;
        if(!native || native.selectionEpoch===undefined)throw new ViewerError('CAPABILITY_UNSUPPORTED','选区缺少原生版本身份，请重新选择。');
        const current=await core.nativeOfficeState(snapshot.context.viewId);
        if(current.sessionId!==native.sessionId)throw new ViewerError('NATIVE_SESSION_EXPIRED','原生选区来源已重新打开。');
        const input={viewId:snapshot.context.viewId,expectedEngineEpoch:native.engineEpoch,expectedEngineRevision:native.engineRevision,expectedSelectionEpoch:native.selectionEpoch,idempotencyKey:args.idempotencyKey+':native-edit',...(actor==='human'?{completion:'applied' as const}:{})};
        if(args.action==='replace') result=await core.executeNativeOffice({...input,...(s.kind==='cells'?{cell:{sheetName:native.sheetName!,address:native.range!,content:args.value??''}}:{replacement:{expectedText:s.text,text:args.value??''}})},actor);
        else {
          const command=({bold:'.uno:Bold',italic:'.uno:Italic',underline:'.uno:Underline',strike:'.uno:Strikeout','align-left':'.uno:LeftPara','align-center':'.uno:CenterPara'} as Record<string,string>)[args.action];
          if(!command)throw new ViewerError('CAPABILITY_UNSUPPORTED','此选区工具尚无原生引擎映射。');
          result=await core.executeNativeOffice({...input,command},actor);
        }
      }
      else { const local:ReadingSnapshot=args.selectionContextId?{id:snapshot.id,schemaVersion:'1.0',createdAt:snapshot.createdAt,context:snapshot.context,document:d}:snapshot as ReadingSnapshot;const operation=operationFor(local,args);const patch=core.prepare(d.id,d.revision,operation,{viewId:snapshot.context.viewId});result={receipt:await core.commit(patch.id,args.idempotencyKey+':edit',actor)}; }
    }
    core.receipts.set(args.idempotencyKey,{payload,receipt:result});await core.persist();return result;
    });
  });documentQueues.set(queueKey,pending);void pending.finally(()=>{if(documentQueues.get(queueKey)===pending)documentQueues.delete(queueKey);}).catch(()=>{});return pending;
}
function operationFor(snapshot:ReadingSnapshot,args:SelectionAction):EditOperation {
  const d=snapshot.document,s=snapshot.context.selection,l=s.locator!,action=args.action;
  if(d.format==='pdf')return {kind:'pdf.markup',style:action as 'highlight'|'underline'|'strike',rects:s.pageRects!};
  if(d.format==='xlsx'){
    if(action==='highlight')return {kind:'sheets.setCellFormat',sheetId:l.sheetId!,address:l.cell!,fill:'FFE48A'};
    const cell=d.model.sheets?.find(s=>s.id===l.sheetId)?.rows.flat().find(c=>c.address===l.cell);
    if(action==='replace')return {kind:'sheets.setCell',sheetId:l.sheetId!,address:l.cell!,value:args.value??''};
    return {kind:'sheets.setCellFormat',sheetId:l.sheetId!,address:l.cell!,...(action==='bold'?{bold:!cell?.bold}:action==='italic'?{italic:!cell?.italic}:action==='underline'?{underline:!cell?.underline}:action==='strike'?{strike:!cell?.strike}:{horizontal:action==='align-left'?'left':'center'})};
  }
  if(d.format==='docx'||d.format==='pptx'){
    const block=d.format==='docx'?d.model.blocks?.find(b=>b.id===l.blockId):d.model.slides?.find(s=>s.id===l.slideId)?.blocks.find(b=>b.id===l.shapeId);
    if(!block)throw new ViewerError('INVALID_TARGET','文字对象不存在。');
    if(action==='heading')return {kind:'word.setParagraphFormat',blockId:block.id,style:'Heading2'};
    if(action==='align-left'||action==='align-center')return {kind:'word.setParagraphFormat',blockId:block.id,alignment:action==='align-left'?'left':'center'};
    if(action==='center-object')return {kind:'slides.setShapeBounds',slideId:l.slideId!,shapeId:block.id,x:(1-(block.width??.8))/2,y:block.y??.1,width:block.width??.8,height:block.height??.1};
    const from=l.from??uniqueOffset(block.text,s.text),to=l.to??from+s.text.length;
    if(block.text.slice(from,to)!==s.text)throw new ViewerError('INVALID_TARGET','选中文字已变化。');
    if(action==='replace'){const text=block.text.slice(0,from)+(args.value??'')+block.text.slice(to);return d.format==='docx'?{kind:'word.setBlock',blockId:block.id,text}:{kind:'slides.setText',slideId:l.slideId!,shapeId:block.id,text};}
    return {kind:'office.formatText',blockId:block.id,slideId:l.slideId,from,to,expectedText:s.text,style:action as 'bold'|'italic'|'underline'|'strike',enabled:true};
  }
  const text=d.model.text??'',from=l?.from??uniqueOffset(text,s.text),to=l?.to??from+s.text.length;
  if(text.slice(from,to)!==s.text)throw new ViewerError('INVALID_TARGET','无法安全匹配选区源码，请在源码模式选择。');
  if(d.format==='html'){
    let safe=false;const visit=(node:any)=>{if(node.nodeName==='#text'&&node.sourceCodeLocation&&from>=node.sourceCodeLocation.startOffset&&to<=node.sourceCodeLocation.endOffset)safe=true;for(const child of node.childNodes??[])visit(child);};visit(parse(text,{sourceCodeLocationInfo:true}));
    if(!safe)throw new ViewerError('INVALID_TARGET','请只选择同一文字节点，避免改写 HTML 标签或属性。');
  }
  const tag=({bold:'strong',italic:'em',strike:'s',code:'code'} as Record<string,string>)[action],wrap=({bold:'**',italic:'*',strike:'~~',code:'`'} as Record<string,string>)[action];
  const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const result=action==='replace'?(d.format==='html'?escape(args.value??''):args.value??''):d.format==='html'?`<${tag}>${s.text}</${tag}>`:wrap+s.text+wrap;
  return {kind:'text.replace',from,to,expectedText:s.text,text:result};
}
function uniqueOffset(text:string,selection:string){const from=selection?text.indexOf(selection):-1;if(from<0||text.indexOf(selection,from+1)>=0)throw new ViewerError('AMBIGUOUS_SELECTION','选区无法唯一对应源码，请在源码模式选择具体范围。');return from;}
