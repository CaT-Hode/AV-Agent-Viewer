import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nativeOfficeStyleSource } from '../packages/office-runtime/src/native-style-source';
import { nativeOfficeWorkerSource } from '../packages/office-runtime/src/worker-source';
import { officeKitWorkerSource } from '../packages/office-runtime/src/kit-worker-source';

const program = join(process.cwd(), 'release/win-unpacked/resources/engines/libreoffice/program');
const pythonCore = existsSync(program) ? readdirSync(program).find(name => /^python-core-\d/.test(name)) : undefined;
const python = pythonCore ? join(program, pythonCore, 'bin/python.exe') : 'python';
const fixture = String.raw`
import ast,copy,hashlib,json,math,re,uuid,queue,threading
from types import SimpleNamespace as NS
source=json.loads(input())
def fail(code,message):raise RuntimeError(code+'|'+message)
constant=lambda name,fallback:fallback
class AnyValue:
    def __init__(self,type,value):self.type=type;self.value=value
uno=NS(getTypeByName=lambda name:name,Any=lambda type,value:AnyValue(type,value),Enum=lambda type,value:NS(typeName=type,value=value),createUnoStruct=lambda name:NS())
unohelper=NS(Base=type('UnoBase',(),{}));XUndoAction=type('XUndoAction',(),{})
exec(source['style'],globals())
for module,names in [(source['shared'],{'execute_operation','selection'}),(source['kit'],{'KitRequestQueue','execute_request','native_input_pending','native_input_state','native_history_signature','live_text_history_fingerprint','reconcile_history_revision','request_receipt','remember_request_receipt','refresh_surface_geometry','kit_callback'})]:
    tree=ast.parse(module);compile(tree,'complete-worker','exec')
    selected=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in names]
    assert len(selected)==len(names);exec(compile(ast.Module(body=selected,type_ignores=[]),'actual-native-style-producer','exec'))
class Complex:
    def __init__(self,theme=4,rgb=0x4472c4,transforms=(('Tint',1700),('LumMod',7000))):self.theme=theme;self.rgb=rgb;self.transforms=transforms
    def getType(self):return 1 if self.theme<0 else 4
    def getThemeColorType(self):return self.theme
    def resolveColor(self,theme):return self.rgb
def property_type(name,value):
    if name in STYLE_COMPLEX_COLORS:return 'com.sun.star.util.XComplexColor'
    if name=='InteropGrabBag':return '[]com.sun.star.beans.PropertyValue'
    if name.startswith('CharPosture'):return 'com.sun.star.awt.FontSlant'
    if name in ['FillStyle','LineStyle']:return 'com.sun.star.drawing.'+name
    if name.startswith('CharFont'):return 'string'
    if type(value) is str:return 'string'
    if type(value) is bool:return 'boolean'
    if type(value) is float:return 'float'
    return 'short' if name in ['ParaAdjust','FillColorTheme','CharColorTheme'] else 'long'
def unbox(value):return value.value if isinstance(value,AnyValue) else value
class Target:
    def __init__(self,properties):
        self.values=copy.deepcopy(properties);self.defaults=copy.deepcopy(properties);self.states={};self.readonly=set();self.writes=[];self.failOnce=None
        self.position=NS(X=100,Y=200);self.size=NS(Width=4000,Height=3000)
    def getPropertySetInfo(self):return NS(getProperties=lambda:[NS(Name=name,Attributes=16 if name in self.readonly else 0,Type=NS(typeName=property_type(name,value))) for name,value in self.values.items()])
    def getPropertyValues(self,names):return tuple(self.getPropertyValue(name) for name in names)
    def getPropertyStates(self,names):return tuple(self.getPropertyState(name) for name in names)
    def getPropertyValue(self,name):return self.values[name]
    def getPropertyState(self,name):return self.states.get(name,'DIRECT_VALUE')
    def setPropertyValue(self,name,value):
        if name==self.failOnce:self.failOnce=None;raise ValueError('actual later field rejected')
        if self is shape:manager.record_shape_native()
        self.values[name]=unbox(value);self.states[name]='DIRECT_VALUE';self.writes.append(name)
        if name in STYLE_COMPLEX_COLORS:
            actual=unbox(value) or Complex(-1,0,());self.values[name]=actual
            color=STYLE_COMPLEX_COLORS[name]
            theme=color+'Theme'
            if theme in self.values:self.values[theme]=actual.theme
        for color,dependencies in STYLE_COLOR_DEPENDENCIES.items():
            if name in [color,*dependencies]:
                for field in [color,*dependencies]:
                    if field in self.values:self.states[field]='DIRECT_VALUE'
        session['engineRevision']+=1
    def setPropertyToDefault(self,name):
        for field in [name,*STYLE_COLOR_DEPENDENCIES.get(name,())]:
            if field in self.defaults:self.values[field]=copy.deepcopy(self.defaults[field]);self.states[field]='DEFAULT_VALUE'
        session['engineRevision']+=1
    def getPosition(self):return self.position
    def getSize(self):return self.size
    def snapshot(self):return copy.deepcopy((self.values,self.states,self.position,self.size))
    def restore_snapshot(self,snapshot):self.values,self.states,self.position,self.size=copy.deepcopy(snapshot)
    def getStart(self):return self
    def getEnd(self):return self
class Run(Target):
    def __init__(self,text,color,font,theme):
        super().__init__({'CharColor':color,'CharComplexColor':Complex(theme,color),'CharColorTheme':theme,'CharColorLumMod':7000,'CharColorLumOff':0,'CharColorTintOrShade':1700,'CharFontName':font,'CharFontNameAsian':font+' Asian','CharFontNameComplex':font+' Complex','CharHeight':12.,'CharHeightAsian':13.,'CharHeightComplex':14.,'CharWeight':100.,'CharWeightAsian':100.,'CharWeightComplex':100.,'CharPosture':NS(value='NONE'),'CharPostureAsian':NS(value='NONE'),'CharPostureComplex':NS(value='NONE'),'CharUnderline':0,'CharStrikeout':0,'CharBackColor':-1,'CharBackTransparent':True})
        self.text=text;self.portionType='Text'
    def getString(self):return self.text
class Enumeration:
    def __init__(self,values):self.values=iter(values);self.next=None;self.available=False
    def hasMoreElements(self):
        if not self.available:
            try:self.next=next(self.values);self.available=True
            except StopIteration:return False
        return True
    def nextElement(self):assert self.hasMoreElements();self.available=False;return self.next
class Portion:
    def __init__(self,run):self.run=run
    def getString(self):return self.run.text
    def getStart(self):return self.run
    def getEnd(self):return self.run
    def getPropertyValue(self,name):assert name=='TextPortionType';return self.run.portionType
class Paragraph(Target):
    def __init__(self,runs):super().__init__({'ParaAdjust':0,'WritingMode':0,'CharBackTransparent':True});self.runs=runs;self.states['CharBackTransparent']='AMBIGUOUS_VALUE'
    def getString(self):return ''.join(run.text for run in self.runs)
    def createEnumeration(self):return Enumeration(Portion(run) for run in self.runs)
class Cursor:
    def __init__(self,target):self.target=target
    def __getattr__(self,name):return getattr(self.target,name)
    def gotoRange(self,end,expand):assert end is self.target and expand
    def gotoStart(self,expand):assert not expand
    def gotoEnd(self,expand):assert expand
class Text:
    def __init__(self,paragraphs):self.paragraphs=paragraphs
    def getString(self):return '\n'.join(paragraph.getString() for paragraph in self.paragraphs)
    def createEnumeration(self):return Enumeration(self.paragraphs)
    def createTextCursorByRange(self,start):return Cursor(start)
    def createTextCursor(self):return Cursor(empty)
class Shape(Target):
    def __init__(self,text):
        bag=(NS(Name='SpPrSolidFillSchemeClr',Value='accent1'),NS(Name='OriginalSolidFillClr',Value=0x4472c4),NS(Name='SpPrLnSolidFillSchemeClr',Value='accent2'),NS(Name='keep',Value='retained'))
        super().__init__({'ZOrder':1,'FillColor':0x4472c4,'FillStyle':NS(value='SOLID'),'FillColorTheme':4,'FillComplexColor':Complex(),'LineColor':0x123456,'LineStyle':NS(value='NONE'),'LineWidth':0,'LineComplexColor':Complex(5,0x123456),'RotateAngle':0,'InteropGrabBag':bag})
        self.text=text
    def supportsService(self,name):return False
    def getText(self):return self.text
class Window:
    def __init__(self):self.enabled=True;self.calls=[]
    def isEnabled(self):return self.enabled
    def setEnable(self,value):self.enabled=value;self.calls.append(value)
class Action:
    def __init__(self,title,undo,redo):self.title=title;self.undo=undo;self.redo=redo
    def getTitle(self):return self.title
class Manager:
    def __init__(self):self.history=[Action('previous',lambda:None,lambda:None)];self.redo=[];self.context=None;self.actions=[];self.performing=False;self.native_shape_before=None;self.contextCount=0
    def isLocked(self):return False
    def getAllUndoActionTitles(self):return tuple(action.getTitle() for action in self.history)
    def getAllRedoActionTitles(self):return tuple(action.getTitle() for action in self.redo)
    def enterUndoContext(self,label):
        assert self.context is None,'typed shape-style must own one transaction, not a nested outer context'
        self.context=label;self.actions=[];self.native_shape_before=None;self.contextCount+=1
    def record_shape_native(self):
        if self.context is not None and not self.performing and self.native_shape_before is None:self.native_shape_before=shape.snapshot()
    def addUndoAction(self,action):assert self.context is not None;self.actions.append(action)
    def leaveUndoContext(self):
        assert self.context is not None
        actions=self.actions[:]
        if self.native_shape_before is not None:
            before=self.native_shape_before;after=shape.snapshot()
            actions.insert(0,Action('native shape subset',lambda:shape.restore_snapshot(before),lambda:shape.restore_snapshot(after)))
        label=self.context;self.context=None;self.actions=[]
        if actions:
            self.history.insert(0,Action(label,lambda:[action.undo() for action in reversed(actions)],lambda:[action.redo() for action in actions]));self.redo=[]
    def undo(self):
        action=self.history.pop(0);self.performing=True
        try:action.undo()
        finally:self.performing=False
        self.redo.insert(0,action)
    def redo_action(self):
        action=self.redo.pop(0);self.performing=True
        try:action.redo()
        finally:self.performing=False
        self.history.insert(0,action)
    def clearRedo(self):self.redo=[]
def setup(empty_text=False):
    global run1,run2,paragraph,text,shape,page,session,view,manager,window,empty,reads,events
    run1=Run('中文😀',0x4472c4,'First',4);run2=Run(' second',0x998877,'Second',7)
    run1.states['CharFontName']='DEFAULT_VALUE'
    for field in ['CharColor',*STYLE_COLOR_DEPENDENCIES['CharColor']]:run1.states[field]='DEFAULT_VALUE'
    empty=Run('',0x112233,'Empty',-1)
    empty.values.update(ParaAdjust=0,WritingMode=0);empty.defaults=copy.deepcopy(empty.values)
    paragraph=Paragraph([] if empty_text else [run1,run2]);text=Text([] if empty_text else [paragraph]);shape=Shape(text)
    page=NS(getCount=lambda:2,getByIndex=lambda i:[object(),shape][i]);window=Window();reads=[];events=[]
    def forbidden(*args):raise AssertionError('explicit shape style cannot read or modify the user selection/current page')
    view={'viewId':'view','controller':NS(getSelection=forbidden,select=forbidden,setCurrentPage=forbidden),'frame':NS(getContainerWindow=lambda:window)}
    manager=Manager();doc=NS(getUndoManager=lambda:manager,getDrawPages=lambda:object(),setModified=lambda value:session.__setitem__('engineRevision',session['engineRevision']+1))
    session={'format':'pptx','doc':doc,'views':{'view':view},'engineRevision':4,'sessionId':'owned','requests':{},'requestSignatures':{}}
    return {'expectedEngineRevision':4,'actor':'agent','requestId':'request'}
def mapped_shape(owner,slide,identifier):assert owner is session and slide=='slide' and identifier=='shape';reads.append((slide,identifier));return page,shape
def mapped_slide(owner,slide):assert owner is session and slide=='slide';return page,0
def expected(owner,target,args):
    if args['expectedEngineRevision']!=owner['engineRevision']:fail('REVISION_CONFLICT','changed')
own_ime_pending=lambda candidate:bool(candidate.get('composition'))
def op(**values):return {'kind':'slides.setShapeStyle','slideId':'slide','shapeId':'shape',**values}
def snapshot():return [target.snapshot() for target in [shape,run1,run2,paragraph]]
def compare(actual,desired):
    for current,before in zip(actual,desired):
        assert all(style_value_key(current[0][key])==style_value_key(value) for key,value in before[0].items())
        for key,value in before[1].items():assert current[1].get(key,'DIRECT_VALUE')==value,(key,current[1].get(key,'DIRECT_VALUE'),value)
def execute(args):
    args={**args,'operation':op(color='166a71',fill='b6d8cc',lineColor='893b58')}
    task=execute_request(session,view,args,args['requestId'])
    try:
        while True:next(task)
    except StopIteration as done:return done.value
emit=lambda event:events.append(event)
invalidate=lambda *args:None
state=lambda owner,target:{'engineRevision':owner['engineRevision'],'undo':{'token':'real'}}
undo_state=lambda owner:{'token':'real'}
`;
function check(body: string) {
  assert.equal(execFileSync(python, ['-c', fixture + body + '\nprint("PASS")'], {
    input: JSON.stringify({ style: nativeOfficeStyleSource, shared: nativeOfficeWorkerSource, kit: officeKitWorkerSource }) + '\n', encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: pythonCore ? program + ';' + process.env.PATH : process.env.PATH, ...(pythonCore ? { PYTHONHOME: join(program, pythonCore) } : {}), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  }).trim(), 'PASS');
}

