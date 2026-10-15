import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { ViewerCore } from '../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { blankBytes } from '../packages/document-core/src/fixtures';
import { dispatch } from '../packages/sdk/src/dispatch';
import { actionsFor } from '../packages/selection-tools/src/index';
import { ViewerError } from '../packages/contracts/src/index';
import type { EditOperation, NativeOfficeCommand, NativeOfficeDriver, NativeOfficeState, NativeOfficeSnapshot, NativeOfficeExecuteRequest, NativeOfficeQuery, NativeOfficeNavigateTarget, NativeOfficeExportFormat, NativeOfficeCapture, NativeOfficeInputRequest, NativeOfficeStylePatch, NativeOfficeStyleInspection } from '../packages/contracts/src/index';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** A deterministic driver seam for Core contracts, using real parseable OOXML.
 * These tests prove routing/version/disk semantics; they do not claim native GUI coverage. */
class OfficeDriver implements NativeOfficeDriver {
  bytes: Uint8Array = new Uint8Array(); before?: Uint8Array; base!: NativeOfficeState;
  viewIds = new Set<string>(); opens = 0; snapshots = 0; executes = 0; inputs = 0; undos = 0; closes = 0; stateCalls = 0; detached: string[] = [];
  unstable = false; pending = false; queryChanges = false; exportChanges = false; changeDuringAck = false; geometry = true; visible = true; selectionOverride?: NativeOfficeState['selection']; visibleText = '真实界面采样测试范围'; visibleTextTruncated = false; visibleRange?: string;
  executeEntered?: ReturnType<typeof gate>; executeWait?: ReturnType<typeof gate>; inputEntered?: ReturnType<typeof gate>; inputWait?: ReturnType<typeof gate>; lastExecute?: NativeOfficeExecuteRequest; lastInput?: NativeOfficeInputRequest; lastTarget?: NativeOfficeNavigateTarget;
  styleApply?: (patch: NativeOfficeStylePatch) => Promise<void>; styleInspection?: NativeOfficeStyleInspection; replacementError?: Error;
  async open(input: Parameters<NativeOfficeDriver['open']>[0]) {
    this.opens++;
    if (!this.base) { this.bytes = input.bytes.slice(); this.base = { sessionId: 'session', documentId: input.documentId, format: input.format, engineEpoch: 'epoch', engineRevision: 0, selectionEpoch: 0, dirty: false, status: 'ready', actor: 'engine', undo: { canUndo: false, canRedo: false, count: 0 }, supportedOperations: ['word.setBlock', 'sheets.setCell'], selectionActions:['bold','italic','underline','strike','align-left','align-center','replace'] }; }
    this.viewIds.add(input.viewId); return this.state('session', input.viewId);
  }
  async state(_session: string, viewId?: string): Promise<NativeOfficeState> {
    this.stateCalls++;
    if(viewId&&!this.viewIds.has(viewId))throw Object.assign(new Error('controller detached'),{code:'NATIVE_VIEW_NOT_FOUND'});
    return structuredClone({ ...this.base, viewId: viewId ?? [...this.viewIds][0], pendingInput: this.pending, visible: this.visible, nativeGeometry: this.geometry,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1.5, bounds: { x: 80, y: 100, width: 800, height: 600 }, screenBounds: { x: 120, y: 150, width: 1200, height: 900 }, layoutRevision: 3, visibleRange: this.visibleRange },
      selection: this.selectionOverride ?? { kind: 'text', text: '当前可见选区', rect: { x: 20, y: 30, width: 100, height: 24 }, locator: { kind: 'paragraph', blockId: 'paragraph-0' } }, visibleText: this.visibleText, visibleTextTruncated: this.visibleTextTruncated, visibleTextReady:true, visibleTextSource:'actual-a11y' });
  }
  async snapshot(_session: string): Promise<NativeOfficeSnapshot> { this.snapshots++; return { bytes: this.bytes.slice(), format: this.base.format, state: await this.state('session'), engineRevisionBefore: this.base.engineRevision, engineRevisionAfter: this.base.engineRevision + (this.unstable ? 1 : 0), stable: !this.unstable, sha256: sha(this.bytes), undoToken: this.base.undo?.token }; }
  async replaceWord(text: string) { const zip = await JSZip.loadAsync(this.bytes), xml = await zip.file('word/document.xml')!.async('string'); zip.file('word/document.xml', xml.replace(/(<w:t>)[\s\S]*?(<\/w:t>)/, '$1' + text + '$2')); this.bytes = await zip.generateAsync({ type: 'uint8array' }); this.changed(); }
  changed() { this.base.engineRevision++; this.base.dirty = true; this.base.undo = { canUndo: true, canRedo: false, count: 1, token: 'undo-' + this.base.engineRevision }; }
  async commands() { return [{ command: '.uno:Bold' },{ command: '.uno:Italic' }, { command: '.uno:Print', opensDialog: true }, ...['.uno:Copy','.uno:CopySheet','.uno:SelectAll','.uno:SelectText','.uno:Select'].map(command => ({ command })), { command: '.uno:Save' }, { command: '.uno:HyperlinkDialog' }, { command: '.uno:RunMacro' }, { command: '.uno:TransformDocumentStructure' }]; }
  async commandStatus(_session: string, _view: string, commands: string[]) { return commands.map(command => ({ command, available: true, enabled: true })); }
  async query(_session: string, _view: string, target: NativeOfficeQuery) { if (this.queryChanges) this.base.selectionEpoch!++; return target.kind === 'style' ? structuredClone(this.styleInspection) : { text: '有限查询范围' }; }
  async execute(input: NativeOfficeExecuteRequest) {
    this.executes++; this.lastExecute = input; this.executeEntered?.resolve(); if (this.executeWait) await this.executeWait.promise;
    this.before = this.bytes.slice();
    if (input.cell) { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(this.bytes) as any); const cell = workbook.getWorksheet(input.cell.sheetName)!.getCell(input.cell.address); cell.value = input.cell.content.startsWith('=') ? { formula: input.cell.content.slice(1) } : input.cell.content; this.bytes = new Uint8Array(await workbook.xlsx.writeBuffer()); this.changed(); }
    else if (input.operation?.kind === 'word.setBlock') await this.replaceWord(input.operation.text);
    else if(input.replacement) { await this.replaceWord(input.replacement.text); if (this.replacementError) throw this.replacementError; }
    else if (input.style) { if (!this.styleApply) throw Object.assign(new Error('style not implemented by this driver'), { code: 'NATIVE_OPERATION_UNSUPPORTED' }); await this.styleApply(input.style); }
    const changed = sha(this.bytes) !== sha(this.before);
    return { status: changed ? 'applied' as const : input.style ? 'no-change' as const : 'dispatched' as const, state: await this.state('session', input.viewId), undoToken: this.base.undo?.token };
  }
  async undo(input: Parameters<NativeOfficeDriver['undo']>[0]) { this.undos++; if (this.before) this.bytes = this.before.slice(); this.changed(); this.base.undo = { canUndo: false, canRedo: true, count: 0 }; return { status: 'applied' as const, state: await this.state('session', input.viewId) }; }
  async navigate(input: { viewId: string; target: NativeOfficeNavigateTarget }) { this.lastTarget = input.target; this.base.selectionEpoch!++; return { status: 'rendered' as const, state: await this.state('session', input.viewId) }; }
  async input(input: NativeOfficeInputRequest) { this.inputs++; this.lastInput = input; this.inputEntered?.resolve(); if (this.inputWait) await this.inputWait.promise; return { state: await this.state('session', input.viewId) }; }
  async captureNative(_session: string, _view: string): Promise<NativeOfficeCapture> { return { mimeType: 'image/png', data: 'test-driver-pixel-seam', width: 1200, height: 900, deviceScaleFactor: 1.5, rect: { x: 0, y: 0, width: 800, height: 600 }, engineEpoch: this.base.engineEpoch, engineRevision: this.base.engineRevision, sessionId: 'session', capturedAt: new Date().toISOString(), layoutRevision: 3 }; }
  async zoom(_session: string, viewId: string, _factor: number) { return this.state('session', viewId); }
  async exportCopy(_session: string, input: { format: NativeOfficeExportFormat }) {
    let bytes: Uint8Array;
    if (input.format === 'pdf') { const pdf = await PDFDocument.create(); pdf.addPage(); bytes = await pdf.save(); }
    else if (input.format === 'odt') { const zip = new JSZip(); zip.file('mimetype', 'application/vnd.oasis.opendocument.text'); zip.file('content.xml', '<office:document-content/>'); bytes = await zip.generateAsync({ type: 'uint8array' }); }
    else bytes = this.bytes.slice();
    if (this.exportChanges) this.changed();
    return { bytes, format: input.format, state: await this.state('session'), engineRevisionBefore: this.base.engineRevision, engineRevisionAfter: this.base.engineRevision, stable: true, sha256: sha(bytes) };
  }
  async ackSaved() { if (this.changeDuringAck) { await this.replaceWord('保存期间继续输入'); return false; } this.base.dirty = false; return true; }
  async detachView(_session: string, viewId: string) { this.detached.push(viewId); this.viewIds.delete(viewId); }
  async close() { this.closes++; this.viewIds.clear(); }
}
async function setup(format: 'docx' | 'xlsx' | 'pptx' = 'docx') {
  const directory = await mkdtemp(join(tmpdir(), 'av-native-writer-')), repository = new JsonWorkspaceRepository(join(directory, 'workspace.json')), core = new ViewerCore(repository);
  const view = await core.openBytes('writer.' + format, await blankBytes(format), format), driver = new OfficeDriver(); core.registerNativeOfficeDriver(driver);
  return { core, view, driver, directory, repository };
}
const versions = (state: NativeOfficeState) => ({ expectedEngineEpoch: state.engineEpoch, expectedEngineRevision: state.engineRevision, expectedSelectionEpoch: state.selectionEpoch });
const plan = (core: ViewerCore, documentId: string, viewId: string, text = '原生写入的真实文件') => core.prepare(documentId, core.getDocument(documentId).info.revision, { kind: 'word.setBlock', blockId: 'paragraph-0', text }, { viewId });

test('tiled first display does not await a serialized mirror, while public reads still obtain a real snapshot', async()=>{
  const {core,view,driver}=await setup();
  await core.openNativeOffice(view.id,{deferInitialMirror:true});
  assert.equal(driver.snapshots,0,'real native state is usable before the OOXML exporter');
  assert.equal(core.getDocument(view.documentId).info.nativeOffice?.mirrorEngineRevision,-1);
  assert.equal((await core.context(view.id)).quality,'not-ready','source bytes cannot masquerade as a fresh native mirror');
  const result=await dispatch(core,'read',{documentId:view.documentId}) as {blocks:unknown[]};
  assert.ok(result.blocks.length);assert.equal(driver.snapshots,1);
  assert.equal(core.getDocument(view.documentId).info.nativeOffice?.mirrorEngineRevision,0);
  assert.equal((await core.context(view.id)).quality,'confirmed');
});

