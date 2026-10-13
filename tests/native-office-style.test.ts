import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nativeOfficeStyleSource } from '../packages/office-runtime/src/native-style-source';

const bundled = join(process.env.LOCALAPPDATA ?? '', 'Programs/AgentViewer/resources/engines/libreoffice/program/python.exe');
const python = existsSync(bundled) ? bundled : 'python';
const fixture = String.raw`
import copy, json, math, re, uuid
from types import SimpleNamespace as NS
def fail(code,message):raise RuntimeError(code+'|'+message)
constant=lambda name,fallback:fallback
class AnyValue:
    def __init__(self,type,value):self.type=type;self.value=value
uno=NS(getTypeByName=lambda name:name,Any=lambda type,value:AnyValue(type,value),Enum=lambda type,value:NS(typeName=type,value=value),createUnoStruct=lambda name:NS())
unohelper=NS(Base=type('UnoBase',(),{}));XUndoAction=type('XUndoAction',(),{})
exec(json.loads(input()),globals())
TEXT_PROPS={'CharFontName':'Arial','CharFontNameAsian':'Source Han Serif','CharFontNameComplex':'Arial','CharHeight':12.,'CharHeightAsian':12.,'CharHeightComplex':12.,'CharWeight':100.,'CharWeightAsian':100.,'CharWeightComplex':100.,'CharPosture':NS(value='NONE'),'CharPostureAsian':NS(value='NONE'),'CharPostureComplex':NS(value='NONE'),'CharUnderline':0,'CharStrikeout':0,'CharColor':0x223344,'CharBackColor':-1,'CharBackTransparent':True}
def property_type(name,value):
    if name.startswith('CharPosture'):return 'com.sun.star.awt.FontSlant'
    if name in ['FillStyle','LineStyle']:return 'com.sun.star.drawing.'+name
    if name=='ParaAdjust':return 'short'
    if name=='HoriJustify':return 'com.sun.star.table.CellHoriJustify'
    if name=='VertJustify':return 'long'
    if name=='ParaLineSpacing':return 'com.sun.star.style.LineSpacing'
    if type(value) is bool:return 'boolean'
    if type(value) is str:return 'string'
    if type(value) is float:return 'float'
    return 'long'
class Target:
    def __init__(self,properties=None,types=None):
        self.values=copy.deepcopy(properties if properties is not None else TEXT_PROPS);self.types=set(types or ['com.sun.star.text.XTextRange']);self.states={};self.readonly=set();self.writes=[];self.failOnce=None;self.position=NS(X=100,Y=200);self.size=NS(Width=4000,Height=3000)
    def queryInterface(self,name):return self if name in self.types else None
    def getPropertySetInfo(self):return NS(getProperties=lambda:[NS(Name=name,Attributes=16 if name in self.readonly else 0,Type=NS(typeName=property_type(name,value))) for name,value in self.values.items()])
    def getPropertyValues(self,names):return tuple(self.values[name] for name in names)
    def getPropertyStates(self,names):return tuple(self.getPropertyState(name) for name in names)
    def getPropertyValue(self,name):return self.values[name]
    def getPropertyState(self,name):return self.states.get(name,'DIRECT_VALUE')
    def setPropertyValue(self,name,value):
        if self.failOnce==name:self.failOnce=None;raise ValueError('native setter rejected')
        self.writes.append((name,value));self.values[name]=value.value if isinstance(value,AnyValue) else value;self.states[name]='DIRECT_VALUE';session['engineRevision']+=1
    def setPropertyToDefault(self,name):self.states[name]='DEFAULT_VALUE'
    def getString(self):return 'selected text'
    def getPosition(self):return self.position
    def getSize(self):return self.size
    def setPosition(self,value):self.position=value;session['engineRevision']+=1
    def setSize(self,value):self.size=value;session['engineRevision']+=1
    def getRangeAddress(self):return NS(Sheet=0,StartColumn=0,EndColumn=1,StartRow=0,EndRow=1)
class Window:
    def __init__(self):self.enabled=True;self.calls=[]
    def isEnabled(self):return self.enabled
    def setEnable(self,value):self.calls.append(value);self.enabled=value
class Manager:
    def __init__(self):self.history=['previous real edit'];self.redo=[];self.clearCalls=0;self.open=False
    def isLocked(self):return False
    def getAllUndoActionTitles(self):return tuple(self.history)
    def getAllRedoActionTitles(self):return tuple(self.redo)
    def enterUndoContext(self,label):
        assert not self.open;self.open=True;self.label=label;self.original=[copy.deepcopy((value.values,value.states,value.position,value.size)) for value in targets];self.before=session['engineRevision']
    def leaveUndoContext(self):
        assert self.open;self.open=False
        if session['engineRevision']!=self.before:self.history.insert(0,self.label);self.redo=[]
    def undo(self):
        self.redo.insert(0,self.history.pop(0))
        for value,original in zip(targets,self.original):value.values,value.states,value.position,value.size=copy.deepcopy(original)
        session['engineRevision']+=1
    def clearRedo(self):self.clearCalls+=1;self.redo=[]
    def addUndoAction(self,action):self.action=action;self.history.insert(0,action.getTitle());self.redo=[]
class Formats:
    def __init__(self):self.items={7:'General'};self.removed=[]
    def queryKey(self,code,locale,scan):return next((key for key,value in self.items.items() if value==code),-1)
    def addNew(self,code,locale):self.items[9]=code;return 9
    def removeByKey(self,key):self.removed.append(key);del self.items[key]
    def getByKey(self,key):return NS(getPropertyValue=lambda name:self.items[key])
def setup(values,format='docx',selected=None):
    global targets,session,view,manager,window
    targets=values;manager=Manager();window=Window();selection=selected if selected is not None else NS(queryInterface=lambda name:None,getCount=lambda:len(targets),getByIndex=lambda index:targets[index])
    view={'controller':NS(getSelection=lambda:selection),'frame':NS(getContainerWindow=lambda:window)}
    session={'format':format,'doc':NS(getUndoManager=lambda:manager,NumberFormats=Formats()),'views':{'view':view},'engineRevision':4,'selectionEpoch':2}
    return {'expectedEngineRevision':4,'expectedSelectionEpoch':2}
def expected(session,view,args):
    if args['expectedEngineRevision']!=session['engineRevision']:fail('REVISION_CONFLICT','changed')
    if args['expectedSelectionEpoch']!=session['selectionEpoch']:fail('SELECTION_CHANGED','changed')
own_ime_pending=lambda view:False
`;
function check(scenario: string) {
  assert.equal(execFileSync(python, ['-c', fixture + '\n' + scenario + "\nprint('PASS')"], {
    input: JSON.stringify(nativeOfficeStyleSource) + '\n', encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  }).trim(), 'PASS');
}

