import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nativeOfficeWorkerSource } from '../packages/office-runtime/src/worker-source';

const bundledPython = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'AgentViewer', 'resources', 'engines', 'libreoffice', 'program', 'python.exe');
const python = existsSync(bundledPython) ? bundledPython : 'python';
function check(functions: string[], scenario: string, prologue = '') {
  const program = `import ast, io, zipfile, pathlib, re, json, xml.etree.ElementTree as ET\nfrom types import SimpleNamespace as NS\nsource=json.loads(input())\nmodule=ast.parse(source)\ncompile(module,'office-worker.py','exec')\ndef fail(code,message):raise RuntimeError(code+'|'+message)\nfunctions=${JSON.stringify(functions)}\nselected=[node for node in module.body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in functions]\nassert len(selected)==len(functions)\n${prologue}\nexec(compile(ast.Module(body=selected,type_ignores=[]),'worker-tested-functions','exec'))\n${scenario}\nprint('PASS')`;
  assert.equal(execFileSync(python, ['-c', program], { input: JSON.stringify(nativeOfficeWorkerSource) + '\n', encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }).trim(), 'PASS');
}

test('worker parses actual URLTransformer out-parameters and generic dispatch cannot force a synchronous dialog', () => {
  check(['url', 'dispatch_command'], String.raw`
class Transformer:
    def parseStrict(self,value):return True, NS(Complete=value.Complete,Protocol='.uno:')
class Dispatch:
    def queryInterface(self,type):return None
    def dispatch(self,target,values):
        assert target.Protocol=='.uno:'
        assert values['SynchronMode'] is False
        self.called=True
dispatch=Dispatch()
uno=NS(createUnoStruct=lambda _:NS(),getTypeByName=lambda name:name)
transformer=Transformer()
command_status=lambda view,command:{'enabled':True}
props=lambda values:values
view={'frame':NS(queryDispatch=lambda target,name,flags:dispatch)}
assert dispatch_command({},view,'.uno:FontDialog',{'SynchronMode':True},'font-dialog')=='dispatched'
assert dispatch.called
`);
});

test('native deck state comes from the actual sidebar provider and slow initialization cannot be interpreted as a close', () => {
  check(['sidebar_state', 'observe_requested_deck'], String.raw`
class Deck:
    def __init__(self,id,active):self.id=id;self.active=active
    def isActive(self):return self.active
    def getId(self):return self.id
class Sidebar:
    def __init__(self):self.visible=False;self.reads=0;self.active=True
    def isVisible(self):return self.visible
    def getDecks(self):
        self.reads+=1
        return NS(getElementNames=lambda:['PropertyDeck','StyleListDeck'],getByName=lambda id:Deck(id,self.active and id=='StyleListDeck'))
sidebar=Sidebar();view={'visible':True,'controller':NS(getSidebar=lambda:sidebar),'requestedDeck':'.uno:DesignerDialog','requestedDeckShown':False}
command_status=lambda *args:(_ for _ in ()).throw(AssertionError('public/chrome command policy cannot be a visibility source'))
for _ in range(10):
    actual=sidebar_state(view);assert actual=={'sidebar':False}
    observe_requested_deck(view,actual)
assert view['requestedDeck']=='.uno:DesignerDialog' and not view['requestedDeckShown'] and sidebar.reads==0
sidebar.visible=True;actual=sidebar_state(view)
assert actual=={'sidebar':True,'deckId':'StyleListDeck'}
observe_requested_deck(view,actual);assert view['requestedDeckShown']
sidebar.active=False
assert sidebar_state(view)=={'sidebar':False}, 'a retained sidebar tab strip is not an expanded native deck'
sidebar.active=True
view['visible']=False;sidebar.visible=False
observe_requested_deck(view,sidebar_state(view));assert view['requestedDeck']=='.uno:DesignerDialog', 'tab hiding is not a native close'
view['visible']=True
view['controller']=NS(getSidebar=lambda:None)
assert sidebar_state(view)=={}
observe_requested_deck(view,{});assert view['requestedDeck']=='.uno:DesignerDialog', 'unavailable UI state cannot prove closed'
view['controller']=NS(getSidebar=lambda:sidebar)
observe_requested_deck(view,sidebar_state(view))
assert 'requestedDeck' not in view and 'requestedDeckShown' not in view
sidebar.visible=True;sidebar.getDecks=lambda:(_ for _ in ()).throw(RuntimeError('decks still loading'))
assert sidebar_state(view)=={}, 'provider existence with a pending deck collection cannot prove expanded content'
`);
});

test('selection replacement is bound to the full real text range and cannot edit a selected shape or truncated range', () => {
  check(['selected_text_range', 'replace_selected_text'], String.raw`
class Range:
    def __init__(self,text):self.text=text
    def queryInterface(self,type):return self
    def getString(self):return self.text
    def setString(self,value):self.text=value
class Ranges:
    def __init__(self,value):self.value=value
    def getCount(self):return 1
    def getByIndex(self,index):return self.value
uno=NS(getTypeByName=lambda value:value)
value=Range('实际选中的原文')
view={'controller':NS(getSelection=lambda:Ranges(value))}
session={'format':'docx'}
try:replace_selected_text(session,view,{'expectedText':'旧选区','text':'错误覆盖'})
except RuntimeError as e:assert str(e).startswith('SELECTION_CHANGED|')
else:raise AssertionError('stale text accepted')
assert value.text=='实际选中的原文'
replace_selected_text(session,view,{'expectedText':value.text,'text':'新文字'})
assert value.text=='新文字'
value.text='x'*48001
assert selected_text_range(session,view) is None
assert selected_text_range({'format':'pptx'},view) is None
`);
});

