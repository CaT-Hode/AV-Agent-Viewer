import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeOfficeState } from '../packages/contracts/src/native-office';
import { createNativeOfficeToolController, nativeOfficeCommandAvailability, nativeOfficeToolCandidates, type NativeOfficeRequest } from '../apps/desktop/src/renderer/lib/native-office-tools';
import { nativeStyleControls, nativeStyleReplacedCommands, nativeStyleTargets, parseNativeStyleValues } from '../apps/desktop/src/renderer/lib/native-office-style';

const initial = (): NativeOfficeState => ({ documentId:'doc',viewId:'view',sessionId:'session',format:'docx',status:'ready',engineEpoch:'epoch',engineRevision:4,selectionEpoch:6,dirty:false,selection:{kind:'text',text:'实际目标'} });
const deferred = <T>() => { let resolve!: (value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve}; };

test('application property controls belong to the selected format and category, with explicit physical units', () => {
  assert.deepEqual(nativeStyleTargets('docx','home'),['text','paragraph']);
  assert.deepEqual(nativeStyleTargets('docx','layout'),['paragraph']);
  assert.deepEqual(nativeStyleTargets('xlsx','home'),['cells']);
  assert.deepEqual(nativeStyleTargets('pptx','home'),['text']);
  assert.deepEqual(nativeStyleTargets('pptx','arrange'),['shape']);
  for(const format of ['docx','xlsx','pptx'] as const)assert.deepEqual(nativeStyleTargets(format,'insert'),[]);
  assert.equal(nativeStyleControls('text').find(control=>control.name==='fontSize')?.unit,'pt');
  assert.equal(nativeStyleControls('paragraph').find(control=>control.name==='firstLine')?.unit,'mm');
  assert.equal(nativeStyleControls('shape').find(control=>control.name==='lineWidth')?.unit,'pt');
  assert.equal(nativeStyleControls('shape').find(control=>control.name==='rotation')?.unit,'°');
});

test('changed-only values use shared native schema and preserve strings, booleans, colours and numeric units', () => {
  assert.deepEqual(parseNativeStyleValues('text',{fontSize:'12.5',bold:false,color:'#af03ff'}),{fontSize:12.5,bold:false,color:'AF03FF'});
  assert.deepEqual(parseNativeStyleValues('paragraph',{firstLine:'-5',lineSpacingPercent:'150',alignment:'justify'}),{firstLine:-5,lineSpacingPercent:150,alignment:'justify'});
  assert.deepEqual(parseNativeStyleValues('cells',{numberFormat:'0.00%;[RED]-0.00%',verticalAlignment:'center',wrap:true}),{numberFormat:'0.00%;[RED]-0.00%',verticalAlignment:'center',wrap:true});
  assert.deepEqual(parseNativeStyleValues('shape',{x:'-2.5',width:'18',rotation:'90',fill:'00ff00'}),{x:-2.5,width:18,rotation:90,fill:'00FF00'});
});

test('automatic, mixed or unavailable properties are not inferred into a patch; invalid changed fields fail locally', () => {
  for(const [target,fields] of [
    ['text',{}],['text',{fontSize:''}],['text',{fontSize:'NaN'}],['text',{fontSize:'401'}],['text',{fontFamily:'x'.repeat(101)}],['text',{color:'automatic'}],['text',{bold:'true'}],
    ['paragraph',{left:'-1'}],['paragraph',{lineSpacingPercent:'501'}],['cells',{verticalAlignment:'middle'}],['cells',{numberFormat:'x'.repeat(121)}],['shape',{width:'0'}],['shape',{lineWidth:'31'}],['shape',{x:'10001'}],['shape',{fontSize:'12'}],
  ] as const) assert.throws(()=>parseNativeStyleValues(target,fields));
  assert.deepEqual(parseNativeStyleValues('text',{italic:true}),{italic:true},'unmodified null/mixed fields must remain absent');
});

test('normal tools obtain candidates without a full catalogue and replace only the controls covered by real inspectors', () => {
  const replaced=nativeStyleReplacedCommands(nativeStyleTargets('docx','home'));
  const candidates=nativeOfficeToolCandidates('docx','home').flatMap(group=>group.commands);
  assert.ok(candidates.some(command=>command.command==='.uno:DesignerDialog'));
  for(const command of candidates)assert.equal(nativeOfficeCommandAvailability(command,initial()).enabled,false,'candidate alone cannot enable a command');
  const visible=candidates.filter(command=>!replaced.has(command.command)).map(command=>command.command);
  for(const removed of ['Bold','Italic','Underline','Strikeout','FontDialog','ParagraphDialog','LeftPara'])assert.ok(!visible.includes('.uno:'+removed));
  assert.ok(visible.includes('.uno:SuperScript'));assert.ok(visible.includes('.uno:DesignerDialog'));
  assert.ok(nativeStyleReplacedCommands(['cells']).has('.uno:FormatCellDialog'));
  assert.ok(nativeStyleReplacedCommands(['shape']).has('.uno:TransformDialog'));
  assert.equal(nativeOfficeCommandAvailability({command:'.uno:DesignerDialog',available:false,enabled:false},initial()).reason,'当前引擎不支持此命令。');
  assert.equal(nativeOfficeCommandAvailability({command:'.uno:DesignerDialog',available:true,enabled:true,state:false},initial()).enabled,true);
});