test('text style inspection aggregates supported scripts and native property states instead of reporting only Latin fonts', () => {
  check(String.raw`
args=setup([Target()]);inspection=inspect_native_style(session,view,'text')
assert inspection['fields']['fontFamily']=={'value':None,'state':'mixed','available':True}
assert inspection['fields']['color']['value']=='223344'
targets[0].states['CharHeightAsian']='AMBIGUOUS_VALUE'
assert inspect_native_style(session,view,'text')['fields']['fontSize']['state']=='mixed'
apply_native_style(session,view,{'target':'text','values':{'fontFamily':'Noto Serif CJK SC','fontSize':18,'bold':True,'italic':True}},args)
for suffix in ['', 'Asian','Complex']:
    assert targets[0].values['CharFontName'+suffix]=='Noto Serif CJK SC'
    assert targets[0].values['CharHeight'+suffix]==18 and targets[0].values['CharWeight'+suffix]==150.
    assert targets[0].values['CharPosture'+suffix].value=='ITALIC'
assert manager.history[1:]==['previous real edit'] and len(manager.history)==2 and window.enabled
assert inspect_native_style(session,view,'text')['fields']['fontFamily']['value']=='Noto Serif CJK SC'
`);
});

test('Impress active text styles are rebound to the verified committed model range and keep a real restoring undo action', () => {
  check(String.raw`
class ModelTarget(Target):
    def setPropertyValue(self,name,value):
        self.writes.append((name,value));self.values[name]=value.value if isinstance(value,AnyValue) else value;self.states[name]='DIRECT_VALUE'
active=Target();model=ModelTarget();args=setup([model],'pptx',active);modified=[];ended=[]
session['doc'].setModified=lambda value:(modified.append(value),session.__setitem__('engineRevision',session['engineRevision']+1))
style_targets=lambda session,view,kind:[active]
selected_text_range=lambda session,view:active
frozen=object()
def ppt_text_transaction_target(session,view,value):assert value is active;return frozen
def ppt_text_model_range(session,view,target,args):
    assert target is frozen and not window.enabled and not manager.open
    ended.append(target);return model
def leave_context():assert manager.open;manager.open=False
manager.leaveUndoContext=leave_context # Direct model property setters have no built-in undo action.
before=copy.deepcopy(model.values)
apply_native_style(session,view,{'target':'text','values':{'fontSize':23,'italic':True,'color':'886622'}},args)
assert ended==[frozen] and not active.writes and modified==[True] and window.enabled
for suffix in ['', 'Asian', 'Complex']:
    assert model.values['CharHeight'+suffix]==23 and model.values['CharPosture'+suffix].value=='ITALIC'
assert len(manager.history)==2 and manager.history[1]=='previous real edit'
assert manager.action.document is session['doc']
manager.action.undo()
for name in ['CharHeight','CharHeightAsian','CharHeightComplex','CharColor']:assert model.values[name]==before[name]
assert model.values['CharPosture'].value=='NONE' and modified==[True,True]
manager.action.redo()
assert model.values['CharHeight']==23 and model.values['CharColor']==0x886622 and model.values['CharPosture'].value=='ITALIC'
assert modified==[True,True,True] and not active.writes and manager.clearCalls==0
`);
});