test('execute result discovers new selections under the actual request actor, then retires that actor before later human input', () => {
  check(['selection_signature', 'update_selection_epoch'], String.raw`
events=[];cleanups=[];order=[];current={'kind':'none','text':'','locator':{'from':0,'to':0}}
emit=lambda event:events.append(event)
manager=object();session={'sessionId':'session','engineRevision':5,'doc':NS(getUndoManager=lambda:manager),'requests':{},'operationActor':None}
view={'viewId':'view','selectionEpoch':0,'actor':'human','semanticSelection':selection_signature(current)}
expected=lambda *args:None
def hide_chrome(view):
    assert session['operationActor']==args['actor']
    cleanups.append(True);order.append('hide')
def state(session,view):
    if session['operationActor'] is not None:assert order[-1]=='hide';order.append('state')
    update_selection_epoch(session,view,current)
    return {'actor':view['actor'],'selectionEpoch':view['selectionEpoch'],'selection':current.copy()}
def dispatch_command(session,view,command,values,key):
    assert command=='.uno:SelectAll' and session['operationActor']==args['actor']
    current.update(kind='text',text='agent-selected-'+key,locator={'from':0,'to':20})
    return 'dispatched'
args={'requestId':'one','actor':'agent','command':'.uno:SelectAll'}
result=run_execute()
assert result['state']['actor']=='agent' and events[-1]['actor']=='agent' and session['operationActor'] is None
assert state(session,view)['actor']=='agent', 'a stable unchanged range retains its producer'
current.update(text='later human selection',locator={'from':3,'to':23})
assert state(session,view)['actor']=='human' and events[-1]['actor']=='human'
args={'requestId':'two','actor':'human','command':'.uno:SelectAll'}
assert run_execute()['state']['actor']=='human' and session['operationActor'] is None
args={'requestId':'three','actor':'agent','command':'.uno:SelectAll'}
def state(session,view):assert order[-1]=='hide';raise RuntimeError('state unavailable')
try:run_execute()
except RuntimeError:pass
else:raise AssertionError('state failure hidden')
assert session['operationActor'] is None and len(cleanups)==3 and 'three' not in session['requests']
args={'requestId':'four','actor':'agent','command':'.uno:SelectAll'}
def dispatch_command(*args):raise RuntimeError('dispatch unavailable')
try:run_execute()
except RuntimeError:pass
else:raise AssertionError('dispatch failure hidden')
assert session['operationActor'] is None and len(cleanups)==4 and 'four' not in session['requests']
`, String.raw`
import hashlib
branch=next(node for node in ast.walk(module) if isinstance(node,ast.If) and isinstance(node.test,ast.Compare) and isinstance(node.test.left,ast.Name) and node.test.left.id=='method' and len(node.test.comparators)==1 and isinstance(node.test.comparators[0],ast.Constant) and node.test.comparators[0].value=='execute')
function=ast.FunctionDef(name='run_execute',args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=branch.body+[ast.Return(value=ast.Name(id='result',ctx=ast.Load()))],decorator_list=[])
exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])),'actual-worker-execute-producer','exec'))
`);
});

test('Impress text replacement binds exact native positions and uses only a private fixed insertion transaction with full readback', () => {
  check(['ppt_text_parts', 'ppt_text_transaction_target', 'ppt_text_model_range', 'ppt_replace_text'], String.raw`
class NativeRange:
    def __init__(self,start,end):self._start=NS(Paragraph=start[0],PositionInParagraph=start[1]);self._end=NS(Paragraph=end[0],PositionInParagraph=end[1])
    @property
    def Start(self):return copy.deepcopy(self._start)
    @Start.setter
    def Start(self,value):self._start=copy.deepcopy(value)
    @property
    def End(self):return copy.deepcopy(self._end)
    @End.setter
    def End(self,value):self._end=copy.deepcopy(value)
def native_range(start,end):return NativeRange(start,end)
class Cursor:
    def __init__(self,text):self.Text=text;self.native=native_range((0,0),(0,0));self.all=False
    def getPropertyValue(self,name):assert name=='Selection';return self.native
    def setPropertyValue(self,name,value):assert name=='Selection';self.native=copy.deepcopy(value)
    def getString(self):
        if self.all:return self.Text.full
        n=self.native;return ppt_text_parts(self.Text.full,[n.Start.Paragraph,n.Start.PositionInParagraph,n.End.Paragraph,n.End.PositionInParagraph])[1]
    def gotoStart(self,expand):self.all=False
    def gotoEnd(self,expand):self.all=expand
class Text:
    def __init__(self,full):self.full=full
    def getString(self):return self.full
    def queryInterface(self,name):return shape if name.endswith('.XShape') else None
    def createTextCursor(self):return Cursor(self)
class Shape:
    def getText(self):return text
    def getPropertyValue(self,name):assert name=='ZOrder';return self.index
shape=Shape();shape.index=1;text=Text('A😀\nold Ω\nsuffix');other=object()
page=NS(getCount=lambda:2,getByIndex=lambda i:[other,shape][i]);pages=NS(getCount=lambda:1,getByIndex=lambda i:page)
active=Cursor(text);active.native=native_range((1,0),(1,5));ended=[];expectations=[]
controller=NS(getCurrentPage=lambda:page,setCurrentPage=lambda current:ended.append(current))
view={'controller':controller,'frame':NS(queryDispatch=lambda *args:object())};session={'doc':NS(getDrawPages=lambda:pages),'engineRevision':7}
def expected(session,view,args):
    expectations.append(args.copy());assert args['expectedEngineRevision']==session['engineRevision'];assert 'expectedSelectionEpoch' not in args
def create_struct(name):
    if name.endswith('.TextPosition'):return NS(Paragraph=0,PositionInParagraph=0)
    assert name.endswith('.TextRangeSelection');return native_range((0,0),(0,0))
uno=NS(getTypeByName=lambda name:name,createUnoStruct=create_struct);url=lambda command:command;props=lambda values:values
command_status=lambda *args:(_ for _ in ()).throw(AssertionError('private transaction must not use public blocked command status'))
class Dispatcher:
    def __init__(self):self.calls=[];self.mode='apply'
    def executeDispatch(self,frame,command,target,flags,values):
        assert command=='.uno:TransformDocumentStructure' and values['SynchronMode'] is True
        payload=json.loads(urllib.parse.unquote(values['DataJson']));self.calls.append(payload)
        commands=payload['Transforms'][0]['SlideCommands'];assert commands[0]=={'JumpToSlide':0}
        edit=commands[1]['EditTextObject.1'];assert len(edit)==2 and set(edit[0])=={'SelectText'} and set(edit[1])=={'InsertText'}
        assert edit[0]['SelectText']==[1,0,1,5]
        if self.mode=='noop':return
        before,selected,after=ppt_text_parts(text.full,edit[0]['SelectText']);text.full=before+edit[1]['InsertText']+after
        if self.mode=='damage':text.full+='unrelated corruption'
        session['engineRevision']+=1
dispatcher=Dispatcher();args={'expectedEngineRevision':7,'expectedSelectionEpoch':9};replacement={'expectedText':'old Ω','text':'new 🧭\nsecond'}
target=ppt_text_transaction_target(session,view,active);ppt_replace_text(session,view,target,replacement,args)
assert text.full=='A😀\nnew 🧭\nsecond\nsuffix' and ended==[page] and session['engineRevision']==8
assert len(dispatcher.calls)==1 and 'UnoCommand' not in json.dumps(dispatcher.calls)
assert expectations==[{'expectedEngineRevision':7}]
for mode in ['noop','damage']:
    text.full='A😀\nold Ω\nsuffix';session['engineRevision']=7;dispatcher.mode=mode;target=ppt_text_transaction_target(session,view,active)
    try:ppt_replace_text(session,view,target,replacement,args)
    except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_APPLY_FAILED|')
    else:raise AssertionError('unverified actual model reported as applied')
`, 'import copy, urllib.parse');
});

