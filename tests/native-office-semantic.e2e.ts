import assert from 'node:assert/strict';
import { _electron as electron, type Page } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { createRegistry } from '../packages/format-adapters/src/index';
import type { DocumentModel, NativeOfficeFormat, NativeOfficeState, NativeOfficeStyleInspection, NativeOfficeStylePatch, NativeOfficeStyleTarget, Receipt, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';

// Real visible Electron, the shipped stdio MCP launcher and the bundled UNO
// controller. No office_input, SendInput, mocked controller or feature skip.
// .uno:Text exercises Impress's actual GUI text-edit mode without synthesizing
// a key. This does not validate physical F2/Ctrl+A or Windows focus activation;
// those remain mandatory cases in native-office.e2e.ts after unlocking Windows.
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-native-semantic-'));
const evidence = process.env.AGENTVIEWER_QA_DIR ? join(resolve(process.env.AGENTVIEWER_QA_DIR), 'native-office-semantic') : join(directory, 'evidence');
await mkdir(evidence, { recursive: true });
const names = { docx: '03-潮灯町的第十三夜.docx', xlsx: '02-编年表.xlsx', pptx: '04-故事介绍.pptx' } as const;
const originals = new Map<NativeOfficeFormat, Buffer>();
for (const format of Object.keys(names) as NativeOfficeFormat[]) { const bytes = await readFile(resolve('examples/moon-tide', names[format])); originals.set(format, bytes); await writeFile(join(directory, names[format]), bytes); }
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const endpoint = `http://127.0.0.1:${port}/`, connectionFile = join(directory, 'runtime', 'connection.json');
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_CONNECTION_FILE: connectionFile };
for (const key of ['ELECTRON_RUN_AS_NODE','AGENTVIEWER_TEST_MODE','AGENTVIEWER_TEST_TRANSLATOR','AGENTVIEWER_VITE_URL']) delete env[key];
const installedExe = process.env.AGENTVIEWER_QA_EXE, executablePath = installedExe ?? require('electron') as string;
const app = await electron.launch({ executablePath, args: installedExe ? [] : ['.'], cwd: resolve('.'), env, timeout: 60000 });
const mcp = new Client({ name: 'agentviewer-native-semantic-acceptance', version: '1.0' });
const errors: string[] = [], stderr: string[] = [], calls: unknown[] = [], results: Record<string, unknown> = { physicalKeyboardVerified: false, physicalMouseVerified: false, commandDrivenImpressTextEditVerified: false };
app.process().stderr?.on('data', chunk => stderr.push(String(chunk)));
const watch = (page: Page) => { page.on('pageerror', error => errors.push(page.url() + ': ' + error.message)); page.on('console', message => { if (message.type() === 'error' && /uncaught|unhandled|object.*destroyed|same key/i.test(message.text())) errors.push(message.text()); }); };
app.context().pages().forEach(watch); app.context().on('page', watch);
const main = await app.firstWindow();
const until = async (check: () => Promise<boolean>, label: string, timeout = 30000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); } throw new Error('Native semantic acceptance timed out: ' + label); };
const tool = async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const reply = await mcp.callTool({ name, arguments: args }), text = (reply.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text;
  calls.push({ name, args, isError: reply.isError === true, result: text ? JSON.parse(text) : reply.content });
  assert.notEqual(reply.isError, true, `${name}: ${text}`); assert.ok(text, name + ' returns actual MCP JSON'); return JSON.parse(text) as T;
};
const workspace = () => tool<WorkspaceState>('workspace_list');
const status = (view: ViewInfo) => tool<NativeOfficeState>('office_status', { viewId: view.id });
const versions = (state: NativeOfficeState) => ({ expectedEngineEpoch: state.engineEpoch, expectedEngineRevision: state.engineRevision, expectedSelectionEpoch: state.selectionEpoch });
const readModel = (view: ViewInfo) => tool<DocumentModel & { revision: number }>('document_read', { documentId: view.documentId });
const open = async (format: NativeOfficeFormat) => {
  const view = await tool<ViewInfo>('reader_open', { uri: join(directory, names[format]) });
  await until(async () => { try { const state = await status(view); results.lastNativeStatus = state; return state.status === 'ready' && state.visible === true && state.nativeGeometry === true && !!state.viewport && state.viewport.width > 100 && state.viewport.height > 100; } catch { return false; } }, 'actual bundled ' + format + ' native controller', 120000);
  const state = await status(view); assert.equal(state.documentId, view.documentId); assert.equal(state.viewId, view.id); assert.equal(state.format, format); assert.match(state.nativeHwnd!, /^[1-9]\d*$/); assert.ok(state.nativePid! > 0);
  await main.locator(`.native-office-content[data-native-office="${view.id}"][data-native-ready="true"]`).waitFor();
  assert.equal((await workspace()).activeViewId, view.id); return view;
};
const navigate = async (view: ViewInfo, target: Record<string, unknown>) => { const current = await status(view); const result = await tool<{ status: string; state: NativeOfficeState }>('office_navigate', { viewId: view.id, ...versions(current), target, idempotencyKey: randomUUID() }); assert.equal(result.status, 'rendered'); assert.equal(result.state.viewId, view.id); return result; };
const command = async (view: ViewInfo, name: string) => { const current = await status(view); const result = await tool<{ receipt: Receipt; state: NativeOfficeState }>('office_execute', { viewId: view.id, ...versions(current), command: name, idempotencyKey: randomUUID() }); assert.ok(['dispatched','applied','no-change'].includes(result.receipt.status)); assert.equal(result.state.viewId, view.id); assert.equal(result.state.actor, 'agent', 'native command reports the real agent producer'); return result; };
const inspect = async (view: ViewInfo, target: NativeOfficeStyleTarget) => { const result = await tool<{ state: NativeOfficeState; data: NativeOfficeStyleInspection }>('office_query', { viewId: view.id, target: { kind: 'style', target } }); assert.equal(result.state.viewId, view.id); assert.equal(result.data.targetKind, target); return result; };
const equalValue = (field: string, actual: unknown, expected: unknown, label: string) => {
  if (typeof expected === 'number') { assert.equal(typeof actual, 'number', label); const tolerance = ['x','y','width','height','left','right','firstLine','top','bottom'].includes(field) ? .05 : field === 'lineWidth' ? .04 : ['fontSize','rotation'].includes(field) ? .02 : .001; assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `${label}: ${String(actual)} vs ${expected}, tolerance ${tolerance}`); }
  else if (['color','highlight','fill','lineColor'].includes(field) && typeof expected === 'string') assert.equal(String(actual).toLowerCase(), expected.toLowerCase(), label);
  else assert.deepEqual(actual, expected, label);
};
const assertPatch = (actual: NativeOfficeStyleInspection, patch: NativeOfficeStylePatch, label: string) => { assert.equal(actual.targetKind, patch.target); for (const [field, expected] of Object.entries(patch.values)) { const value = actual.fields[field]; assert.equal(value?.available, true, `${label}: ${field} is truly supported`); assert.notEqual(value.state, 'mixed'); assert.notEqual(value.state, 'unsupported'); equalValue(field, value.value, expected, `${label}: ${field}`); } };
const selectImpressTextAfterCommit = async (view: ViewInfo, target: NativeOfficeStyleTarget) => {
  const current = await status(view);
  if (current.format !== 'pptx' || !['text','paragraph'].includes(target) || current.selection?.kind === 'text') return;
  // Native transactions finish TextEdit to commit the actual model. Re-enter
  // the one real selected object for subsequent inspection, never substitute
  // a cached range for the controller's current selection.
  assert.equal(current.selection?.kind, 'objects'); assert.equal(current.selection.objectNames?.length, 1);
  const name = current.selection.objectNames[0]; assert.ok(name); assert.equal(typeof current.selection.slideIndex, 'number');
  await command(view, '.uno:SelectObject');
  await navigate(view, { kind: 'shape', slideIndex: current.selection.slideIndex, name });
  await command(view, '.uno:Text'); await command(view, '.uno:SelectAll');
  await until(async () => { const state = await status(view); return state.selection?.kind === 'text' && !!state.selection.text && !!state.selection.locator?.blockId; }, 'actual text selection after native commit');
};
const applyStyle = async (view: ViewInfo, patch: NativeOfficeStylePatch) => {
  const current = await status(view); assert.equal(typeof current.selectionEpoch, 'number');
  const result = await tool<{ receipt: Receipt; state: NativeOfficeState; undoToken?: string }>('office_execute', { viewId: view.id, ...versions(current), style: patch, idempotencyKey: randomUUID() });
  assert.equal(result.receipt.status, 'applied'); assert.equal(result.state.viewId, view.id); assert.equal(result.state.actor, 'agent', 'native style reports the real agent producer'); assert.ok(result.undoToken); assert.notEqual(result.undoToken, current.undo?.token);
  await selectImpressTextAfterCommit(view, patch.target);
  assertPatch((await inspect(view, patch.target)).data, patch, 'applied style'); assert.equal((await workspace()).documents.find(item => item.id === view.documentId)!.dirty, true); return result;
};
const roundTrip = async (view: ViewInfo, target: NativeOfficeStyleTarget, make: (before: NativeOfficeStyleInspection) => NativeOfficeStylePatch, label: string) => {
  const before = await inspect(view, target), patch = make(before.data), fields = Object.keys(patch.values), source = (await workspace()).documents.find(item => item.id === view.documentId)!; assert.ok(source.path);
  const sourceBefore = await readFile(source.path), progress: Record<string, unknown> = { before, patch }; results[label] = progress;
  for (const field of fields) assert.equal(before.data.fields[field]?.available, true, `${label}: actual target supports ${field}`);
  assert.equal((await status(view)).selectionEpoch, before.state.selectionEpoch, 'no different selection between inspection and edit');
  const applied = await applyStyle(view, patch); progress.applied = applied; progress.changed = await inspect(view, target);
  const current = await status(view); assert.equal(current.undo?.token, applied.undoToken);
  const undone = await tool<{ receipt: Receipt; state: NativeOfficeState }>('office_undo', { viewId: view.id, ...versions(current), undoToken: applied.undoToken, idempotencyKey: randomUUID() }); progress.undone = undone; assert.equal(undone.receipt.status, 'undone');
  await selectImpressTextAfterCommit(view, target);
  const restored = await inspect(view, target); progress.restored = restored;
  for (const field of fields) { assert.equal(restored.data.fields[field]?.available, true); assert.equal(restored.data.fields[field].state, before.data.fields[field].state, `${label}: restore original PropertyState`); equalValue(field, restored.data.fields[field].value, before.data.fields[field].value, `${label}: undo restores ${field}`); }
  assert.deepEqual(await readFile(source.path), sourceBefore, 'semantic edit/undo never saves implicitly'); return patch;
};
const saveReopen = async (view: ViewInfo, format: NativeOfficeFormat) => {
  const saved = await tool<Receipt>('document_save', { documentId: view.documentId }); assert.equal(saved.status, 'saved'); assert.equal(resolve(saved.path!), resolve(join(directory, names[format])));
  assert.equal((await workspace()).documents.find(item => item.id === view.documentId)!.dirty, false); assert.equal((await status(view)).unsavedContentChanges, false);
  const bytes = await readFile(saved.path!), disk = await createRegistry().resolve(format).open(new Uint8Array(bytes), format); assert.equal(disk.format, format); assert.ok(bytes.length > 1000);
  assert.notDeepEqual(bytes, originals.get(format), 'a deliberately retained style/content edit must be present in the real saved file');
  const held = await tool<{ state: { controlId: string } | null }>('reader_agent_status', { viewId: view.id }); if (held.state) await tool('reader_agent_release', { viewId: view.id, controlId: held.state.controlId });
  const oldSession = (await status(view)).sessionId; await tool('reader_manage_views', { action: 'close', viewId: view.id });
  const closed = await workspace(); assert.ok(!closed.views.some(item => item.id === view.id)); assert.ok(!closed.documents.find(item => item.id === view.documentId)?.nativeOffice, 'closing the last view disposes its real native writer');
  const reopened = await open(format), fresh = await status(reopened); assert.equal(reopened.documentId, view.documentId); assert.notEqual(reopened.id, view.id); assert.notEqual(fresh.sessionId, oldSession, 'reopen loads the actual disk file into a new native model');
  assert.equal((await workspace()).documents.find(item => item.id === reopened.documentId)!.dirty, false);
  return { reopened, disk, hash: createHash('sha256').update(bytes).digest('hex') };
};
const shapeQuery = (view: ViewInfo, name: string) => tool<{ data: { name: string; text: string; bounds: { x: number; y: number; width: number; height: number } } }>('office_query', { viewId: view.id, target: { kind: 'shape', slideIndex: 0, name } });
const assertSelectionIdentity = (state: NativeOfficeState, kind: 'text' | 'objects') => { assert.equal(state.selection?.kind, kind); assert.ok(state.selection.locator?.blockId, 'actual native range/object identity'); if ('identityUnavailable' in state.selection) assert.notEqual(state.selection.identityUnavailable, true); };

