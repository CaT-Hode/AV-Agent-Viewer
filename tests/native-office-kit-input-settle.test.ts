import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { officeKitWorkerSource } from '../packages/office-runtime/src/kit-worker-source';

const program = join(process.cwd(), 'release', 'win-unpacked', 'resources', 'engines', 'libreoffice', 'program');
const core = existsSync(program) ? readdirSync(program).find(name => /^python-core-\d/.test(name)) : undefined;
const python = core ? join(program, core, 'bin', 'python.exe') : 'python';
function scenario(names: string[], body: string) {
  const script = `import ast,json,hashlib,queue,math\nfrom types import SimpleNamespace as NS\nsource=json.loads(input())\nmodule=ast.parse(source)\ncompile(module,'kit-worker.py','exec')\nnames=${JSON.stringify(names)}\nnodes=[n for n in module.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names]\nassert len(nodes)==len(names)\nclock=[0.]\ntime=NS(monotonic=lambda:clock[0])\nunohelper=NS(Base=type('Base',(object,),{}));XCallback=type('XCallback',(object,),{})\ndef fail(code,message):raise RuntimeError(code+'|'+message)\nexec(compile(ast.Module(body=nodes,type_ignores=[]),'input-settle-regression','exec'))\nif 'native_event_fence' not in names:native_event_fence=lambda:None\n${body}\nprint('PASS')`;
  assert.equal(execFileSync(python, ['-c', script], { input: JSON.stringify(officeKitWorkerSource) + '\n', encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: core ? program + ';' + process.env.PATH : process.env.PATH, ...(core ? { PYTHONHOME: join(program, core) } : {}), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }).trim(), 'PASS');
}

test('explicit Calc save waits for delayed native callbacks without clearing pending flags or replaying Return', () => {
  scenario(['NativeUiDelay','native_input_pending','settle_native_input','input_request'], String.raw`
session={'format':'xlsx'};view={'inputStreams':{},'nativeEditing':True,'caretVisible':True,'layoutRevision':1}
calls=[];restored=[];I=None
target=object();view['controller']=NS(getSelection=lambda:target,select=lambda value:restored.append(value))
checked_integer=lambda value,*bounds:value
doc_call=lambda owner,name,*args:(lambda:0) if name=='getPart' else lambda *values:calls.append(values)
post_input_event=lambda *args:None
state=lambda owner,item:{'pendingInput':native_input_pending(owner,item)}
task=input_request(session,view,{'streamId':'human','sequence':1,'layoutRevision':1,'expectedPartIndex':0,'event':{'kind':'barrier'}})
next(task);next(task)
assert calls==[(0,0,1280),(1,0,1280)]
assert isinstance(next(task),NativeUiDelay)
assert view['nativeEditing'] and view['caretVisible'] and not restored
# Only the real native callback, simulated here, ends pending input.
view['nativeEditing']=False;view['caretVisible']=False
next(task);assert restored==[target]
try:next(task)
except StopIteration as completed:assert completed.value['state']['pendingInput'] is False
else:raise AssertionError('save acknowledgement remained suspended')
assert calls==[(0,0,1280),(1,0,1280)] and session['operationActor'] is None
`);
});

test('the native event fence drains key, accelerator and callback events before reporting input completion', () => {
  scenario(['native_event_fence'], String.raw`
pump=NS(executing=True);vcl_main_thread=lambda:True;vcl_system_loop=lambda:False
events=['Enter'];processed=[];view={'selection':'Z50','pendingInput':True}
def vcl_reschedule(all_current):
    assert all_current is True
    if not events:return False
    current=list(events);events.clear()
    for event in current:
        processed.append(event)
        if event=='Enter':events.append('accelerator')
        elif event=='accelerator':view['selection']='Z51';events.append('callback-flush')
        elif event=='callback-flush':view['pendingInput']=False
    return True
assert native_event_fence()==3
assert processed==['Enter','accelerator','callback-flush'] and not events
assert view=={'selection':'Z51','pendingInput':False}
`);
});

test('native event draining refuses another thread/system loop and has a bounded busy result', () => {
  scenario(['native_event_fence'], String.raw`
pump=NS(executing=True);vcl_main_thread=lambda:True;vcl_system_loop=lambda:False
calls=[]
def vcl_reschedule(all_current):calls.append(all_current);clock[0]+=.8;return True
try:native_event_fence()
except RuntimeError as error:assert str(error).startswith('NATIVE_EVENT_FENCE_BUSY|')
else:raise AssertionError('a perpetual event queue was acknowledged')
assert calls==[True,True,True]
for main,system,executing in [(False,False,True),(True,True,True),(True,False,False)]:
    vcl_main_thread=lambda:main;vcl_system_loop=lambda:system;pump.executing=executing
    before=len(calls)
    try:native_event_fence()
    except RuntimeError as error:assert str(error).startswith('NATIVE_EVENT_FENCE_UNAVAILABLE|')
    else:raise AssertionError('input processing lost its controlled UI thread')
    assert len(calls)==before
`);
});