test('Impress model rebinding refuses stale object identities, changed unselected text and invalid UTF-16 boundaries before dispatch', () => {
  check(['ppt_text_parts', 'ppt_text_transaction_target', 'ppt_text_model_range'], String.raw`
native=NS(Start=NS(Paragraph=0,PositionInParagraph=0),End=NS(Paragraph=0,PositionInParagraph=3))
text=NS(getString=lambda:'old suffix',queryInterface=lambda name:shape)
model=NS(setPropertyValue=lambda *args:None,getString=lambda:'old')
text.createTextCursor=lambda:model;shape=NS(getPropertyValue=lambda name:0,getText=lambda:text)
current=[shape];page=NS(getCount=lambda:1,getByIndex=lambda i:current[i]);pages=NS(getCount=lambda:1,getByIndex=lambda i:page)
controller=NS(getCurrentPage=lambda:page,setCurrentPage=lambda current:None);view={'controller':controller};session={'doc':NS(getDrawPages=lambda:pages)}
uno=NS(getTypeByName=lambda name:name);expected=lambda *args:None;active=NS(Text=text,getPropertyValue=lambda name:native,getString=lambda:'old')
target=ppt_text_transaction_target(session,view,active)
for changed in ['identity','unselected-content']:
    current[0]=object() if changed=='identity' else shape;text.getString=lambda:'old changed suffix' if changed=='unselected-content' else 'old suffix'
    try:ppt_text_model_range(session,view,target,{})
    except RuntimeError as error:assert str(error).startswith('SELECTION_CHANGED|')
    else:raise AssertionError('stale actual target accepted')
for positions in [[0,1,0,2],[1,0,1,1],[0,0,0,99]]:
    try:ppt_text_parts('😀old',positions)
    except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_TARGET_UNAVAILABLE|')
    else:raise AssertionError('invalid native UTF-16 or paragraph bounds accepted')
current[0]=shape;text.getString=lambda:'old suffix';shape.getPropertyValue=lambda name:True
try:ppt_text_transaction_target(session,view,active)
except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_TARGET_UNAVAILABLE|')
else:raise AssertionError('coerced Z-order identity accepted')
`);
});

test('legacy Word paragraph mapping rejects textbox drift and sorts table columns numerically after Z', () => {
  check(['native_paragraphs', 'checked_native_paragraphs'], String.raw`
class Enumeration:
    def __init__(self,values):self.values=iter(values);self.next=None
    def hasMoreElements(self):
        try:self.next=next(self.values);return True
        except StopIteration:return False
    def nextElement(self):return self.next
class Paragraph:
    def __init__(self,text):self.String=text
    def supportsService(self,name):return name.endswith('.Paragraph')
class Text:
    def __init__(self,values):self.values=values
    def createEnumeration(self):return Enumeration(self.values)
class Table:
    def supportsService(self,name):return name.endswith('.TextTable')
    def getCellNames(self):return ['AA1','B1','Z1','A1']
    def getCellByName(self,name):return NS(Text=Text([Paragraph(name)]))
assert [v.String for v in native_paragraphs(Text([Table()]))]==['A1','B1','Z1','AA1']
text=Text([Paragraph('正文')]);buffer=io.BytesIO()
with zipfile.ZipFile(buffer,'w') as archive:
    archive.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>正文</w:t></w:r><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></w:p></w:document>')
model_parts=lambda session:zipfile.ZipFile(io.BytesIO(session['mappingBytes']))
try:checked_native_paragraphs({'doc':NS(Text=text),'mappingBytes':buffer.getvalue()})
except RuntimeError as e:assert str(e).startswith('NATIVE_TARGET_UNSUPPORTED|')
else:raise AssertionError('ambiguous paragraph mapping accepted')
`);
});

test('document snapshot refuses a pending buffer in any controller including a hidden non-active view', () => {
  check(['snapshot'], String.raw`
session={'doc':NS(), 'views':{'hidden':{'pending':True},'active':{'pending':False}}}
state=lambda session,view:{'pendingInput':view['pending']}
try:snapshot(session,session['views']['active'])
except RuntimeError as e:assert str(e).startswith('NATIVE_PENDING_INPUT|')
else:raise AssertionError('hidden controller pending buffer ignored')
`);
});

test('mouse modifier flags and mandatory geometry guard preserve Ctrl wheel and reject unversioned pointers', () => {
  check(['mouse_flags', 'native_input_action'], String.raw`
assert mouse_flags(['control','shift'])==12
assert mouse_flags(['alt'])==0
expected=lambda session,view,args:None
try:native_input_action({}, {'layoutRevision':4}, {'action':{'kind':'scroll'}})
except RuntimeError as e:assert str(e).startswith('STALE_COORDINATES|')
else:raise AssertionError('unversioned pointer accepted')
`);
});

test('file MIME parser accepts only absolute supported document lists and preserves image or text native drops', () => {
  check(['file_drop_paths'], String.raw`
DOCUMENT_DROP_SUFFIXES={'.docx','.pdf','.md','.html','.xlsx','.pptx'}
uno=NS(fileUrlToSystemPath=lambda value:'C:/docs/'+value.rsplit('/',1)[-1])
assert file_drop_paths('C:/docs/a.docx\0C:/docs/b.pdf\0')==[str(pathlib.Path('C:/docs/a.docx')),str(pathlib.Path('C:/docs/b.pdf'))]
assert len(file_drop_paths('C:/docs/文档.md\0'.encode('utf-16-le')))==1
assert file_drop_paths('file:///C:/docs/a.docx\r\n')==[str(pathlib.Path('C:/docs/a.docx'))]
assert file_drop_paths('C:/docs/a.png')==[]
assert file_drop_paths('C:/docs/a.docx\0C:/docs/a.png')==[]
assert file_drop_paths('https://example.com/a.docx')==[]
assert file_drop_paths('正文内部拖动文字')==[]
`);
});

test('selection leases follow semantic ranges while scroll rectangles and page presentation stay out of their identity', () => {
  check(['selection_signature'], String.raw`
first={'kind':'text','text':'重复段落','locator':{'from':3,'to':7,'pageIndex':0},'rect':{'x':10,'y':15,'width':60,'height':20}}
scrolled={**first,'locator':{**first['locator'],'pageIndex':1},'rect':{'x':10,'y':80,'width':60,'height':20}}
assert selection_signature(first)==selection_signature(scrolled)
different_range={**first,'locator':{'from':20,'to':24}}
assert selection_signature(first)!=selection_signature(different_range)
assert selection_signature(first)!=selection_signature({'kind':'none','text':''})
assert selection_signature({'kind':'cells','text':'7','sheetName':'Sheet1','range':'A1'})!=selection_signature({'kind':'cells','text':'7','sheetName':'Sheet2','range':'A1'})
`);
});