test('pending native import neither blocks unrelated views nor resurrects a tab closed before its controller arrives',async()=>{
  const {core,view,driver}=await setup(),entered=gate(),release=gate(),original=driver.open.bind(driver),before=core.getDocument(view.documentId).bytes.slice();
  driver.open=async input=>{entered.resolve();await release.promise;return original(input);};
  const first=core.openNativeOffice(view.id,{deferInitialMirror:true}),duplicate=core.openNativeOffice(view.id,{deferInitialMirror:true});
  const rejected=Promise.all([assert.rejects(first,{code:'NATIVE_OPEN_CANCELLED'}),assert.rejects(duplicate,{code:'NATIVE_OPEN_CANCELLED'})]);
  await entered.promise;
  assert.throws(()=>core.registerNativeOfficeDriver(new OfficeDriver()),{code:'NATIVE_SESSION_ACTIVE'});
  const markdown=await core.openBytes('independent.md',new TextEncoder().encode('# 继续阅读'),'markdown');core.activate(markdown.id);
  await core.requestCloseView(view.id,true);
  assert.equal(core.activeViewId,markdown.id);assert.equal(core.views.has(view.id),false);assert.equal(driver.closes,0,'the importer remains live until its real completion');
  assert.equal(core.getDocument(view.documentId).info.nativeOffice,undefined);
  release.resolve();await rejected;
  assert.equal(driver.opens,1,'two requests share one actual import');assert.equal(driver.closes,1,'only the abandoned writer is retired after import');
  assert.equal(core.getDocument(view.documentId).info.nativeOffice,undefined);assert.deepEqual(core.getDocument(view.documentId).bytes,before);
});

test('cancelling a second loading controller leaves the already bound writable document and view intact',async()=>{
  const {core,view,driver}=await setup();await core.openNativeOffice(view.id);
  const second=core.addView(view.documentId),entered=gate(),release=gate(),original=driver.open.bind(driver);
  driver.open=async input=>{entered.resolve();await release.promise;return original(input);};
  const pending=core.openNativeOffice(second.id,{deferInitialMirror:true}),rejected=assert.rejects(pending,{code:'NATIVE_OPEN_CANCELLED'});
  await entered.promise;await driver.replaceWord('原视图继续编辑');await core.requestCloseView(second.id,true);assert.equal(core.views.has(view.id),true);
  release.resolve();await rejected;
  assert.equal(driver.closes,0,'cancelling another controller never closes the shared writer');assert.deepEqual(driver.detached,[second.id]);
  assert.equal((await core.nativeOfficeState(view.id)).viewId,view.id);assert.equal(core.getDocument(view.documentId).info.nativeOffice?.sessionId,'session');
  await core.synchronizeNativeDocument(view.documentId);assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text,'原视图继续编辑');
});

test('cancelled imports retain failed writer cleanup until shutdown confirms actual disposal',async()=>{
  const {core,view,driver}=await setup(),entered=gate(),release=gate(),originalOpen=driver.open.bind(driver),originalClose=driver.close.bind(driver);
  const before=core.getDocument(view.documentId).bytes.slice();let closeAttempts=0;
  driver.open=async input=>{entered.resolve();await release.promise;return originalOpen(input);};
  driver.close=async()=>{if(++closeAttempts<3)throw new ViewerError('NATIVE_CLOSE_VETO','own test worker remains live');await originalClose();};
  const opening=core.openNativeOffice(view.id,{deferInitialMirror:true}),rejected=assert.rejects(opening,{code:'NATIVE_CLOSE_VETO'});
  await entered.promise;await core.requestCloseView(view.id,true);
  let terminal=false;const shutdown=core.shutdownNativeOffice().finally(()=>{terminal=true;}),shutdownRejected=assert.rejects(shutdown,{code:'NATIVE_CLOSE_VETO'});
  await Promise.resolve();assert.equal(terminal,false,'shutdown must await the importer actual terminal receipt');assert.equal(closeAttempts,0);
  release.resolve();await rejected;await shutdownRejected;
  assert.equal(closeAttempts,2);assert.equal(driver.viewIds.has(view.id),true);assert.equal(core.views.has(view.id),false);assert.equal(core.getDocument(view.documentId).info.nativeOffice,undefined);
  assert.throws(()=>core.registerNativeOfficeDriver(new OfficeDriver()),{code:'NATIVE_SESSION_ACTIVE'},'failed cleanup cannot silently orphan a writer');
  await core.shutdownNativeOffice();assert.equal(closeAttempts,3);assert.equal(driver.closes,1);assert.equal(driver.snapshots,0);assert.deepEqual(core.getDocument(view.documentId).bytes,before);
  core.registerNativeOfficeDriver(new OfficeDriver());
});

for(const cleanup of ['reject','missing'] as const)test('cancelled extra controller with '+cleanup+' detach preserves parent edits and clears only after whole-writer close',async()=>{
  const {core,view,driver,directory}=await setup();await core.openNativeOffice(view.id);
  const second=core.addView(view.documentId),entered=gate(),release=gate(),originalOpen=driver.open.bind(driver);let detachAttempts=0;
  driver.open=async input=>{entered.resolve();await release.promise;return originalOpen(input);};
  if(cleanup==='missing')Reflect.set(driver,'detachView',undefined);
  else driver.detachView=async()=>{detachAttempts++;throw new ViewerError('NATIVE_CONNECTION_LOST','own test detach not confirmed');};
  const pending=core.openNativeOffice(second.id,{deferInitialMirror:true}),rejected=assert.rejects(pending,{code:cleanup==='missing'?'CAPABILITY_UNSUPPORTED':'NATIVE_CONNECTION_LOST'});
  await entered.promise;await driver.replaceWord('父视图未保存的修改');await core.requestCloseView(second.id,true);release.resolve();await rejected;
  assert.equal(driver.closes,0);assert.equal(driver.viewIds.has(second.id),true);assert.equal((await core.nativeOfficeState(view.id)).viewId,view.id);
  await core.synchronizeNativeDocument(view.documentId);assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text,'父视图未保存的修改');
  const patch=plan(core,view.documentId,view.id,'父视图继续修改并保存');await core.commit(patch.id,'parent-after-cancel-'+cleanup,'human');
  const target=join(directory,'parent-after-cancel.docx');await core.save(view.documentId,target);assert.deepEqual(new Uint8Array(await readFile(target)),driver.bytes);
  assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text,'父视图继续修改并保存');assert.equal(driver.closes,0);
  await core.shutdownNativeOffice();assert.equal(driver.closes,1);assert.equal(detachAttempts,cleanup==='reject'?1:0,'confirmed writer close retires all its controllers without replaying detach');
  assert.equal(core.views.has(view.id),true);assert.equal(core.views.has(second.id),false);core.registerNativeOfficeDriver(new OfficeDriver());
});

test('trusted worker exit disposes cancelled-import tombstones without retrying a dead worker',async()=>{
  const {core,view,driver}=await setup(),entered=gate(),release=gate(),originalOpen=driver.open.bind(driver);let closeAttempts=0;
  driver.open=async input=>{entered.resolve();await release.promise;return originalOpen(input);};
  driver.close=async()=>{closeAttempts++;throw new ViewerError('NATIVE_CONNECTION_LOST','own test close result unknown');};
  const pending=core.openNativeOffice(view.id,{deferInitialMirror:true}),rejected=assert.rejects(pending,{code:'NATIVE_CONNECTION_LOST'});
  await entered.promise;await core.requestCloseView(view.id,true);release.resolve();await rejected;
  assert.throws(()=>core.registerNativeOfficeDriver(new OfficeDriver()),{code:'NATIVE_SESSION_ACTIVE'});
  core.failNativeOfficeSession('session');await core.shutdownNativeOffice();assert.equal(closeAttempts,1);core.registerNativeOfficeDriver(new OfficeDriver());
});

test('reopening after a failed sole-writer retirement imports updated library bytes instead of adopting the obsolete model',async()=>{
  const {core,view,driver,directory}=await setup(),entered=gate(),release=gate(),originalOpen=driver.open.bind(driver),originalClose=driver.close.bind(driver);let closeAttempts=0;
  driver.open=async input=>{entered.resolve();await release.promise;return originalOpen(input);};
  driver.close=async()=>{if(++closeAttempts<3)throw new ViewerError('NATIVE_CLOSE_VETO','own test writer remains live');await originalClose();Reflect.set(driver,'base',undefined);};
  const opening=core.openNativeOffice(view.id,{deferInitialMirror:true}),rejected=assert.rejects(opening,{code:'NATIVE_CLOSE_VETO'});
  await entered.promise;await core.requestCloseView(view.id,true);release.resolve();await rejected;
  const next=core.addView(view.documentId),patch=plan(core,view.documentId,next.id,'文档库中的后续编辑');await core.commit(patch.id,'library-after-retirement','human');
  const target=join(directory,'updated-library.docx');await core.save(view.documentId,target);const bytes=core.getDocument(view.documentId).bytes.slice();
  await assert.rejects(core.openNativeOffice(next.id,{deferInitialMirror:true}),{code:'NATIVE_CLOSE_VETO'});assert.equal(driver.opens,1,'an unretired sole writer cannot accept a new controller');assert.equal(core.getDocument(view.documentId).info.nativeOffice,undefined);
  await core.openNativeOffice(next.id,{deferInitialMirror:true});assert.equal(closeAttempts,3);assert.equal(driver.opens,2);assert.deepEqual(driver.bytes,bytes);assert.deepEqual(new Uint8Array(await readFile(target)),bytes);
  await core.synchronizeNativeDocument(view.documentId);assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text,'文档库中的后续编辑');await core.shutdownNativeOffice();
});