test('mapped shape style changes real run colors, clears theme/interop dependencies and has one complete mixed native Undo/Redo', () => {
  check(String.raw`
args=setup();before=snapshot();original1=run1.values['CharComplexColor'];original2=run2.values['CharComplexColor']
apply_mapped_shape_style(session,view,op(color='166a71',fill='b6d8cc',lineColor='893b58',lineWidth=1.5,fontName='New',fontSize=20,bold=True,italic=True,underline=True,strike=True,alignment='center',rotation=25),args)
assert manager.contextCount==1 and len(manager.history)==2 and manager.context is None and window.enabled
assert shape.values['FillColor']==0xb6d8cc and shape.values['LineColor']==0x893b58
assert shape.values['FillStyle'].value=='SOLID' and shape.values['LineStyle'].value=='SOLID'
assert shape.values['FillComplexColor'].theme==-1 and shape.values['LineComplexColor'].theme==-1
assert [value.Name for value in shape.values['InteropGrabBag']]==['keep']
for run in [run1,run2]:
    assert run.values['CharColor']==0x166a71 and run.values['CharComplexColor'].theme==-1
    for suffix in ['', 'Asian','Complex']:
        assert run.values['CharFontName'+suffix]=='New' and run.values['CharHeight'+suffix]==20 and run.values['CharWeight'+suffix]==150.
    assert run.values['CharPosture'].value=='ITALIC' and run.values['CharUnderline']==1 and run.values['CharStrikeout']==1
assert paragraph.values['ParaAdjust']==3 and shape.values['RotateAngle']==2500
after=snapshot();manager.undo();compare(snapshot(),before)
assert run1.values['CharComplexColor'].theme==4 and run2.values['CharComplexColor'].theme==7
assert run1.values['CharComplexColor'].transforms==original1.transforms and run2.values['CharComplexColor'].transforms==original2.transforms
assert run1.states['CharFontName']=='DEFAULT_VALUE' and run1.states['CharColor']=='DEFAULT_VALUE'
manager.redo_action();compare(snapshot(),after)
assert text.getString()=='中文😀 second' and len(manager.history)==2
`);
});