test('native caret and text-range identity uses exact UNO containers and UTF-16 offsets, reusing unchanged ranges only', () => {
  check(['native_text_container_id', 'native_range_locator'], String.raw`
class Text:
    def __init__(self,value):self.value=value;self.prefixReads=0
    def createTextCursorByRange(self,value):return Range(self,value.start,value.end)
    def compareRegionStarts(self,a,b):return a.start-b.start
    def compareRegionEnds(self,a,b):return a.end-b.end
class Range:
    def __init__(self,text,start,end):self.Text=text;self.start=start;self.end=end
    def getStart(self):return Range(self.Text,self.start,self.start)
    def getEnd(self):return Range(self.Text,self.end,self.end)
    def gotoStart(self,expand):self.start=0
    def gotoRange(self,value,expand):self.end=value.end
    @property
    def String(self):self.Text.prefixReads+=1;return self.Text.value[self.start:self.end]
session={'engineRevision':5,'format':'docx'};view={};text=Text('A😀\n重复\n重复')
first=Range(text,4,4);locator=native_range_locator(session,view,first,'')
assert locator['from']==5 and locator['to']==5
assert text.prefixReads==1
for _ in range(10):assert native_range_locator(session,view,Range(text,4,4),'')==locator
assert text.prefixReads==1, 'unchanged viewport polls must not read the document prefix again'
later=native_range_locator(session,view,Range(text,7,7),'')
assert later['from']==8 and later['blockId']==locator['blockId'] and text.prefixReads==2
other=Text(text.value);other_locator=native_range_locator(session,view,Range(other,4,4),'')
assert other_locator['from']==locator['from'] and other_locator['blockId']!=locator['blockId'], 'identical text in another shape/cell/frame must have another identity'
session['engineRevision']=6
assert native_range_locator(session,view,first,'')['from']==5 and text.prefixReads==3
assert all(entry['revision']==6 for entry in view['rangeLocatorCache'])
try:native_range_locator(session,view,NS(Text=NS()),'')
except RuntimeError as error:assert str(error).startswith('NATIVE_SELECTION_UNSUPPORTED|')
else:raise AssertionError('text container without exact range comparison accepted')
`, 'import uuid');
});

test('Impress without XTextRangeCompare uses only the exact selected text container and bounded UTF-16 prefix', () => {
  check(['native_text_container_id', 'native_range_locator'], String.raw`
class Text:
    def __init__(self,value):self.value=value
    def createTextCursorByRange(self,value):return Range(self,value.start,value.end)
class Range:
    def __init__(self,text,start,end):self.Text=text;self.start=start;self.end=end
    def getStart(self):return Range(self.Text,self.start,self.start)
    def gotoStart(self,expand):self.start=0
    @property
    def String(self):return self.Text.value[self.start:self.end]
session={'engineRevision':2,'format':'pptx'};view={};a=Text('😀same');b=Text('😀same')
first=native_range_locator(session,view,Range(a,1,5),'same');second=native_range_locator(session,view,Range(b,1,5),'same')
assert first['from']==second['from']==2 and first['to']==second['to']==6 and first['blockId']!=second['blockId']
assert native_range_locator(session,view,Range(a,1,5),'same')==first
assert view['rangeLocatorCache']==[], 'a non-comparable mutable range must not be reused as a cached positional lease'
late=native_range_locator(session,view,Range(a,2,5),'ame');assert late['from']==3 and late!=first
huge=Text('a'*48001)
try:native_range_locator(session,view,Range(huge,48000,48001),'a')
except RuntimeError as error:assert str(error).startswith('NATIVE_SELECTION_UNSUPPORTED|')
else:raise AssertionError('unbounded native shape prefix accepted')
`, 'import uuid');
});

test('Word empty carets and all selected ranges change semantic leases even when SelectionChanged is missed', () => {
  check(['selection_signature', 'update_selection_epoch', 'native_text_container_id', 'native_range_locator', 'selection', 'expected'], String.raw`
class Text:
    def __init__(self,value):self.value=value
    def createTextCursorByRange(self,value):return Range(self,value.start,value.end)
    def compareRegionStarts(self,a,b):return a.start-b.start
    def compareRegionEnds(self,a,b):return a.end-b.end
class Range:
    def __init__(self,text,start,end):self.Text=text;self.start=start;self.end=end
    def getStart(self):return Range(self.Text,self.start,self.start)
    def getEnd(self):return Range(self.Text,self.end,self.end)
    def gotoStart(self,expand):self.start=0
    def gotoRange(self,value,expand):self.end=value.end
    def getString(self):return self.Text.value[self.start:self.end]
    def getPage(self):return 1
    @property
    def String(self):return self.getString()
text=Text('same\nsame');ranges=[Range(text,0,0)]
controller=NS(getSelection=lambda:NS(getCount=lambda:len(ranges),getByIndex=lambda i:ranges[i]),getViewCursor=lambda:ranges[0])
session={'sessionId':'doc-session','format':'docx','engineRevision':3};view={'viewId':'view-a','controller':controller,'selectionEpoch':0};events=[];emit=events.append;epoch='engine-a'
initial=selection(session,view);assert initial['kind']=='none' and not initial.get('identityUnavailable')
assert update_selection_epoch(session,view,initial) and view['selectionEpoch']==1
lease=view['selectionEpoch'];view['captureCache']={};view['accessibilityCache']={};ranges[0]=Range(text,5,5)
try:expected(session,view,{'expectedEngineRevision':3,'expectedSelectionEpoch':lease,'style':{'target':'paragraph'}})
except RuntimeError as error:assert str(error).startswith('SELECTION_CHANGED|')
else:raise AssertionError('old paragraph caret lease accepted after an unreported native caret move')
assert view['selectionEpoch']==2 and 'captureCache' not in view and 'accessibilityCache' not in view
current=selection(session,view);assert not update_selection_epoch(session,view,{**current,'rect':{'x':20},'pageIndex':7})
ranges[:]=[Range(text,0,4),Range(text,5,9)];both=selection(session,view);assert both['locator']['blockId'].startswith('native-ranges:')
ranges[1]=Range(text,6,9);changed=selection(session,view);assert selection_signature(both)!=selection_signature(changed)
ranges[:]=[NS(getString=lambda:'',getPage=lambda:1)];unavailable=selection(session,view);assert unavailable['identityUnavailable']
try:expected(session,view,{'expectedEngineRevision':3,'expectedSelectionEpoch':view['selectionEpoch'],'style':{'target':'paragraph'}})
except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_TARGET_UNAVAILABLE|')
else:raise AssertionError('unidentifiable paragraph caret accepted')
assert events[0]['viewId']=='view-a' and events[0]['actor']=='human'
`, 'import uuid, hashlib');
});