test('native writer invalidates old mirror patches, commits only through driver and retains view identity', async () => {
  const { core, view, driver } = await setup(), old = plan(core, view.documentId, view.id), second = core.addView(view.documentId);
  core.registry.resolve('docx').apply = async () => { throw new Error('old OOXML writer must not execute'); };
  await core.openNativeOffice(view.id); await core.openNativeOffice(second.id);
  await assert.rejects(core.commit(old.id, 'old-writer'), { code: 'NATIVE_WRITER_CHANGED' });
  const patch = plan(core, view.documentId, second.id); core.activate(view.id, 'human');
  const receipt = await core.commit(patch.id, 'native'); assert.equal(receipt.status, 'applied'); assert.equal(driver.executes, 1);
  assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text, '原生写入的真实文件'); assert.equal(core.getView(second.id).agentState?.phase, 'editing'); assert.equal(core.getView(view.id).agentState, undefined); assert.equal(core.lastHumanViewId, view.id);
  assert.deepEqual(await core.commit(patch.id, 'native'), receipt); assert.equal(driver.executes, 1);
  const reply = await dispatch(core, 'office-execute', { viewId: second.id, ...versions(await core.nativeOfficeState(second.id)), command: '.uno:Bold', idempotencyKey: 'command' }) as any;
  assert.equal(reply.state.viewId, second.id); assert.equal(reply.receipt.status, 'dispatched');
});

test('desktop native display omits large mirrored models before cloning while public reads and snapshots retain actual content', async () => {
  const { core, view, driver } = await setup(); const ordinary = await core.openBytes('ordinary.docx', await blankBytes('docx'), 'docx'), markdown = await core.openBytes('notes.md', new TextEncoder().encode('# 完整 Markdown'), 'markdown');
  await core.openNativeOffice(view.id); const text = '原生正文和样式仍完整。'.repeat(20000); await driver.replaceWord(text); await core.synchronizeNativeDocument(view.documentId);
  const original = structuredClone(core.getDocument(view.documentId).info), beforeBytes = core.getDocument(view.documentId).bytes.slice(), lease = core.acquireAgentView({ viewId: view.id });
  const publicState = core.state(), display = core.stateForDisplay(), shown = display.documents.find(document => document.id === view.documentId)!;
  assert.deepEqual(shown, { ...original, model: { format: 'docx' } }); assert.equal(display.views.find(candidate => candidate.id === view.id)?.agentState?.controlId, lease.controlId);
  assert.deepEqual(display.documents.find(document => document.id === ordinary.documentId), publicState.documents.find(document => document.id === ordinary.documentId)); assert.deepEqual(display.documents.find(document => document.id === markdown.documentId), publicState.documents.find(document => document.id === markdown.documentId));
  assert.equal(publicState.documents.find(document => document.id === view.documentId)!.model.blocks![0].text, text); assert.ok(Buffer.byteLength(JSON.stringify(display)) < Buffer.byteLength(JSON.stringify(publicState)) / 4);
  const read = await dispatch(core, 'read', { documentId: view.documentId }) as any; assert.equal(read.blocks[0].text, text); assert.equal((await core.snapshot(view.id)).document.model.blocks![0].text, text);
  shown.title = '只修改投影'; display.views[0].pinned = true; assert.equal(core.getDocument(view.documentId).info.title, original.title); assert.equal(core.getView(display.views[0].id).pinned, false); assert.deepEqual(core.getDocument(view.documentId).bytes, beforeBytes);
  core.failNativeOfficeSession('session'); const failed = core.stateForDisplay().documents.find(document => document.id === view.documentId)!; assert.deepEqual(failed.model, { format: 'docx' }); assert.equal(failed.nativeOffice?.status, 'failed'); assert.equal(core.state().documents.find(document => document.id === view.documentId)!.model.blocks![0].text, text);
  await core.closeNativeOffice(view.documentId); assert.equal(core.stateForDisplay().documents.find(document => document.id === view.documentId)!.model.blocks![0].text, text);
});

test('engine edits and unstable or pending snapshots cannot be mistaken for current stable bytes', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); const patch = plan(core, view.documentId, view.id);
  await driver.replaceWord('人类后来修改'); await assert.rejects(core.commit(patch.id, 'stale'), { code: 'VERSION_CONFLICT' }); assert.equal(driver.executes, 0);
  const before = core.getDocument(view.documentId).bytes.slice(), count = driver.snapshots; driver.unstable = true;
  await assert.rejects(core.synchronizeNativeDocument(view.documentId), { code: 'NATIVE_SNAPSHOT_BUSY' }); assert.equal(driver.snapshots - count, 3); assert.deepEqual(core.getDocument(view.documentId).bytes, before);
  driver.unstable = false; driver.pending = true; await assert.rejects(core.synchronizeNativeDocument(view.documentId), { code: 'NATIVE_EDIT_IN_PROGRESS' });
});

test('snapshot digest reuse still validates driver bytes before publishing, including drivers without a supplied hash', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); const before = core.getDocument(view.documentId).bytes.slice(), snapshot = driver.snapshot.bind(driver), adapter = core.registry.resolve('docx'), open = adapter.open.bind(adapter); let parsed = 0;
  adapter.open = async (...args) => { parsed++; return open(...args); };
  await driver.replaceWord('需要真实校验的文件内容'); driver.snapshot = async (...args) => ({ ...await snapshot(...args), sha256: '0'.repeat(64) });
  await assert.rejects(core.synchronizeNativeDocument(view.documentId), { code: 'NATIVE_SNAPSHOT_INVALID' }); assert.deepEqual(core.getDocument(view.documentId).bytes, before); assert.equal(parsed, 0);
  driver.snapshot = async (...args) => ({ ...await snapshot(...args), sha256: undefined });
  await core.synchronizeNativeDocument(view.documentId); assert.deepEqual(core.getDocument(view.documentId).bytes, driver.bytes); assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text, '需要真实校验的文件内容'); assert.equal(parsed, 1);
  await core.synchronizeNativeDocument(view.documentId); assert.equal(parsed, 1);
});

test('normal context/status polls never snapshot, confirmed selection requires real native geometry', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); const count = driver.snapshots;
  const context = await core.context(view.id); assert.equal(context.actor, 'engine'); assert.equal(context.quality, 'confirmed'); assert.deepEqual(context.selection.rect, { x: 20, y: 30, width: 100, height: 24 });
  for (let i = 0; i < 8; i++) { await dispatch(core, 'office-status', { viewId: view.id }); await core.context(view.id); } assert.equal(driver.snapshots, count);
  driver.geometry = false; assert.equal((await core.context(view.id)).quality, 'not-ready'); assert.equal((await core.context(view.id)).selection.rect, undefined);
  driver.geometry = true; await driver.replaceWord('原生未同步'); assert.equal((await core.context(view.id)).quality, 'not-ready');
});

test('trusted native context reuse avoids a second driver read without weakening public fresh reads or source/selection/layout guards', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); const state = await core.nativeOfficeState(view.id), calls = driver.stateCalls;
  const reused = core.updateNativeOfficeContext(state); assert.equal(driver.stateCalls, calls); assert.equal(reused.quality, 'confirmed'); assert.equal(reused.visibleText, driver.visibleText); assert.equal(reused.nativeOffice?.engineEpoch, state.engineEpoch);
  await core.context(view.id); assert.equal(driver.stateCalls, calls + 1);
  for (const patch of [{ viewId: undefined }, { sessionId: 'wrong-session' }, { engineEpoch: 'old-epoch' }, { documentId: 'wrong-document' }, { engineRevision: state.engineRevision + 1 }, { selectionEpoch: state.selectionEpoch! + 1 }, { viewport: { ...state.viewport!, layoutRevision: 4 } }]) assert.throws(() => core.updateNativeOfficeContext({ ...state, ...patch }));
  driver.visibleText = '真正新视口'; const fresh = await core.context(view.id); assert.equal(fresh.visibleText, '真正新视口'); assert.equal(driver.stateCalls, calls + 2);
  const idleEvents = core.eventLog.filter(event => event.type === 'context.changed').length, latest = await core.nativeOfficeState(view.id);
  for (let index = 0; index < 8; index++) core.updateNativeOfficeContext(latest);
  assert.equal(core.eventLog.filter(event => event.type === 'context.changed').length, idleEvents); assert.equal(driver.snapshots, 1);
});

test('identical fresh native reads preserve the display context reference, version and capture time', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); await core.context(view.id);
  const original = core.getView(view.id).context!, display = core.stateForDisplay(), calls = driver.stateCalls;
  for (let index = 0; index < 8; index++) {
    const received = await core.context(view.id);
    assert.strictEqual(core.getView(view.id).context, original);
    assert.equal(received.viewRevision, original.viewRevision); assert.equal(received.capturedAt, original.capturedAt);
    assert.deepEqual(core.stateForDisplay(), display);
  }
  assert.equal(driver.stateCalls, calls + 8, 'preserving display state must not skip the public live engine check');
  assert.equal(driver.snapshots, 1, 'context polling must not export the document');
});

test('native context dedup retains real selection, actor, layout, source and quality changes', async () => {
  const { core, view } = await setup(); await core.openNativeOffice(view.id);
  let state = await core.nativeOfficeState(view.id); core.updateNativeOfficeContext(state);
  const changed = (patch: Partial<NativeOfficeState>) => {
    const previous = core.getView(view.id).context!;
    state = { ...state, ...patch }; core.updateNativeOfficeState(state);
    const received = core.updateNativeOfficeContext(state);
    assert.notStrictEqual(core.getView(view.id).context, previous);
    assert.equal(received.viewRevision, previous.viewRevision + 1);
    const current = core.getView(view.id).context;
    core.updateNativeOfficeContext(structuredClone(state)); assert.strictEqual(core.getView(view.id).context, current);
    return received;
  };
  assert.equal(changed({ actor: 'human' }).actor, 'human');
  assert.equal(changed({ selectionEpoch: state.selectionEpoch! + 1, selection: { ...state.selection!, text: '真正的新选区', rect: { x: 22, y: 40, width: 160, height: 24 } } }).selection.text, '真正的新选区');
  assert.equal(changed({ viewport: { ...state.viewport!, layoutRevision: state.viewport!.layoutRevision! + 1, width: 700 } }).viewport!.width, 700);
  assert.equal(changed({ viewport: { ...state.viewport!, deviceScaleFactor: 2 } }).viewport!.deviceScaleFactor, 2);
  assert.equal(changed({ visibleText: '新的实际可见正文' }).visibleText, '新的实际可见正文');
  assert.equal(changed({ selectionActions: ['replace'] }).nativeOffice!.selectionActions![0], 'replace');
  assert.equal(changed({ visibleTextTruncated: true }).nativeOffice!.visibleTextTruncated, true);
  assert.equal(changed({ nativeGeometry: false }).selection.rect, undefined);
  assert.equal(changed({ nativeGeometry: true }).quality, 'confirmed');
  const unavailable = changed({ visibleTextReady: false, visibleTextSource: 'unavailable' });
  assert.equal(unavailable.quality, 'not-ready'); assert.equal(unavailable.visibleText, '');
  assert.equal(changed({ visibleTextReady: true, visibleTextSource: 'actual-a11y' }).quality, 'confirmed');
  assert.equal(changed({ visible: false }).quality, 'not-ready');
});

