import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { officeKitWorkerSource } from '../packages/office-runtime/src/kit-worker-source';

const program = join(process.cwd(), 'release', 'win-unpacked', 'resources', 'engines', 'libreoffice', 'program');
const core = existsSync(program) ? readdirSync(program).find(name => /^python-core-\d/.test(name)) : undefined;
const python = core ? join(program, core, 'bin', 'python.exe') : 'python';
function check(names: string[], scenario: string) {
  const script = `import ast, json\nfrom types import SimpleNamespace as NS\nsource=json.loads(input())\nmodule=ast.parse(source)\ncompile(module,'kit-worker.py','exec')\nnames=${JSON.stringify(names)}\nnodes=[node for node in module.body if isinstance(node,ast.FunctionDef) and node.name in names]\nassert len(nodes)==len(names)\ndef fail(code,message):raise RuntimeError(code+'|'+message)\nexec(compile(ast.Module(body=nodes,type_ignores=[]),'kit-history-regression','exec'))\n${scenario}\nprint('PASS')`;
  assert.equal(execFileSync(python, ['-c', script], { input: JSON.stringify(officeKitWorkerSource) + '\n', encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: core ? program + ';' + process.env.PATH : process.env.PATH, ...(core ? { PYTHONHOME: join(program, core) } : {}), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }).trim(), 'PASS');
}

test('PPT model undo rejects native caret or composition even when the editing callback reports false', () => {
  check(['require_stable_history'], String.raw`
for field in ['caretVisible','nativeEditing','composition']:
    session={'format':'pptx','views':{'requested':{'nativeEditing':False},'other':{field:True}}}
    try:require_stable_history(session)
    except RuntimeError as error:assert str(error).startswith('NATIVE_PENDING_INPUT|')
    else:raise AssertionError('an active same-model Outliner was accepted')
require_stable_history({'format':'pptx','views':{'a':{},'closed':{'caretVisible':True,'disposed':True}}})
require_stable_history({'format':'docx','views':{'a':{'caretVisible':True}}})
`);
});

test('native undo history repairs a missing modify event and invalidates only live views', () => {
  check(['native_history_signature', 'reconcile_history_revision'], String.raw`
undo=['real text transaction'];redo=[];events=[];damages=[]
manager=NS(getAllUndoActionTitles=lambda:undo,getAllRedoActionTitles=lambda:redo)
session={'doc':NS(getUndoManager=lambda:manager),'sessionId':'same-model','engineRevision':3,'operationActor':'agent','views':{'a':{'viewId':'a'},'b':{'viewId':'b'},'closed':{'viewId':'closed','disposed':True}}}
emit=events.append;invalidate=lambda owner,view:damages.append(view['viewId'])
before=native_history_signature(session)
undo.clear();redo.append('real text transaction')
assert reconcile_history_revision(session,3,before)
assert session['engineRevision']==4 and session['unsavedContentChanges'] is True
assert events==[{'type':'changed','sessionId':'same-model','engineRevision':4,'actor':'agent'}]
assert damages==['a','b']
assert not reconcile_history_revision(session,3,before), 'an already emitted revision cannot be duplicated'
`);
});

test('history reads and listener-confirmed edits do not receive speculative revision changes', () => {
  check(['native_history_signature', 'reconcile_history_revision'], String.raw`
undo=['real text transaction'];redo=[]
manager=NS(getAllUndoActionTitles=lambda:undo,getAllRedoActionTitles=lambda:redo)
session={'doc':NS(getUndoManager=lambda:manager),'engineRevision':3,'views':{}}
emit=lambda value:(_ for _ in ()).throw(AssertionError('unexpected synthetic event'))
invalidate=lambda *args:(_ for _ in ()).throw(AssertionError('unexpected damage'))
before=native_history_signature(session)
assert not reconcile_history_revision(session,3,before)
undo.clear();redo.append('real text transaction');session['engineRevision']=4
assert not reconcile_history_revision(session,3,before)
`);
});

test('native redo confirms its history transition after UI turns before repairing its version', () => {
  check(['dispatch_with_history'], String.raw`
session={'engineRevision':3};history=[(['action'],[])];seen=[]
native_history_signature=lambda owner:history[0]
dispatch_command=lambda *args:'applied'
reconcile_history_revision=lambda owner,revision,before:seen.append((revision,before,history[0]))
task=dispatch_with_history(session,{},'.uno:Redo',{},'redo')
next(task);assert not seen
next(task);assert not seen
history[0]=([],['action'])
try:next(task)
except StopIteration as done:assert done.value=='applied'
else:raise AssertionError('redo did not complete after UI turns')
assert seen==[(3,(['action'],[]),([],['action']))]
`);
});

test('default Undo and Redo use the same model manager while parameterized history commands fail explicitly', () => {
  check(['dispatch_command'], String.raw`
actions=[];manager=NS(undo=lambda:actions.append('undo'),redo=lambda:actions.append('redo'))
session={'doc':NS(getUndoManager=lambda:manager)}
require_stable_history=lambda owner:actions.append('guard')
command_status=lambda view,command:{'enabled':True}
activate=lambda *args:(_ for _ in ()).throw(AssertionError('unconfirmed queued command used'))
assert dispatch_command(session,{},'.uno:Undo',{},'undo')=='applied'
assert dispatch_command(session,{},'.uno:Redo',{},'redo')=='applied'
assert actions==['guard','undo','guard','redo']
try:dispatch_command(session,{},'.uno:Undo',{'Undo':3},'counted-undo')
except RuntimeError as error:assert str(error).startswith('INVALID_NATIVE_HISTORY_ARGS|')
else:raise AssertionError('parameterized history was silently executed with default arguments')
assert actions==['guard','undo','guard','redo','guard']
`);
});