test('Impress equal selected text in separate native text containers never shares a lease', () => {
  check(['selection_signature', 'update_selection_epoch', 'native_text_container_id', 'native_range_locator', 'selection'], String.raw`
class Text:
    def __init__(self):self.value='same'
    def createTextCursorByRange(self,value):return Range(self,value.start,value.end)
    def compareRegionStarts(self,a,b):return a.start-b.start
    def compareRegionEnds(self,a,b):return a.end-b.end
class Range:
    def __init__(self,text,start=0,end=4):self.Text=text;self.start=start;self.end=end
    def getString(self):return self.Text.value[self.start:self.end]
    def getStart(self):return Range(self.Text,self.start,self.start)
    def getEnd(self):return Range(self.Text,self.end,self.end)
    def gotoStart(self,expand):self.start=0
    def gotoRange(self,value,expand):self.end=value.end
    @property
    def String(self):return self.getString()
page=NS();first=Range(Text());second=Range(Text());controller=NS(selected=first,getCurrentPage=lambda:page);controller.getSelection=lambda:controller.selected
session={'sessionId':'ppt-session','engineRevision':8,'format':'pptx','doc':NS(getDrawPages=lambda:NS(getCount=lambda:1,getByIndex=lambda i:page))};view={'viewId':'ppt-view','controller':controller,'selectionEpoch':0};emit=lambda event:None
a=selection(session,view);update_selection_epoch(session,view,a);assert view['selectionEpoch']==1
controller.selected=second;b=selection(session,view);assert a['text']==b['text']=='same' and a['slideIndex']==b['slideIndex']==0
assert selection_signature(a)!=selection_signature(b) and update_selection_epoch(session,view,b) and view['selectionEpoch']==2
assert not update_selection_epoch(session,view,selection(session,view))
`, 'import uuid, hashlib');
});

test('unnamed or duplicate-name Impress shapes retain stable actual object leases, not name-based aliases', () => {
  check(['selection_signature', 'native_shape_identity', 'selection'], String.raw`
class Shape:
    def __init__(self,id):self.id=id;self.Name='';self.String='same'
    def __eq__(self,other):return isinstance(other,Shape) and self.id==other.id
page=NS();controller=NS(selected=Shape(1),getCurrentPage=lambda:page)
controller.getSelection=lambda:NS(getCount=lambda:1,getByIndex=lambda i:controller.selected)
session={'engineRevision':0,'format':'pptx','doc':NS(getDrawPages=lambda:NS(getCount=lambda:1,getByIndex=lambda i:page))};view={'controller':controller}
first=selection(session,view);controller.selected=Shape(1);same=selection(session,view)
assert selection_signature(first)==selection_signature(same), 'fresh UNO wrappers for the same actual shape must not cause polling churn'
controller.selected=Shape(2);other=selection(session,view)
assert first['objectNames']==other['objectNames']==[''] and first['text']==other['text']
assert selection_signature(first)!=selection_signature(other), 'distinct unnamed shapes cannot share the edit lease'
controller.selected.Name='duplicated';a=selection(session,view);controller.selected=Shape(3);controller.selected.Name='duplicated';b=selection(session,view)
assert a['objectNames']==b['objectNames'] and selection_signature(a)!=selection_signature(b)
`, 'import uuid, hashlib');
});

test('same-version native snapshots reuse verified bytes but retain current view and all-controller pending guards', () => {
  check(['snapshot'], String.raw`
FILTERS={'docx':'Office Open XML Text'}
session={'format':'docx','engineRevision':4,'doc':NS(isModified=lambda:True),'views':{'a':{},'b':{}},'lastSnapshot':{'engineRevision':4,'undoToken':'undo4','dirty':True,'result':{'bytes':'fixed-zip','sha256':'fixed-hash','state':{'viewId':'a'}}}}
undo_state=lambda session:{'token':'undo4'}
state=lambda session,view:{'pendingInput':view.get('pending',False),'viewId':view.get('viewId','b')}
result=snapshot(session,session['views']['b'])
assert result['bytes']=='fixed-zip' and result['sha256']=='fixed-hash'
assert result['state']['viewId']=='b'
session['views']['a']['pending']=True
try:snapshot(session,session['views']['b'])
except RuntimeError as e:assert str(e).startswith('NATIVE_PENDING_INPUT|')
else:raise AssertionError('cache bypassed the document input barrier')
`);
});

test('native keyboard focus handoff refuses an unrelated foreground application before sending or joining its input queue', () => {
  check(['focus_input'], String.raw`
own_input_foreground=lambda view:False
W=NS(DWORD=lambda:NS(value=0));C=NS(byref=lambda value:value)
def pid(hwnd,out):out.value=1 if hwnd==100 else 2;return 42
user32=NS(GetForegroundWindow=lambda:900,GetWindowThreadProcessId=pid)
view={'owner':100,'hwnd':101,'frame':NS(getComponentWindow=lambda: (_ for _ in ()).throw(AssertionError('foreign focus handoff attempted')))}
try:focus_input(view)
except RuntimeError as e:assert str(e).startswith('NATIVE_INPUT_FOCUS|')
else:raise AssertionError('foreign foreground accepted')
`);
});

test('native CSS coordinates derive from the actual owner client ratio and verify the full requested surface', () => {
  check(['coordinate_scale', 'surface_geometry', 'view_scale', 'native_geometry'], String.raw`
import math
viewport={'width':1440,'height':900}
bounds={'x':330,'y':49,'width':1037,'height':851}
# Chromium forced to scale 1 on a 150% Windows display must not multiply these
# CSS coordinates by the unrelated HWND DPI and clip the right/bottom edges.
assert coordinate_scale(viewport,viewport)==1
target=surface_geometry(bounds,viewport,{'x':100,'y':200},1)
assert target=={'x':430,'y':249,'width':1037,'height':851}
# A natural 150% client maps the same trusted CSS viewport to physical pixels.
assert coordinate_scale({'width':2160,'height':1350},viewport)==1.5
target150=surface_geometry(bounds,{'width':2160,'height':1350},{'x':-2160,'y':30},1.5)
assert target150=={'x':-1665,'y':104,'width':1555,'height':1276}
assert surface_geometry({'x':1439,'y':899,'width':3,'height':3},viewport,{'x':0,'y':0},1)=={'x':1439,'y':899,'width':1,'height':1}
for client,box in [({'width':1440,'height':1200},viewport),(viewport,{'width':0,'height':900}),(viewport,{'width':True,'height':900}),(viewport,{'width':float('nan'),'height':900})]:
    try:coordinate_scale(client,box)
    except RuntimeError:pass
    else:raise AssertionError('invalid or anisotropic owner viewport accepted')
for scale in [None,False,0,-1,float('inf'),'1.5']:
    try:view_scale({'coordinateScale':scale})
    except RuntimeError as e:assert str(e).startswith('NATIVE_GEOMETRY_UNAVAILABLE|')
    else:raise AssertionError('unconfirmed scale accepted')
user32=NS(IsWindow=lambda hwnd:True,IsIconic=lambda hwnd:False,IsWindowVisible=lambda hwnd:True)
view={'owner':100,'hwnd':101,'visible':True,'coordinateScale':1,'targetBounds':target}
client={'width':1037,'height':851}
assert native_geometry(view,client,target)
assert native_geometry(view,client,{**target,'x':target['x']+2})
assert not native_geometry(view,client,{**target,'x':target['x']+3})
assert not native_geometry(view,{'width':945,'height':826},{**target,'width':945,'height':826}), 'nonzero clipped body is not ready'
assert not native_geometry({**view,'visible':False},client,target)
`);
});