test('explicit RGB clears only its native theme dependency and undo restores the complete immutable theme value', () => {
  check(String.raw`
class ComplexColor:
    def __init__(self,theme=4,transforms=(('Tint',1700),('LumMod',7000)),rgb=0x4472c4):self.theme=theme;self.transforms=transforms;self.rgb=rgb
    def getType(self):return 1 if self.theme<0 else 4
    def getThemeColorType(self):return self.theme
    def resolveColor(self,theme):return self.rgb
class ColorTarget(Target):
    def __init__(self):
        bag=(NS(Name='OriginalSolidFillClr',Value=0x4472c4),NS(Name='SpPrSolidFillSchemeClr',Value='accent1'),NS(Name='SpPrSolidFillSchemeClrTransformations',Value=(NS(Name='Tint',Value=1700),)),NS(Name='unrelated-data',Value='keep'),NS(Name='SpPrLnSolidFillSchemeClr',Value='accent2'))
        super().__init__({'FillColor':0x4472c4,'FillStyle':1,'FillColorTheme':4,'FillColorLumMod':7000,'FillColorLumOff':0,'FillComplexColor':ComplexColor(),'InteropGrabBag':bag},['com.sun.star.drawing.XShape'])
        self.original=copy.deepcopy(self.values)
        self.geometryWrites=[]
    def setPosition(self,value):self.geometryWrites.append('position');super().setPosition(value)
    def setSize(self,value):self.geometryWrites.append('size');super().setSize(value)
    def getPropertySetInfo(self):
        info=super().getPropertySetInfo();properties=info.getProperties()
        for p in properties:
            if p.Name=='FillComplexColor':p.Type.typeName='com.sun.star.util.XComplexColor'
            if p.Name=='InteropGrabBag':p.Type.typeName='[]com.sun.star.beans.PropertyValue'
            if p.Name.startswith('FillColor') and p.Name!='FillColor':p.Type.typeName='short'
        return NS(getProperties=lambda:properties)
    def setPropertyValue(self,name,value):
        super().setPropertyValue(name,value)
        if name in STYLE_COLOR_DEPENDENCIES['FillColor'] or name=='FillColor':
            for field in ['FillColor',*STYLE_COLOR_DEPENDENCIES['FillColor']]:self.states[field]='DIRECT_VALUE'
        if name=='FillComplexColor':
            assert isinstance(value,AnyValue) and value.type=='com.sun.star.util.XComplexColor'
            actual=value.value or ComplexColor(-1,(),0);self.values[name]=actual;self.values['FillColorTheme']=actual.theme
            self.values['FillColorLumMod']=dict(actual.transforms).get('LumMod',10000);self.values['FillColorLumOff']=dict(actual.transforms).get('LumOff',0)
    def setPropertyToDefault(self,name):
        if name in STYLE_COLOR_DEPENDENCIES['FillColor'] or name=='FillColor':
            for field in ['FillColor',*STYLE_COLOR_DEPENDENCIES['FillColor']]:self.values[field]=copy.deepcopy(self.original[field]);self.states[field]='DEFAULT_VALUE'
        else:super().setPropertyToDefault(name)
for initial in ['direct','default']:
    color=ColorTarget()
    if initial=='default':
        for name in ['FillColor',*STYLE_COLOR_DEPENDENCIES['FillColor']]:color.states[name]='DEFAULT_VALUE'
    args=setup([color],'pptx',color);manager.leaveUndoContext=lambda:setattr(manager,'open',False)
    original_complex=copy.deepcopy(color.values['FillComplexColor'])
    original_bag=copy.deepcopy(color.values['InteropGrabBag'])
    apply_native_style(session,view,{'target':'shape','values':{'fill':'b6d8cc'}},args)
    assert color.values['FillColor']==0xb6d8cc and color.values['FillComplexColor'].theme==-1 and color.values['FillComplexColor'].transforms==()
    assert [p.Name for p in color.values['InteropGrabBag']]==['unrelated-data','SpPrLnSolidFillSchemeClr']
    assert manager.action.before[0]['raw']['FillComplexColor'].transforms==original_complex.transforms
    manager.action.undo()
    assert color.values['FillColor']==0x4472c4 and color.values['FillComplexColor'].theme==4 and color.values['FillComplexColor'].transforms==original_complex.transforms
    assert style_value_key(color.values['InteropGrabBag'])==style_value_key(original_bag)
    assert color.getPropertyState('FillColor')==('DEFAULT_VALUE' if initial=='default' else 'DIRECT_VALUE')
    manager.action.redo();assert color.values['FillColor']==0xb6d8cc and color.values['FillComplexColor'].theme==-1
    assert color.geometryWrites==[], 'color-only undo must not trigger autofit by setting unchanged native geometry'
    assert manager.history[-1]=='previous real edit' and manager.clearCalls==0
color=ColorTarget();args=setup([color],'pptx',color);color.readonly.add('FillComplexColor')
try:apply_native_style(session,view,{'target':'shape','values':{'fill':'b6d8cc'}},args)
except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_FIELD_UNSUPPORTED|')
else:raise AssertionError('theme dependency not preflighted')
assert not color.writes
point=NS(X=3,Y=9,typeName='com.sun.star.awt.Point',value=NS(X=3,Y=9))
assert style_value_key(point)==(('X',3),('Y',9)), 'actual PyUNO structs expose value too; they are not enums'
`);
});