test('all requested shape and run fields are preflighted before any write and mixed unsupported fields are not flattened', () => {
  check(String.raw`
for issue in ['readonly','mixed','field']:
    args=setup()
    if issue=='readonly':run2.readonly.add('CharComplexColor')
    elif issue=='mixed':run2.states['CharColor']='AMBIGUOUS_VALUE'
    else:run2.portionType='TextField'
    try:apply_mapped_shape_style(session,view,op(fill='b6d8cc',color='166a71'),args)
    except RuntimeError as error:assert str(error).startswith(('NATIVE_STYLE_FIELD_UNSUPPORTED|','NATIVE_STYLE_TARGET_UNAVAILABLE|'))
    else:raise AssertionError('unrestorable text field was mutated')
    assert not shape.writes and not run1.writes and not run2.writes and not window.calls and manager.contextCount==0
args=setup();run2.portionType='TextField'
apply_mapped_shape_style(session,view,op(fill='b6d8cc',alignment='center'),args)
assert shape.values['FillColor']==0xb6d8cc and paragraph.values['ParaAdjust']==3 and not run1.writes and not run2.writes
`);
});

test('a later run setter failure rolls back shape plus every run/default/theme without deleting earlier native history', () => {
  check(String.raw`
args=setup();before=snapshot();run2.failOnce='CharColor'
try:apply_mapped_shape_style(session,view,op(fill='b6d8cc',lineColor='893b58',color='166a71'),args)
except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_APPLY_FAILED|')
else:raise AssertionError('partial shape/text operation reported success')
compare(snapshot(),before)
assert manager.getAllUndoActionTitles()==('previous',) and not manager.redo and window.enabled and manager.context is None
`);
});