test('saved acknowledgement suppresses only its unchanged status notification and reuses the exact saved bytes', () => {
  check(['refresh_content_dirtiness', 'saved_ack_notification', 'Modified', 'undo_state', 'snapshot', 'acknowledge_saved'], String.raw`
import hashlib
epoch='epoch-1';events=[];emit=lambda value:events.append(value)
class Document:
    def __init__(self,mode='status'):self.dirty=True;self.titles=['Native edit'];self.mode=mode;self.resets=[]
    def isModified(self):return self.dirty
    def getUndoManager(self):
        return NS(getAllUndoActionTitles=lambda:self.titles[:],isRedoPossible=lambda:False,getCurrentUndoActionTitle=lambda:self.titles[-1] if self.titles else None,isUndoPossible=lambda:bool(self.titles))
    def setModified(self,value):
        self.resets.append(value);self.dirty=value
        if not value and self.mode=='undo':self.titles.append('Concurrent native edit')
        if not value and self.mode=='human':
            self.dirty=True;self.listener.modified(None);self.dirty=False
        self.listener.modified(None)
def make(mode='status'):
    doc=Document(mode);session={'doc':doc,'sessionId':'doc','format':'docx','engineRevision':4,'views':{},'unsavedContentChanges':doc.isModified()}
    doc.listener=Modified(session);token=undo_state(session)['token']
    session['lastSnapshot']={'engineRevision':4,'hash':'verified-hash','undoToken':token,'dirty':True,'result':{'bytes':'exact-saved-zip','sha256':'verified-hash','dirty':True,'state':{}}}
    return session
args={'engineEpoch':epoch,'engineRevision':4,'hash':'verified-hash'}
session=make();before=undo_state(session)
assert acknowledge_saved(session,args) is True
assert session['engineRevision']==4 and undo_state(session)==before
assert not session['doc'].isModified() and not events
assert session['unsavedContentChanges'] is False
assert 'acknowledgingSave' not in session
assert session['lastSnapshot']['dirty'] is False and session['lastSnapshot']['result']['dirty'] is False
assert session['lastSnapshot']['result']['state']['unsavedContentChanges'] is False
state=lambda session,view:{'viewId':'current','pendingInput':False,'unsavedContentChanges':session['unsavedContentChanges']}
result=snapshot(session,{}) # No storeToURL exists: only the unchanged verified cache may be used.
assert result['bytes']=='exact-saved-zip' and result['sha256']=='verified-hash' and result['dirty'] is False
# An ordinary event after the acknowledgement must never be suppressed.
session['exporting']=True;session['doc'].setModified(True)
assert session['engineRevision']==5 and session['doc'].isModified() and len(events)==1
assert session['unsavedContentChanges'] is True
session['doc'].setModified(False)
assert session['engineRevision']==6 and len(events)==2
assert session['unsavedContentChanges'] is True, 'a native temporary save cannot acknowledge the application source'
# A stale saved hash is read-only and cannot reset current dirty status.
session=make();assert acknowledge_saved(session,{**args,'hash':'wrong-hash'}) is False
assert session['doc'].isModified() and not session['doc'].resets
assert session['unsavedContentChanges'] is True
for mode in ['undo','human']:
    session=make(mode);old_count=len(events)
    assert acknowledge_saved(session,args) is False
    assert session['doc'].isModified() and session['engineRevision']>4
    assert session['unsavedContentChanges'] is True
    assert len(events)>old_count and 'acknowledgingSave' not in session and 'lastSnapshot' not in session
# Pure reading metadata may notify/increase engineRevision without changing the
# native document's real modified state. It must not create content dirtiness.
session=make();session['doc'].dirty=False;session['unsavedContentChanges']=False
session['doc'].listener.modified(None)
assert session['engineRevision']==5 and session['unsavedContentChanges'] is False
# A real native dirty state observed by polling is authoritative even if its
# modify notification was coalesced; becoming clean later does not clear it.
session['doc'].dirty=True
assert refresh_content_dirtiness(session) is True and session['unsavedContentChanges'] is True
session['doc'].dirty=False
assert refresh_content_dirtiness(session) is False and session['unsavedContentChanges'] is True
`, "unohelper=NS(Base=type('UnoBase',(),{}));XModifyListener=type('XModifyListener',(),{})");
});

test('Excel formulas use native A1 token parsing for every assignment path and explicit native error readback', () => {
  check(['excel_formula_parser', 'set_excel_formula', 'set_cell_content', 'excel_cell_formula', 'query_cell_range', 'execute_operation'], String.raw`
constant=lambda name,fallback:fallback
class Parser:
    def __init__(self):self.parsed=[];self.printed=[];self.properties=[]
    def getPropertySetInfo(self):return NS(hasPropertyByName=lambda name:True)
    def __setattr__(self,name,value):
        if name in ['CompileEnglish','FormulaConvention','ParameterSeparator','OpCodeMap']:
            self.properties.append(name)
            if name=='OpCodeMap':assert self.CompileEnglish is True
        object.__setattr__(self,name,value)
    def parseFormula(self,text,address):
        self.parsed.append((text,address));return (NS(text=text,address=address),)
    def printFormula(self,tokens,address):
        assert tokens[0].address is address
        self.printed.append(tokens);return tokens[0].text.removeprefix('=')
class Mapper:
    def getAvailableMappings(self,language,groups):assert language==4 and groups==0x7fffffff;return ('XL_ENGLISH_FULL_MAP',)
class Cell:
    def __init__(self,value='',kind='TEXT',error=0):self.content=value;self.kind=kind;self.error=error;self.address=NS(Sheet=1,Column=3,Row=2);self.tokens=();self.direct=[]
    def getCellAddress(self):return self.address
    def setTokens(self,tokens):self.tokens=tokens;self.kind='FORMULA'
    def getTokens(self):return self.tokens
    def getType(self):return NS(value=self.kind)
    def getFormula(self):return str(self.content)
    def setFormula(self,value):self.direct.append(value);self.content=value
    def getError(self):return self.error
class Document:
    def __init__(self):self.calls=[];self.parser=Parser()
    def createInstance(self,name):
        self.calls.append(name);return self.parser if name.endswith('.FormulaParser') else Mapper()
    def getSheets(self):return NS()
doc=Document();session={'doc':doc};cell=Cell()
formula='=IF(1=1,"comma,semicolon;",\'中文 表\'!A1)'
set_cell_content(session,cell,formula)
assert doc.parser.parsed[-1][0]==formula and doc.parser.parsed[-1][1] is cell.address
assert not cell.direct and cell.tokens[0].text==formula
assert doc.parser.CompileEnglish is True and doc.parser.FormulaConvention==1 and doc.parser.ParameterSeparator==','
assert doc.parser.OpCodeMap==('XL_ENGLISH_FULL_MAP',) and len(doc.calls)==2
assert excel_cell_formula(session,cell)==formula and len(doc.calls)==2, 'parser must be cached per native document'
plain=Cell();set_cell_content(session,plain,'20.5');assert plain.direct==['20.5'] and not plain.tokens
sheet=NS();cells={'A1':Cell(),'B1':Cell(),'C1':Cell()}
mapped_sheet=lambda session,sheetId:sheet
checked_range=lambda sheet,address:cells[address]
sheet.getCellByPosition=lambda column,row:cells[['B1','C1'][column]]
cells['B1'].getRangeAddress=lambda:NS(StartColumn=0,StartRow=0)
execute_operation(session,{}, {'kind':'sheets.setCell','sheetId':'sheet','address':'A1','formula':'SUM(20,22)'})
assert cells['A1'].tokens[0].text=='=SUM(20,22)'
execute_operation(session,{}, {'kind':'sheets.setRangeValues','sheetId':'sheet','start':'B1','rows':[['=SUM(1,2)','=IF(1=1,"a,b","c")']]})
assert cells['B1'].tokens[0].text=='=SUM(1,2)' and cells['C1'].tokens[0].text=='=IF(1=1,"a,b","c")'
bad=Cell(kind='FORMULA',error=532);set_excel_formula(session,bad,'=1/0')
range_cells=[cells['A1'],plain,bad]
area=NS(getRangeAddress=lambda:NS(StartColumn=4,EndColumn=6,StartRow=10,EndRow=10),getCellByPosition=lambda c,r:range_cells[c],getDataArray=lambda:((42.,20.5,None),))
read=query_cell_range(session,area)
assert read['values']==((42.,20.5,None),) and read['errors']==[[0,0,532]]
assert read['formulas']==[['=SUM(20,22)','20.5','=1/0']]
# Actual bundled ScFormulaParserObj omits the documented separator property;
# its complete native Excel mapping still carries separator semantics.
without_separator=Document();without_separator.parser.getPropertySetInfo=lambda:NS(hasPropertyByName=lambda name:False)
fallback_session={'doc':without_separator};set_excel_formula(fallback_session,Cell(),'=SUM(20,22)')
assert not hasattr(without_separator.parser,'ParameterSeparator') and without_separator.parser.OpCodeMap==('XL_ENGLISH_FULL_MAP',)
`);
});