test('same native state becomes confirmed when its mirror catches up, without requiring an extra engine revision', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); await core.context(view.id);
  driver.changed(); const current = await core.nativeOfficeState(view.id);
  const waiting = core.updateNativeOfficeContext(current), previous = core.getView(view.id).context!;
  assert.equal(waiting.quality, 'not-ready'); const revision = core.getDocument(view.documentId).info.revision;
  await core.synchronizeNativeDocument(view.documentId);
  assert.equal(core.getDocument(view.documentId).info.revision, revision, 'this same-byte snapshot updates only the native mirror lease');
  const confirmed = core.updateNativeOfficeContext(current);
  assert.equal(confirmed.quality, 'confirmed'); assert.equal(confirmed.nativeOffice!.engineRevision, waiting.nativeOffice!.engineRevision);
  assert.notStrictEqual(core.getView(view.id).context, previous); assert.equal(confirmed.viewRevision, waiting.viewRevision + 1);
});

test('continuous native position updates persist the latest recovery within 2.5 seconds instead of each poll', async t => {
  const { core, view, driver, repository } = await setup(); await core.openNativeOffice(view.id); await core.persist();
  const originalSave = repository.save.bind(repository), writes: Promise<void>[] = [];
  repository.save = value => { const pending = originalSave(value); writes.push(pending); return pending; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let index = 0; index < 6; index++) {
    driver.visibleText = '持续滚动真实视口 ' + index; const state = await core.nativeOfficeState(view.id); core.updateNativeOfficeContext(state);
    t.mock.timers.tick(450); if (index < 5) assert.equal(writes.length, 0);
  }
  assert.equal(writes.length, 1); await Promise.all(writes);
  const recovery = await repository.load<any>(); assert.equal(recovery.views[0].context.visibleText, '持续滚动真实视口 5'); assert.equal(recovery.documents[0].bytes, Buffer.from(driver.bytes).toString('base64'));
  // Eight identical polls still read fresh metadata but create no writes/events.
  const events = core.eventLog.length;
  for (let index = 0; index < 8; index++) core.updateNativeOfficeContext(await core.nativeOfficeState(view.id));
  t.mock.timers.tick(3000); assert.equal(writes.length, 1); assert.equal(core.eventLog.length, events);
});

test('native content revisions and dirty stay on prompt recovery budget while explicit save cancels deferred position writes', async t => {
  const { core, view, driver, repository, directory } = await setup(); await core.openNativeOffice(view.id); await core.persist();
  const originalSave = repository.save.bind(repository), writes: Promise<void>[] = [];
  repository.save = value => { const pending = originalSave(value); writes.push(pending); return pending; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  driver.visibleText = '待恢复阅读位置'; core.updateNativeOfficeContext(await core.nativeOfficeState(view.id));
  t.mock.timers.tick(200); await driver.replaceWord('内容修改必须及时留恢复点'); await core.nativeOfficeState(view.id);
  t.mock.timers.tick(299); assert.equal(writes.length, 0); t.mock.timers.tick(1); assert.equal(writes.length, 1); await Promise.all(writes);
  let recovery = await repository.load<any>(); assert.equal(recovery.documents[0].info.dirty, true); assert.equal(recovery.documents[0].info.nativeOffice.engineRevision, driver.base.engineRevision);
  await core.synchronizeNativeDocument(view.documentId); t.mock.timers.tick(300); assert.equal(writes.length, 2); await Promise.all(writes);
  recovery = await repository.load<any>(); assert.equal(recovery.documents[0].bytes, Buffer.from(driver.bytes).toString('base64')); assert.equal(recovery.documents[0].info.model.blocks[0].text, '内容修改必须及时留恢复点');
  driver.visibleText = '另一个待恢复位置'; core.updateNativeOfficeContext(await core.nativeOfficeState(view.id)); const before = writes.length;
  const path = join(directory, 'explicit-save.docx'); await core.save(view.documentId, path); assert.equal(writes.length, before + 1); assert.deepEqual(new Uint8Array(await readFile(path)), driver.bytes);
  t.mock.timers.tick(5000); assert.equal(writes.length, before + 1); recovery = await repository.load<any>(); assert.equal(recovery.documents[0].info.dirty, false); assert.equal(recovery.documents[0].sourceHash, sha(await readFile(path)));
});

test('native viewport locator follows actual visible text after scrolling, preserves offscreen selection provenance and exposes coverage',async()=>{
  const {core,view,driver}=await setup();await core.openNativeOffice(view.id);
  const caret={kind:'native-text',pageIndex:0,quote:'留在第一页的选区'};
  driver.selectionOverride={kind:'text',text:'留在第一页的选区',pageIndex:0,locator:caret,rect:{x:20,y:30,width:120,height:24}};assert.deepEqual((await core.context(view.id)).locator,caret);
  driver.selectionOverride={...driver.selectionOverride,rect:undefined};driver.visibleText='滚动后真实显示的第五页正文';driver.visibleTextTruncated=true;
  const context=await core.context(view.id);assert.equal(context.locator.pageIndex,undefined);assert.deepEqual(context.locator,{kind:'native-viewport',quote:'滚动后真实显示的第五页正文'});assert.deepEqual(context.selection.locator,caret);assert.equal(context.selection.text,'留在第一页的选区');assert.equal(context.nativeOffice?.visibleTextTruncated,true);assert.equal(context.nativeOffice?.visibleTextSource,'actual-a11y');assert.equal(context.nativeOffice?.visibleTextReady,true);
  driver.selectionOverride.rect={x:20,y:-200,width:120,height:24};assert.equal((await core.context(view.id)).locator.kind,'native-viewport');
  const calc=await setup('xlsx');await calc.core.openNativeOffice(calc.view.id);calc.driver.visibleRange='D20:H40';calc.driver.selectionOverride={kind:'cells',text:'离屏A1',sheetName:'功能清单',range:'A1'};const cells=await calc.core.context(calc.view.id);assert.equal(cells.locator.kind,'native-viewport');assert.equal(cells.locator.cell,'D20:H40');assert.equal(cells.locator.sheetId,'功能清单');assert.equal(cells.nativeOffice?.range,'A1');
});

test('trusted native state raises original dirty before idle mirroring and never clears it from a temporary native clean flag',async()=>{
  const {core,view,driver,directory}=await setup();await core.save(view.documentId,join(directory,'original.docx'));await core.openNativeOffice(view.id);assert.equal(core.getDocument(view.documentId).info.dirty,false);
  const count=driver.snapshots,bytes=core.getDocument(view.documentId).bytes.slice();await driver.replaceWord('尚未闲时同步的输入');driver.base.dirty=false;core.updateNativeOfficeState(await driver.state('session',view.id));
  assert.equal(core.getDocument(view.documentId).info.dirty,true);assert.equal(driver.snapshots,count);assert.deepEqual(core.getDocument(view.documentId).bytes,bytes);
  core.updateNativeOfficeState(await driver.state('session',view.id));assert.equal(core.getDocument(view.documentId).info.dirty,true);
});

test('draft rejection/version checks run before native execution, released in-flight native edits stay truthful', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id);
  core.extensions.set('before-agent-edit', async () => { throw Object.assign(new Error('draft'), { code: 'DRAFT_CONFLICT' }); });
  await assert.rejects(dispatch(core, 'office-execute', { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), command: '.uno:Bold', idempotencyKey: 'draft' }), { code: 'DRAFT_CONFLICT' }); assert.equal(driver.executes, 0);
  core.extensions.delete('before-agent-edit'); const lease = core.acquireAgentView({ viewId: view.id }), patch = plan(core, view.documentId, view.id);
  driver.executeEntered = gate(); driver.executeWait = gate(); const executing = core.commit(patch.id, 'already-dispatched'); await driver.executeEntered.promise;
  core.releaseAgentView({ viewId: view.id, controlId: lease.controlId }); driver.executeWait.resolve(); const receipt = await executing;
  assert.equal(receipt.status, 'applied'); assert.equal(receipt.controlReleased, true); assert.equal(core.getView(view.id).agentState, undefined); assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text, '原生写入的真实文件');
  assert.deepEqual(await core.commit(patch.id, 'already-dispatched'), receipt); assert.equal(core.getView(view.id).agentState, undefined);
});

test('save writes a frozen real file, cannot clear concurrent native edits or overwrite external source changes', async () => {
  const { core, view, driver, directory } = await setup(); await core.openNativeOffice(view.id); await driver.replaceWord('保存快照');
  const output = join(directory, 'saved.docx'); driver.changeDuringAck = true; await core.save(view.documentId, output);
  const onDisk = await core.registry.resolve('docx').open(new Uint8Array(await readFile(output)), 'docx'); assert.equal(onDisk.blocks![0].text, '保存快照'); assert.equal(core.getDocument(view.documentId).info.dirty, true);
  await core.synchronizeNativeDocument(view.documentId); assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text, '保存期间继续输入');
  await writeFile(output, await blankBytes('docx')); await assert.rejects(core.save(view.documentId), { code: 'FILE_CONFLICT' });
});

test('a native temporary save clearing dirty cannot mark original source bytes saved', async () => {
  const { core, view, driver, directory } = await setup(), output = join(directory, 'original.docx');
  await core.save(view.documentId, output); const original = await readFile(output); await core.openNativeOffice(view.id);
  await driver.replaceWord('原生内部临时保存'); driver.base.dirty = false;
  await core.synchronizeNativeDocument(view.documentId); assert.equal(core.getDocument(view.documentId).info.dirty, true); assert.deepEqual(await readFile(output), original);
  await assert.rejects(core.requestCloseView(view.id, false), { code: 'UNSAVED_CHANGES' }); assert.equal(driver.closes, 0);
});

test('authoritative clean content history ignores view revisions and serialization metadata without clearing existing dirty', async () => {
  const { core, view, driver, directory } = await setup(), path = join(directory, 'original.docx'); await core.save(view.documentId, path); const source = await readFile(path);
  await core.openNativeOffice(view.id); driver.base.unsavedContentChanges = false; driver.base.engineRevision++;
  // OOXML packaging metadata can differ after view settings/normalization even
  // though the authoritative native model has never had a content edit.
  const zip = await JSZip.loadAsync(driver.bytes); driver.bytes = await zip.generateAsync({ type: 'uint8array', comment: 'native view serialization' });
  core.updateNativeOfficeState(await driver.state('session', view.id)); assert.equal(core.getDocument(view.documentId).info.dirty, false);
  await core.synchronizeNativeDocument(view.documentId); assert.equal(core.getDocument(view.documentId).info.dirty, false); assert.notEqual(sha(core.getDocument(view.documentId).bytes), sha(source)); assert.deepEqual(await readFile(path), source);
  core.getDocument(view.documentId).info.dirty = true; core.updateNativeOfficeState(await driver.state('session', view.id)); await core.synchronizeNativeDocument(view.documentId); assert.equal(core.getDocument(view.documentId).info.dirty, true);
});

