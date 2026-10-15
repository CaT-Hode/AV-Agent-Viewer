import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {officeKitWorkerSource} from '../packages/office-runtime/src/kit-worker-source';
const program=join(process.cwd(),'release','win-unpacked','resources','engines','libreoffice','program');
const core=existsSync(program)?readdirSync(program).find(name=>/^python-core-\d/.test(name)):undefined;
const python=core?join(program,core,'bin','python.exe'):'python';
function scenario(body:string){
 const script=`import ast,json\nsource=json.loads(input());module=ast.parse(source);compile(module,'kit-worker','exec')\nnodes=[node for node in module.body if isinstance(node,ast.FunctionDef) and node.name in ['project_visible_text','enable_context_projection','visible_projection_key','parts_state']]\nassert len(nodes)==4\nexec(compile(ast.Module(body=nodes,type_ignores=[]),'projection-cache','exec'))\n${setup}\n${body}\nprint('PASS')`;
 assert.equal(execFileSync(python,['-c',script],{input:JSON.stringify(officeKitWorkerSource)+'\n',encoding:'utf8',timeout:15000,env:{...process.env,PATH:core?program+';'+process.env.PATH:process.env.PATH,...(core?{PYTHONHOME:join(program,core)}:{}),PYTHONUTF8:'1'}}).trim(),'PASS');
}
const setup=String.raw`
epoch='engine-epoch';session={'sessionId':'writer-session','engineRevision':3,'format':'xlsx'};view={'viewId':'reader-view','contextProjectionEnabled':True,'partIndex':0,'eventSequence':10,'zoom':1,'deviceScaleFactor':1,'visible':True,'visibleTwips':{'x':0,'y':0,'width':15000,'height':9000},'pending':False}
native_input_pending=lambda s,v:v['pending'];calls=[]
def read_visible_text(s,v):
    calls.append((s['engineRevision'],v['partIndex'],dict(v['visibleTwips'])));return ('ACTUAL_'+str(len(calls)),False,True)
`;
test('new displays skip semantic enumeration until the trusted host explicitly enables their exact view',()=>scenario(String.raw`
view.pop('contextProjectionEnabled');view['visibleProjection']={'key':'old','result':('OLD',False,True)}
for _ in range(3):assert project_visible_text(session,view)==('',False,False)
assert calls==[] and 'visibleProjection' not in view and 'semanticView' not in session,'no hidden whole-model geometry pass or stale ready text before actual presentation'
view['contextProjectionEnabled']=False
assert project_visible_text(session,view)==('',False,False) and calls==[]
other=dict(view,viewId='second-reader');other['contextProjectionEnabled']=False
ack=enable_context_projection(session,view)
assert ack=={'sessionId':'writer-session','viewId':'reader-view','engineEpoch':epoch,'enabled':True}
assert calls==[],'enabling is a cheap flag acknowledgement, not the first semantic read'
assert project_visible_text(session,other)==('',False,False) and calls==[],'the acknowledgement cannot enable another controller'
actual=project_visible_text(session,view)
assert actual==('ACTUAL_1',False,True) and len(calls)==1
assert enable_context_projection(session,view)==ack
assert project_visible_text(session,view)==actual and len(calls)==1,'repeated presentation confirmation keeps valid same-view projection reuse'
`));
test('idle viewport reuses its projection while model, part, native layout and viewport changes remain fresh',()=>scenario(String.raw`
first=project_visible_text(session,view)
assert project_visible_text(session,view)==first and len(calls)==1
for change in [lambda:session.update(engineRevision=4),lambda:view.update(partIndex=1),lambda:view.update(eventSequence=11),lambda:view['visibleTwips'].update(x=500),lambda:view.update(zoom=1.25)]:
    change();before=len(calls);project_visible_text(session,view);assert len(calls)==before+1
other=dict(view);other.pop('visibleProjection');project_visible_text(session,other);assert len(calls)==7,'separate live views cannot share a viewport projection'
`));
test('native pending buffers, unavailable geometry and a mid-read model transition cannot publish stale cached text',()=>scenario(String.raw`
project_visible_text(session,view);view['pending']=True
project_visible_text(session,view);project_visible_text(session,view);assert len(calls)==3 and 'visibleProjection' not in view
view['pending']=False;view['visible']=False
assert project_visible_text(session,view)==('',False,False)
view['visible']=True;project_visible_text(session,view);assert len(calls)==4
def read_visible_text(s,v):
    calls.append('changed while probing');s['engineRevision']+=1;return ('AFTER_TRANSITION',False,True)
view['eventSequence']+=1;project_visible_text(session,view);assert 'visibleProjection' not in view
def read_visible_text(s,v):
    calls.append('geometry unavailable');return ('',False,False)
project_visible_text(session,view);project_visible_text(session,view);assert calls[-2:]==['geometry unavailable','geometry unavailable']
`));
test('part catalog caches names but still checks actual part count and model/layout changes',()=>scenario(String.raw`
I=P=None;native_calls=[];count=2;names=['One','Two'];kit_string=lambda text:text
def doc_call(s,name,result,*types):
    def invoke(*args):
        native_calls.append(name)
        return count if name=='getParts' else names[args[0]]
    return invoke
first=parts_state(session);assert [p['name'] for p in first]==names
parts_state(session);assert native_calls.count('getParts')==2 and native_calls.count('getPartName')==2
names[0]='Renamed';session['engineRevision']+=1;assert parts_state(session)[0]['name']=='Renamed'
before=native_calls.count('getPartName');session['partGeometryGeneration']=1;parts_state(session);assert native_calls.count('getPartName')==before+2
count=3;names.append('Three');assert len(parts_state(session))==3 and parts_state(session)[2]['name']=='Three'
`));