test('document keys, text, pointers and window events invoke the real processing fence after posting', () => {
  scenario(['checked_integer','post_input_event'], String.raw`
calls=[];I=U=S=None;activate=lambda *args:None;key_code=lambda event:1280
mouse_buttons=lambda value:value;mouse_modifiers=lambda event:0
def doc_call(owner,name,*types):return lambda *values:calls.append(name)
native_event_fence=lambda:calls.append('fence')
view={};session={}
for event,expected in [({'kind':'key','phase':'down'},['postKeyEvent','fence']),({'kind':'text','text':'native IME'},['postWindowExtTextInputEvent','postWindowExtTextInputEvent','fence']),({'kind':'barrier'},['fence']),({'kind':'pointer','phase':'down','pointTwips':{'x':1,'y':2},'buttons':1},['postMouseEvent','fence'])]:
    calls.clear();post_input_event(session,view,event);assert calls==expected
calls.clear();post_input_event(session,view,{'kind':'key','phase':'down'}, {'id':7,'instanceId':'native-window'})
assert calls==['postWindowKeyEvent','fence']
`);
});

test('queued input for an old native part is rejected before text, keys, pointers or a save commit can execute', () => {
  scenario(['checked_integer','input_request'], String.raw`
I=None;calls=[]
doc_call=lambda *args:lambda:3
post_input_event=lambda *args:calls.append('posted')
for event in [{'kind':'text','text':'old slide'},{'kind':'key','phase':'down','key':'Delete'},{'kind':'pointer','phase':'down'},{'kind':'barrier'}]:
    session={'format':'pptx'};view={'inputStreams':{},'layoutRevision':5}
    task=input_request(session,view,{'streamId':'human','sequence':1,'layoutRevision':5,'expectedPartIndex':2,'event':event})
    try:next(task)
    except RuntimeError as error:assert str(error).startswith('STALE_OFFICE_SURFACE_PART|')
    else:raise AssertionError('an old-part edit was retargeted')
    assert not view['inputStreams'] and 'operationActor' not in session
assert not calls
# A malformed/missing frozen part cannot silently accept the current part.
task=input_request({}, {'inputStreams':{}}, {'streamId':'human','sequence':1,'event':{'kind':'text','text':'missing'}})
try:next(task)
except RuntimeError as error:assert str(error).startswith('INVALID_OFFICE_SURFACE_INPUT|')
else:raise AssertionError('an absent target identity was accepted')
`);
});

test('an acknowledged duplicate keeps its receipt after navigation while window input uses its own identity', () => {
  scenario(['checked_integer','input_request'], String.raw`
I=None;calls=[];receipt={'ackSequence':1}
args={'streamId':'human','sequence':1,'expectedPartIndex':0,'event':{'kind':'text','text':'once'}}
signature=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
view={'inputStreams':{('document','human'):{'sequence':1,'signature':signature,'result':receipt}}}
doc_call=lambda *args:(_ for _ in ()).throw(AssertionError('duplicate input looked up or changed its new target'))
task=input_request({},view,args)
try:next(task)
except StopIteration as completed:assert completed.value is receipt
else:raise AssertionError('duplicate input was executed again')
post_input_event=lambda *args:calls.append('window-input');state=lambda *args:{'pendingInput':False}
session={};window={'instanceId':'actual-window-instance'};view={'inputStreams':{}}
task=input_request(session,view,{'streamId':'window','sequence':1,'event':{'kind':'text','text':'dialog'}},window)
next(task);next(task)
try:next(task)
except StopIteration as completed:assert completed.value['ackSequence']==1
else:raise AssertionError('window input did not complete')
assert calls==['window-input']
`);
});