test('authoritative content history survives native temporary save with dirty false until application save', async () => {
  const { core, view, driver, directory } = await setup(), path = join(directory, 'original.docx'); await core.save(view.documentId, path); const source = await readFile(path);
  await core.openNativeOffice(view.id); await driver.replaceWord('真实修改后原生临时保存'); driver.base.dirty = false; driver.base.unsavedContentChanges = true;
  core.updateNativeOfficeState(await driver.state('session', view.id)); assert.equal(core.getDocument(view.documentId).info.dirty, true);
  await core.synchronizeNativeDocument(view.documentId); assert.equal(core.getDocument(view.documentId).info.dirty, true); assert.deepEqual(await readFile(path), source); await assert.rejects(core.requestCloseView(view.id), { code: 'UNSAVED_CHANGES' });
  driver.ackSaved = async () => { driver.base.dirty = false; driver.base.unsavedContentChanges = false; return true; };
  await core.save(view.documentId); assert.equal(core.getDocument(view.documentId).info.dirty, false); assert.deepEqual(new Uint8Array(await readFile(path)), driver.bytes);
});

test('native undo is conditional and cannot restore old mirror bytes into a live writer', async () => {
  const { core, view, driver } = await setup(), old = plan(core, view.documentId, view.id, '旧镜像事务'); const oldReceipt = await core.commit(old.id, 'old');
  await core.openNativeOffice(view.id); await assert.rejects(core.undo(oldReceipt.transactionId), { code: 'NATIVE_UNDO_UNAVAILABLE' });
  const receipt = await core.commit(plan(core, view.documentId, view.id).id, 'new-native'); const result = await core.undo(receipt.transactionId); assert.equal(result.status, 'undone'); assert.equal(driver.undos, 1); assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text, '旧镜像事务');
  const another = await core.commit(plan(core, view.documentId, view.id).id, 'another'); await driver.replaceWord('后续编辑'); await assert.rejects(core.undo(another.transactionId), { code: 'VERSION_CONFLICT' }); assert.equal(driver.undos, 1);
});

test('shared document controllers detach safely, last close checkpoints and restart has no fictitious live session', async () => {
  const { core, view, driver, repository } = await setup(), second = core.addView(view.documentId); await core.openNativeOffice(view.id); await core.openNativeOffice(second.id);
  await core.requestCloseView(second.id, true); assert.deepEqual(driver.detached, [second.id]); assert.equal(driver.closes, 0);
  await driver.replaceWord('退出前的原生修改'); core.acquireAgentView({ viewId: view.id }); await core.requestCloseView(view.id, true); assert.equal(driver.closes, 1); assert.equal(core.views.size, 0);
  assert.equal(core.getDocument(view.documentId).info.nativeOffice, undefined); assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text, '退出前的原生修改');
  const restored = new ViewerCore(repository); await restored.initialize(); assert.equal(restored.getDocument(view.documentId).info.nativeOffice, undefined); assert.deepEqual(restored.state().agentStates, []);
});

test('detaching a native window preserves tab/control identities and reopens that controller on the same shared model',async()=>{
  const {core,view,driver}=await setup(),other=core.addView(view.documentId,'second-window');await core.openNativeOffice(view.id);await core.openNativeOffice(other.id);const lease=core.acquireAgentView({viewId:view.id});await core.context(view.id);
  core.activate(other.id,'human');const result=await core.detachNativeOfficeView(view.id);assert.equal(result.detached,true);assert.equal(core.getView(view.id).agentState?.controlId,lease.controlId);assert.equal(core.getView(view.id).context?.quality,'not-ready');assert.equal(core.getView(view.id).context?.viewport,undefined);assert.equal(core.getView(view.id).context?.selection.rect,undefined);assert.deepEqual(driver.detached,[view.id]);assert.equal(driver.closes,0);assert.equal(core.lastHumanViewId,other.id);
  const calls=driver.stateCalls,context=await core.context(view.id);assert.equal(context.quality,'not-ready');assert.equal(context.visibleText,'');assert.equal(driver.stateCalls,calls);await assert.rejects(core.nativeOfficeState(view.id),{code:'NATIVE_VIEW_NOT_FOUND'});
  const otherState=await core.nativeOfficeState(other.id);assert.equal(otherState.sessionId,'session');assert.equal(driver.opens,2);await core.openNativeOffice(view.id);assert.equal(driver.opens,3);assert.equal(driver.viewIds.has(view.id),true);assert.equal(core.getView(view.id).agentState?.controlId,lease.controlId);assert.equal((await core.nativeOfficeState(view.id)).sessionId,otherState.sessionId);
});

test('dynamic catalog keeps unknown enabled honest, routes managed operations and allows native hyperlink dialog', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id);
  const catalog = await dispatch(core, 'office-commands', { viewId: view.id }) as any;
  assert.equal(catalog.commands.find((c: any) => c.command === '.uno:Bold').enabled, undefined); assert.equal(catalog.commands.find((c: any) => c.command === '.uno:Save').enabled, false); assert.equal(catalog.commands.find((c: any) => c.command === '.uno:RunMacro').enabled, false);
  const args = { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), idempotencyKey: 'command' };
  await assert.rejects(dispatch(core, 'office-execute', { ...args, command: '.uno:Save' }), { code: 'NATIVE_COMMAND_MANAGED' }); assert.equal(driver.executes, 0);
  await dispatch(core, 'office-execute', { ...args, command: '.uno:HyperlinkDialog' }); assert.equal(driver.executes, 1);
  driver.queryChanges = true; await assert.rejects(dispatch(core, 'office-query', { viewId: view.id, target: { kind: 'selection' } }), { code: 'STALE_NATIVE_QUERY' });
});

test('public SDK/Core rejects raw structural transforms including nested managed commands before the native writer', async () => {
  const { core, view, driver } = await setup('pptx'); await core.openNativeOffice(view.id); const lease = core.acquireAgentView({ viewId: view.id, phase: 'reading' });
  const original = driver.bytes.slice(), beforeRevision = core.getDocument(view.documentId).info.revision;
  const catalog = await dispatch(core, 'office-commands', { viewId: view.id }) as { commands: NativeOfficeCommand[] };
  const item = catalog.commands.find(value => value.command === '.uno:TransformDocumentStructure');
  assert.equal(item?.available, false); assert.equal(item.enabled, false); assert.equal(item.reason, '结构化编辑仅通过绑定真实目标的类型化事务提供');
  const payloads = [
    { UnoCommand: { name: '.uno:Save' } },
    { Transforms: { SlideCommands: [{ 'EditTextObject.0': [{ UnoCommand: '.uno:RunMacro' }] }] } },
    { Transforms: { SlideCommands: [{ 'EditTextObject.0': [{ SelectText: [] }, { InsertText: 'unvalidated object edit' }] }] } },
  ];
  for (const [index, payload] of payloads.entries()) {
    await assert.rejects(dispatch(core, 'office-execute', { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), command: '.uno:TransformDocumentStructure', args: [{ name: 'DataJson', type: 'string', value: JSON.stringify(payload) }], controlId: lease.controlId, idempotencyKey: 'public-transform-' + index }), { code: 'NATIVE_COMMAND_MANAGED', message: '结构化编辑仅通过绑定真实目标的类型化事务提供' });
  }
  assert.equal(driver.executes, 0); assert.deepEqual(driver.bytes, original); assert.equal(core.getDocument(view.documentId).info.revision, beforeRevision); assert.equal(core.getView(view.id).agentState?.phase, 'reading');
  // The field name itself is not blacklisted: other allowed native commands
  // continue to receive primitive args without a global DataJson ban.
  const value = JSON.stringify({ literal: '.uno:Save is text here' });
  await dispatch(core, 'office-execute', { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), command: '.uno:Bold', args: [{ name: 'DataJson', type: 'string', value }], controlId: lease.controlId, idempotencyKey: 'ordinary-primitive-args' });
  assert.equal(driver.executes, 1); assert.deepEqual(driver.lastExecute?.args, [{ name: 'DataJson', type: 'string', value }]);
});

test('command-status batch cannot attach a later selection capability to an earlier selection lease', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id);
  const before = await core.nativeOfficeState(view.id), status = driver.commandStatus.bind(driver);
  driver.commandStatus = async (...args) => { const commands = await status(...args); driver.base.selectionEpoch!++; return commands; };
  await assert.rejects(dispatch(core, 'office-command-status', { viewId: view.id, commands: ['.uno:Bold', '.uno:Italic'] }), { code: 'STALE_NATIVE_QUERY' });
  driver.commandStatus = status;
  const result = await dispatch(core, 'office-command-status', { viewId: view.id, commands: ['.uno:Bold'] }) as any;
  assert.equal(result.state.selectionEpoch, before.selectionEpoch! + 1); assert.equal(result.commands[0].enabled, true); assert.equal(driver.executes, 0);
});

test('a committed source save keeps its receipt/hash/recovery when its native acknowledgement is lost', async () => {
  for (const failureAt of ['ack', 'state'] as const) {
    const { core, view, driver, directory, repository } = await setup(); await core.openNativeOffice(view.id); await driver.replaceWord('保存后确认失败的实际内容');
    const path = join(directory, 'saved.docx'), readState = driver.state.bind(driver);
    driver.ackSaved = async () => {
      if (failureAt === 'ack') throw Object.assign(new Error('lost save acknowledgement'), { code: 'NATIVE_REQUEST_TIMEOUT' });
      driver.base.dirty = false; driver.state = async () => { throw Object.assign(new Error('writer ended after save'), { code: 'NATIVE_WORKER_EXITED' }); }; return true;
    };
    const receipt = await core.save(view.documentId, path);
    assert.equal(receipt.status, 'saved'); assert.equal(receipt.path, path); assert.match(receipt.warnings![0], /文件已保存/); assert.deepEqual(new Uint8Array(await readFile(path)), driver.bytes);
    assert.equal(core.getDocument(view.documentId).sourceHash, sha(await readFile(path))); assert.equal(core.getDocument(view.documentId).info.dirty, true);
    assert.equal(core.eventLog.filter(event => event.type === 'document.saved').length, 1);
    const restored = new ViewerCore(repository); await restored.initialize(); assert.equal(restored.getDocument(view.documentId).sourceHash, sha(await readFile(path))); assert.equal(restored.getDocument(view.documentId).info.dirty, true);
    // A later genuine acknowledgement can settle the same saved source without
    // a false external-file conflict caused by a forgotten source hash.
    driver.state = readState; driver.ackSaved = async () => { driver.base.dirty = false; return true; };
    assert.equal((await core.save(view.documentId)).status, 'saved'); assert.equal(core.getDocument(view.documentId).info.dirty, false);
  }
});