test('explicit target styles preserve a different user selection and support an actual empty text cursor', () => {
  check(String.raw`
args=setup(empty_text=True)
apply_mapped_shape_style(session,view,op(color='166a71',fontSize=24,alignment='right',fill='b6d8cc'),args)
assert empty.values['CharColor']==0x166a71 and empty.values['CharHeight']==24 and text.getString()==''
assert manager.contextCount==1 and window.enabled
args=setup();view.update(nativeEditing=True,caretVisible=True);posted=[]
post_input_event=lambda *args:None
selected_text_range=lambda owner,target:run1
ppt_text_transaction_target=lambda owner,target,actual:{'shape':shape,'positions':[0,0,0,4],'fullText':text.getString()}
style_targets=lambda owner,target,kind:[run1] if kind=='text' else [paragraph]
command_status=lambda target,command:{'enabled':True}
for name in STYLE_SCRIPT_PROPERTIES['bold']:run1.states[name]='AMBIGUOUS_VALUE'
mixed=inspect_native_style(session,view,'text')['fields']['bold']
assert mixed['available'] and mixed['state']=='mixed' and mixed['value'] is None
def dispatch_live(frame,command,target,flags,values):
    posted.append((command,dict(values)));assert command=='.uno:Bold' and values['Bold'] is True,'the requested uniform value must be explicit, never a toggle'
    for name in STYLE_SCRIPT_PROPERTIES['bold']:run1.values[name]=150.;run1.states[name]='DIRECT_VALUE'
dispatcher=NS(executeDispatch=dispatch_live);props=lambda values:values;native_event_fence=lambda:None
result=apply_live_native_text_style(session,view,{'target':'text','values':{'bold':True}},args)
assert result=={'status':'applied','historyScope':'text'} and len(posted)==1
assert inspect_native_style(session,view,'text')['fields']['bold']['value'] is True
assert apply_live_native_text_style(session,view,{'target':'text','values':{'bold':True}},{**args,'expectedEngineRevision':session['engineRevision']})['status']=='no-change' and len(posted)==1
unsupported=inspect_native_style(session,view,'paragraph')['fields']['left']
assert not unsupported['available'] and unsupported['state']=='unsupported' and '段落' in unsupported['reason']
`);
});