try {
  await main.locator('.prose h1').waitFor();
  await app.evaluate(({ BrowserWindow }, url) => { const owner = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL() === url)!; owner.hide(); owner.show(); }, endpoint);
  const identity = await app.evaluate(({ app }) => ({ pid: process.pid, profile: app.getPath('userData'), locked: app.hasSingleInstanceLock(), executable: app.getPath('exe'), appPath: app.getAppPath(), resourcesPath: process.resourcesPath })); assert.equal(resolve(identity.profile), resolve(directory)); assert.equal(identity.locked, true); assert.equal(resolve(identity.executable), resolve(executablePath)); results.processIdentity = identity;
  results.mainSha256 = createHash('sha256').update(await readFile(join(identity.appPath, 'dist/main/index.cjs'))).digest('hex');
  results.assets = await main.evaluate(() => ({ scripts: [...document.scripts].map(script => script.src), styles: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link => link.href) }));
  await until(async () => { try { return JSON.parse(await readFile(connectionFile, 'utf8')).protocolVersion === '1.0'; } catch { return false; } }, 'private actual MCP connection');
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['plugins/agent-viewer/server/launch.mjs'], cwd: resolve('.'), env }));
  const tools = (await mcp.listTools()).tools.map(item => item.name); for (const name of ['reader_open','office_status','office_query','office_execute','office_navigate','office_undo','office_cell_set','document_save','reader_manage_views']) assert.ok(tools.includes(name));

  let word = await open('docx'); const wordSource = await readModel(word), paragraphs = wordSource.blocks!.map(block => block.text); assert.ok(paragraphs[0]?.trim());
  await navigate(word, { kind: 'paragraph', paragraphIndex: 0, select: true });
  const wordSelection = await status(word); assertSelectionIdentity(wordSelection, 'text'); assert.equal(wordSelection.selection!.text, paragraphs[0]); assert.equal(wordSelection.selection!.locator!.from, 0); assert.equal(wordSelection.selection!.locator!.to, paragraphs[0].length);
  const wordText = await roundTrip(word, 'text', value => ({ target: 'text', values: { fontSize: value.fields.fontSize.value === 18 ? 21 : 18, italic: value.fields.italic.value !== true, color: value.fields.color.value === '166a71' ? '893b58' : '166a71' } }), 'writerText');
  assert.deepEqual((await readModel(word)).blocks!.map(block => block.text), paragraphs);
  await applyStyle(word, wordText); await navigate(word, { kind: 'paragraph', paragraphIndex: 0 });
  const wordParagraph = await roundTrip(word, 'paragraph', value => ({ target: 'paragraph', values: { alignment: value.fields.alignment.value === 'center' ? 'left' : 'center', left: typeof value.fields.left.value === 'number' && value.fields.left.value < 990 ? value.fields.left.value + 2.5 : 2.5, lineSpacingPercent: value.fields.lineSpacingPercent.value === 150 ? 175 : 150 } }), 'writerParagraph');
  await applyStyle(word, wordParagraph); const wordSaved = await saveReopen(word, 'docx'); word = wordSaved.reopened;
  assert.deepEqual(wordSaved.disk.blocks!.map(block => block.text), paragraphs, 'saved Writer text and paragraph order are unchanged');
  await navigate(word, { kind: 'paragraph', paragraphIndex: 0, select: true }); assertSelectionIdentity(await status(word), 'text'); assertPatch((await inspect(word, 'text')).data, wordText, 'reopened Writer text style'); assertPatch((await inspect(word, 'paragraph')).data, wordParagraph, 'reopened Writer paragraph style'); results.writerSaved = { hash: wordSaved.hash, text: wordText, paragraph: wordParagraph };
  console.log('Native semantic: real Writer selected text/paragraph, typed style, native undo, disk save and reopen passed');

  let calc = await open('xlsx'); const sheets = await tool<{ data: { sheets: { index: number; name: string }[] } }>('office_query', { viewId: calc.id, target: { kind: 'sheets' } }), sheet = sheets.data.sheets[0]; assert.ok(sheet?.name);
  await navigate(calc, { kind: 'cell', sheetName: sheet.name, address: 'Z50' }); const selectedCell = await status(calc); assert.equal(selectedCell.selection?.kind, 'cells'); assert.equal(selectedCell.selection.sheetName, sheet.name); assert.equal(selectedCell.selection.range, 'Z50');
  const cell = await tool<{ receipt: Receipt }>('office_cell_set', { viewId: calc.id, ...versions(selectedCell), sheetName: sheet.name, address: 'Z50', content: '=SUM(20,22)', idempotencyKey: randomUUID() }); assert.equal(cell.receipt.status, 'applied');
  const getCell = () => tool<{ data: { values: unknown[][]; formulas: string[][]; errors: number[][] } }>('office_query', { viewId: calc.id, target: { kind: 'cell-range', sheetName: sheet.name, range: 'Z50' } });
  const cellBefore = await getCell(); assert.equal(cellBefore.data.values[0][0], 42); assert.equal(cellBefore.data.formulas[0][0], '=SUM(20,22)'); assert.equal(cellBefore.data.errors[0][0], 0);
  const cellStyle = await roundTrip(calc, 'cells', value => ({ target: 'cells', values: { fill: value.fields.fill.value === 'd8e8dd' ? 'f0dfcf' : 'd8e8dd', wrap: value.fields.wrap.value !== true, numberFormat: value.fields.numberFormat.value === '0.0000' ? '0.00' : '0.0000' } }), 'calcCells'); assert.deepEqual((await getCell()).data, cellBefore.data);
  await applyStyle(calc, cellStyle); const calcSaved = await saveReopen(calc, 'xlsx'); calc = calcSaved.reopened;
  const diskCell = calcSaved.disk.sheets!.find(item => item.name === sheet.name)!.rows[49][25]; assert.equal(diskCell.formula, 'SUM(20,22)'); assert.equal(Number(diskCell.value), 42);
  await navigate(calc, { kind: 'cell', sheetName: sheet.name, address: 'Z50' }); assertPatch((await inspect(calc, 'cells')).data, cellStyle, 'reopened Calc cell style'); assert.deepEqual((await getCell()).data, cellBefore.data); results.calcSaved = { hash: calcSaved.hash, computed: cellBefore, style: cellStyle };
  console.log('Native semantic: real Calc cell/formula 42, typed style, native undo, disk save and reopen passed');

  let slides = await open('pptx');
  const shapeList = await tool<{ data: { slideIndex: number; total: number; unit: string; truncated: boolean; objects: { name: string; type: string; text: string; bounds: { x: number; y: number; width: number; height: number } }[] } }>('office_query', { viewId: slides.id, target: { kind: 'shapes', slideIndex: 0 } });
  assert.equal(shapeList.data.unit, '1/100mm'); assert.equal(shapeList.data.slideIndex, 0); assert.ok(shapeList.data.total > 0); assert.ok(shapeList.data.objects.length > 0 && shapeList.data.objects.length <= 500); assert.equal(shapeList.data.truncated, shapeList.data.objects.length < shapeList.data.total);
  const named = shapeList.data.objects.find(item => !!item.text.trim() && !!item.name.trim() && shapeList.data.objects.filter(other => other.name === item.name).length === 1); assert.ok(named, 'discover one real, uniquely named text shape instead of guessing the first shape');
  await navigate(slides, { kind: 'shape', slideIndex: 0, name: named.name }); const shapeSelection = await status(slides); assertSelectionIdentity(shapeSelection, 'objects'); assert.deepEqual(shapeSelection.selection!.objectNames, [named.name]);
  const marker = '真实语义 Impress 文字样式 · QA';
  results.impressTextModeDispatch = await command(slides, '.uno:Text');
  // A collapsed Impress edit caret is not necessarily exposed by getSelection.
  // SelectAll's observable result proves text mode: an unchanged object mode
  // would still return XShapes and fail the exact range assertions below.
  await command(slides, '.uno:SelectAll');
  await until(async () => { const current = await status(slides); results.impressSelectTextProbe = current; return current.selection?.kind === 'text' && current.selection.text === named.text && !!current.selection.locator?.blockId && (!('identityUnavailable' in current.selection) || current.selection.identityUnavailable !== true); }, 'actual controller SelectAll yields the complete shape text and stable native range identity');
  const textSelection = await status(slides); assertSelectionIdentity(textSelection, 'text'); assert.equal(textSelection.selection!.locator!.from, 0); assert.equal(textSelection.selection!.locator!.to, named.text.length);
  // Replacing the actual selected XTextRange creates a unique persisted marker;
  // no OOXML shape id or substitute controller is injected into this path.
  const replacement = await tool<{ receipt: Receipt; state: NativeOfficeState }>('office_execute', { viewId: slides.id, ...versions(textSelection), replacement: { expectedText: named.text, text: marker }, idempotencyKey: randomUUID() }); assert.equal(replacement.receipt.status, 'applied'); assert.equal(replacement.state.actor, 'agent', 'native replacement reports the real agent producer');
  await selectImpressTextAfterCommit(slides, 'text');
  await command(slides, '.uno:SelectAll'); await until(async () => (await status(slides)).selection?.text === marker, 'actual text range covers the new full marker');
  assertSelectionIdentity(await status(slides), 'text');
  const slideText = await roundTrip(slides, 'text', value => ({ target: 'text', values: { fontSize: value.fields.fontSize.value === 19 ? 23 : 19, italic: value.fields.italic.value !== true, color: value.fields.color.value === '166a71' ? '893b58' : '166a71' } }), 'impressText'); assert.equal((await shapeQuery(slides, named.name)).data.text, marker);
  await applyStyle(slides, slideText); results.commandDrivenImpressTextEditVerified = true;
  await navigate(slides, { kind: 'shape', slideIndex: 0, name: named.name }); const objectAgain = await status(slides); assertSelectionIdentity(objectAgain, 'objects'); assert.deepEqual(objectAgain.selection!.objectNames, [named.name]);
  const shapeBefore = await shapeQuery(slides, named.name);
  const shapeStyle = await roundTrip(slides, 'shape', value => { const x = value.fields.x.value, width = value.fields.width.value; assert.equal(typeof x, 'number'); assert.equal(typeof width, 'number'); equalValue('x', x, shapeBefore.data.bounds.x / 100, 'native 1/100mm position versus public mm'); equalValue('width', width, shapeBefore.data.bounds.width / 100, 'native 1/100mm width versus public mm'); return { target: 'shape', values: { x: Number(x) + 2.5, width: Number(width) + 3, fill: value.fields.fill.value === 'b6d8cc' ? 'dbc3d2' : 'b6d8cc' } }; }, 'impressShape');
  assert.deepEqual((await shapeQuery(slides, named.name)).data, shapeBefore.data, 'real native undo restores object geometry/text, not a mirrored approximation');
  await applyStyle(slides, shapeStyle); const changedShape = await shapeQuery(slides, named.name); assert.equal(changedShape.data.text, marker);
  if (shapeStyle.target !== 'shape') throw new Error('shape style expected'); assert.ok(Math.abs(changedShape.data.bounds.x - shapeStyle.values.x! * 100) <= 1); assert.ok(Math.abs(changedShape.data.bounds.width - shapeStyle.values.width! * 100) <= 1); assert.equal(changedShape.data.bounds.y, shapeBefore.data.bounds.y); assert.equal(changedShape.data.bounds.height, shapeBefore.data.bounds.height);
  const slidesSaved = await saveReopen(slides, 'pptx'); slides = slidesSaved.reopened; assert.ok(slidesSaved.disk.slides!.some(page => page.blocks.some(block => block.text === marker)));
  // The actual PPTX must store the pre-save logical geometry exactly. This
  // build's importer exposes open rectangle sizes one 1/100mm unit smaller:
  // the same difference exists on the untouched input. Do not compensate the
  // file or loosen the native Undo assertions above.
  const savedZip = await JSZip.loadAsync(await readFile(join(directory, names.pptx))), savedXml = new DOMParser().parseFromString(await savedZip.file('ppt/slides/slide1.xml')!.async('string'), 'application/xml');
  const presentationNS = 'http://schemas.openxmlformats.org/presentationml/2006/main', drawingNS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const savedShapes = Array.from(savedXml.getElementsByTagNameNS(presentationNS, 'sp')).filter(shape => shape.getElementsByTagNameNS(presentationNS, 'cNvPr')[0]?.getAttribute('name') === named.name); assert.equal(savedShapes.length, 1);
  const transform = savedShapes[0].getElementsByTagNameNS(drawingNS, 'xfrm')[0], offset = transform.getElementsByTagNameNS(drawingNS, 'off')[0], extent = transform.getElementsByTagNameNS(drawingNS, 'ext')[0]; assert.ok(offset && extent);
  const storedGeometry = { x: Number(offset.getAttribute('x')), y: Number(offset.getAttribute('y')), width: Number(extent.getAttribute('cx')), height: Number(extent.getAttribute('cy')) };
  for (const field of ['x','y','width','height'] as const) assert.equal(storedGeometry[field], changedShape.data.bounds[field] * 360, 'actual saved XML retains exact EMU ' + field);
  await navigate(slides, { kind: 'shape', slideIndex: 0, name: named.name }); const reloadedShape = (await shapeQuery(slides, named.name)).data;
  const { bounds: reloadedBounds, ...reloadedIdentity } = reloadedShape, { bounds: savedBounds, ...savedIdentity } = changedShape.data;
  assert.deepEqual(reloadedIdentity, savedIdentity, 'PPTX reopen retains exact name, type and text');
  for (const field of ['x','y'] as const) assert.equal(reloadedBounds[field], savedBounds[field], 'PPTX reopen retains exact ' + field);
  for (const field of ['width','height'] as const) assert.ok(Math.abs(reloadedBounds[field] - savedBounds[field]) <= 1, 'PPTX native import size differs by at most 0.01mm: ' + field);
  results.impressStoredGeometry = { unit: 'EMU', saved: storedGeometry, preSaveNative: savedBounds, reloadedNative: reloadedBounds, nativeUnit: '1/100mm' };
  assertPatch((await inspect(slides, 'shape')).data, shapeStyle, 'reopened Impress shape style');
  await command(slides, '.uno:Text'); await command(slides, '.uno:SelectAll'); await until(async () => { const current = await status(slides); results.impressReopenedTextProbe = current; return current.selection?.kind === 'text' && current.selection.text === marker; }, 'reopened text selection');
  const reopenedText = await status(slides); assertSelectionIdentity(reopenedText, 'text'); assert.equal(reopenedText.selection!.locator!.from, 0); assert.equal(reopenedText.selection!.locator!.to, marker.length); assertPatch((await inspect(slides, 'text')).data, slideText, 'reopened Impress text style');
  await navigate(slides, { kind: 'shape', slideIndex: 0, name: named.name }); assertSelectionIdentity(await status(slides), 'objects'); results.impressSaved = { hash: slidesSaved.hash, objectList: shapeList, marker, textStyle: slideText, shapeStyle };
  console.log('Native semantic: actual Impress GUI Text/SelectAll, typed text/object style, native undo, disk save and reopen passed; physical keys remain unverified');

  for (const format of Object.keys(names) as NativeOfficeFormat[]) assert.deepEqual(await readFile(resolve('examples/moon-tide', names[format])), originals.get(format), 'the original authored examples remain byte-identical');
  assert.deepEqual(errors, []); assert.doesNotMatch(stderr.join(''), /Object has been destroyed|UnhandledPromiseRejection|Uncaught (?:Exception|TypeError|Error)/i);
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), port, directory, ...results, errors }, null, 2));
  console.log('Real reader / stdio MCP / UNO semantic acceptance: PASS', evidence);
} catch (error) {
  await main.screenshot({ path: join(evidence, 'failure-chrome.png'), scale: 'css' }).catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), directory, port, ...results, errors, stderr: stderr.join('').slice(-20000) }, null, 2)); console.error('Native semantic acceptance evidence:', evidence); throw error;
} finally {
  await mcp.close().catch(() => {}); await writeFile(join(evidence, 'mcp-calls.json'), JSON.stringify(calls, null, 2)); await writeFile(join(evidence, 'main-stderr.log'), stderr.join(''));
  await app.close(); // Only this isolated application; no process killing or user session shutdown.
}