test('a close veto can refresh and retry, while an unknown close outcome never drops a live writer', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); await driver.replaceWord('关闭被拒绝时保留真实内容');
  const close = driver.close.bind(driver), state = driver.state.bind(driver);
  driver.close = async () => { throw Object.assign(new Error('dialog veto'), { code: 'NATIVE_CLOSE_VETO' }); };
  await assert.rejects(core.closeNativeOffice(view.documentId), { code: 'NATIVE_CLOSE_VETO' });
  assert.equal(core.getDocument(view.documentId).info.nativeOffice?.status, 'failed'); assert.equal(driver.viewIds.has(view.id), true); assert.equal(core.eventLog.filter(event => event.type === 'office.closed').length, 0);
  assert.equal((await core.nativeOfficeState(view.id)).status, 'ready');
  driver.close = async () => { throw Object.assign(new Error('close outcome unknown'), { code: 'NATIVE_REQUEST_TIMEOUT' }); };
  await assert.rejects(core.closeNativeOffice(view.documentId), { code: 'NATIVE_REQUEST_TIMEOUT' });
  driver.state = async () => { throw Object.assign(new Error('state still unanswered'), { code: 'NATIVE_REQUEST_TIMEOUT' }); };
  await assert.rejects(core.closeNativeOffice(view.documentId), { code: 'NATIVE_REQUEST_TIMEOUT' });
  assert.notEqual(core.getDocument(view.documentId).info.nativeOffice, undefined); assert.equal(driver.viewIds.has(view.id), true); assert.equal(driver.closes, 0);
  driver.state = state; driver.close = close;
  await core.closeNativeOffice(view.documentId); assert.equal(driver.closes, 1); assert.equal(core.getDocument(view.documentId).info.nativeOffice, undefined);
  assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text, '关闭被拒绝时保留真实内容'); assert.equal(core.getDocument(view.documentId).info.dirty, true);
});

test('PDF/ODF export is an independent parseable file, refuses destination overwrite and changed source', async () => {
  const { core, view, driver, directory } = await setup(); await core.openNativeOffice(view.id);
  const args = { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), idempotencyKey: 'export', path: join(directory, 'copy.pdf'), format: 'pdf' };
  const exported = await dispatch(core, 'office-export', args) as any; const pdf = await PDFDocument.load(await readFile(args.path)); assert.equal(pdf.getPageCount(), 1); assert.equal(exported.sha256, sha(await readFile(args.path))); assert.equal(core.getDocument(view.documentId).info.path, undefined);
  assert.deepEqual(await dispatch(core, 'office-export', args), exported);
  await assert.rejects(dispatch(core, 'office-export', { ...args, idempotencyKey: 'existing' }), { code: 'FILE_EXISTS' });
  const odf = join(directory, 'copy.odt'); await dispatch(core, 'office-export', { ...args, path: odf, format: 'odt', idempotencyKey: 'odf' }); assert.equal(await (await JSZip.loadAsync(await readFile(odf))).file('mimetype')!.async('string'), 'application/vnd.oasis.opendocument.text');
  driver.exportChanges = true; await assert.rejects(dispatch(core, 'office-export', { ...args, path: join(directory, 'changed.pdf'), idempotencyKey: 'changed' }), { code: 'NATIVE_EXPORT_INVALID' });
});

test('typed cell edit routes sheet names/formulas and returns requested controller, not snapshot controller', async () => {
  const { core, view, driver } = await setup('xlsx'), second = core.addView(view.documentId); await core.openNativeOffice(view.id); await core.openNativeOffice(second.id);
  core.registry.resolve('xlsx').apply = async () => { throw new Error('mirror writer forbidden'); };
  const input = { viewId: second.id, ...versions(await core.nativeOfficeState(second.id)), sheetName: '功能清单', address: 'G20', content: '=SUM(A1:A2)', idempotencyKey: 'formula' };
  const result = await dispatch(core, 'office-cell-set', input) as any; assert.equal(result.state.viewId, second.id); assert.equal(result.receipt.status, 'applied'); assert.deepEqual(driver.lastExecute?.cell, { sheetName: '功能清单', address: 'G20', content: '=SUM(A1:A2)' });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(core.getDocument(view.documentId).bytes) as any); assert.equal(workbook.getWorksheet('功能清单')!.getCell('G20').formula, 'SUM(A1:A2)');
  assert.deepEqual(await dispatch(core, 'office-cell-set', input), result); assert.equal(driver.executes, 1);
  const undone = await dispatch(core, 'office-undo', { viewId: second.id, ...versions(await core.nativeOfficeState(second.id)), undoToken: result.undoToken, idempotencyKey: 'cell-undo' }) as any; assert.equal(undone.state.viewId, second.id);
});

test('public native input/capture/zoom are view scoped and reject hidden/stale geometry', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id);
  const input = { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), expectedLayoutRevision: 3, action: { kind: 'type', text: '中文输入' }, idempotencyKey: 'input' };
  const result = await dispatch(core, 'office-input', input) as any; assert.equal(result.status, 'dispatched'); assert.equal(driver.lastInput?.viewId, view.id); assert.deepEqual(await dispatch(core, 'office-input', input), result); assert.equal(driver.inputs, 1);
  const shot = await dispatch(core, 'office-capture', { viewId: view.id, expectedLayoutRevision: 3 }) as any; assert.equal(shot.viewId, view.id); assert.equal(shot.layoutRevision, 3);
  await assert.rejects(dispatch(core, 'office-capture', { viewId: view.id, expectedLayoutRevision: 2 }), { code: 'STALE_COORDINATES' });
  const zoom = await dispatch(core, 'zoom', { viewId: view.id, factor: 1.5 }) as any; assert.equal(zoom.zoom, 1.5);
  driver.visible = false; await assert.rejects(dispatch(core, 'office-input', { ...input, idempotencyKey: 'hidden' }), { code: 'NATIVE_VIEW_HIDDEN' }); await assert.rejects(dispatch(core, 'office-capture', { viewId: view.id }), { code: 'NATIVE_VIEW_HIDDEN' });
});

test('coordinate native inputs require a layout lease, while keyboard inputs retain semantic engine/selection leases', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id);
  const expected = { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)) };
  for (const action of [{ kind: 'click', x: 10, y: 10 }, { kind: 'move', x: 10, y: 10 }, { kind: 'drag', from: { x: 10, y: 10 }, to: { x: 20, y: 20 } }, { kind: 'scroll', x: 10, y: 10, deltaY: 20 }]) {
    await assert.rejects(dispatch(core, 'office-input', { ...expected, action, idempotencyKey: 'missing-layout-' + action.kind }), { code: 'STALE_COORDINATES' });
  }
  assert.equal(driver.inputs, 0);
  await assert.rejects(dispatch(core, 'office-input', { ...expected, expectedLayoutRevision: 2, action: { kind: 'click', x: 10, y: 10 }, idempotencyKey: 'old-layout' }), { code: 'STALE_COORDINATES' }); assert.equal(driver.inputs, 0);
  await dispatch(core, 'office-input', { ...expected, expectedLayoutRevision: 3, action: { kind: 'click', x: 10, y: 10 }, idempotencyKey: 'current-layout' }); assert.equal(driver.lastInput?.expectedLayoutRevision, 3);
  await dispatch(core, 'office-input', { ...expected, action: { kind: 'press', key: 'Enter' }, idempotencyKey: 'semantic-key' }); assert.equal(driver.lastInput?.expectedSelectionEpoch, expected.expectedSelectionEpoch); assert.equal(driver.inputs, 2);
});

test('legacy reader navigation maps to native paragraph/cell targets without emitting fake DOM requests', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id);
  const args = { viewId: view.id, expectedRevision: core.getDocument(view.documentId).info.revision, target: { kind: 'paragraph', blockId: 'paragraph-1' }, idempotencyKey: 'native-reader' };
  const result = await dispatch(core, 'reader-navigate', args) as any; assert.equal(result.status, 'rendered'); assert.deepEqual(driver.lastTarget, { kind: 'paragraph', paragraphIndex: 1 }); assert.equal(core.eventLog.filter(event => event.type === 'reader.navigate').length, 0);
  assert.deepEqual(await dispatch(core, 'reader-navigate', args), result);
  const sheet = await setup('xlsx'); await sheet.core.openNativeOffice(sheet.view.id);
  await dispatch(sheet.core, 'reader-navigate', { viewId: sheet.view.id, expectedRevision: 0, target: { kind: 'cell', sheetId: '1', address: 'AY2000' }, idempotencyKey: 'beyond-mirror' }); assert.deepEqual(sheet.driver.lastTarget, { kind: 'cell', sheetName: '功能清单', address: 'AY2000' });
});

test('native selection formatting needs frozen selection epoch, never guesses an OOXML block or first shape', async () => {
  const {core,view,driver}=await setup();await core.openNativeOffice(view.id);
  driver.selectionOverride={kind:'text',text:core.getDocument(view.documentId).info.model.blocks![0].text,rect:{x:20,y:30,width:100,height:24}};
  const snapshot=await core.snapshot(view.id),actions=actionsFor(snapshot,false).map(action=>action.id);
  assert.equal(snapshot.context.selection.locator,undefined);assert.equal(actions.includes('bold'),true);assert.equal(actions.includes('replace'),true);assert.equal(actions.includes('center-object'),false);
  await dispatch(core,'selection-action',{snapshotId:snapshot.id,action:'italic',idempotencyKey:'native-selected-italic'},'human');assert.equal(driver.lastExecute?.command,'.uno:Italic');assert.equal(driver.lastExecute?.actor,'human');assert.equal(driver.lastExecute?.operation,undefined);assert.equal(driver.lastExecute?.expectedSelectionEpoch,snapshot.context.nativeOffice?.selectionEpoch);
  driver.base.selectionEpoch!++;await assert.rejects(dispatch(core,'selection-action',{snapshotId:snapshot.id,action:'bold',idempotencyKey:'native-stale-selection'}),{code:'STALE_SELECTION'});
  const fresh=await core.snapshot(view.id);await dispatch(core,'selection-action',{snapshotId:fresh.id,action:'replace',value:'真实选区替换',idempotencyKey:'native-selected-replace'});
  assert.deepEqual(driver.lastExecute?.replacement,{expectedText:driver.selectionOverride.text,text:'真实选区替换'});assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text,'真实选区替换');
});

