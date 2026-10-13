import assert from 'node:assert/strict';
import { _electron as electron, type Page } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserAction, DocumentModel, EditOperation, NativeOfficeCommand, NativeOfficeState, NativeOfficeStyleInspection, NativeOfficeStylePatch, NativeOfficeStyleTarget, Receipt, ReadingContext, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';
import { createRegistry } from '../packages/format-adapters/src/index';
import { libreOfficeExecutable } from '../packages/engines/src/index';
import { dirname } from 'node:path';

// Real Electron + the shipped stdio MCP launcher + bundled LibreOffice.
// Document writes occur only through actual MCP tools. evaluate is limited to
// window lifecycle, pixel inspection and trusted UI calls for human selection.
// Every Office source is a temporary copy; this never attaches to the installed app.
const require = createRequire(import.meta.url), executable = require('electron') as string;
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-native-office-'));
const evidence = process.env.AGENTVIEWER_QA_DIR ? join(resolve(process.env.AGENTVIEWER_QA_DIR), 'native-office') : join(directory, 'evidence');
await mkdir(evidence, { recursive: true });
const names = { docx: '03-潮灯町的第十三夜.docx', pptx: '04-故事介绍.pptx', xlsx: '02-编年表.xlsx' } as const;
const sourceBytes = new Map<string, Buffer>();
for (const name of Object.values(names)) { const bytes = await readFile(resolve('examples/moon-tide', name)); sourceBytes.set(name, bytes); await writeFile(join(directory, name), bytes); }
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const endpoint = `http://127.0.0.1:${port}/`;
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_CONNECTION_FILE: join(directory, 'runtime', 'connection.json') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'AGENTVIEWER_TEST_MODE', 'AGENTVIEWER_TEST_TRANSLATOR', 'AGENTVIEWER_VITE_URL']) delete env[key];
const scale = Number(process.env.AGENTVIEWER_QA_SCALE ?? 1);
const app = await electron.launch({ executablePath: executable, args: ['.', '--force-device-scale-factor=' + scale], cwd: resolve('.'), env, timeout: 60000 });
const mcp = new Client({ name: 'agentviewer-native-office-acceptance', version: '1.0' });
const primary = app.process(), stderr: string[] = [], errors: string[] = [], results: Record<string, unknown> = {}, children = new Set<ChildProcess>();
primary.stderr?.on('data', chunk => stderr.push(String(chunk)));
const watch = (page: Page) => { page.on('pageerror', error => errors.push(page.url() + ': ' + error.message)); page.on('console', message => { if (message.type() === 'error' && /same key|uncaught|object.*destroyed|unhandled/i.test(message.text())) errors.push(message.text()); }); };
app.context().pages().forEach(watch); app.context().on('page', watch);
let main = await app.firstWindow();
const until = async (check: () => Promise<boolean>, label: string, timeout = 30000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 90)); } throw new Error('Native Office acceptance timed out: ' + label); };
const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => main.evaluate(value => window.agentViewer!.call(value.method, value.args), { method, args }) as Promise<T>;
const tool = async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => { const result = await mcp.callTool({ name, arguments: args }); const text = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text; assert.notEqual(result.isError, true, `${name}: ${text}`); assert.ok(text, name + ' returns JSON'); return JSON.parse(text) as T; };
const workspace = () => tool<WorkspaceState>('workspace_list');
const native = (viewId: string) => tool<NativeOfficeState>('office_status', { viewId });
const version = (state: NativeOfficeState) => ({ expectedEngineEpoch: state.engineEpoch, expectedEngineRevision: state.engineRevision, expectedSelectionEpoch: state.selectionEpoch });
const active = () => workspace().then(value => value.activeViewId);
const events:unknown[]=[];let lastEvent=0;
const recordEvents=async()=>{const next=await invoke<{seq:number;type:string;data:unknown}[]>('events',{after:lastEvent});if(next.length)lastEvent=next.at(-1)!.seq;events.push(...next);results.events=events;};
const activateOwnReader=async(target:NativeOfficeState)=>{
  const identity=await app.evaluate(({BrowserWindow},url)=>{const owner=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url)!;owner.show();owner.focus();const value=owner.getNativeWindowHandle();return {handle:String(value.length>=8?value.readBigUInt64LE():BigInt(value.readUInt32LE())),pid:process.pid,bytes:value.toString('hex'),bounds:owner.getContentBounds(),alwaysOnTop:owner.isAlwaysOnTop()};},endpoint);
  results.lastActivation=identity;
  const python=join(dirname(libreOfficeExecutable(resolve('.'))!.path),'python.exe');
  const code=`import ctypes as C,sys,json,time
from ctypes import wintypes as W
u=C.WinDLL('user32',use_last_error=True);k=C.WinDLL('kernel32');h=int(sys.argv[1]);reader_pid=int(sys.argv[2]);n=int(sys.argv[3]);native_pid=int(sys.argv[4])
u.GetWindowThreadProcessId.argtypes=[W.HWND,C.POINTER(W.DWORD)];u.GetWindowThreadProcessId.restype=W.DWORD
u.GetForegroundWindow.restype=W.HWND;u.SetForegroundWindow.argtypes=[W.HWND];u.BringWindowToTop.argtypes=[W.HWND];u.ShowWindow.argtypes=[W.HWND,C.c_int];u.SetFocus.argtypes=[W.HWND]
u.AttachThreadInput.argtypes=[W.DWORD,W.DWORD,W.BOOL];u.GetWindow.argtypes=[W.HWND,W.UINT];u.GetWindow.restype=W.HWND
u.GetClientRect.argtypes=[W.HWND,C.POINTER(W.RECT)];u.ClientToScreen.argtypes=[W.HWND,C.POINTER(W.POINT)]
u.WindowFromPoint.argtypes=[W.POINT];u.WindowFromPoint.restype=W.HWND;u.GetAncestor.argtypes=[W.HWND,W.UINT];u.GetAncestor.restype=W.HWND
u.SetCursorPos.argtypes=[C.c_int,C.c_int];u.SetCursorPos.restype=W.BOOL
# Only this short-lived helper thread adopts PM2, so all hit-test coordinates
# and SetCursorPos use physical pixels even at 150/200% or on another display.
u.SetThreadDpiAwarenessContext.argtypes=[C.c_void_p];u.SetThreadDpiAwarenessContext.restype=C.c_void_p
assert u.SetThreadDpiAwarenessContext(C.c_void_p(-4)),'physical reader coordinates cannot be verified'
def pid(hwnd):
 value=W.DWORD();u.GetWindowThreadProcessId(hwnd,C.byref(value));return value.value
assert pid(h)==reader_pid,'not this test reader: actual='+str(pid(h))+' expected='+str(reader_pid)+' hwnd='+str(h)
assert pid(n)==native_pid,'not this native frame'
def foreground():
 g=int(u.GetForegroundWindow() or 0);actual_pid=pid(g);v=g
 for _ in range(12):
  if v in [h,n] and actual_pid in [reader_pid,native_pid]:return True,g,actual_pid
  v=int(u.GetWindow(v,4) or 0)
  if not v:break
 return False,g,actual_pid
t=u.GetWindowThreadProcessId(h,None);f=u.GetWindowThreadProcessId(u.GetForegroundWindow(),None);c=k.GetCurrentThreadId();pairs=[]
try:
 for a,b in [(c,f),(c,t)]:
  if a and b and a!=b and u.AttachThreadInput(a,b,True):pairs.append((a,b))
 u.ShowWindow(h,5);u.BringWindowToTop(h);u.SetForegroundWindow(h);u.SetFocus(h)
finally:
 for a,b in reversed(pairs):u.AttachThreadInput(a,b,False)
allowed,g,actual_pid=foreground();proof={'mouseFallback':False}
if not allowed:
 # Click only the static, noninteractive logo of this isolated reader. The
 # physical client/CSS ratio handles forced DPI without guessing Windows DPI.
 rect=W.RECT();assert u.GetClientRect(h,C.byref(rect)),'reader client unavailable'
 css_width=float(sys.argv[5]);css_height=float(sys.argv[6]);width=rect.right-rect.left;height=rect.bottom-rect.top
 assert css_width>0 and css_height>0 and width>0 and height>0,'invalid reader viewport'
 sx=width/css_width;sy=height/css_height;point=W.POINT(round(34*sx),round(24*sy))
 assert 0<point.x<width and 0<point.y<height,'logo is outside reader client'
 assert u.ClientToScreen(h,C.byref(point)),'reader screen origin unavailable'
 def own_logo_hit():
  hit=int(u.WindowFromPoint(point) or 0)
  assert hit and pid(hit)==reader_pid and int(u.GetAncestor(hit,2) or 0)==h,'static logo is covered by another window: hit='+str(hit)+' pid='+str(pid(hit))
  return hit
 hit=own_logo_hit()
 assert u.SetCursorPos(point.x,point.y),'cannot position pointer on own logo'
 own_logo_hit() # Recheck after moving, immediately before the one click.
 class MouseInput(C.Structure):_fields_=[('dx',W.LONG),('dy',W.LONG),('mouseData',W.DWORD),('dwFlags',W.DWORD),('time',W.DWORD),('dwExtraInfo',C.c_size_t)]
 class Payload(C.Union):_fields_=[('mi',MouseInput)]
 class Input(C.Structure):_fields_=[('type',W.DWORD),('data',Payload)]
 u.SendInput.argtypes=[W.UINT,C.POINTER(Input),C.c_int];u.SendInput.restype=W.UINT
 click=(Input*2)();click[0].type=0;click[0].data.mi.dwFlags=2;click[1].type=0;click[1].data.mi.dwFlags=4
 assert u.SendInput(2,click,C.sizeof(Input))==2,'own logo click was rejected'
 proof={'mouseFallback':True,'point':{'x':point.x,'y':point.y},'hit':str(hit),'clientScale':{'x':sx,'y':sy}}
 deadline=time.monotonic()+.75
 while True:
  allowed,g,actual_pid=foreground()
  if allowed or time.monotonic()>=deadline:break
  time.sleep(.01)
assert allowed,'reader foreground activation was rejected: foreground='+str(g)+' pid='+str(actual_pid)+' reader='+str(h)+' native='+str(n)
proof.update(foreground=str(g),foregroundPid=actual_pid);print(json.dumps(proof))
`;
  const ownTopmost=async(value:boolean)=>app.evaluate(({BrowserWindow},args)=>{if(process.pid!==args.pid)throw new Error('Activation process identity changed');const owner=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&window.webContents.getURL()===args.url&&window.getNativeWindowHandle().toString('hex')===args.bytes);if(!owner)throw new Error('Isolated reader no longer exists');owner.setAlwaysOnTop(args.value);},{pid:identity.pid,url:endpoint,bytes:identity.bytes,value});
  try {
    // This changes only this QA reader's z-order, never another application's.
    // The click below still requires a real, unobstructed own-reader hit test.
    await ownTopmost(true);
    await new Promise<void>((done,reject)=>{const child=spawn(python,['-c',code,identity.handle,String(identity.pid),String(target.nativeHwnd),String(target.nativePid),String(identity.bounds.width),String(identity.bounds.height)],{windowsHide:true,stdio:['ignore','pipe','pipe']});let error='',output='';child.stderr.on('data',chunk=>error+=String(chunk));child.stdout.on('data',chunk=>output+=String(chunk));child.once('error',reject);child.once('exit',status=>{if(status!==0){reject(new Error('Activate only the isolated reader '+JSON.stringify(identity)+': '+error));return;}try{results.lastActivation={...identity,proof:JSON.parse(output)};done();}catch(cause){reject(cause);}});});
  } finally { await ownTopmost(identity.alwaysOnTop); }
};
const readers = () => app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.webContents.getURL() === url).map(window => ({ id: window.id, visible: window.isVisible(), minimized: window.isMinimized(), bounds: window.getContentBounds() })), endpoint);
const nativeReady = async (view: ViewInfo, target:Page=main) => {
  let last: NativeOfficeState | undefined;
  await until(async () => { try { last = await native(view.id); return last.status === 'ready' && !!last.visible && !!last.nativeGeometry && !!last.viewport && last.viewport.width > 100 && last.viewport.height > 100; } catch { return false; } }, 'real native surface ready: ' + view.id, 120000);
  assert.equal(last!.documentId, view.documentId); assert.equal(last!.viewId, view.id); assert.match(last!.nativeHwnd!, /^[1-9]\d*$/); assert.ok(last!.nativePid! > 0);
  assert.deepEqual({menus:last!.nativeUi?.menus,toolbars:last!.nativeUi?.toolbars,statusbar:last!.nativeUi?.statusbar}, { menus: false, toolbars: false, statusbar: false });
  assert.ok(Math.abs(last!.viewport!.width-last!.viewport!.bounds.width)<2 && Math.abs(last!.viewport!.height-last!.viewport!.bounds.height)<2,'actual native region fills the requested renderer surface');
  await target.locator(`.native-office-content[data-native-office="${view.id}"][data-native-ready="true"]`).waitFor(); return last!;
};
const open = async (format: keyof typeof names) => { const view = await tool<ViewInfo>('reader_open', { uri: join(directory, names[format]) }); await until(async () => (await active()) === view.id, 'MCP-opened active view'); await nativeReady(view); return view; };
const selectTab = async (view: ViewInfo) => { await main.locator(`.tab[data-view-id="${view.id}"] .tab-select`).click(); await until(async () => (await active()) === view.id, 'actual tab activation'); };
const input = async (view: ViewInfo, action: BrowserAction, humanSelection = false) => { const state = await native(view.id), args = { viewId: view.id, ...version(state), expectedLayoutRevision: state.viewport?.layoutRevision, action, idempotencyKey: crypto.randomUUID() };await activateOwnReader(state);return humanSelection ? invoke('office-input', args) : tool('office_input', args); };
const navigate = async (view: ViewInfo, target: Record<string, unknown>) => { const state = await native(view.id); return tool('office_navigate', { viewId: view.id, ...version(state), target, idempotencyKey: crypto.randomUUID() }); };
const model = (view: ViewInfo) => tool<DocumentModel & { revision: number }>('document_read', { documentId: view.documentId });
const queryStyle = async (view: ViewInfo, target: NativeOfficeStyleTarget) => {
  const result = await tool<{ state: NativeOfficeState; data: NativeOfficeStyleInspection }>('office_query', { viewId: view.id, target: { kind: 'style', target } });
  assert.equal(result.state.viewId, view.id); assert.equal(result.state.documentId, view.documentId); assert.equal(result.data.targetKind, target);
  return result;
};
const assertStyleValue = (field: string, actual: unknown, expected: unknown, label: string) => {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', label);
    // Writer uses twips; native shape coordinates use 1/100mm. Compare the
    // public mm/point values at their real precision, not JS float identity.
    const tolerance = ['x','y','width','height','left','right','firstLine','top','bottom'].includes(field) ? .05 : field === 'lineWidth' ? .04 : ['fontSize','rotation'].includes(field) ? .02 : .001;
    assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `${label}: actual=${String(actual)} expected=${expected} tolerance=${tolerance}`);
  } else if (['color','highlight','fill','lineColor'].includes(field) && typeof expected === 'string') assert.equal(String(actual).toLowerCase(), expected.toLowerCase(), label);
  else assert.deepEqual(actual, expected, label);
};
const styleRoundTrip = async (view: ViewInfo, target: NativeOfficeStyleTarget, makePatch: (inspection: NativeOfficeStyleInspection) => NativeOfficeStylePatch, label: string, inspectChanged?: (style: NativeOfficeStylePatch) => Promise<unknown>) => {
  const before = await queryStyle(view, target), style = makePatch(before.data), fields = Object.keys(style.values), document = (await workspace()).documents.find(item => item.id === view.documentId)!;
  assert.ok(document.path, `${label}: this acceptance uses an actual temporary source file`); const originalSource = await readFile(document.path);
  results.typedStyleRoundTrips ??= {};
  const progress: Record<string, unknown> = { before, requested: style, sourceHashBefore: createHash('sha256').update(originalSource).digest('hex') };
  (results.typedStyleRoundTrips as Record<string, unknown>)[label] = progress;
  assert.equal(style.target, target);
  for (const field of fields) assert.equal(before.data.fields[field]?.available, true, `${label}: actual selection supports ${field}`);
  const current = await native(view.id); assert.equal(current.selectionEpoch, before.state.selectionEpoch, `${label}: inspection and mutation keep the same real selection`);
  const applied = await tool<{ receipt: Receipt; state: NativeOfficeState; undoToken?: string }>('office_execute', { viewId: view.id, ...version(current), style, idempotencyKey: crypto.randomUUID() });
  progress.applied = applied;
  assert.equal(applied.receipt.status, 'applied', `${label}: real typed setters must change the native model`); assert.equal(applied.state.viewId, view.id);
  assert.ok(applied.undoToken, `${label}: one real native undo action is required`); assert.notEqual(applied.undoToken, current.undo?.token, `${label}: do not reuse an earlier command's undo token`);
  const changed = await queryStyle(view, target);
  progress.changed = changed;
  for (const [field, value] of Object.entries(style.values)) { const result = changed.data.fields[field]; assert.equal(result?.available, true); assert.notEqual(result.state, 'mixed'); assert.notEqual(result.state, 'unsupported'); assertStyleValue(field, result.value, value, `${label}: real changed ${field}`); }
  assert.equal((await workspace()).documents.find(item => item.id === view.documentId)!.dirty, true, `${label}: style changes belong to the unsaved application source`);
  if (inspectChanged) progress.actualNativeObjectAfter = await inspectChanged(style);
  const currentUndo = await native(view.id); assert.equal(currentUndo.undo?.token, applied.undoToken, `${label}: an unrelated edit must not be undone`);
  const undone = await tool<{ receipt: Receipt; state: NativeOfficeState }>('office_undo', { viewId: view.id, ...version(currentUndo), undoToken: applied.undoToken, idempotencyKey: crypto.randomUUID() });
  progress.undone = undone;
  assert.equal(undone.receipt.status, 'undone', `${label}: real native undo completed`); assert.equal(undone.state.viewId, view.id);
  const restored = await queryStyle(view, target);
  progress.restored = restored;
  for (const field of fields) { assert.equal(restored.data.fields[field]?.available, before.data.fields[field].available); assert.equal(restored.data.fields[field].state, before.data.fields[field].state, `${label}: original property state restored for ${field}`); assertStyleValue(field, restored.data.fields[field].value, before.data.fields[field].value, `${label}: native undo restores ${field}`); }
  const finalSource = await readFile(document.path); assert.deepEqual(finalSource, originalSource, `${label}: query/edit/undo never implicitly saves the source`);
  const report = { before, requested: style, applied, changed, undone, restored };
  return report;
};
const patch = async (view: ViewInfo, operation: EditOperation, controlId?: string) => { const source = await model(view); const plan = await tool<{ id: string }>('document_plan_patch', { documentId: view.documentId, viewId: view.id, expectedRevision: source.revision, operation, ...(controlId ? { controlId } : {}) }); const receipt = await tool<{ status: string; transactionId: string }>('document_apply_patch', { patchId: plan.id, idempotencyKey: crypto.randomUUID() }); assert.equal(receipt.status, 'applied'); return receipt; };
const capture = async (view: ViewInfo, label: string) => {
  const state = await native(view.id), result = await mcp.callTool({ name: 'office_capture', arguments: { viewId: view.id, expectedEngineEpoch: state.engineEpoch, expectedEngineRevision: state.engineRevision, expectedLayoutRevision: state.viewport?.layoutRevision } });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const content = result.content as { type: string; data?: string; text?: string; mimeType?: string }[], image = content.find(item => item.type === 'image'), metadata = JSON.parse(content.find(item => item.type === 'text')!.text!) as Record<string, unknown>;
  assert.equal(image?.mimeType, 'image/png'); assert.ok(image?.data); assert.equal(metadata.viewId, view.id); assert.equal(metadata.documentId, view.documentId); assert.equal(metadata.sessionId, state.sessionId); assert.equal(metadata.engineEpoch, state.engineEpoch); assert.equal(metadata.engineRevision, state.engineRevision);
  const bytes = Buffer.from(image.data, 'base64'); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const pixels = await app.evaluate(({ nativeImage }, data) => { const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64')), bitmap = image.toBitmap(); const colors = new Set<number>(); let light=0,black=0,samples=0; for (let index = 0; index < bitmap.length; index += 16) { colors.add((bitmap[index] << 16) | (bitmap[index + 1] << 8) | bitmap[index + 2]);samples++;if(bitmap[index]>200&&bitmap[index+1]>200&&bitmap[index+2]>200)light++;if(bitmap[index]<30&&bitmap[index+1]<30&&bitmap[index+2]<30)black++; } return { size: image.getSize(), colors: colors.size, empty: image.isEmpty(),lightFraction:light/samples,blackFraction:black/samples }; }, image.data);
  assert.equal(pixels.empty, false); assert.ok(pixels.colors >= 12, label + ': genuine document raster must contain text/lines, not a uniform placeholder'); assert.ok(pixels.size.width > 100 && pixels.size.height > 100);
  await writeFile(join(evidence, label + '.png'), bytes); return { metadata, pixels };
};
const saveReopen = async (view: ViewInfo, format: keyof typeof names) => {
  await tool('document_save', { documentId: view.documentId });
  const bytes = await readFile(join(directory, names[format])); assert.notDeepEqual(bytes, sourceBytes.get(names[format]));
  const disk = await createRegistry().resolve(format).open(new Uint8Array(bytes), format);
  const online = (await workspace()).documents.find(item => item.id === view.documentId)!; assert.equal(online.dirty, false);
  const agent = await tool<{ state: { controlId: string } | null }>('reader_agent_status', { viewId: view.id }); if (agent.state) await tool('reader_agent_release', { viewId: view.id, controlId: agent.state.controlId });
  await tool('reader_manage_views', { action: 'close', viewId: view.id });
  const reopened = await open(format); assert.equal(reopened.documentId, view.documentId); assert.notEqual(reopened.id, view.id);
  return { reopened, disk, hash: createHash('sha256').update(bytes).digest('hex') };
};
const launchAgain = () => new Promise<void>((done, reject) => { const child = spawn(executable, ['.'], { cwd: resolve('.'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child); let output = ''; child.stdout?.on('data', chunk => { output += String(chunk); }); child.stderr?.on('data', chunk => { output += String(chunk); }); const timer = setTimeout(() => { child.kill(); reject(new Error('isolated second instance did not exit')); }, 15000); child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); }); child.once('exit', (code, signal) => { clearTimeout(timer); children.delete(child); assert.equal(signal, null); assert.equal(code, 0, output); done(); }); });

try {
  await main.locator('.prose h1').waitFor();
  // The test launcher may inherit SW_HIDE. Reveal only this run's reader;
  // native readiness below still verifies Windows visibility and actual pixels.
  await app.evaluate(({BrowserWindow},url)=>{const owner=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url)!;owner.hide();owner.show();owner.focus();},endpoint);
  await until(async () => { try { return JSON.parse(await readFile(env.AGENTVIEWER_CONNECTION_FILE, 'utf8')).protocolVersion === '1.0'; } catch { return false; } }, 'isolated MCP discovery');
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['plugins/agent-viewer/server/launch.mjs'], env, cwd: resolve('.') }));
  const tools = (await mcp.listTools()).tools.map(item => item.name);
  for (const name of ['office_session', 'office_status', 'office_commands', 'office_command_status', 'office_query', 'office_execute', 'office_cell_set', 'office_capture', 'office_input', 'office_navigate', 'office_undo', 'document_plan_patch', 'document_apply_patch', 'document_save']) assert.ok(tools.includes(name), 'actual shipped MCP tool: ' + name);
  const processIdentity = await app.evaluate(({ app }) => ({ pid: process.pid, profile: app.getPath('userData'), lock: app.hasSingleInstanceLock() })); assert.equal(resolve(processIdentity.profile), resolve(directory)); assert.equal(processIdentity.lock, true); results.processIdentity = processIdentity;
  await invoke('settings-set', { id: 'appearance.autoHideToolbar', value: false });
  await invoke('settings-set', { id: 'appearance.motion', value: 'off' });
  await invoke('settings-set', { id: 'appearance.theme', value: 'light' });
  await invoke('settings-set', { id: 'appearance.documentBackground', value: 'paper' });

  let word = await open('docx'); const wordStart = await native(word.id);
  assert.equal(wordStart.unsavedContentChanges,false,'opening a native view does not create a content edit');
  assert.equal((await workspace()).documents.find(item=>item.id===word.documentId)!.dirty,false,'initial native serialization and layout do not mark source dirty');
  console.log('Native Office acceptance: actual Writer ready');
  results.writerInitial={state:wordStart,capture:await capture(word,'writer-initial-native')};
  assert.ok((results.writerInitial as {capture:{pixels:{lightFraction:number;blackFraction:number}}}).capture.pixels.lightFraction>.75,'light application keeps the actual Office page and canvas light instead of adopting Windows dark appearance');
  const displayState=await invoke<WorkspaceState>('state'),fullState=await workspace();
  assert.deepEqual(displayState.documents.find(document=>document.id===word.documentId)!.model,{format:'docx'});
  assert.ok(fullState.documents.find(document=>document.id===word.documentId)!.model.blocks!.length>10,'public MCP workspace continues to expose the complete native mirror');
  results.officeDisplayPayload={displayBytes:Buffer.byteLength(JSON.stringify(displayState)),publicBytes:Buffer.byteLength(JSON.stringify(fullState))};
  const beforeStats=await invoke<{methods:Record<string,{count:number}>}>('office-statistics');
  await main.waitForTimeout(4500);
  const afterStats=await invoke<{methods:Record<string,{count:number;totalMs:number;maximumMs:number}>}>('office-statistics'),staticReads=(afterStats.methods.state?.count??0)-(beforeStats.methods.state?.count??0);
  assert.ok(staticReads<=13,'steady native reading shares the host state stream instead of polling the same body independently from each renderer tool');
  results.officeSteadyReads={periodMs:4500,stateRequests:staticReads,methods:afterStats.methods};
  const catalog = await tool<{ total: number; commands: NativeOfficeCommand[] }>('office_commands', { viewId: word.id, offset: 0, limit: 500 });
  assert.ok(catalog.total > 80, 'discover the real full LibreOffice command directory'); assert.ok(catalog.commands.some(item => item.command === '.uno:Bold'));
  const managed = await tool<{ commands: NativeOfficeCommand[] }>('office_command_status', { viewId: word.id, commands: ['.uno:Save', '.uno:NewWindow'] }); assert.ok(managed.commands.every(item => item.enabled === false && item.available === false && !!item.reason));
  const home = main.getByRole('button', { name: '开始', exact: true }); if (await home.getAttribute('aria-pressed') !== 'true') await home.click();
  await main.locator('.native-office-tools[data-office-category="home"]').waitFor(); assert.equal(await main.locator('.office-editing-ribbon').count(), 0);
  await main.locator('.native-office-search>summary').click(); await main.getByRole('textbox', { name: '搜索原生 Office 命令' }).fill('.uno:Bold'); await until(async () => (await main.locator('.native-office-search-results').innerText()).includes('.uno:Bold'), 'real catalog is searchable in the sidebar');
  const control = await tool<{ controlId: string }>('reader_agent_acquire', { viewId: word.id, documentId: word.documentId, phase: 'editing', agentId: 'native-office-acceptance' });
  await input(word, { kind: 'press', key: 'Home', modifiers: ['control'] }); await input(word, { kind: 'press', key: 'End', modifiers: ['shift'] });
  await until(async () => !!(await native(word.id)).selection?.text, 'actual Writer native text selection');
  const boldBefore = await tool<{ commands: NativeOfficeCommand[] }>('office_command_status', { viewId: word.id, commands: ['.uno:Bold'] }); assert.equal(boldBefore.commands[0]?.enabled, true);
  const selectedState = await native(word.id); const bold = await tool<{ receipt: { status: string }; state: NativeOfficeState }>('office_execute', { viewId: word.id, ...version(selectedState), command: '.uno:Bold', controlId: control.controlId, idempotencyKey: crypto.randomUUID() }); assert.ok(['applied', 'dispatched'].includes(bold.receipt.status));
  const boldAfter = await tool<{ commands: NativeOfficeCommand[] }>('office_command_status', { viewId: word.id, commands: ['.uno:Bold'] }); assert.equal(boldAfter.commands[0].state, !boldBefore.commands[0].state);
  const writerTextBefore = (await model(word)).blocks!.map(block => block.text);
  await styleRoundTrip(word, 'text', inspection => ({ target: 'text', values: { fontSize: inspection.fields.fontSize.value === 18 ? 21 : 18, italic: inspection.fields.italic.value !== true, color: inspection.fields.color.value === '166a71' ? '893b58' : '166a71' } }), 'writer-text');
  assert.deepEqual((await model(word)).blocks!.map(block => block.text), writerTextBefore, 'Writer text styling and undo preserve every paragraph text');
  await navigate(word, { kind: 'paragraph', paragraphIndex: 0 });
  await styleRoundTrip(word, 'paragraph', inspection => ({ target: 'paragraph', values: { alignment: inspection.fields.alignment.value === 'center' ? 'left' : 'center', left: typeof inspection.fields.left.value === 'number' && inspection.fields.left.value < 990 ? inspection.fields.left.value + 2.5 : 2.5, lineSpacingPercent: inspection.fields.lineSpacingPercent.value === 150 ? 175 : 150 } }), 'writer-paragraph');
  assert.deepEqual((await model(word)).blocks!.map(block => block.text), writerTextBefore, 'Writer paragraph styling and undo preserve text and paragraph order');
  await until(async () => await main.locator(`.tab[data-view-id="${word.id}"][data-agent-phase="editing"]`).count() === 1, 'Agent badge bound to the edited Writer view');
  results.writer = { state: await native(word.id), catalogCount: catalog.total, boldBefore, boldAfter, capture: await capture(word, 'writer-native') };

  // A native input shortcut must write the application source copy, not merely
  // LibreOffice's private loading file. This is an actual keyboard path assertion.
  const wordHashBefore = createHash('sha256').update(await readFile(join(directory, names.docx))).digest('hex');
  await input(word, { kind: 'press', key: 's', modifiers: ['control'] });
  await until(async () => {await recordEvents();return createHash('sha256').update(await readFile(join(directory, names.docx))).digest('hex') !== wordHashBefore && (await workspace()).documents.find(item => item.id === word.documentId)?.dirty === false;}, 'native focused Ctrl+S saves the application source file', 45000);
  console.log('Native Office acceptance: actual selection, command, Agent identity and Ctrl+S passed');
  const stylesState=await native(word.id);
  await tool('office_execute',{viewId:word.id,...version(stylesState),command:'.uno:DesignerDialog',idempotencyKey:crypto.randomUUID()});
  await until(async()=>{const status=await native(word.id);return status.nativeUi?.sidebar===true&&!!status.nativeUi.deckId;},'actual Writer styles deck is visible');
  results.stylesDeck=await capture(word,'writer-styles-deck');
  const stylesCloseState=await native(word.id);await tool('office_execute',{viewId:word.id,...version(stylesCloseState),command:'.uno:DesignerDialog',idempotencyKey:crypto.randomUUID()});
  await until(async()=>{const status=await native(word.id);return status.nativeUi?.sidebar===false&&!status.nativeUi.deckId;},'actual Writer styles deck closes');

  const readerBefore = (await readers())[0], screenBefore = (await native(word.id)).viewport!.screenBounds;
  await app.evaluate(({ BrowserWindow }, value) => { const window = BrowserWindow.fromId(value.id)!; const bounds = window.getBounds(); window.setPosition(bounds.x + 35, bounds.y + 20); }, { id: readerBefore.id });
  await until(async () => { const state = await native(word.id); const owner = (await readers())[0]; return Math.abs((state.viewport!.screenBounds.x - screenBefore.x) - (owner.bounds.x - readerBefore.bounds.x) * state.viewport!.deviceScaleFactor) < 2 && Math.abs((state.viewport!.screenBounds.y - screenBefore.y) - (owner.bounds.y - readerBefore.bounds.y) * state.viewport!.deviceScaleFactor) < 2 && owner.bounds.x !== readerBefore.bounds.x; }, 'actual native HWND follows owner move');
  results.windowMoved = { before: screenBefore, after: (await native(word.id)).viewport!.screenBounds };

  const duplicate=await tool<ViewInfo>('reader_manage_views',{action:'duplicate-view',viewId:word.id});
  const duplicateState=await nativeReady(duplicate);
  assert.equal(duplicateState.sessionId,wordStart.sessionId);assert.notEqual(duplicateState.nativeHwnd,wordStart.nativeHwnd);
  assert.equal((await tool<{state:unknown}>('reader_agent_status',{viewId:duplicate.id})).state,null);
  const agentPage=app.context().pages().find(page=>page.url().includes('#/agent-toolbar'));assert.ok(agentPage,'held Agent has a trusted operation surface');
  await until(async()=>!(await agentPage.evaluate(()=>window.agentViewer!.call('toolbar-state',{})) as {visible:boolean}).visible,'duplicated view does not inherit another view operation capsule');
  await tool('reader_manage_views',{action:'close',viewId:duplicate.id});
  await selectTab(word);await nativeReady(word);await capture(word,'writer-after-controller-detach');
  results.sharedController={sameSession:true,closedViewId:duplicate.id,remainingViewId:word.id};

  const secondWindow=await invoke<{windowId:string}>('new-window',{viewId:word.id});
  await until(async()=>app.context().pages().filter(page=>!page.isClosed()&&page.url()===endpoint&&page!==main).length===1,'second reader window');
  const secondPage=app.context().pages().find(page=>!page.isClosed()&&page.url()===endpoint&&page!==main)!;
  const sharedView=(await workspace()).views.find(view=>view.windowId===secondWindow.windowId)!;
  const secondState=await nativeReady(sharedView,secondPage);assert.equal(secondState.sessionId,wordStart.sessionId);
  // Activating another window must not replace this window's own selected tab.
  assert.equal(await main.locator(`.tab[data-view-id="${word.id}"].active`).count(),1);
  const secondWindowId=(await readers()).find(window=>window.id!==readerBefore.id)!.id;
  await app.evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id)!.close(),secondWindowId);
  await until(async()=>(await readers()).length===1&&(await workspace()).views.find(view=>view.id===sharedView.id)?.windowId==='main','shared view migrates after normal owner closure');
  await selectTab(sharedView);const remounted=await nativeReady(sharedView);
  assert.equal(remounted.sessionId,wordStart.sessionId);assert.notEqual(remounted.nativeHwnd,secondState.nativeHwnd);
  await tool('reader_manage_views',{action:'close',viewId:sharedView.id});
  await selectTab(word);await nativeReady(word);
  results.sharedWindow={before:secondState.nativeHwnd,after:remounted.nativeHwnd,modelSurvived:true};
  console.log('Native Office acceptance: shared views and second window passed');

  const calc = await open('xlsx'); assert.equal((await tool<{ state: { controlId: string } }>('reader_agent_status', { viewId: word.id })).state.controlId, control.controlId); assert.equal((await tool<{ state: unknown }>('reader_agent_status', { viewId: calc.id })).state, null, 'user switching does not transfer the Writer Agent');
  await tool('reader_agent_release', { viewId: word.id, controlId: control.controlId });
  await until(async () => await main.locator(`.tab[data-view-id="${word.id}"] .tab-agent-indicator`).count() === 0, 'explicit release clears only the original view badge');
  const sheets = await tool<{ data: { sheets: { index: number; name: string }[] } }>('office_query', { viewId: calc.id, target: { kind: 'sheets' } }); const sheet = sheets.data.sheets[0]; assert.ok(sheet?.name);
  await navigate(calc, { kind: 'cell', sheetName: sheet.name, address: 'Z50' });
  const cellState = await native(calc.id); const cell = await tool<{ receipt: { status: string } }>('office_cell_set', { viewId: calc.id, ...version(cellState), sheetName: sheet.name, address: 'Z50', content: '=SUM(20,22)', idempotencyKey: crypto.randomUUID() }); assert.equal(cell.receipt.status, 'applied');
  const computed = await tool<{ data: { values: unknown[][]; formulas: string[][] } }>('office_query', { viewId: calc.id, target: { kind: 'cell-range', sheetName: sheet.name, range: 'Z50' } }); assert.equal(computed.data.values[0][0], 42); assert.equal(computed.data.formulas[0][0], '=SUM(20,22)');
  await styleRoundTrip(calc, 'cells', inspection => ({ target: 'cells', values: { fill: inspection.fields.fill.value === 'd8e8dd' ? 'f0dfcf' : 'd8e8dd', wrap: inspection.fields.wrap.value !== true, numberFormat: inspection.fields.numberFormat.value === '0.0000' ? '0.00' : '0.0000' } }), 'calc-cells');
  const calcAfterStyleUndo = await tool<{ data: { values: unknown[][]; formulas: string[][] } }>('office_query', { viewId: calc.id, target: { kind: 'cell-range', sheetName: sheet.name, range: 'Z50' } }); assert.deepEqual(calcAfterStyleUndo.data, computed.data, 'cell styling and native undo preserve the actual numeric type, formula and computed value');
  await until(async () => await main.getByRole('textbox', { name: '单元格内容或公式', exact: true }).inputValue() === '=SUM(20,22)', 'real compact formula bar follows native cell');
  const bar = await main.locator('.native-office-formula-bar').boundingBox(), surface = await main.locator('.native-office-surface').boundingBox(); assert.ok(bar && surface); assert.ok(Math.abs(bar.height - 32) < .5); assert.ok(surface.y >= bar.y + bar.height - .5, 'formula bar has its own layout area above the native content');
  const zoomBefore = (await workspace()).views.find(item => item.id === calc.id)!.zoom ?? 1, geometryBefore = await native(calc.id);
  await input(calc, { kind: 'scroll', x: 200, y: 160, deltaX: 0, deltaY: -120, modifiers: ['control'] });
  await until(async () => ((await workspace()).views.find(item => item.id === calc.id)!.zoom ?? 1) !== zoomBefore, 'actual native Ctrl+wheel synchronizes the application zoom');
  assert.ok((await native(calc.id)).viewport!.layoutRevision! > geometryBefore.viewport!.layoutRevision!); results.calc = { computed, bar, surface, capture: await capture(calc, 'calc-native'), zoom: (await workspace()).views.find(item => item.id === calc.id)!.zoom };
  const calcSaved = await saveReopen(calc, 'xlsx'); assert.equal(calcSaved.disk.sheets!.find(item => item.name === sheet.name)!.rows[49][25].formula, 'SUM(20,22)'); assert.equal(Number(calcSaved.disk.sheets!.find(item => item.name === sheet.name)!.rows[49][25].value), 42);
  console.log('Native Office acceptance: actual Calc calculation, compact formula bar, zoom and saved reopen passed');

  let slides = await open('pptx'); const slideModel = await model(slides), slide = slideModel.slides![0], shape = slide.blocks.find(item => !!item.text.trim())!; assert.ok(shape);
  const marker = '真实原生 Impress 对象编辑 · QA'; await patch(slides, { kind: 'slides.setText', slideId: slide.id, shapeId: shape.id, text: marker });
  assert.ok((await model(slides)).slides?.some(item => item.blocks.some(block => block.text === marker)));
  await main.locator('.native-office-tools[data-office-category="slides"]').waitFor(); const engineSlides = await tool<{ data: { slides: { index: number; name: string; thumbnail?: string }[] } }>('office_query', { viewId: slides.id, target: { kind: 'slides' } });
  const objectList = await tool<{ data: { slideIndex: number; total: number; objects: { name: string; type: string; text: string; bounds: { x: number; y: number; width: number; height: number } }[]; truncated: boolean; unit: string } }>('office_query', { viewId: slides.id, target: { kind: 'shapes', slideIndex: 0 } });
  assert.equal(objectList.data.slideIndex, 0); assert.equal(objectList.data.unit, '1/100mm'); assert.ok(objectList.data.total > 0); assert.ok(objectList.data.objects.length > 0 && objectList.data.objects.length <= 500); assert.equal(objectList.data.truncated, objectList.data.total > objectList.data.objects.length);
  const nativeShape = objectList.data.objects.find(item => item.text === marker && !!item.name); assert.ok(nativeShape, 'discover the modified actual shape from the native engine instead of guessing an OOXML id or first object'); assert.equal(objectList.data.objects.filter(item => item.name === nativeShape.name).length, 1, 'the selected native object name is unique');
  await navigate(slides, { kind: 'shape', slideIndex: 0, name: nativeShape.name });
  const actualShapeSelection = await native(slides.id); assert.equal(actualShapeSelection.selection?.kind, 'objects'); assert.deepEqual(actualShapeSelection.selection.objectNames, [nativeShape.name]); assert.equal(actualShapeSelection.selection.slideIndex, 0);
  // Selecting an XShape does not prove a text edit range. Use actual Impress
  // keyboard input to enter its editor before requesting typed text setters.
  await input(slides, { kind: 'press', key: 'F2', modifiers: [] });
  await input(slides, { kind: 'press', key: 'a', modifiers: ['control'] });
  await until(async () => {
    const status = await native(slides.id); results.impressTextSelectionProbe = status;
    const selected = status.selection;
    return selected?.kind === 'text' && selected.text === marker && selected.slideIndex === 0 && !!selected.locator?.blockId && typeof selected.locator.from === 'number' && typeof selected.locator.to === 'number' && (!('identityUnavailable' in selected) || selected.identityUnavailable !== true);
  }, 'actual F2 / Ctrl+A creates the exact Impress text range with a verifiable identity');
  const actualTextSelection = await native(slides.id); assert.equal(actualTextSelection.selection?.kind, 'text'); assert.equal(actualTextSelection.selection.text, marker); assert.equal(actualTextSelection.selection.slideIndex, 0);
  assert.ok(actualTextSelection.selection.locator?.blockId); assert.equal(actualTextSelection.selection.locator.from, 0); assert.equal(actualTextSelection.selection.locator.to, marker.length);
  if ('identityUnavailable' in actualTextSelection.selection) assert.notEqual(actualTextSelection.selection.identityUnavailable, true, 'real native text identity cannot be marked unavailable');
  const impressTextStyle = await styleRoundTrip(slides, 'text', inspection => ({ target: 'text', values: { fontSize: inspection.fields.fontSize.value === 19 ? 23 : 19, italic: inspection.fields.italic.value !== true, color: inspection.fields.color.value === '166a71' ? '893b58' : '166a71' } }), 'impress-text', async () => {
    const result = await tool<{ data: { name: string; text: string } }>('office_query', { viewId: slides.id, target: { kind: 'shape', slideIndex: 0, name: nativeShape.name } });
    assert.equal(result.data.name, nativeShape.name); assert.equal(result.data.text, marker, 'typing-mode style setters do not rewrite the shape text'); return result;
  });
  const textAfterUndo = await tool<{ data: { name: string; text: string } }>('office_query', { viewId: slides.id, target: { kind: 'shape', slideIndex: 0, name: nativeShape.name } }); assert.equal(textAfterUndo.data.name, nativeShape.name); assert.equal(textAfterUndo.data.text, marker, 'Impress text-style undo retains the complete original marker');
  results.impressTypedText = { selected: actualTextSelection, roundTrip: impressTextStyle, textAfterUndo };
  await input(slides, { kind: 'press', key: 'Escape', modifiers: [] });
  await navigate(slides, { kind: 'shape', slideIndex: 0, name: nativeShape.name });
  const objectAfterTextEdit = await native(slides.id); assert.equal(objectAfterTextEdit.selection?.kind, 'objects'); assert.deepEqual(objectAfterTextEdit.selection.objectNames, [nativeShape.name]); assert.equal(objectAfterTextEdit.selection.slideIndex, 0);
  const shapeBefore = await tool<{ data: { name: string; text: string; bounds: { x: number; y: number; width: number; height: number } } }>('office_query', { viewId: slides.id, target: { kind: 'shape', slideIndex: 0, name: nativeShape.name } });
  const shapeStyle = await styleRoundTrip(slides, 'shape', inspection => {
    const x = inspection.fields.x.value, width = inspection.fields.width.value; assert.equal(typeof x, 'number'); assert.equal(typeof width, 'number');
    assertStyleValue('x', x, shapeBefore.data.bounds.x / 100, 'Impress public mm style corresponds to native 1/100mm bounds'); assertStyleValue('width', width, shapeBefore.data.bounds.width / 100, 'Impress width units are explicit');
    return { target: 'shape', values: { x: Number(x) + 2.5, width: Number(width) + 3, fill: inspection.fields.fill.value === 'b6d8cc' ? 'dbc3d2' : 'b6d8cc' } };
  }, 'impress-shape', async style => {
    assert.equal(style.target, 'shape'); if (style.target !== 'shape') throw new Error('expected shape patch');
    const result = await tool<{ data: { name: string; text: string; bounds: { x: number; y: number; width: number; height: number } } }>('office_query', { viewId: slides.id, target: { kind: 'shape', slideIndex: 0, name: nativeShape.name } });
    assert.equal(result.data.name, nativeShape.name); assert.equal(result.data.text, marker);
    assert.ok(Math.abs(result.data.bounds.x - style.values.x! * 100) <= 1, 'real XShape position changes by requested mm converted to 1/100mm');
    assert.ok(Math.abs(result.data.bounds.width - style.values.width! * 100) <= 1, 'real XShape width changes by requested mm converted to 1/100mm');
    assert.equal(result.data.bounds.y, shapeBefore.data.bounds.y); assert.equal(result.data.bounds.height, shapeBefore.data.bounds.height);
    return result;
  });
  const shapeRestored = await tool<{ data: { name: string; text: string; bounds: { x: number; y: number; width: number; height: number } } }>('office_query', { viewId: slides.id, target: { kind: 'shape', slideIndex: 0, name: nativeShape.name } }); assert.deepEqual(shapeRestored.data, shapeBefore.data, 'real XUndoAction restores the named shape bounds and original text');
  results.impressTypedSelection = { objectList, selected: actualShapeSelection, shapeBefore, shapeRestored, nativeUndoToken: shapeStyle.applied.undoToken };
  await until(async () => await main.locator('.native-office-slide-list>button').count() === engineSlides.data.slides.length, 'actual slide list is only in the left sidebar'); assert.equal(await main.locator('.office-slide-strip,.office-presentation-footer').count(), 0);
  await main.getByRole('button', { name: '第 2 张幻灯片', exact: true }).click(); await until(async () => (await native(slides.id)).selection?.slideIndex === 1, 'left native slide navigation renders the target');
  results.impress = { engineSlides, capture: await capture(slides, 'impress-native') }; const slidesSaved = await saveReopen(slides, 'pptx'); assert.ok(slidesSaved.disk.slides?.some(item => item.blocks.some(block => block.text === marker))); slides = slidesSaved.reopened;
  console.log('Native Office acceptance: actual Impress edit, left slides and saved reopen passed');
  await selectTab(word); await nativeReady(word);
  await input(word, { kind: 'press', key: 'Home', modifiers: ['control'] }, true); await input(word, { kind: 'press', key: 'End', modifiers: ['shift'] }, true);
  await until(async () => { const context = await tool<ReadingContext>('reader_get_context', { viewId: word.id }); return context.actor === 'human' && context.quality === 'confirmed' && !!context.selection.text && !!context.selection.rect; }, 'real human native selection has confirmed geometry');
  await until(async () => app.context().pages().some(page => page.url().includes('#/selection-toolbar')), 'trusted native selection surface'); const selectionPage = app.context().pages().find(page => page.url().includes('#/selection-toolbar'))!;
  const selectionState = () => selectionPage.evaluate(() => window.agentViewer!.call('toolbar-state', { backdropPatches: true })) as Promise<{ visible: boolean; viewId?: string; backdropImage?: string; backdropSample?: { navigationId: string; sourceContentsId: number } }>;
  await until(async () => { const state = await selectionState(); return state.visible && state.viewId === word.id && !!state.backdropImage && !!state.backdropSample?.navigationId; }, 'selection capsule samples genuine native pixels');
  const selectionPixels = await selectionState(); assert.ok(selectionPixels.backdropSample!.navigationId.includes(word.id)); await writeFile(join(evidence, 'selection-native-backdrop.png'), Buffer.from(selectionPixels.backdropImage!.split(',')[1], 'base64')); results.selection = { state: { ...selectionPixels, backdropImage: '[PNG saved separately]' } };
  await selectTab(slides); await nativeReady(slides); await until(async () => !(await selectionState()).visible, 'view switching clears previous native selection surface');

  // Select the existing loopback page by document identity; no external website.
  const webWorkspace = await workspace(), web = webWorkspace.views.find(view => webWorkspace.documents.find(document => document.id === view.documentId)?.format === 'web')!; assert.ok(web);
  await selectTab(web); await until(async () => (await tool<ReadingContext>('reader_get_context', { viewId: web.id })).quality === 'confirmed', 'native Office to actual webpage');
  const ownerId = (await readers())[0].id; await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.minimize(), ownerId); await until(async () => (await readers())[0].minimized, 'isolated reader minimized after removing native overlays');
  await app.evaluate(({ BrowserWindow }, id) => { const owner = BrowserWindow.fromId(id)!; owner.restore(); owner.show(); owner.focus(); }, ownerId); await until(async () => (await readers())[0].visible && !(await readers())[0].minimized, 'reader restored without destroyed overlay callbacks');
  await selectTab(word); await nativeReady(word); const wordSaved = await saveReopen(word, 'docx'); word = wordSaved.reopened;
  const identityBefore = { viewId: word.id, documentId: word.documentId, state: await native(word.id) };
  await main.getByRole('button', { name: '设置', exact: true }).click(); await until(async () => app.context().pages().some(page => page.url().includes('#/settings')), 'settings survives reader closure');
  const closingReaderId = (await readers())[0].id; await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(), closingReaderId); await until(async () => (await readers()).length === 0, 'reader normally closes with stable native checkpoints');
  await launchAgain(); await until(async () => (await readers()).length === 1 && (await readers())[0].visible, 'real second instance recreates one reader');
  await until(async () => app.context().pages().some(page => !page.isClosed() && page.url() === endpoint), 'new reader Page'); main = app.context().pages().find(page => !page.isClosed() && page.url() === endpoint)!;
  await nativeReady(word); assert.equal((await active()), identityBefore.viewId); assert.equal((await native(word.id)).documentId, identityBefore.documentId); assert.notEqual((await native(word.id)).nativeHwnd, identityBefore.state.nativeHwnd, 'new reader mounts a new native controller rather than a destroyed old HWND');
  results.recreated = { before: identityBefore, after: await native(word.id) };
  for (const name of Object.values(names)) assert.deepEqual(await readFile(resolve('examples/moon-tide', name)), sourceBytes.get(name), 'original authored example remains unchanged');
  assert.deepEqual(errors, []); assert.doesNotMatch(stderr.join(''), /Object has been destroyed|UnhandledPromiseRejection|Uncaught (?:Exception|TypeError|Error)/i);
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, scale, port, ...results, errors, rendererScreenshotsIncludeNativePixels: false }, null, 2)); console.log('Real bundled native Office / actual stdio MCP / dynamic commands / semantic edits / source save + reopen / own HWND capture / Agent identity / selection / move + CtrlS + Ctrlwheel / overlay lifecycle / reader recreate: PASS', evidence);
} catch (error) {
  await recordEvents().catch(()=>{});
  await main.screenshot({ path: join(evidence, 'failure-chrome.png'), scale: 'css' }).catch(() => {}); await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), scale, results, errors, stderr: stderr.join('').slice(-20000) }, null, 2)); console.error('Native Office actual acceptance evidence:', evidence); throw error;
} finally {
  await mcp.close().catch(() => {}); for (const child of children) child.kill(); await writeFile(join(evidence, 'main-stderr.log'), stderr.join(''));
  const closing = app.close(), deadline = setTimeout(() => { primary.kill(); process.exitCode = 1; }, 30000); try { await closing; } finally { clearTimeout(deadline); }
}
