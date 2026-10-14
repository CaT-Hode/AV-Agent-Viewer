import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { officeKitWorkerSource } from '../packages/office-runtime/src/kit-worker-source';

const program = join(process.cwd(), 'release', 'win-unpacked', 'resources', 'engines', 'libreoffice', 'program');
const core = existsSync(program) ? readdirSync(program).find(name => /^python-core-\d/.test(name)) : undefined;
const python = core ? join(program, core, 'bin', 'python.exe') : 'python';
function scenario(body: string) {
  const script = `import ast,json,math,ctypes as C\nsource=json.loads(input())\nmodule=ast.parse(source)\ncompile(module,'kit-worker.py','exec')\nnodes=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name in ['reveal_native_target','surface_size','surface_origin_css','clip_capture_geometry','native_input']]\nassert len(nodes)==5\nexec(compile(ast.Module(body=nodes,type_ignores=[]),'reveal-regression','exec'))\n${body}\nprint('PASS')`;
  assert.equal(execFileSync(python, ['-c', script], { input: JSON.stringify(officeKitWorkerSource) + '\n', encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: core ? program + ';' + process.env.PATH : process.env.PATH, ...(core ? { PYTHONHOME: join(program, core) } : {}), PYTHONUTF8: '1' } }).trim(), 'PASS');
}
const setup = String.raw`
events=[];native=[]
rect_values=lambda r:dict(r)
kit_size=lambda s:{'width':100000,'height':100000}
event_identity=lambda s,v:{'sessionId':'current-session','viewId':'current-view','engineEpoch':'current-epoch'}
emit=events.append;I=None
doc_call=lambda *args:lambda *values:native.append(values)
session={'format':'docx'}
view={'layoutReady':True,'visibleTwips':{'x':0,'y':0,'width':18000,'height':12000},'viewportCss':{'width':1200,'height':800},'zoom':1,'layoutRevision':7,'documentOriginCss':{'x':0,'y':0},'partIndex':2}
`;
test('native offscreen reveal moves only the requested view and keeps input coordinates aligned with its new scroll', () => {
  scenario(setup + String.raw`
target={'x':38000,'y':30000,'width':1600,'height':400}
reveal_native_target(session,view,target)
visible=view['visibleTwips'];event=events[-1]
assert visible['x']<=target['x'] and target['x']+target['width']<=visible['x']+visible['width']
assert visible['y']<=target['y'] and target['y']+target['height']<=visible['y']+visible['height']
assert view['layoutRevision']==8 and event['viewId']=='current-view' and event['partIndex']==2
assert event['scrollCss']['x']>0 and event['scrollCss']['y']>0
assert view['documentOriginCss']['x']==-event['scrollCss']['x']
assert view['documentOriginCss']['y']==-event['scrollCss']['y']
screen_x=target['x']/15+view['documentOriginCss']['x']
assert math.isclose((screen_x-view['documentOriginCss']['x'])*15,target['x'])
assert native[-1]==tuple(round(visible[k]) for k in ['x','y','width','height'])
`);
});
test('empty Calc targets extend only their real sheet view instead of clamping navigation to the populated area', () => {
  scenario(setup + String.raw`
session={'format':'xlsx'}
kit_size=lambda s:{'width':20000,'height':16000}
target={'x':38000,'y':30000,'width':1600,'height':400}
reveal_native_target(session,view,target)
size=surface_size(session,view);visible=view['visibleTwips']
assert size['width']>=target['x']+target['width'] and size['height']>=target['y']+target['height']
assert visible['x']<=target['x'] and target['x']+target['width']<=visible['x']+visible['width']
assert visible['y']<=target['y'] and target['y']+target['height']<=visible['y']+visible['height']
other_view={'partIndex':2};assert surface_size(session,other_view)=={'width':20000,'height':16000}
view['partIndex']=1;assert surface_size(session,view)=={'width':20000,'height':16000}
assert set(session)=={'format'}
`);
});
test('native reveal avoids scroll churn for visible targets and clamps oversized ranges to real document bounds', () => {
  scenario(setup + String.raw`
reveal_native_target(session,view,{'x':1800,'y':1800,'width':600,'height':300})
assert events==[] and view['layoutRevision']==7
reveal_native_target(session,view,{'x':99000,'y':99000,'width':10000,'height':30000})
assert view['visibleTwips']['x']==82000 and view['visibleTwips']['y']==88000
assert len(events)==1
before=dict(view['visibleTwips']);view['layoutReady']=False
reveal_native_target(session,view,{'x':0,'y':0,'width':1,'height':1})
assert view['visibleTwips']==before and len(events)==1
`);
});