test('native Calc single cell replace uses explicit range, while multi-cell replace is not falsely advertised',async()=>{
  const {core,view,driver}=await setup('xlsx');await core.openNativeOffice(view.id);driver.selectionOverride={kind:'cells',text:'格式',sheetName:'功能清单',range:'A1'};
  const snapshot=await core.snapshot(view.id);assert.equal(actionsFor(snapshot,false).some(action=>action.id==='replace'),true);
  await dispatch(core,'selection-action',{snapshotId:snapshot.id,action:'replace',value:'新表头',idempotencyKey:'selected-cell'},'human');assert.deepEqual(driver.lastExecute?.cell,{sheetName:'功能清单',address:'A1',content:'新表头'});
  driver.selectionOverride={kind:'cells',text:'范围',sheetName:'功能清单',range:'A1:B2'};const range=await core.snapshot(view.id);assert.equal(actionsFor(range,false).some(action=>action.id==='replace'),false);
  const count=driver.executes;const note=await dispatch(core,'selection-action',{snapshotId:range.id,action:'highlight',idempotencyKey:'native-highlight'}) as any;assert.equal(note.annotation.kind,'highlight');assert.equal(driver.executes,count);
});

test('trusted native failure preserves recovery bytes and publishes failed state without calling a dead worker',async()=>{
  const {core,view,driver,directory}=await setup();await core.save(view.documentId,join(directory,'original.docx'));await core.openNativeOffice(view.id);
  await driver.replaceWord('退出前已经稳定的内容');await core.synchronizeNativeDocument(view.documentId);const checkpoint=core.getDocument(view.documentId).bytes.slice(),calls=driver.stateCalls;
  core.failNativeOfficeSession('session');const state=await core.nativeOfficeState(view.id);assert.equal(state.status,'failed');assert.equal(state.visible,false);assert.equal(state.nativeGeometry,false);assert.equal(state.visibleTextReady,false);assert.equal(driver.stateCalls,calls);
  assert.equal((await core.context(view.id)).quality,'not-ready');assert.equal(driver.stateCalls,calls);assert.deepEqual(core.getDocument(view.documentId).bytes,checkpoint);assert.equal(core.getDocument(view.documentId).info.dirty,true);
  await assert.rejects(dispatch(core,'office-execute',{viewId:view.id,...versions(state),command:'.uno:Bold',idempotencyKey:'failed'}),{code:'NATIVE_SESSION_EXPIRED'});assert.equal(driver.executes,0);await core.persist();
});

test('trusted exit close and shutdown retain the last checkpoint without contacting dead UNO or saving source bytes',async()=>{
  const {core,view,driver,directory,repository}=await setup();const originalPath=join(directory,'original.docx');await core.save(view.documentId,originalPath);const original=await readFile(originalPath);
  await core.openNativeOffice(view.id);await driver.replaceWord('最后确认的恢复正文');await core.synchronizeNativeDocument(view.documentId);const checkpoint=core.getDocument(view.documentId).bytes.slice(),snapshots=driver.snapshots;
  core.failNativeOfficeSession('session');await assert.rejects(core.requestCloseView(view.id),{code:'UNSAVED_CHANGES'});await core.requestCloseView(view.id,true);
  assert.equal(driver.closes,0);assert.equal(driver.snapshots,snapshots);assert.equal(core.getDocument(view.documentId).info.dirty,true);assert.equal(core.getDocument(view.documentId).info.nativeOffice,undefined);assert.deepEqual(core.getDocument(view.documentId).bytes,checkpoint);assert.deepEqual(await readFile(originalPath),original);assert.match(core.getDocument(view.documentId).info.warnings.join('\n'),/最后确认的恢复点.*未保存到原文件/);
  const recovered=new ViewerCore(repository);await recovered.initialize();assert.deepEqual(recovered.getDocument(view.documentId).bytes,checkpoint);assert.equal(recovered.getDocument(view.documentId).info.dirty,true);
  const second=core.addView(view.documentId),replacement=new OfficeDriver();core.registerNativeOfficeDriver(replacement);await core.openNativeOffice(second.id);core.failNativeOfficeSession('session');const replacementSnapshots=replacement.snapshots;await core.shutdownNativeOffice();assert.equal(replacement.closes,0);assert.equal(replacement.snapshots,replacementSnapshots);assert.equal(core.getDocument(view.documentId).info.nativeOffice,undefined);
});

test('dispatched editing changes only a held reading lease phase, never invents a completed edit or revision',async()=>{
  const {core,view,driver}=await setup();await core.openNativeOffice(view.id);const owner=core.acquireAgentView({viewId:view.id}),revision=core.getDocument(view.documentId).info.revision;
  const args={viewId:view.id,...versions(await core.nativeOfficeState(view.id)),controlId:owner.controlId,command:'.uno:Bold',idempotencyKey:'pending-format'};
  const result=await dispatch(core,'office-execute',args) as any;assert.equal(result.receipt.status,'dispatched');assert.equal(core.getView(view.id).agentState?.phase,'editing');assert.equal(core.getView(view.id).agentState?.lastEdit,undefined);assert.equal(core.getDocument(view.documentId).info.revision,revision);assert.equal(driver.executes,1);
  core.releaseAgentView({viewId:view.id,controlId:owner.controlId});await dispatch(core,'office-execute',{...args,controlId:undefined,idempotencyKey:'no-held-owner'});assert.equal(core.getView(view.id).agentState,undefined);
});

test('readonly dispatched commands and a released or paused in-flight editor cannot set an editing phase',async()=>{
  const {core,view,driver}=await setup();await core.openNativeOffice(view.id);const owner=core.acquireAgentView({viewId:view.id});
  await dispatch(core,'office-execute',{viewId:view.id,...versions(await core.nativeOfficeState(view.id)),command:'.uno:Print',idempotencyKey:'print'});assert.equal(core.getView(view.id).agentState?.phase,'reading');
  driver.executeEntered=gate();driver.executeWait=gate();const executing=dispatch(core,'office-execute',{viewId:view.id,...versions(await core.nativeOfficeState(view.id)),controlId:owner.controlId,command:'.uno:Bold',idempotencyKey:'release-pending'});await driver.executeEntered.promise;core.releaseAgentView({viewId:view.id,controlId:owner.controlId});core.setAgentControl(view.id,'paused');driver.executeWait.resolve();const result=await executing as any;
  assert.equal(result.receipt.status,'dispatched');assert.equal(result.receipt.controlReleased,true);assert.equal(core.getView(view.id).agentState,undefined);assert.equal(core.agentViewStatus({viewId:view.id}).userControl,'paused');
});

test('copy and selection commands preserve reading phase while duplicating a sheet is editing work', async () => {
  const { core, view } = await setup(); await core.openNativeOffice(view.id); const lease = core.acquireAgentView({ viewId: view.id });
  for (const command of ['.uno:Copy', '.uno:SelectAll', '.uno:SelectText', '.uno:Select']) {
    await dispatch(core, 'office-execute', { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), controlId: lease.controlId, command, idempotencyKey: 'readonly-' + command });
    assert.equal(core.getView(view.id).agentState?.phase, 'reading'); assert.equal(core.getView(view.id).agentState?.lastEdit, undefined);
  }
  await dispatch(core, 'office-execute', { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), controlId: lease.controlId, command: '.uno:CopySheet', idempotencyKey: 'duplicate-sheet' });
  assert.equal(core.getView(view.id).agentState?.phase, 'editing'); assert.equal(core.getView(view.id).agentState?.lastEdit, undefined);
});

test('native editing input changes only the held lease phase and reports real pointer coordinates without claiming a commit', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); const lease = core.acquireAgentView({ viewId: view.id }), revision = core.getDocument(view.documentId).info.revision;
  const args = { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), controlId: lease.controlId, expectedLayoutRevision: 3 };
  for (const action of [{ kind: 'press', key: 'ArrowDown' }, { kind: 'press', key: 'c', modifiers: ['control'] }, { kind: 'press', key: 'a', modifiers: ['meta'] }, { kind: 'click', x: 24, y: 18 }, { kind: 'drag', from: { x: 10, y: 20 }, to: { x: 100, y: 40 } }]) {
    await dispatch(core, 'office-input', { ...args, action, idempotencyKey: 'read-input-' + JSON.stringify(action) }); assert.equal(core.getView(view.id).agentState?.phase, 'reading');
  }
  const drag = core.eventLog.filter(event => event.type === 'office.input').at(-1)!.data as any; assert.deepEqual(drag.point, { x: 100, y: 40 }); assert.deepEqual(drag.from, { x: 10, y: 20 }); assert.deepEqual(drag.to, { x: 100, y: 40 });
  for (const action of [{ kind: 'type', text: '中文输入' }, { kind: 'press', key: 'Backspace' }, { kind: 'press', key: 'Delete' }, { kind: 'press', key: 'a', modifiers: ['shift'] }]) {
    core.acquireAgentView({ viewId: view.id, controlId: lease.controlId, phase: 'reading' });
    const result = await dispatch(core, 'office-input', { ...args, action, idempotencyKey: 'edit-input-' + JSON.stringify(action) }) as any;
    assert.equal(result.status, 'dispatched'); assert.equal(core.getView(view.id).agentState?.phase, 'editing'); assert.equal(core.getView(view.id).agentState?.lastEdit, undefined); assert.equal(core.getDocument(view.documentId).info.revision, revision);
  }
  core.releaseAgentView({ viewId: view.id, controlId: lease.controlId });
  await dispatch(core, 'office-input', { ...args, controlId: undefined, action: { kind: 'type', text: '未确认提交的输入' }, idempotencyKey: 'without-held-input' }); assert.equal(core.getView(view.id).agentState, undefined); assert.equal(driver.snapshots, 1);
});

test('released, replaced or paused in-flight native input cannot update the old reading lease', async () => {
  for (const change of ['release', 'replace', 'pause'] as const) {
    const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); const lease = core.acquireAgentView({ viewId: view.id }); driver.inputEntered = gate(); driver.inputWait = gate();
    const args = { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), controlId: lease.controlId, action: { kind: 'type', text: '已发出的输入' }, idempotencyKey: 'in-flight-' + change };
    const pending = dispatch(core, 'office-input', args); await driver.inputEntered.promise;
    if (change === 'pause') core.setAgentControl(view.id, 'paused');
    else { core.releaseAgentView({ viewId: view.id, controlId: lease.controlId }); if (change === 'replace') core.acquireAgentView({ viewId: view.id }); }
    driver.inputWait.resolve(); const result = await pending as any;
    assert.equal(result.status, 'dispatched'); assert.equal(result.controlReleased, true); assert.equal((core.eventLog.filter(event => event.type === 'office.input').at(-1)!.data as { controlReleased?: boolean }).controlReleased, true); assert.equal(core.getView(view.id).agentState?.phase, change === 'release' ? undefined : 'reading'); assert.equal(core.getView(view.id).agentState?.lastEdit, undefined);
    assert.deepEqual(await dispatch(core, 'office-input', args), result); assert.equal(driver.inputs, 1);
  }
});