test('snapshot instability reports bounded state metadata without leaking undo titles or accepting changed exports', () => {
  check(['snapshot_diagnostic', 'snapshot'], String.raw`
import tempfile, uuid, base64, hashlib
secret='PRIVATE_USER_UNDO_TITLE'
before_undo={'token':'before-hash','count':2,'canUndo':True,'canRedo':False,'title':secret}
after_undo={'token':'after-hash','count':3,'canUndo':True,'canRedo':True,'title':'ANOTHER_PRIVATE_TITLE'}
info=snapshot_diagnostic({'sessionId':'owned-session','format':'pptx'},0,'pptx',1,2,False,True,before_undo,after_undo)
assert info['changed']=={'revision':True,'dirty':True,'undo':True,'undoTitle':True}
assert info['before']['undoToken']=='before-hash' and info['after']['undoCount']==3
assert secret not in json.dumps(info) and 'ANOTHER_PRIVATE_TITLE' not in json.dumps(info) and 'title' not in info['before']
events=[];emit=lambda value:events.append(value)
FILTERS={'pptx':'Impress MS PowerPoint 2007 XML'}
state=lambda session,view:{'pendingInput':False}
props=lambda value:value
store_snapshot_file=lambda session,output,filter_name:session['doc'].storeToURL(output.as_uri(),props({'FilterName':filter_name,'Overwrite':True}))
with tempfile.TemporaryDirectory(prefix='agentviewer-snapshot-diagnostic-unit-') as directory:
    ROOT=pathlib.Path(directory).resolve()
    assert ROOT.parent==pathlib.Path(tempfile.gettempdir()).resolve()
    class Document:
        def isModified(self):return False
        def storeToURL(self,uri,properties):
            (ROOT/uri.rsplit('/',1)[-1]).write_bytes(b'not-stable-yet')
            session['engineRevision']+=1
    session={'doc':Document(),'views':{},'format':'pptx','sessionId':'owned-session','engineRevision':0}
    undo_state=lambda session:{'token':'revision-hash-'+str(session['engineRevision']),'count':0,'canUndo':False,'canRedo':False,'title':secret}
    try:snapshot(session,{})
    except RuntimeError as error:assert str(error).startswith('SNAPSHOT_BUSY|')
    else:raise AssertionError('unstable native export accepted')
    assert len(events)==3 and [event['attempt'] for event in events]==[1,2,3]
    assert all(event['changed']['revision'] and event['changed']['undo'] and not event['changed']['dirty'] for event in events)
    assert secret not in json.dumps(events) and 'lastSnapshot' not in session
    assert not list(ROOT.iterdir()), 'temporary exports must be removed after rejected attempts'
`);
});

test('PPTX clone colors restore actual native values only on verified temporary objects, leaving source content and history untouched', () => {
  check(['reconcile_clone_shape_colors','style_value_key'], String.raw`
class ComplexColor:
    def __init__(self,theme):self.theme=theme
    def getType(self):return 4
    def getThemeColorType(self):return self.theme
    def resolveColor(self,theme):return 0
class Shape:
    ShapeType='actual-type';Name='actual-name';String='same real text'
    def __init__(self,theme,source=False):self.values={'FillColor':0xb6d8cc,'FillComplexColor':ComplexColor(theme),'InteropGrabBag':(NS(Name='keep',Value='actual metadata'),)};self.writes=[];self.source=source
    def getPropertySetInfo(self):return NS(hasPropertyByName=lambda name:name in self.values)
    def getPropertyValue(self,name):return self.values[name]
    def setPropertyValue(self,name,value):
        assert not self.source, 'the sole writer cannot be changed by snapshot repair'
        self.writes.append(name);self.values[name]=value.value
source=Shape(-1,True);target=Shape(4)
def document(shape):return NS(getDrawPages=lambda:NS(getCount=lambda:1,getByIndex=lambda i:NS(getCount=lambda:1,getByIndex=lambda j:shape)))
session={'doc':document(source),'engineRevision':7,'undo':'untouched'};clone=document(target)
uno=NS(Any=lambda type,value:NS(type=type,value=value))
reconcile_clone_shape_colors(session,clone)
assert target.values['FillColor']==0xb6d8cc and target.values['FillComplexColor'] is source.values['FillComplexColor']
assert target.values['InteropGrabBag'] is source.values['InteropGrabBag'] and not source.writes and session['engineRevision']==7 and session['undo']=='untouched'
count=len(target.writes);reconcile_clone_shape_colors(session,clone);assert len(target.writes)==count+3, 'all hidden transforms are carried by the complete immutable value even if its public theme matches'
for attribute in ['Name','String','ShapeType']:
    target=Shape(4);setattr(target,attribute,'mismatched actual object')
    try:reconcile_clone_shape_colors(session,document(target))
    except RuntimeError as error:assert str(error).startswith('NATIVE_EXPORT_FAILED|')
    else:raise AssertionError('guessed clone object accepted')
    assert not target.writes and not source.writes
target=Shape(4);target.getPropertySetInfo=lambda:NS(hasPropertyByName=lambda name:name=='FillColor')
try:reconcile_clone_shape_colors(session,document(target))
except RuntimeError as error:assert str(error).startswith('NATIVE_EXPORT_FAILED|')
else:raise AssertionError('missing clone carrier ignored')
`);
});