test('a harness scroll updates the screenshot and next input origin before the renderer layout acknowledgement', () => {
  scenario(setup + String.raw`
expected=lambda *args:None;state=lambda s,v:dict(v)
args={'expectedLayoutRevision':7,'action':{'kind':'scroll','x':40,'y':30,'deltaX':350,'deltaY':480}}
list(native_input(session,view,args))
assert view['layoutRevision']==8
assert view['documentOriginCss']=={'x':-350,'y':-480}
assert events[-1]['scrollCss']=={'x':350,'y':480}
# A next viewport-local input and capture must map to the same document point,
# without waiting for a later DOM observer to replace the origin.
assert math.isclose((40-view['documentOriginCss']['x'])*15,5850)
assert math.isclose((30-view['documentOriginCss']['y'])*15,7650)
assert session['operationActor'] is None
`);
});

test('capture retains real blank Calc cells in an expanded sheet view and still clips an unrelated sheet', () => {
  scenario(setup + String.raw`
session={'format':'xlsx'};kit_size=lambda s:{'width':20000,'height':16000}
target={'x':38000,'y':30000,'width':1600,'height':400}
reveal_native_target(session,view,target)
overlaps=lambda a,b:a['x']<b['x']+b['width'] and a['x']+a['width']>b['x'] and a['y']<b['y']+b['height'] and a['y']+a['height']>b['y']
buffer=(C.c_ubyte*(16*4*4))(*([255]*(16*4*4)))
clip_capture_geometry(session,view,buffer,16,4,target)
assert all(value==255 for value in buffer),'legal visible blank cells must not become transparent'
view['partIndex']=1
clip_capture_geometry(session,view,buffer,16,4,target)
assert all(value==0 for value in buffer),'sheet-specific extent cannot leak into another sheet'
assert set(session)=={'format'}
`);
});

test('a fitted PPT retains its vertical canvas origin after a clamped harness scroll and the next click', () => {
  scenario(setup + String.raw`
session={'format':'pptx'};kit_size=lambda s:{'width':12000,'height':6000}
view['visibleTwips']={'x':0,'y':0,'width':12000,'height':6000};view['documentOriginCss']={'x':200,'y':200}
expected=lambda *args:None;state=lambda s,v:dict(v)
list(native_input(session,view,{'expectedLayoutRevision':7,'action':{'kind':'scroll','x':240,'y':240,'deltaX':350,'deltaY':480}}))
assert view['documentOriginCss']=={'x':200,'y':200}
assert events[-1]['scrollCss']=={'x':0,'y':0}
inputs=[];post_input_event=lambda s,v,event:inputs.append(event)
list(native_input(session,view,{'expectedLayoutRevision':8,'action':{'kind':'click','x':240,'y':240}}))
assert len(inputs)==2 and all(event['pointTwips']=={'x':600,'y':600} for event in inputs)
# The next viewport-local screenshot maps to that identical native point.
assert (240-view['documentOriginCss']['y'])*15==600
`);
});

test('PPT horizontal target reveal preserves vertical centring while other formats remain top aligned', () => {
  scenario(setup + String.raw`
session={'format':'pptx'};kit_size=lambda s:{'width':30000,'height':6000}
view['visibleTwips']={'x':0,'y':0,'width':18000,'height':6000};view['documentOriginCss']={'x':0,'y':200}
reveal_native_target(session,view,{'x':25000,'y':2000,'width':1200,'height':800})
assert events[-1]['scrollCss']['x']>0 and events[-1]['scrollCss']['y']==0
assert view['documentOriginCss']['x']==-events[-1]['scrollCss']['x']
assert view['documentOriginCss']['y']==200
kit_size=lambda s:{'width':12000,'height':6000}
for format in ['docx','xlsx']:
    session={'format':format};assert surface_origin_css(session,view,{'x':0,'y':0})=={'x':200,'y':0}
session={'format':'pptx'};kit_size=lambda s:{'width':30000,'height':18000}
assert surface_origin_css(session,view,{'x':7500,'y':6000})=={'x':-500,'y':-400}
`);
});