test('typed shape-style dispatch owns its sole context and retries return the existing receipt', () => {
  check(String.raw`
args=setup();first=execute(args);second=execute(args)
assert first==second and first['status']=='applied' and manager.contextCount==1 and len(manager.history)==2 and session['operationActor'] is None
assert window.enabled
args=setup();view['nativeEditing']=True;view['caretVisible']=True
assert native_input_pending(session,view) and native_input_state(session,view)=={'composing':False,'inFlight':False,'editing':'text','modal':False}
view['composition']={'id':'ime'}
try:execute(args)
except RuntimeError as error:assert str(error).startswith('NATIVE_PENDING_INPUT|')
else:raise AssertionError('composition was overwritten by an Office command')
assert not shape.writes and not run1.writes and manager.contextCount==0
args=setup();view.update(nativeEditing=True,caretVisible=True)
view['controller']=NS(getSelection=lambda:NS(getCount=lambda:1,getByIndex=lambda index:shape),getCurrentPage=lambda:page)
session['doc'].getDrawPages=lambda:NS(getCount=lambda:1,getByIndex=lambda index:page)
assert selection(session,view)=={'kind':'none','text':'','slideIndex':0},'an active Outliner caret must not expose the marked shape as selected text or objects'
view.update(nativeEditing=False,caretVisible=False)
assert selection(session,view)['kind']=='objects','a real object selection remains available outside text editing'
view.update(nativeEditing=True,caretVisible=True)
selected_text_range=lambda owner,target:NS(getString=lambda:'nested text')
def ppt_text_transaction_target(*args):raise RuntimeError('grouped target cannot be bound for a top-level style mutation')
command_status=lambda target,command:{'enabled':True}
fingerprint=live_text_history_fingerprint(session,view,{'kind':'key','phase':'down','key':'z','modifiers':{'control':True}})
assert ['unbound-text','nested text'] in json.loads(fingerprint),'an observation failure must not prevent native grouped-text Undo'
args=setup();I=int;CALLBACK=lambda callback:callback;callback_refs=[];native_reads=[];invalidations=[]
actual={'size':{'width':19200,'height':10800},'count':2,'part':0,'rects':[{'x':0,'y':0,'width':19200,'height':10800}]}
pages=[NS(Name='first',Width=33867,Height=19050),NS(Name='second',Width=33867,Height=19050)]
session['doc'].getDrawPages=lambda:NS(getCount=lambda:len(pages),getByIndex=lambda index:pages[index])
activate=lambda *args:None
kit_size=lambda owner:dict(actual['size'])
page_rectangles=lambda owner:list(actual['rects'])
def doc_call(owner,method,*args):
    native_reads.append(method);return lambda:actual['part' if method=='getPart' else 'count']
invalidate=lambda owner,target,*args:invalidations.append(target['viewId'])
view.update(partIndex=0,layoutRevision=7,eventSequence=0)
assert not refresh_surface_geometry(session,view)
native_reads.clear();callback=kit_callback(session,view)
for _ in range(20):callback(13,b'19200, 10800',None)
callback(14,b'1',None);callback(14,b'0',None)
assert native_reads==[],'callback handling must not re-enter native code'
assert not refresh_surface_geometry(session,view) and view['layoutRevision']==7 and invalidations==[] and session.get('partGeometryGeneration',0)==0,'repeated size and temporary export part callbacks cannot retire real viewport coordinates'
actual['part']=1;callback(14,b'1',None)
assert refresh_surface_geometry(session,view) and view['partIndex']==1 and view['layoutRevision']==8 and len(invalidations)==1
actual['size']['width']=20000;pages[1].Width=35278;callback(13,b'',None)
assert refresh_surface_geometry(session,view) and view['layoutRevision']==9 and session['partGeometryGeneration']==1,'a real native paper/slide resize must retire coordinates'
pages.append(NS(Name='third',Width=33867,Height=19050));actual['count']=3;callback(13,b'20000, 10800',None)
assert refresh_surface_geometry(session,view) and session['partGeometryGeneration']==2,'adding a same-size part cannot be hidden by size payload equality'
pages.pop();actual['count']=2;callback(13,b'',None)
assert refresh_surface_geometry(session,view) and session['partGeometryGeneration']==3,'deleting a same-size part remains visible'
session['format']='docx';view.pop('nativeGeometrySignature');assert not refresh_surface_geometry(session,view)
actual['rects']=[{'x':0,'y':0,'width':20000,'height':12000}];callback(13,b'',None)
assert refresh_surface_geometry(session,view) and session['partGeometryGeneration']==4,'Writer physical page rectangles participate in the real geometry receipt'
jobs=KitRequestQueue();job=lambda id,method,args={}:{'id':id,'method':method,'args':args}
jobs.put(job('read1','inspect',{'target':{'kind':'style','target':'text'}}));jobs.put(job('read2','inspect',{'target':{'kind':'style','target':'text'}}));jobs.put(job('input1','surfaceInput'));jobs.put(job('state','state'));jobs.put(job('input2','execute'));jobs.put(job('save','snapshot'));jobs.put(job('input3','surfaceInput'))
assert jobs.get_nowait()['id']=='input1' and jobs.get_nowait()['id']=='input2'
merged=jobs.get_nowait();assert merged['id']=='read1' and [item['id'] for item in merged['_followers']]==['read2']
assert [jobs.get_nowait()['id'] for _ in range(3)]==['state','save','input3'] and jobs.empty() and jobs.pending==0
jobs=KitRequestQueue();jobs.put(job('before','state'));jobs.put(job('write','execute'));jobs.put(job('after','state'))
assert [jobs.get_nowait()['id'] for _ in range(3)]==['write','before','after'],'observations separated by a write retain independent receipts'
`);
});