test('every selected target is preflighted before any mutation and shape text is never guessed as an edited text range', () => {
  check(String.raw`
args=setup([Target(),Target()]);targets[1].readonly.add('CharHeightAsian')
try:apply_native_style(session,view,{'target':'text','values':{'fontSize':22}},args)
except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_FIELD_UNSUPPORTED|')
else:raise AssertionError('read-only second range partially edited')
assert not any(value.writes for value in targets) and not window.calls and manager.history==['previous real edit']
shape=Target(types=['com.sun.star.drawing.XShape','com.sun.star.text.XTextRange']);args=setup([shape],'pptx',shape)
assert all(not field['available'] for field in inspect_native_style(session,view,'text')['fields'].values())
try:apply_native_style(session,view,{'target':'text','values':{'bold':True}},args)
except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_TARGET_UNAVAILABLE|')
else:raise AssertionError('whole selected shape text treated as text selection')
`);
});

test('typed paragraph and cell fields respect native short, long, enum and struct types and mm/pt conversions', () => {
  check(String.raw`
props={'ParaAdjust':0,'ParaLeftMargin':0,'ParaRightMargin':0,'ParaFirstLineIndent':0,'ParaTopMargin':0,'ParaBottomMargin':0,'ParaLineSpacing':NS(Mode=0,Height=100)}
args=setup([Target(props)]);style_targets=lambda session,view,kind:targets
apply_native_style(session,view,{'target':'paragraph','values':{'alignment':'center','left':12.5,'firstLine':-2,'lineSpacingPercent':150}},args)
written=dict(targets[0].writes)
assert written['ParaAdjust'].type=='short' and written['ParaAdjust'].value==3
assert targets[0].values['ParaLeftMargin']==1250 and targets[0].values['ParaFirstLineIndent']==-200
assert targets[0].values['ParaLineSpacing'].Mode==0 and targets[0].values['ParaLineSpacing'].Height==150
props={**TEXT_PROPS,'HoriJustify':NS(value='LEFT'),'VertJustify':1,'IsTextWrapped':False,'CellBackColor':0,'NumberFormat':7,'CharLocale':NS(Language='en')}
cell=Target(props,['com.sun.star.sheet.XSheetCellRange']);args=setup([cell],'xlsx',cell)
apply_native_style(session,view,{'target':'cells','values':{'verticalAlignment':'center','alignment':'justify','wrap':True,'fill':'abcdef','numberFormat':'0.00'}},args)
written=dict(cell.writes)
assert written['VertJustify'].type=='long' and written['VertJustify'].value==2
assert written['HoriJustify'].typeName=='com.sun.star.table.CellHoriJustify' and written['HoriJustify'].value=='BLOCK'
assert cell.values['CellBackColor']==0xabcdef and cell.values['IsTextWrapped'] is True
assert inspect_native_style(session,view,'cells')['fields']['numberFormat']['value']=='0.00'
`);
});