test('PPTX snapshot guard preserves native history, suspends only owned inputs and restores every window on failure', () => {
  check(['store_snapshot_file', 'snapshot', 'snapshot_diagnostic'], String.raw`
import tempfile, uuid, base64, hashlib
props=lambda values:values
reconcile_clone_shape_colors=lambda session,clone:None # Color reconciliation has its separate actual-helper regression above.
events=[];emit=lambda value:events.append(value)
FILTERS={'pptx':'Impress MS PowerPoint 2007 XML'}
state=lambda session,view:{'pendingInput':False}
class Manager:
    def __init__(self):self.locked=False;self.history=['real user edit'];self.redo=['actual redo'];self.lockCalls=0
    def isLocked(self):return self.locked
    def lock(self):assert not self.locked;self.locked=True;self.lockCalls+=1
    def unlock(self):assert self.locked;self.locked=False
class Window:
    def __init__(self,enabled=True,failRestore=False):self.enabled=enabled;self.changes=[];self.failRestore=failRestore
    def isEnabled(self):return self.enabled
    def setEnable(self,enabled):
        self.changes.append(enabled)
        if enabled and self.failRestore:raise RuntimeError('disposed during export')
        self.enabled=enabled
class Document:
    def __init__(self,manager):self.manager=manager;self.dirty=False;self.exports=0;self.failure=False;self.concurrent=False
    def getUndoManager(self):return self.manager
    def isModified(self):return self.dirty
    def storeToURL(self,uri,properties):
        assert all(not item.enabled for item in windows) and self.manager.locked
        assert properties['FilterName']=='impress8', 'live model must never run the polluting PPTX exporter'
        self.exports+=1
        if not self.manager.locked:self.manager.history.insert(0,'export temporary slide')
        if self.concurrent:session['engineRevision']+=1;self.dirty=True
        if self.failure:raise RuntimeError('actual exporter failed')
        (ROOT/uri.rsplit('/',1)[-1]).write_bytes(b'export-'+str(session['engineRevision']).encode())
class Clone:
    def __init__(self):self.closed=False;self.polluted=False
    def storeToURL(self,uri,properties):
        assert all(w.enabled for w in windows) and not manager.locked, 'live inputs must resume before clone conversion'
        assert properties['FilterName']=='Impress MS PowerPoint 2007 XML'
        self.polluted=True
        (ROOT/uri.rsplit('/',1)[-1]).write_bytes(b'isolated-pptx-'+str(session['engineRevision']).encode())
    def close(self,deliver):assert deliver;self.closed=True
clones=[]
def clone_document(uri,target,flags,properties):
    assert properties['Hidden'] is True and properties['ReadOnly'] is True and properties['FilterName']=='impress8'
    assert properties['MacroExecutionMode']==0 and properties['UpdateDocMode']==0
    assert pathlib.Path(uri.removeprefix('file:///')).is_file()
    clone=Clone();clones.append(clone);return clone
desktop=NS(loadComponentFromURL=clone_document);uno=NS(Any=lambda kind,value:value);SafeImportInteraction=lambda:NS()
def undo_state(session):
    m=session['doc'].manager
    return {'token':hashlib.sha256(json.dumps([session['engineRevision'],m.history,m.redo]).encode()).hexdigest(),'count':len(m.history),'canUndo':bool(m.history),'canRedo':bool(m.redo),'title':m.history[0] if m.history else None}
with tempfile.TemporaryDirectory(prefix='agentviewer-pptx-snapshot-unit-') as directory:
    ROOT=pathlib.Path(directory);manager=Manager();doc=Document(manager);windows=[Window(),Window()]
    session={'doc':doc,'views':{str(i):{'frame':NS(getContainerWindow=lambda w=w:w)} for i,w in enumerate(windows)},'format':'pptx','sessionId':'doc','engineRevision':7}
    original=(list(manager.history),list(manager.redo),undo_state(session))
    first=snapshot(session,{})
    assert first['stable'] and (manager.history,manager.redo,undo_state(session))==original
    assert clones[0].closed and clones[0].polluted
    assert all(w.enabled and w.changes==[False,True] for w in windows) and not manager.locked
    second=snapshot(session,{})
    assert second['bytes']==first['bytes'] and doc.exports==1, 'verified same-version cache must skip export and input suspension'
    session['engineRevision']+=1;manager.history.insert(0,'second real edit');manager.redo.clear();doc.dirty=True
    third=snapshot(session,{})
    assert third['stable'] and doc.exports==2 and manager.history==['second real edit','real user edit'] and not manager.redo
    doc.failure=True
    try:store_snapshot_file(session,ROOT/'failed.pptx',FILTERS['pptx'])
    except RuntimeError as error:assert str(error)=='actual exporter failed'
    else:raise AssertionError('export exception disappeared')
    assert not manager.locked and all(w.enabled for w in windows)
    assert all(clone.closed for clone in clones) and not list(ROOT.glob('*.odp'))
    doc.failure=False;doc.concurrent=True;session.pop('lastSnapshot',None)
    try:snapshot(session,{})
    except RuntimeError as error:assert str(error).startswith('SNAPSHOT_BUSY|')
    else:raise AssertionError('concurrent content mutation accepted while undo recording locked')
    assert len(events)==3 and all(e['changed']['revision'] for e in events)
    assert not manager.locked and all(w.enabled for w in windows)
    windows[1].enabled=False;count=manager.lockCalls
    try:store_snapshot_file(session,ROOT/'modal.pptx',FILTERS['pptx'])
    except RuntimeError as error:assert str(error).startswith('NATIVE_PENDING_INPUT|')
    else:raise AssertionError('pre-existing modal input freeze was overridden')
    assert windows[0].enabled and not windows[1].enabled and manager.lockCalls==count
    windows[1].enabled=True;windows[1].failRestore=True
    try:store_snapshot_file(session,ROOT/'restore-error.pptx',FILTERS['pptx'])
    except RuntimeError as error:assert str(error).startswith('NATIVE_INPUT_RESTORE_FAILED|')
    else:raise AssertionError('failed restoration hidden')
    assert windows[0].enabled and not manager.locked, 'one disposed window must not skip restoring the other controller'
    assert not list(ROOT.glob('*.odp')), 'original or restoration failures cannot retain native intermediate documents'
`);
});