test('typed properties freshly check selection lease then perform exactly one transaction without menu/status catalogue reads', async () => {
  let state=initial();const calls:{method:string;args?:Record<string,unknown>}[]=[];
  const request=(async(method,args)=>{calls.push({method,args});if(method==='office-status')return{...state};assert.equal(method,'office-execute');return{receipt:{status:'applied'},state:{...state,engineRevision:5,dirty:true}};}) as NativeOfficeRequest;
  const owner=createNativeOfficeToolController({documentId:'doc',viewId:'view'},{current:()=>state,request,accept:value=>{state=value;},makeKey:()=> 'style-once'});
  const source=state,result=await owner.controller.setStyle('text',{fontSize:14,bold:true},source);
  assert.equal(result.status,'applied');assert.equal(state.engineRevision,5);
  assert.deepEqual(calls,[{method:'office-status',args:{viewId:'view'}},{method:'office-execute',args:{viewId:'view',expectedEngineEpoch:'epoch',expectedEngineRevision:4,expectedSelectionEpoch:6,idempotencyKey:'style-once',style:{target:'text',values:{fontSize:14,bold:true}}}}]);
  owner.dispose();
});

test('invalid or outdated property sources cannot send a native mutation', async () => {
  for(const scenario of ['unknown-field','range','source','fresh-revision','fresh-selection','no-selection-epoch','wrong-view','pending-input','disposed'] as const){
    let state=initial(),mutations=0,reads=0;const source=state;
    const request=(async(method)=>{if(method==='office-status'){reads++;return scenario==='fresh-revision'?{...state,engineRevision:5}:scenario==='fresh-selection'?{...state,selectionEpoch:7}:scenario==='wrong-view'?{...state,viewId:'other'}:state;}mutations++;return{receipt:{status:'applied'},state};}) as NativeOfficeRequest;
    const owner=createNativeOfficeToolController({documentId:'doc',viewId:'view'},{current:()=>state,request,accept:()=>{}});
    if(scenario==='source')state={...state,selectionEpoch:7};
    if(scenario==='pending-input')state={...state,pendingInput:true};
    if(scenario==='no-selection-epoch'){state={...state,selectionEpoch:undefined};source.selectionEpoch=undefined;}
    if(scenario==='disposed')owner.dispose();
    const values=scenario==='unknown-field'?{width:1}:scenario==='range'?{fontSize:0}:{bold:true};
    await assert.rejects(owner.controller.setStyle('text',values,source));assert.equal(mutations,0);
    if(['unknown-field','range','source','pending-input','disposed'].includes(scenario))assert.equal(reads,0);
    owner.dispose();
  }
});

test('selection change while the fresh read is in flight rejects before dispatch and preserves the newer state', async () => {
  let state=initial(),mutations=0;const source=state,gate=deferred<NativeOfficeState>();
  const request=(async(method)=>{if(method==='office-status')return gate.promise;mutations++;}) as NativeOfficeRequest;
  const owner=createNativeOfficeToolController({documentId:'doc',viewId:'view'},{current:()=>state,request,accept:()=>{}});
  const pending=owner.controller.setStyle('text',{bold:true},source),rejected=assert.rejects(pending,/文档或选区已变化/);
  state={...state,selectionEpoch:7,selection:{kind:'text',text:'用户的新选区'}};gate.resolve(source);await rejected;
  assert.equal(mutations,0);assert.equal(state.selection?.text,'用户的新选区');owner.dispose();
});

test('draft preparation cannot silently rebase inspector data onto a different content revision', async () => {
  let state=initial(),mutations=0;const source=state;
  const request=(async(method)=>{if(method==='office-status')return state;mutations++;}) as NativeOfficeRequest;
  const owner=createNativeOfficeToolController({documentId:'doc',viewId:'view'},{current:()=>state,request,accept:value=>{state=value;},beforeAction:async()=>({...state,engineRevision:5})});
  await assert.rejects(owner.controller.setStyle('text',{bold:true},source),/属性来源/);assert.equal(mutations,0);assert.equal(state.engineRevision,5);owner.dispose();
});

test('one typed edit remains in flight and an unconfirmed receipt is never rewritten as applied', async () => {
  let state=initial();const gate=deferred<unknown>();let calls=0;
  const request=(async(method)=>{if(method==='office-status')return state;calls++;return gate.promise;}) as NativeOfficeRequest;
  const owner=createNativeOfficeToolController({documentId:'doc',viewId:'view'},{current:()=>state,request,accept:value=>{state=value;}});
  const pending=owner.controller.setStyle('text',{italic:true},state);await Promise.resolve();
  await assert.rejects(owner.controller.setStyle('text',{bold:true},state),/上一条/);
  gate.resolve({receipt:{status:'dispatched',warnings:['尚未确认快照']},state});const result=await pending;
  assert.equal(result.status,'dispatched');assert.deepEqual(result.warnings,['尚未确认快照']);assert.equal(calls,1);owner.dispose();
});