test('native logical START and END paragraph alignment follows actual LTR or RTL writing mode without guessing context', () => {
  check(String.raw`
props={'ParaAdjust':5,'WritingMode':0};args=setup([Target(props)]);style_targets=lambda session,view,kind:targets
assert inspect_native_style(session,view,'paragraph')['fields']['alignment']['value']=='left'
targets[0].values['ParaAdjust']=6
assert inspect_native_style(session,view,'paragraph')['fields']['alignment']['value']=='right'
targets[0].values['WritingMode']=1
assert inspect_native_style(session,view,'paragraph')['fields']['alignment']['value']=='left'
targets[0].values['ParaAdjust']=5
assert inspect_native_style(session,view,'paragraph')['fields']['alignment']['value']=='right'
for direction in [2,3,4,5,6,7,None,True]:
    targets[0].values['WritingMode']=direction
    result=inspect_native_style(session,view,'paragraph')['fields']['alignment']
    assert result['value'] is None and result['available'] and result.get('reason'), 'vertical, contextual or unavailable direction is not an assumed LTR paragraph'
targets[0].values['WritingMode']=0;targets[0].states['WritingMode']='AMBIGUOUS_VALUE'
assert inspect_native_style(session,view,'paragraph')['fields']['alignment']=={'value':None,'state':'mixed','available':True}
targets[0].states.clear();targets[0].values['WritingMode']=NS(value='RL_TB');targets[0].values['ParaAdjust']=NS(value='END')
assert inspect_native_style(session,view,'paragraph')['fields']['alignment']['value']=='left'
targets[0].values['ParaAdjust']=NS(value='START')
assert inspect_native_style(session,view,'paragraph')['fields']['alignment']['value']=='right'
targets[0].values.pop('WritingMode');result=inspect_native_style(session,view,'paragraph')['fields']['alignment'];assert result['value'] is None and result.get('reason')
targets[0].values['ParaAdjust']=3
assert inspect_native_style(session,view,'paragraph')['fields']['alignment']['value']=='center', 'physical alignment never depends on direction inference'
`);
});