test('a retired hover consumes its sequence with an explicit discard while leaving the actual target and actor untouched', () => {
  scenario(['checked_integer','input_request'], String.raw`
I=None;selected={'kind':'text','text':'committed selection'}
session={'format':'pptx','operationActor':None};view={'inputStreams':{},'layoutRevision':23,'actor':'agent','selection':selected}
doc_call=lambda *args:lambda:0
state=lambda owner,item:{'layoutRevision':item['layoutRevision'],'actor':item['actor'],'selection':item['selection'],'pendingInput':False}
post_input_event=lambda *args:(_ for _ in ()).throw(AssertionError('obsolete hover was posted'))
args={'streamId':'human','sequence':1,'layoutRevision':22,'expectedPartIndex':0,'event':{'kind':'pointer','phase':'move','buttons':0,'pointTwips':{'x':1,'y':2}}}
task=input_request(session,view,args)
try:next(task)
except StopIteration as completed:receipt=completed.value
else:raise AssertionError('a discarded hover requested UI execution')
assert receipt['ackSequence']==1 and receipt['discarded']['code']=='STALE_OFFICE_SURFACE_LAYOUT'
assert receipt['discarded']['reason'] and receipt['state']['layoutRevision']==23
assert receipt['state']['selection'] is selected and receipt['state']['actor']=='agent'
assert view['selection'] is selected and view['actor']=='agent' and session['operationActor'] is None
assert view['inputStreams'][('document','human')]['result'] is receipt
state=lambda *args:(_ for _ in ()).throw(AssertionError('duplicate discard looked up a new target'))
doc_call=lambda *args:(_ for _ in ()).throw(AssertionError('duplicate discard consulted or modified native input'))
task=input_request(session,view,args)
try:next(task)
except StopIteration as completed:assert completed.value is receipt
else:raise AssertionError('discarded hover was replayed')
`);
});

test('stale press, release, dragging and selection handles stay errors and a hover cannot bypass native part identity', () => {
  scenario(['checked_integer','input_request'], String.raw`
I=None;doc_call=lambda *args:lambda:0
post_input_event=lambda *args:(_ for _ in ()).throw(AssertionError('a stale edit was posted'))
state=lambda *args:(_ for _ in ()).throw(AssertionError('a stale edit was acknowledged'))
for event in [{'kind':'pointer','phase':'down','buttons':1},{'kind':'pointer','phase':'up','buttons':0},{'kind':'pointer','phase':'cancel','buttons':0},{'kind':'pointer','phase':'move','buttons':1},{'kind':'selection-handle','edge':'start'}]:
    view={'inputStreams':{},'layoutRevision':23};session={}
    task=input_request(session,view,{'streamId':'human','sequence':1,'layoutRevision':22,'expectedPartIndex':0,'event':event})
    try:next(task)
    except RuntimeError as error:assert str(error).startswith('STALE_OFFICE_SURFACE_LAYOUT|')
    else:raise AssertionError('stale press/release/drag was silently discarded')
    assert not view['inputStreams'] and 'operationActor' not in session
task=input_request({}, {'inputStreams':{},'layoutRevision':23}, {'streamId':'human','sequence':1,'layoutRevision':22,'expectedPartIndex':1,'event':{'kind':'pointer','phase':'move','buttons':0}})
try:next(task)
except RuntimeError as error:assert str(error).startswith('STALE_OFFICE_SURFACE_PART|')
else:raise AssertionError('hover discard bypassed the real page/sheet target')
`);
});

test('an editor or validation dialog that does not settle fails boundedly and retains its pending input', () => {
  scenario(['NativeUiDelay','native_input_pending','settle_native_input'], String.raw`
view={'nativeEditing':True,'caretVisible':True};task=settle_native_input({'format':'xlsx'},view)
assert isinstance(next(task),NativeUiDelay)
clock[0]=2.01
try:next(task)
except RuntimeError as error:assert str(error).startswith('NATIVE_PENDING_INPUT|')
else:raise AssertionError('unstable input was acknowledged')
assert view=={'nativeEditing':True,'caretVisible':True}
# Writer's normal caret is not an unfinished cell/Outliner buffer.
assert not native_input_pending({'format':'docx'},{'caretVisible':True})
assert native_input_pending({'format':'docx'},{'composition':{'id':'ime'}})
`);
});

test('RPC suspension leaves time for native callback flush and keeps later requests serialized', () => {
  scenario(['NativeUiDelay','RpcPump'], String.raw`
events=[];scheduled=[];timers=[];advanced=[]
request_queue=queue.Queue();request_queue.put({'id':'first'});request_queue.put({'id':'second'})
def handle_request(request):
    advanced.append(request['id']);yield NativeUiDelay(.01)
    advanced.append(request['id']+'-done');return request['id']
class Timer:
    def __init__(self,seconds,callback):self.callback=callback;timers.append(self)
    def start(self):pass
threading=NS(Timer=Timer);async_service=NS(addCallback=lambda callback,arg:scheduled.append(callback))
emit=events.append;quitting=False;shutdown_event=NS(set=lambda:None)
pump=RpcPump();pump.notify(None)
assert advanced==['first'] and not scheduled and len(timers)==1
# Incoming messages may post notify while a delayed save owns the UI job.
pump.notify(None);assert advanced==['first'] and request_queue.qsize()==1
clock[0]=.02;timers[0].callback();assert scheduled==[pump]
pump.notify(None)
assert advanced==['first','first-done'] and events==[{'id':'first','ok':True,'result':'first'}]
assert request_queue.qsize()==1 and scheduled==[pump,pump]
pump.notify(None);assert advanced[-1]=='second'
`);
});