test('typed selected styles use the native writer, frozen source view, real saved bytes and conditional native undo', async () => {
  const { core, view, driver, directory } = await setup(); await core.openNativeOffice(view.id); await driver.replaceWord('真正选中的文字'); await core.synchronizeNativeDocument(view.documentId); const second = core.addView(view.documentId); await core.openNativeOffice(second.id);
  core.registry.resolve('docx').apply = async () => { throw new Error('old mirror style writer must not run'); };
  driver.styleApply = async () => { const zip = await JSZip.loadAsync(driver.bytes), xml = await zip.file('word/document.xml')!.async('string'); zip.file('word/document.xml', xml.replace('<w:r>', '<w:r><w:rPr><w:b/></w:rPr>')); driver.bytes = await zip.generateAsync({ type: 'uint8array' }); driver.changed(); };
  const lease = core.acquireAgentView({ viewId: second.id }), version = versions(await core.nativeOfficeState(second.id)), before = driver.bytes.slice(); let notified: any;
  core.extensions.set('before-agent-edit', async args => { notified = args; }); core.activate(view.id, 'human');
  const input = { viewId: second.id, ...version, controlId: lease.controlId, style: { target: 'text', values: { bold: true } }, idempotencyKey: 'native-font' };
  const result = await dispatch(core, 'office-execute', input) as any; assert.equal(result.receipt.status, 'applied'); assert.equal(result.state.viewId, second.id); assert.equal(driver.lastExecute?.style?.target, 'text'); assert.equal(driver.lastExecute?.actor, 'agent'); assert.deepEqual(notified.operation, { kind: 'native.style.text', style: input.style }); assert.equal(notified.viewId, second.id);
  assert.equal(core.getView(second.id).agentState?.lastEdit?.kind, 'native.style.text'); assert.equal(core.lastHumanViewId, view.id); assert.deepEqual(await dispatch(core, 'office-execute', input), result); assert.equal(driver.executes, 1);
  const path = join(directory, 'styled.docx'); await core.save(view.documentId, path); assert.match(await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml')!.async('string'), /<w:b\/>/);
  const undo = await dispatch(core, 'office-undo', { viewId: second.id, ...versions(await core.nativeOfficeState(second.id)), undoToken: result.undoToken, idempotencyKey: 'style-undo' }) as any; assert.equal(undo.receipt.status, 'undone'); assert.deepEqual(core.getDocument(view.documentId).bytes, before);
});

test('style inspection preserves mixed/unsupported values and rejects a selection that changed during its query', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id);
  driver.styleInspection = { targetKind: 'text', fields: { fontSize: { value: null, state: 'mixed', available: true }, bold: { value: true, state: 'direct', available: true }, fontFamily: { value: '思源宋体', state: 'default', available: true }, highlight: { value: null, state: 'unsupported', available: false, reason: 'current target lacks property' } } };
  const result = await dispatch(core, 'office-query', { viewId: view.id, target: { kind: 'style', target: 'text' } }) as any; assert.deepEqual(result.data, driver.styleInspection); assert.equal(result.state.viewId, view.id);
  driver.queryChanges = true; await assert.rejects(dispatch(core, 'office-query', { viewId: view.id, target: { kind: 'style', target: 'text' } }), { code: 'STALE_NATIVE_QUERY' });
});

test('style mutation requires an exact selection lease and one compatible target, retaining drafts and source bytes on rejection', async () => {
  const { core, view, driver } = await setup(); await core.openNativeOffice(view.id); driver.styleApply = async () => {}; const args = { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), style: { target: 'text', values: { bold: true } }, idempotencyKey: 'guard' }, before = driver.bytes.slice();
  await assert.rejects(dispatch(core, 'office-execute', { ...args, expectedSelectionEpoch: undefined }), { code: 'STALE_SELECTION' });
  await assert.rejects(dispatch(core, 'office-execute', { ...args, command: '.uno:Bold' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(dispatch(core, 'office-execute', { ...args, args: [{ name: 'path', value: 'file:///bad' }] }), { code: 'INVALID_ARGUMENT' });
  core.extensions.set('before-agent-edit', async () => { throw Object.assign(new Error('draft'), { code: 'DRAFT_CONFLICT' }); }); await assert.rejects(dispatch(core, 'office-execute', args), { code: 'DRAFT_CONFLICT' }); core.extensions.delete('before-agent-edit');
  core.extensions.set('before-agent-edit', async () => { driver.base.selectionEpoch!++; }); await assert.rejects(dispatch(core, 'office-execute', args), { code: 'STALE_SELECTION' }); core.extensions.delete('before-agent-edit');
  driver.selectionOverride = { kind: 'none', text: '' }; const fresh = { ...args, ...versions(await core.nativeOfficeState(view.id)) }; await assert.rejects(dispatch(core, 'office-execute', fresh), { code: 'INVALID_TARGET' });
  await assert.rejects(dispatch(core, 'office-execute', { ...fresh, style: { target: 'cells', values: { fill: 'ffffff' } } }), { code: 'INVALID_TARGET' }); assert.equal(driver.executes, 0); assert.deepEqual(driver.bytes, before);
  const caret = await dispatch(core, 'office-execute', { ...fresh, style: { target: 'paragraph', values: { left: 10 } }, idempotencyKey: 'actual-caret' }) as any; assert.equal(caret.receipt.status, 'no-change'); assert.equal(driver.executes, 1);
});

test('a released in-flight style stays truthful and a partial failed native style preserves its real checkpoint without saving the source', async () => {
  const { core, view, driver, directory, repository } = await setup(); await core.openNativeOffice(view.id); const path = join(directory, 'original.docx'); await core.save(view.documentId, path); const source = await readFile(path);
  driver.styleApply = async () => { await driver.replaceWord('原生样式事务后的实际内容'); }; const lease = core.acquireAgentView({ viewId: view.id }); driver.executeEntered = gate(); driver.executeWait = gate();
  const pending = dispatch(core, 'office-execute', { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), controlId: lease.controlId, style: { target: 'text', values: { bold: true } }, idempotencyKey: 'released-style' }); await driver.executeEntered.promise; core.releaseAgentView({ viewId: view.id, controlId: lease.controlId }); driver.executeWait.resolve(); const result = await pending as any; assert.equal(result.receipt.status, 'applied'); assert.equal(result.receipt.controlReleased, true); assert.equal(core.getView(view.id).agentState, undefined);
  driver.executeWait = undefined; driver.styleApply = async () => { await driver.replaceWord('回滚失败仍需要恢复的真实内容'); throw Object.assign(new Error('native rollback failed'), { code: 'NATIVE_STYLE_ROLLBACK_FAILED' }); };
  await assert.rejects(dispatch(core, 'office-execute', { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), style: { target: 'text', values: { italic: true } }, idempotencyKey: 'failed-style' }), { code: 'NATIVE_STYLE_ROLLBACK_FAILED' });
  assert.equal(core.getDocument(view.documentId).info.model.blocks![0].text, '回滚失败仍需要恢复的真实内容'); assert.equal(core.getDocument(view.documentId).info.dirty, true); assert.deepEqual(await readFile(path), source); assert.equal(core.getView(view.id).agentState, undefined);
  const recovery = await repository.load<any>(); assert.equal(recovery.documents[0].bytes, Buffer.from(driver.bytes).toString('base64')); assert.equal(core.getDocument(view.documentId).info.nativeOffice?.status, 'ready');
});

test('replacement that changes native bytes before a readback error preserves actual recovery without a success receipt or retry', async () => {
  const { core, view, driver, directory, repository } = await setup(); await core.openNativeOffice(view.id);
  const path = join(directory, 'original.docx'); await core.save(view.documentId, path); const source = await readFile(path), revisionBefore = core.getDocument(view.documentId).info.revision;
  const lease = core.acquireAgentView({ viewId: view.id, phase: 'reading' });
  driver.replacementError = Object.assign(new Error('真实文字已修改，但回读失败。'), { code: 'NATIVE_OUTCOME_UNKNOWN' });
  const input = { viewId: view.id, ...versions(await core.nativeOfficeState(view.id)), controlId: lease.controlId, replacement: { expectedText: '当前可见选区', text: '必须保留的实际原生替换内容' }, idempotencyKey: 'replacement-readback-error' };
  await assert.rejects(dispatch(core, 'office-execute', input), { code: 'NATIVE_OUTCOME_UNKNOWN', message: '真实文字已修改，但回读失败。' });
  assert.equal(driver.executes, 1); assert.equal(driver.base.engineRevision, 1);
  const actual = core.getDocument(view.documentId); assert.equal(actual.info.model.blocks![0].text, input.replacement.text); assert.ok(actual.info.revision > revisionBefore); assert.equal(actual.info.dirty, true); assert.equal(actual.info.nativeOffice?.status, 'ready');
  assert.deepEqual(await readFile(path), source, 'error recovery cannot silently save the source');
  assert.equal(core.receipts.has('office-command:' + input.idempotencyKey), false); assert.equal(core.getView(view.id).agentState?.phase, 'reading'); assert.equal(core.getView(view.id).agentState?.lastEdit, undefined);
  assert.equal(core.eventLog.some(event => event.type === 'office.executed' && (event.data as { idempotencyKey?: string }).idempotencyKey === input.idempotencyKey), false);
  const saved = await repository.load<any>(), checkpoint = saved.documents.find((document: any) => document.info.id === view.documentId); assert.equal(checkpoint.bytes, Buffer.from(driver.bytes).toString('base64')); assert.equal(checkpoint.info.dirty, true); assert.equal(saved.receipts.some(([key]: [string, unknown]) => key === 'office-command:' + input.idempotencyKey), false);
  const restored = new ViewerCore(repository); await restored.initialize(); assert.equal(restored.getDocument(view.documentId).info.model.blocks![0].text, input.replacement.text); assert.equal(restored.getDocument(view.documentId).info.dirty, true);
  await assert.rejects(dispatch(core, 'office-execute', input), { code: 'VERSION_CONFLICT' }); assert.equal(driver.executes, 1, 'a stale explicit retry does not duplicate the already changed native content');
});