test('shape updates preserve unspecified geometry and generate typed native paint values', () => {
  check(String.raw`
shape=Target({'RotateAngle':0,'FillColor':0,'FillStyle':NS(value='NONE'),'LineColor':0,'LineWidth':0,'LineStyle':NS(value='NONE'),'MoveProtect':False,'SizeProtect':False},['com.sun.star.drawing.XShape'])
args=setup([shape],'pptx',shape)
apply_native_style(session,view,{'target':'shape','values':{'x':5.5,'height':18,'rotation':32.5,'fill':'aabbcc','lineWidth':1.5}},args)
assert shape.position.X==550 and shape.position.Y==200 and shape.size.Width==4000 and shape.size.Height==1800
assert shape.values['RotateAngle']==3250 and shape.values['FillStyle'].value=='SOLID'
assert shape.values['LineWidth']==round(1.5*2540/72)
fields=inspect_native_style(session,view,'shape')['fields'];assert fields['x']['value']==5.5 and fields['rotation']['value']==32.5
shape.values['MoveProtect']=True;assert not inspect_native_style(session,view,'shape')['fields']['x']['available']
`);
});

test('a failing native setter undoes only the new transaction and restores enabled inputs without clearing prior undo history', () => {
  check(String.raw`
args=setup([Target(),Target()]);original=copy.deepcopy([value.values for value in targets]);targets[1].failOnce='CharHeightAsian'
try:apply_native_style(session,view,{'target':'text','values':{'fontSize':20}},args)
except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_APPLY_FAILED|')
else:raise AssertionError('partial multi-range mutation accepted')
assert [style_value_key(value.values['CharHeight']) for value in targets]==[12.,12.]
assert all(verify_native_style_restore({'target':value,'raw':old,'states':{},'geometry':{}}) for value,old in zip(targets,original))
assert manager.history==['previous real edit'] and manager.redo==[] and manager.clearCalls==1 and window.enabled
`);
});

test('a version change between preflight and the input guard is not rolled back as though it belonged to this style request', () => {
  check(String.raw`
args=setup([Target()]);calls=0
def expected(session,view,args):
    global calls
    calls+=1
    if calls==2:
        targets[0].values['CharColor']=0x998877;session['engineRevision']+=1;fail('REVISION_CONFLICT','a new human edit')
try:apply_native_style(session,view,{'target':'text','values':{'fontSize':20}},args)
except RuntimeError as error:assert str(error).startswith('REVISION_CONFLICT|')
else:raise AssertionError('stale style request accepted')
assert targets[0].values['CharColor']==0x998877 and not targets[0].writes and manager.history==['previous real edit'] and window.enabled
`);
});

test('a failed edit with prior redo history is explicitly unverified rather than claiming completely unchanged history', () => {
  check(String.raw`
args=setup([Target(),Target()]);manager.redo=['earlier real redo'];targets[1].failOnce='CharHeightAsian'
try:apply_native_style(session,view,{'target':'text','values':{'fontSize':20}},args)
except RuntimeError as error:assert str(error).startswith('NATIVE_STYLE_ROLLBACK_UNVERIFIED|')
else:raise AssertionError('lost pre-existing redo reported as a clean atomic failure')
assert manager.history==['previous real edit'] and manager.clearCalls==0 and window.enabled
assert all(value.values['CharHeight']==12. for value in targets)
`);
});

test('a direct shape engine without built-in undo receives one real before/after action with working restore and redo', () => {
  check(String.raw`
shape=Target({'RotateAngle':0,'FillColor':0,'FillStyle':NS(value='NONE'),'LineColor':0,'LineWidth':0,'LineStyle':NS(value='NONE'),'MoveProtect':False,'SizeProtect':False},['com.sun.star.drawing.XShape']);args=setup([shape],'pptx',shape)
def no_native_undo_leave():manager.open=False
manager.leaveUndoContext=no_native_undo_leave
apply_native_style(session,view,{'target':'shape','values':{'x':5.5,'height':18,'rotation':20,'fill':'aabbcc'}},args)
assert manager.history[1:]==['previous real edit'] and len(manager.history)==2
manager.action.undo()
assert shape.position.X==100 and shape.position.Y==200 and shape.size.Height==3000 and shape.values['RotateAngle']==0 and shape.values['FillColor']==0
manager.action.redo()
assert shape.position.X==550 and shape.size.Height==1800 and shape.values['RotateAngle']==2000 and shape.values['FillColor']==0xaabbcc
shape.states['FillColor']='AMBIGUOUS_VALUE';assert not inspect_native_style(session,view,'shape')['fields']['fill']['available']
`);
});
