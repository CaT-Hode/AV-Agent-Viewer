import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { ViewerCore } from '../packages/document-core/src/index';
import { NativeOfficeRuntime } from '../packages/office-runtime/src/index';
import type { OfficeAuthoringOperation, OfficeAuthoringQuery } from '../packages/office-runtime/src/authoring';
import { JsonWorkspaceRepository } from '../packages/persistence/src/index';
import { recordCurrentBuild } from './helpers/current-build';
import type { DocumentModel, EditOperation, NativeOfficeDriver, NativeOfficeFormat, NativeOfficeSnapshotReuse, NativeOfficeState, NativeOfficeStyleInspection, ViewInfo } from '../packages/contracts/src/index';
import { isOfficeSurfaceState, type OfficeSurfaceState } from '../packages/contracts/src/office-surface';

// Actual bundled Kit + production Core export and filesystem publication. This
// deliberately has no Electron window, MCP transport, source injection, fake
// native state, mocked mirror, cache-disable switch, or user-owned document.
// Timings are diagnostic Core/driver wall time, not whole-app or strict A/B.
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-export-copy-'));
await recordCurrentBuild(directory);
const evidence = join(directory, 'result.json');
const engineRoot = resolve(process.env.AGENTVIEWER_ENGINES_DIR ?? 'release/win-unpacked/resources/engines');
const adapterPath = resolve('dist/main/office-kit-windows.dll');
const samplesRoot = resolve(process.env.AGENTVIEWER_EXPORT_SAMPLES ?? 'examples/moon-tide');
const iterations = Number(process.env.AGENTVIEWER_EXPORT_ITERATIONS ?? 2);
assert.ok(Number.isInteger(iterations) && iterations >= 2 && iterations <= 20, 'Use 2–20 explicit native-copy paths');
const names = { docx: '03-潮灯町的第十三夜.docx', xlsx: '02-编年表.xlsx', pptx: '04-故事介绍.pptx' } as const;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const versions = (state: NativeOfficeState) => ({ expectedEngineEpoch: state.engineEpoch, expectedEngineRevision: state.engineRevision });
const guard = (state: NativeOfficeState) => ({ sessionId: state.sessionId, engineEpoch: state.engineEpoch, engineRevision: state.engineRevision, dirty: state.dirty, unsavedContentChanges: state.unsavedContentChanges, undo: state.undo });
function exported(value: unknown) {
  assert.ok(value && typeof value === 'object' && 'status' in value && value.status === 'exported' && 'sha256' in value && typeof value.sha256 === 'string' && 'format' in value && typeof value.format === 'string');
  return value as { status: 'exported'; sha256: string; format: string };
}
const sourcePaths = [
  'packages/document-core/src/index.ts', 'packages/office-runtime/src/index.ts',
  'packages/office-runtime/src/worker-source.ts', 'packages/office-runtime/src/kit-worker-source.ts',
  'packages/office-runtime/src/kit-update-policy-source.ts', 'packages/office-runtime/src/kit-binary-source.ts',
  'packages/office-runtime/src/binary-protocol.ts', 'packages/office-runtime/src/native-style-source.ts',
  'packages/office-runtime/src/authoring.ts', 'packages/office-runtime/src/authoring-source.ts',
  'tests/office-export.integration.ts', 'package-lock.json',
].map(path => resolve(path)).concat(adapterPath, join(engineRoot, 'libreoffice/program/mergedlo.dll'), Object.values(names).map(name => join(samplesRoot, name)));
async function identities() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async path => {
    const hash = createHash('sha256'), stream = createReadStream(path);
    await new Promise<void>((done, reject) => { stream.on('data', chunk => hash.update(chunk)); stream.once('error', reject); stream.once('end', done); });
    return [path, hash.digest('hex')];
  })));
}
const runtime = new NativeOfficeRuntime({ appRoot: resolve('.'), dataDir: join(directory, 'runtime'), sofficePath: join(engineRoot, 'libreoffice/program/soffice.exe'), adapterPath, backend: 'kit', requestTimeoutMs: 120000 });
const repository = new JsonWorkspaceRepository(join(directory, 'workspace.json'));
const core = new ViewerCore(repository);
const driverCalls: { method: string; format?: string; elapsedMs: number; bytes?: number; sha256?: string; reusedMirror?: boolean }[] = [];
let ackSavedCalls = 0;
const driver: NativeOfficeDriver = {
  open: input => runtime.open({ ...input, sessionId: input.documentId, ownerHwnd: '1', ownerViewport: { width: 1000, height: 800 }, bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: false }),
  state: (sessionId, viewId) => runtime.state(sessionId, viewId),
  snapshot: async (sessionId, reuse?: NativeOfficeSnapshotReuse) => {
    const started = performance.now(), result = await runtime.snapshot(sessionId, undefined, reuse);
    driverCalls.push({ method: 'snapshot', format: result.format, elapsedMs: performance.now() - started, bytes: result.bytes.length, sha256: sha(result.bytes), reusedMirror: result.bytes === reuse?.bytes });
    return result;
  },
  exportCopy: async (sessionId, value) => {
    const started = performance.now(), result = await runtime.exportCopy(sessionId, value);
    driverCalls.push({ method: 'exportCopy', format: value.format, elapsedMs: performance.now() - started, bytes: result.bytes.length, sha256: result.sha256 });
    return result;
  },
  commands: (sessionId, viewId) => runtime.commands(sessionId, viewId),
  query: (sessionId, viewId, target) => runtime.query(sessionId, viewId, target),
  execute: request => runtime.execute(request), undo: request => runtime.undo(request),
  navigate: request => runtime.navigate(request),
  ackSaved: async (sessionId, value) => { ackSavedCalls++; return runtime.ackSaved(sessionId, value); },
  close: sessionId => runtime.close(sessionId, { discard: true }),
};
core.registerNativeOfficeDriver(driver);
const report: Record<string, any> = {
  directory, evidence, iterations,
  scope: 'Actual hidden NativeOfficeRuntime + production ViewerCore.exportNativeOffice + JsonWorkspaceRepository + independent disk files. No Electron/GUI/MCP/OS physical input, full-render, translation, memory or whole-app performance claim. Timings include the public Core mirror/version barrier, real driver RPC, output validation/publication and workspace persistence; startup is outside these timings. OS caches and background work are uncontrolled. No before/after percentage is derived from this single version.',
  formats: [], errors: [], phases: [], nativeEdits: [],
};
runtime.on('diagnostic', value => { (report.nativeDiagnostics ??= []).push(value); });
console.log('Native export-copy acceptance evidence:', evidence);
function phase(name: string, item?: Record<string, any>) {
  const value = { name, format: item?.format, atMs: performance.now() };
  report.currentPhase = value; report.phases.push(value);
  if (item) item.phase = name;
}

function workerHandle() { return (runtime as unknown as { worker?: ChildProcessWithoutNullStreams }).worker; }
async function waitOwnedExit(worker: ChildProcessWithoutNullStreams | undefined) {
  if (!worker) return true;
  if (worker.exitCode !== null || worker.signalCode !== null) return true;
  return new Promise<boolean>(done => {
    const exited = () => { clearTimeout(timer); done(true); };
    const timer = setTimeout(() => { worker.removeListener('exit', exited); done(false); }, 20000);
    worker.once('exit', exited);
    if (worker.exitCode !== null || worker.signalCode !== null) { worker.removeListener('exit', exited); clearTimeout(timer); done(true); }
  });
}
async function nativeEdit(view: ViewInfo, operation: EditOperation, expected: 'text-mutation' | 'style' = 'text-mutation') {
  const unchangedStyle = expected === 'style';
  if (unchangedStyle) assert.ok(['office.setTextStyle', 'sheets.setCellFormat', 'slides.setShapeStyle'].includes(operation.kind), 'Only the three explicit setup style operations may be idempotent');
  const before = await core.nativeOfficeState(view.id);
  const result = await runtime.execute({ sessionId: before.sessionId, viewId: view.id, ...versions(before), requestId: randomUUID(), actor: 'human', operation });
  const receipt: Record<string, unknown> = {
    phase: report.currentPhase, expected, operation: operation.kind,
    target: Object.fromEntries(Object.entries(operation).filter(([name]) => ['blockId', 'sheetId', 'address', 'slideId', 'shapeId'].includes(name))),
    status: result.status, before: structuredClone(guard(before)), after: structuredClone(guard(result.state)),
    selectionEpoch: result.state.selectionEpoch, pendingInput: result.state.pendingInput,
  };
  report.nativeEdits.push(receipt);
  if (operation.kind === 'slides.setText' && result.status !== 'applied') {
    // Diagnose the exact previously verified native object before rejecting
    // the reply. No alternate object, text mutation, snapshot or retry occurs.
    const item = report.formats.at(-1), name: unknown = item?.target?.shapeName;
    if (typeof name === 'string' && item?.format === 'pptx') {
      try {
        const readback = await runtime.query(before.sessionId, view.id, { kind: 'shape', slideIndex: 0, name }) as { name: string; text: string };
        assert.equal(readback.name, name); assert.equal(typeof readback.text, 'string');
        receipt.nativeReadback = { name, requestedTextSha256: sha(operation.text), requestedTextLength: operation.text.length, actualTextSha256: sha(readback.text), actualTextLength: readback.text.length, matchesRequestedText: readback.text === operation.text };
        receipt.afterReadback = structuredClone(guard(await core.nativeOfficeState(view.id)));
      } catch (error) { receipt.readbackError = error instanceof Error ? error.message : String(error); }
    } else receipt.readbackError = 'The previously verified PPT shape identity is unavailable; no fallback target was queried.';
  }
  if (unchangedStyle) assert.ok(result.status === 'applied' || result.status === 'no-change', 'An explicit style must be applied or already match; actual color readback remains mandatory');
  else assert.equal(result.status, 'applied', 'The marker text operation must really change the owned document');
  assert.equal(result.state.pendingInput, false);
  core.updateNativeOfficeState(result.state);
  return result.state;
}
type Target = { wordId?: string; sheetId?: string; sheetName?: string; slideId?: string; shapeId?: string; shapeName?: string };
function textOperation(format: NativeOfficeFormat, target: Target, text: string): EditOperation {
  if (format === 'docx') return { kind: 'word.setBlock', blockId: target.wordId!, text };
  if (format === 'xlsx') return { kind: 'sheets.setCell', sheetId: target.sheetId!, address: 'A1', value: text, valueType: 'text' };
  return { kind: 'slides.setText', slideId: target.slideId!, shapeId: target.shapeId!, text };
}
async function inspectColors(view: ViewInfo, format: NativeOfficeFormat, target: Target) {
  const state = await core.nativeOfficeState(view.id);
  const destination = format === 'docx' ? { kind: 'paragraph' as const, paragraphIndex: 0, select: true }
    : format === 'xlsx' ? { kind: 'cell' as const, sheetName: target.sheetName!, address: 'A1' }
      : { kind: 'shape' as const, slideIndex: 0, name: target.shapeName! };
  const navigation = await runtime.navigate({ sessionId: state.sessionId, viewId: view.id, ...versions(state), requestId: randomUUID(), actor: 'human', target: destination });
  core.updateNativeOfficeState(navigation.state);
  const kind = format === 'docx' ? 'text' : format === 'xlsx' ? 'cells' : 'shape';
  const result = await runtime.query(state.sessionId, view.id, { kind: 'style', target: kind }) as NativeOfficeStyleInspection;
  const expected = format === 'docx' ? { color: '166a71' } : format === 'xlsx' ? { color: '166a71', fill: 'e3d7b4' } : { fill: '166a71', lineColor: '893b58' };
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(expected)) {
    const field = result.fields[name]; assert.equal(field?.available, true, 'Actual native color must be inspectable: ' + name);
    assert.equal(String(field.value).toLowerCase(), value, 'Actual native target has the intended color: ' + name);
    fields[name] = field;
  }
  return fields;
}
async function selectPptText(view: ViewInfo, target: Target, text: string, from = 0, to = text.length) {
  let state = await core.nativeOfficeState(view.id);
  const navigation = await runtime.navigate({ sessionId: state.sessionId, viewId: view.id, ...versions(state), requestId: randomUUID(), actor: 'human', target: { kind: 'shape', slideIndex: 0, name: target.shapeName! } });
  core.updateNativeOfficeState(navigation.state);
  const press = async (key: string, modifiers: ('shift' | 'control')[] = []) => {
    const current = await core.nativeOfficeState(view.id);
    const result = await runtime.input({ sessionId: current.sessionId, viewId: view.id, ...versions(current), actor: 'human', idempotencyKey: randomUUID(), action: { kind: 'press', key, modifiers } });
    core.updateNativeOfficeState(result.state);
    (report.pptTextSelectionInputs ??= []).push({ key, modifiers, sessionId: current.sessionId, viewId: view.id, before: { engineRevision: current.engineRevision, selectionKind: current.selection?.kind, pendingInput: current.pendingInput }, after: { engineRevision: result.state.engineRevision, selectionKind: result.state.selection?.kind, textLength: result.state.selection?.text.length, textSha256: sha(result.state.selection?.text ?? ''), pendingInput: result.state.pendingInput } });
  };
  // Follow the actual Kit/Chromium F2 entry already exercised by the embedded
  // Office acceptance, using its production native-input route. Generic UNO
  // Text dispatch was not sufficient for this hidden controller in a7.
  await press('F2');
  await press('Home', ['control']);
  await press('End', ['control', 'shift']);
  for (let attempt = 0; attempt < 30; attempt++) {
    state = await core.nativeOfficeState(view.id);
    if (state.selection?.kind === 'text' && state.selection.text === text) break;
    await new Promise(done => setTimeout(done, 20));
  }
  assert.equal(state.selection?.kind, 'text'); assert.equal(state.selection.text, text, 'Actual native text mode must select exactly the verified named object');
  if (from !== 0 || to !== text.length) {
    await press('Home', ['control']);
    for (let i = 0; i < from; i++) await press('ArrowRight');
    for (let i = from; i < to; i++) await press('ArrowRight', ['shift']);
    state = await core.nativeOfficeState(view.id);
    assert.equal(state.selection?.kind, 'text'); assert.equal(state.selection.text, text.slice(from, to));
  }
  return state;
}
async function pptStyleSignature(bytes: Uint8Array, target: Target) {
  const zip = await JSZip.loadAsync(bytes), xml = await zip.file(target.slideId!)!.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml'), serializer = new XMLSerializer();
  const candidates = Array.from(doc.getElementsByTagNameNS('*', 'sp')).filter(element => Array.from(element.getElementsByTagNameNS('*', 'cNvPr')).some(value => value.getAttribute('id') === target.shapeId));
  assert.equal(candidates.length, 1, 'Saved style evidence uses the exact mapped shape, never a first-shape fallback');
  const element = candidates[0], children = Array.from(element.childNodes).filter(node => node.nodeType === 1);
  const spPr = children.find(node => node.localName === 'spPr'), txBody = children.find(node => node.localName === 'txBody');
  assert.ok(spPr && txBody);
  return { shapePropertiesSha256: sha(serializer.serializeToString(spPr)), textBodySha256: sha(serializer.serializeToString(txBody)) };
}
async function savePptStyleCopy(view: ViewInfo, target: Target, label: string) {
  const state = await core.nativeOfficeState(view.id), path = join(directory, 'pptx-style-' + label + '.pptx');
  await core.exportNativeOffice({ viewId: view.id, ...versions(state), path, format: 'pptx', idempotencyKey: randomUUID() });
  const bytes = new Uint8Array(await readFile(path));
  return { path, sha256: sha(bytes), bytes: bytes.length, signature: await pptStyleSignature(bytes, target) };
}
async function reopenPptStyleCopy(path: string, target: Target, marker: string, expectedColor: 'mixed' | string, sourceDocumentId: string) {
  const diskHash = sha(await readFile(path)), view = await core.openFile(path);
  assert.notEqual(view.documentId, sourceDocumentId, 'A separately reopened copy must have its own document identity');
  await core.openNativeOffice(view.id, { deferInitialMirror: true });
  let firstFailure = false;
  try {
    const before = await core.nativeOfficeState(view.id); assert.equal(before.pendingInput, false);
    const actual = await runtime.query(before.sessionId, view.id, { kind: 'shape', slideIndex: 0, name: target.shapeName! }) as { name: string; text: string };
    assert.equal(actual.name, target.shapeName); assert.equal(actual.text, marker);
    // Re-import the real disk copy, then serialize that actual native model.
    // Do not enter an Outliner merely to read an aggregate of Latin/Asian/
    // complex-script font families, which legitimately differ after import.
    const snapshot = await runtime.snapshot(before.sessionId, view.id);
    assert.equal(snapshot.format, 'pptx'); assert.deepEqual(guard(snapshot.state), guard(before));
    const snapshotPath = path + '.reopened-native.pptx';
    await writeFile(snapshotPath, snapshot.bytes, { flag: 'wx' });
    const model = await core.registry.resolve('pptx').open(snapshot.bytes, 'pptx');
    const matches = model.slides?.[0].blocks.filter(block => block.text === marker) ?? [];
    assert.equal(matches.length, 1, 'The independently parsed native roundtrip contains the exact unique marker');
    const block = matches[0], runs = (block.runs ?? []).filter(run => run.text), inspections = [];
    assert.equal(runs.map(run => run.text).join(''), marker);
    const split = Math.floor(marker.length / 2);
    let position = 0;
    for (const run of runs) {
      const from = position, to = from + run.text.length; position = to;
      assert.ok(to <= split || from >= split, 'A run cannot flatten the two distinct Latin fonts');
      const fontName = from < split ? 'Times New Roman' : 'Arial';
      const color = expectedColor === 'mixed' ? from < split ? 'aa3344' : '225599' : expectedColor;
      const inspection = { from, to, expectedColor: color, expectedLatinFont: fontName, actualColor: run.color ?? block.color, actualLatinFont: run.fontName ?? block.fontName };
      inspections.push(inspection);
      (report.pptReopenInspections ??= []).push({ path, viewId: view.id, ...inspection });
      assert.equal(inspection.actualColor?.toLowerCase(), color); assert.equal(inspection.actualLatinFont, fontName);
    }
    const zip = await JSZip.loadAsync(snapshot.bytes), xml = await zip.file(target.slideId!)!.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const elements = Array.from(doc.getElementsByTagNameNS('*', 'sp')).filter(shape => Array.from(shape.getElementsByTagNameNS('*', 'cNvPr')).some(value => value.getAttribute('name') === target.shapeName));
    assert.equal(elements.length, 1, 'Native roundtrip OOXML still identifies the exact named object');
    const xmlRuns = Array.from(elements[0].getElementsByTagNameNS('*', 'r')); let xmlPosition = 0;
    for (const run of xmlRuns) {
      const text = Array.from(run.getElementsByTagNameNS('*', 't')).map(node => node.textContent ?? '').join(''); if (!text) continue;
      const from = xmlPosition, to = from + text.length; xmlPosition = to;
      assert.ok(to <= split || from >= split);
      const latin = run.getElementsByTagNameNS('*', 'latin')[0]?.getAttribute('typeface');
      const color = run.getElementsByTagNameNS('*', 'srgbClr')[0]?.getAttribute('val');
      assert.equal(latin, from < split ? 'Times New Roman' : 'Arial');
      assert.equal(color?.toLowerCase(), expectedColor === 'mixed' ? from < split ? 'aa3344' : '225599' : expectedColor, 'Actual native saved run retains explicit RGB rather than stale theme metadata');
    }
    assert.equal(xmlPosition, marker.length);
    assert.equal(sha(await readFile(path)), diskHash, 'Reopening and inspecting an exported copy never writes it');
    return { documentId: view.documentId, runs: inspections, diskSha256: diskHash, nativeSnapshot: { path: snapshotPath, bytes: snapshot.bytes.length, sha256: sha(snapshot.bytes) } };
  } catch (error) {
    firstFailure = true;
    (report.pptReopenFailures ??= []).push({ path, viewId: view.id, phase: report.currentPhase, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) });
    throw error;
  } finally {
    try {
      const settled = await core.nativeOfficeState(view.id);
      (report.pptReopenCleanup ??= []).push({ path, viewId: view.id, enteredOutliner: false, pendingInput: settled.pendingInput, engineRevision: settled.engineRevision });
      assert.equal(settled.pendingInput, false, 'Read-only native re-import and serialization must leave no pending input');
      assert.equal(sha(await readFile(path)), diskHash);
      await core.closeNativeOffice(view.documentId);
    } catch (error) {
      (report.pptReopenCleanupFailures ??= []).push({ path, viewId: view.id, firstFailurePreserved: firstFailure, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) });
      if (!firstFailure) throw error;
    }
  }
}
async function verifyModel(bytes: Uint8Array, format: NativeOfficeFormat, marker: string) {
  const model: DocumentModel = await core.registry.resolve(format).open(bytes, format);
  if (format === 'xlsx') {
    const cell = model.sheets?.[0].rows.flat().find(cell => cell.address === 'A1');
    assert.ok(cell); assert.equal(cell.value, marker); assert.equal(cell.color?.toLowerCase(), '166a71'); assert.equal(cell.fill?.toLowerCase(), 'e3d7b4');
  } else {
    const block = (format === 'docx' ? model.blocks : model.slides?.[0].blocks)?.find(block => block.text === marker);
    assert.ok(block, 'Independent exported model contains the actual native edit');
    if (format === 'pptx') {
      assert.equal(block.fill?.toLowerCase(), '166a71'); assert.equal(block.lineColor?.toLowerCase(), '893b58');
      const runs = (block.runs ?? []).filter(run => run.text);
      assert.ok(runs.length); assert.ok(runs.every(run => (run.color ?? block.color)?.toLowerCase() === '166a71'), 'Every independent saved text run retains the requested explicit font RGB');
    }
    else assert.ok([block.color, ...(block.runs ?? []).map(run => run.color)].some(color => color?.toLowerCase() === '166a71'), 'Word run color survives actual serialization');
  }
  return model;
}

async function verifyWordVisibleProjection() {
  phase('word-visible-page-ranges');
  const paragraph = (text: string) => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>';
  const paragraphs = Array.from({ length: 2101 }, (_, index) => paragraph('Native paragraph ' + index)).join('');
  const table = '<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>'
    + Array.from({ length: 1051 }, (_, row) => '<w:tr>' + [0, 1].map(column => '<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>' + paragraph(`Native table row ${row} column ${column}`) + '</w:tc>').join('') + '</w:tr>').join('') + '</w:tbl>';
  const giant = 'GIANT_BEGIN ' + Array.from({ length: 3000 }, (_, index) => `Segment_${index.toString().padStart(4, '0')} native paragraph content. `).join('') + ' GIANT_END';
  assert.ok(giant.length > 48000);
  const zip = await JSZip.loadAsync(await readFile(join(samplesRoot, names.docx))), original = await zip.file('word/document.xml')!.async('string');
  const xml = original.replace(/<w:body>[\s\S]*?<w:sectPr/, '<w:body>' + paragraphs + table + paragraph(giant) + paragraph('After giant paragraph') + '<w:sectPr');
  assert.notEqual(xml, original); zip.file('word/document.xml', xml);
  const documentId = randomUUID(), viewId = randomUUID(), bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  let current = await runtime.open({ sessionId: documentId, documentId, viewId, format: 'docx', bytes, revision: 0, ownerHwnd: '1', ownerViewport: { width: 1000, height: 800 }, bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: false }) as OfficeSurfaceState;
  assert.ok(isOfficeSurfaceState(current));
  await runtime.enableContextProjection(documentId, viewId);
  const results: Record<string, unknown>[] = []; report.wordVisibleProjection = { sourceSha256: sha(bytes), paragraphs: 2101, tableCells: 2102, giantCharacters: giant.length, results };
  const signature = (state: NativeOfficeState) => { assert.ok(state.selection); return { epoch: state.selectionEpoch, kind: state.selection.kind, text: state.selection.text, locator: state.selection.locator }; };
  async function show(pageIndex: number, expected: string) {
    const page = current.pages?.[pageIndex]; assert.ok(page);
    const selected = signature(current), native = guard(current), started = performance.now();
    current = await runtime.surfaceLayout(documentId, { viewId, layoutRevision: current.layoutRevision + 1, partIndex: 0, visibleTwips: page, viewportCss: { width: 1000, height: 800 }, documentOriginCss: { x: 0, y: -page.y / 15 }, boundsCss: { x: 0, y: 0, width: 1000, height: 800 }, zoom: 1, deviceScaleFactor: 1, visible: true, focused: false });
    const text = current.visibleText; assert.equal(typeof text, 'string'); assert.ok(text);
    assert.equal(current.visibleTextReady, true); assert.equal(current.visibleTextTruncated, false); assert.ok(text.includes(expected), 'The actual visible page text contains ' + expected);
    assert.deepEqual(signature(current), selected, 'A semantic geometry probe never moves the human selection');
    assert.deepEqual(guard(current), native, 'Reading visible pages preserves native content, dirty state and Undo');
    results.push({ pageIndex, expected, characters: text.length, textSha256: sha(text), elapsedMs: performance.now() - started });
  }
  async function select(paragraphIndex: number) {
    const result = await runtime.navigate({ sessionId: documentId, viewId, ...versions(current), requestId: randomUUID(), actor: 'human', target: { kind: 'paragraph', paragraphIndex, select: true } });
    assert.ok(isOfficeSurfaceState(result.state)); current = result.state;
    assert.ok(current.selection); assert.ok(Number.isInteger(current.selection.pageIndex)); return current.selection.pageIndex!;
  }
  try {
    await show(await select(2100), 'Native paragraph 2100');
    await show(await select(2101), 'Native table row 0 column 0');
    await show(await select(4202), 'Native table row 1050 column 1');
    assert.ok(current.selection); assert.ok(!('identityUnavailable' in current.selection), 'Writer table selection uses the real CellName property');
    assert.equal(current.selection.locator?.cell, 'B1051');
    await show(0, 'Native paragraph 0');
    const lastPage = await select(4203);
    await show(lastPage, 'GIANT_END');
    assert.ok(!current.visibleText!.includes('GIANT_BEGIN'), 'A later page of a giant paragraph cannot repeat its initial 48k prefix');
    await show(lastPage - 1, 'Segment_');
    assert.ok(!current.visibleText!.includes('GIANT_BEGIN'));
  } finally { await runtime.close(documentId, { discard: true }); }
}

/** The same three engine flows can verify structured authoring without any
 * physical, CDP, simulated keyboard/mouse, Electron or human-window input. */
async function verifyStructuredAuthoring() {
  report.scope = 'Actual hidden Kit structured authoring, native readback, idempotency, Undo/Redo, serialization and independent native re-import. No input or UI validation.';
  for (const format of ['docx', 'xlsx', 'pptx'] as const) {
    const sourceBytes = new Uint8Array(await readFile(join(samplesRoot, names[format]))), documentId = randomUUID(), viewId = randomUUID();
    const item: Record<string, any> = { format, sourceSha256: sha(sourceBytes), operations: [] }; report.formats.push(item); phase('authoring-' + format, item);
    let current: NativeOfficeState = await runtime.open({ sessionId: documentId, documentId, viewId, format, bytes: sourceBytes, revision: 0, ownerHwnd: '1', ownerViewport: { width: 1000, height: 800 }, bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: false });
    async function query(target: OfficeAuthoringQuery): Promise<any> {
      for (let attempt = 0; ; attempt++) {
        try { const result = await runtime.authoringQuery(documentId, viewId, target); current = result.state; return result.data; }
        catch (error) { if (attempt >= 3 || !(error instanceof Error) || !('code' in error) || error.code !== 'STALE_NATIVE_QUERY') throw error; }
      }
    }
    async function edit(operation: OfficeAuthoringOperation) {
      current = await runtime.state(documentId, viewId);
      const request = { sessionId: documentId, viewId, ...versions(current), requestId: randomUUID(), actor: 'agent' as const, operation };
      const result = await runtime.authoringExecute(request); current = result.state;
      assert.equal(result.verified, true); assert.equal(current.pendingInput, false);
      assert.deepEqual(await runtime.authoringExecute(request), result, 'An acknowledged logical request is replayed before checking its old engine revision');
      await assert.rejects(runtime.authoringExecute({ ...request, operation: { kind: 'slides.moveSlide', slideIndex: 0, index: 0 } }), /请求身份/);
      item.operations.push({ kind: operation.kind, status: result.status, verified: result.verified, warnings: result.warnings, engineRevision: current.engineRevision, undoAvailable: !!result.undoToken });
      return result;
    }
    async function undoAndRedo(verifyUndo: () => Promise<void>, verifyRedo: () => Promise<void>) {
      current = await runtime.state(documentId, viewId); assert.ok(current.undo?.token);
      const result = await runtime.undo({ sessionId: documentId, viewId, ...versions(current), undoToken: current.undo.token, actor: 'agent' }); current = result.state;
      await verifyUndo(); current = await runtime.state(documentId, viewId);
      const redo = await runtime.execute({ sessionId: documentId, viewId, ...versions(current), requestId: randomUUID(), actor: 'agent', command: '.uno:Redo' }); current = redo.state;
      await verifyRedo();
    }
    const marker = 'AV_STRUCTURED_' + format + '_中文😀';
    let sheetName = '', originalPpt = '';
    if (format === 'docx') {
      const first = (await query({ kind: 'word.paragraphs', limit: 1 })).paragraphs[0]; assert.equal(first.textHash, sha(first.text));
      await edit({ kind: 'word.replaceText', paragraphIndex: 0, from: 0, to: first.utf16Length, expectedText: first.text, text: marker });
      await runtime.snapshot(documentId, viewId);
      const navigation = await runtime.navigate({ sessionId: documentId, viewId, ...versions(current), requestId: randomUUID(), actor: 'human', target: { kind: 'paragraph', paragraphIndex: 0, select: true } }); current = navigation.state;
      const selectedBefore = structuredClone(current.selection), selected = await query({ kind: 'selection-target' });
      assert.equal(selected.editable, true); assert.deepEqual(selected.target, { kind: 'word.range', paragraphIndex: 0, from: 0, to: marker.length }); assert.equal(selected.text, marker); assert.deepEqual(current.selection, selectedBefore);
      const multiline = marker + '\nNative cross-paragraph😀';
      const inserted = await edit({ kind: 'word.replaceText', paragraphIndex: 0, from: 0, to: marker.length, expectedText: marker, text: multiline });
      const cross = (inserted.readback as any).target; assert.equal(cross.kind, 'word.nativeRange'); const crossText = (await query({ kind: 'word.nativeRange', anchor: cross.anchor })).text; assert.equal(crossText.replace(/\r\n/g, '\n'), multiline);
      const formatted = await edit({ kind: 'word.formatRangeText', anchor: cross.anchor, expectedText: crossText, values: { italic: true } });
      const fresh = (formatted.readback as any).target; assert.equal(fresh.kind, 'word.nativeRange');
      const restored = await edit({ kind: 'word.replaceRangeText', anchor: fresh.anchor, expectedText: crossText, text: marker }); assert.equal((restored.readback as any).target.kind, 'word.range');
      await assert.rejects(query({ kind: 'word.nativeRange', anchor: fresh.anchor }), /过期/);
      await edit({ kind: 'word.formatText', paragraphIndex: 0, from: marker.length - 2, to: marker.length, expectedText: '😀', values: { bold: true, color: '166a71' } });
      await edit({ kind: 'word.formatParagraph', paragraphIndex: 0, values: { alignment: 'center' } });
      assert.equal((await query({ kind: 'word.range', paragraphIndex: 0, from: marker.length - 2, to: marker.length })).text, '😀');
      const clamped = await query({ kind: 'word.range', paragraphIndex: 0, from: marker.length - 1, to: marker.length }); assert.equal(clamped.text, '😀'); assert.equal(clamped.from, marker.length - 2); assert.equal(clamped.to, marker.length);
      const matches = await query({ kind: 'search', query: '😀', limit: 1 }); assert.equal(matches.units[0].from, marker.length - 2);
      assert.equal((await query({ kind: 'search', query: '😀', ...matches.cursor, limit: 1 })).units.some((unit: any) => unit.paragraphIndex === 0), false);
      const styles = (await query({ kind: 'word.pageStyles' })).styles; await edit({ kind: 'word.pageLayout', pageStyleName: styles[0].name, left: 22 });
      await edit({ kind: 'word.addComment', paragraphIndex: 0, from: 0, to: marker.length, expectedText: marker, text: 'Native bounded comment' });
      const comments = (await query({ kind: 'word.comments' })).comments; assert.equal(comments.at(-1).anchorText, marker);
      await edit({ kind: 'word.deleteComment', commentIndex: comments.at(-1).commentIndex, expectedText: 'Native bounded comment' });
      const table = await edit({ kind: 'word.insertTable', paragraphIndex: 0, rows: [['A', 'B'], ['C', 'D']] });
      await edit({ kind: 'word.setTableCell', tableName: (table.readback as any).name, cellName: 'B2', expectedText: 'D', text: 'Cell😀' });
      const tableName = (table.readback as any).name, cells = await query({ kind: 'word.table', tableName, limit: 1 }); assert.equal(cells.cells.length, 1); assert.equal(cells.next, 1); assert.equal(cells.total, 4);
      const longCell = '表格😀'.repeat(1000); await edit({ kind: 'word.setTableCell', tableName, cellName: 'B2', expectedText: 'Cell😀', text: longCell });
      assert.equal((await query({ kind: 'word.table', tableName })).cells.find((cell: any) => cell.name === 'B2').textTruncated, true);
      const completeCell = (await query({ kind: 'word.table', tableName, cellName: 'B2' })).cells[0]; assert.equal(completeCell.text, longCell); assert.equal(completeCell.textTruncated, false);
      assert.ok((await query({ kind: 'word.tables' })).tables.some((value: any) => value.name === (table.readback as any).name));
      await edit({ kind: 'word.setTracking', enabled: true });
      await edit({ kind: 'word.replaceText', paragraphIndex: 0, from: 0, to: 0, expectedText: '', text: 'Rejected' });
      assert.equal((await query({ kind: 'word.revisions' })).canAcceptReject, true);
      await edit({ kind: 'word.resolveRevision', revisionIndex: 0, action: 'reject' });
      assert.equal((await query({ kind: 'word.paragraphs', limit: 1 })).paragraphs[0].text, marker);
      await edit({ kind: 'word.replaceText', paragraphIndex: 0, from: 0, to: 0, expectedText: '', text: 'Accepted' });
      await edit({ kind: 'word.resolveRevision', revisionIndex: 0, action: 'accept' });
      await edit({ kind: 'word.setTracking', enabled: false });
      const before = (await query({ kind: 'word.paragraphs', limit: 1 })).paragraphs[0].text;
      await edit({ kind: 'word.replaceText', paragraphIndex: 0, from: 0, to: before.length, expectedText: before, text: marker });
      await undoAndRedo(async () => assert.equal((await query({ kind: 'word.paragraphs', limit: 1 })).paragraphs[0].text, before), async () => assert.equal((await query({ kind: 'word.paragraphs', limit: 1 })).paragraphs[0].text, marker));
    } else if (format === 'xlsx') {
      const sheets = await runtime.query(documentId, viewId, { kind: 'sheets' }) as { sheets: { name: string }[] }; sheetName = sheets.sheets[0].name;
      const selectedBefore = structuredClone(current.selection), selected = await query({ kind: 'selection-target' }); assert.equal(selected.editable, true); assert.deepEqual(selected.target, { kind: 'sheets.range', sheetName, range: selectedBefore!.range }); assert.deepEqual(current.selection, selectedBefore);
      await edit({ kind: 'sheets.addSheet', name: 'Authoring temporary' }); await edit({ kind: 'sheets.renameSheet', sheetName: 'Authoring temporary', name: 'Authoring renamed' }); await edit({ kind: 'sheets.deleteSheet', sheetName: 'Authoring renamed' });
      await edit({ kind: 'sheets.merge', sheetName, range: 'Q20:R20', merge: true }); await edit({ kind: 'sheets.merge', sheetName, range: 'Q20:R20', merge: false });
      for (const action of ['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns'] as const) await edit({ kind: 'sheets.grid', sheetName, action, index: 22, count: 2 });
      await edit({ kind: 'sheets.setRangeValues', sheetName, range: 'Q1:S4', rows: [['Category', 'Value', 'Formula'], ['B', 4, '=R2*2'], ['A', 2, 0], ['A', 3, marker]] });
      await edit({ kind: 'sheets.formatRange', sheetName, range: 'Q1:S4', values: { bold: true, fill: 'ffeecc' } });
      await edit({ kind: 'sheets.setValidation', sheetName, range: 'R2:R4', type: 'WHOLE', formula1: '1', formula2: '10' });
      await edit({ kind: 'sheets.sort', sheetName, range: 'Q1:S4', column: 1, header: true });
      await edit({ kind: 'sheets.filter', sheetName, range: 'Q1:S4', enabled: true }); await edit({ kind: 'sheets.filter', sheetName, range: 'Q1:S4', enabled: false });
      for (const type of ['column', 'bar', 'line', 'pie', 'scatter', 'area'] as const) {
        const name = 'Authoring_' + type; const chart = await edit({ kind: 'sheets.addChart', sheetName, name, range: 'Q1:R4', type, x: 10, y: 10, width: 120, height: 80 }); assert.equal((chart.readback as any).type, type);
        if (type !== 'column') await edit({ kind: 'sheets.deleteChart', sheetName, name });
      }
      await edit({ kind: 'sheets.addPivot', sheetName, name: 'AuthoringPivot', range: 'Q1:R4', destination: 'V1', rows: ['Category'], data: [{ field: 'Value', function: 'SUM' }] });
      assert.equal((await query({ kind: 'sheets.pivots', sheetName })).pivots[0].fields.find((field: any) => field.name === 'Value').function, 'SUM');
      const range = await query({ kind: 'sheets.range', sheetName, range: 'Q1:S4' }); assert.ok(range.formulas.flat().some((value: string) => value.startsWith('=')));
      await edit({ kind: 'sheets.setRangeValues', sheetName, range: 'AA10:AB14', rows: [[true, false], ['=ISLOGICAL(AA10)', '=ISLOGICAL(AB10)'], ['=TYPE(AA10)', '=TYPE(AB10)'], ['=COUNT(AA10)', '=COUNT(AB10)'], ['=SUM(AA10)', '=SUM(AB10)']] });
      await undoAndRedo(async () => assert.deepEqual((await query({ kind: 'sheets.range', sheetName, range: 'AA10:AB10' })).kinds[0], ['empty', 'empty']), async () => assert.deepEqual((await query({ kind: 'sheets.range', sheetName, range: 'AA10:AB10' })).values[0], [true, false]));
      const logical = await query({ kind: 'sheets.range', sheetName, range: 'AA10:AB14' }); assert.deepEqual(logical.values[0], [true, false]); assert.deepEqual(logical.kinds[0], ['logical', 'logical']); assert.deepEqual(logical.values[1], [true, true]); assert.deepEqual(logical.values[2], [4, 4]);
      await edit({ kind: 'sheets.setRangeValues', sheetName, range: 'AA10', rows: [[42]] });
      const numeric = await query({ kind: 'sheets.range', sheetName, range: 'AA10:AB14' }); assert.equal(numeric.values[0][0], 42); assert.equal(numeric.kinds[0][0], 'number'); assert.equal(numeric.values[1][0], false); assert.equal(numeric.values[2][0], 1);
      await edit({ kind: 'sheets.setRangeValues', sheetName, range: 'AA10', rows: [['=TRUE()']] });
      const formula = await query({ kind: 'sheets.range', sheetName, range: 'AA10:AB14' }); assert.equal(formula.kinds[0][0], 'formula'); assert.equal(formula.logical[0][0], true); assert.equal(formula.values[0][0], true); assert.equal(formula.values[1][0], true);
      await edit({ kind: 'sheets.setRangeValues', sheetName, range: 'AC10:AD10', rows: [['=TRUE()', '=42']] });
      await edit({ kind: 'sheets.formatRange', sheetName, range: 'AC10', values: { numberFormat: '0.00' } }); await edit({ kind: 'sheets.formatRange', sheetName, range: 'AD10', values: { numberFormat: 'BOOLEAN' } });
      await edit({ kind: 'sheets.setRangeValues', sheetName, range: 'AC11:AD11', rows: [['=ISLOGICAL(AC10)', '=ISLOGICAL(AD10)']] });
      const controlled = await query({ kind: 'sheets.range', sheetName, range: 'AC10:AD11' }); assert.deepEqual(controlled.values, [[1, 42], [false, true]]); assert.deepEqual(controlled.logical[0], [false, true]);
      item.logicalReadback = { literal: logical, numeric, formula };
    } else {
      const before = structuredClone(current), objects = await query({ kind: 'slides.objects', slideIndex: 2 }); originalPpt = (await query({ kind: 'slides.objectText', slideIndex: 2, objectPath: objects.objects[0].objectPath })).text;
      const text = await edit({ kind: 'slides.replaceText', slideIndex: 2, objectPath: [0], expectedText: originalPpt, text: marker }); assert.ok(text.undoToken);
      assert.deepEqual(current.selection, before.selection, 'Editing a different page leaves the human selection unchanged'); assert.equal((current as any).partIndex, (before as any).partIndex);
      await undoAndRedo(async () => assert.equal((await query({ kind: 'slides.objectText', slideIndex: 2, objectPath: [0] })).text, originalPpt), async () => assert.equal((await query({ kind: 'slides.objectText', slideIndex: 2, objectPath: [0] })).text, marker));
      await edit({ kind: 'slides.moveSlide', slideIndex: 2, index: 3 }); await edit({ kind: 'slides.moveSlide', slideIndex: 3, index: 2 });
      await edit({ kind: 'slides.formatText', slideIndex: 2, objectPath: [0], values: { bold: true, color: '335577' } });
      await edit({ kind: 'slides.formatObject', slideIndex: 2, objectPath: [0], values: { fill: 'cceeff' } });
      await edit({ kind: 'slides.setLegacyAnimation', slideIndex: 2, objectPath: [0], effect: 'APPEAR', speed: 'FAST' });
      const grouped = await edit({ kind: 'slides.group', slideIndex: 0, objectPaths: [[0], [1]] }); assert.ok((await query({ kind: 'slides.objects', slideIndex: 0 })).objects.some((object: any) => object.objectPath.length === 2));
      await edit({ kind: 'slides.ungroup', slideIndex: 0, objectPath: (grouped.readback as any).objectPath });
      await edit({ kind: 'slides.applyMaster', slideIndex: 2, masterIndex: 0 });
      const notes = (await query({ kind: 'slides.notes', slideIndex: 2 })).text; await edit({ kind: 'slides.setNotes', slideIndex: 2, text: marker });
      await undoAndRedo(async () => assert.equal((await query({ kind: 'slides.notes', slideIndex: 2 })).text, notes), async () => assert.equal((await query({ kind: 'slides.notes', slideIndex: 2 })).text, marker));
      await edit({ kind: 'slides.setBackground', slideIndex: 2, color: 'cceeff' }); await edit({ kind: 'slides.add', index: 2, title: 'Temporary native page' });
      const duplicate = await edit({ kind: 'slides.duplicate', slideIndex: 2 }); await edit({ kind: 'slides.delete', slideIndex: (duplicate.readback as any).slideIndex }); await edit({ kind: 'slides.delete', slideIndex: 2 });
      assert.equal((await query({ kind: 'slides.objectText', slideIndex: 2, objectPath: [0] })).text, marker);
      assert.equal((await query({ kind: 'slides.animations', slideIndex: 2 })).timingTreeCovered, false);
      const exact = (await query({ kind: 'slides.objects', slideIndex: 2 })).objects.find((object: any) => object.objectPath.length === 1 && object.objectPath[0] === 0);
      const navigation = await runtime.navigate({ sessionId: documentId, viewId, ...versions(current), requestId: randomUUID(), actor: 'human', target: { kind: 'shape', slideIndex: 2, name: exact.name } }); current = navigation.state;
      const selectedBefore = structuredClone(current.selection), selected = await query({ kind: 'selection-target' }); assert.equal(selected.editable, true); assert.deepEqual(selected.target, { kind: 'slides.object', slideIndex: 2, objectPath: [0], matchFrom: 0, matchTo: marker.length }); assert.equal(selected.text, marker); assert.deepEqual(current.selection, selectedBefore);
    }
    current = await runtime.state(documentId, viewId); const snapshot = await runtime.snapshot(documentId, viewId); assert.equal(snapshot.engineRevisionBefore, snapshot.engineRevisionAfter);
    assert.deepEqual(guard(await runtime.state(documentId, viewId)), guard(current), 'Serialization preserves source native history and dirtiness');
    const path = join(directory, 'structured-' + format + '.' + format); await writeFile(path, snapshot.bytes, { flag: 'wx' });
    const copyId = randomUUID(); await runtime.open({ sessionId: copyId, documentId: copyId, viewId: copyId, format, bytes: new Uint8Array(await readFile(path)), revision: 0, ownerHwnd: '1', ownerViewport: { width: 1000, height: 800 }, bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: false });
    const reopened = async (target: OfficeAuthoringQuery): Promise<any> => (await runtime.authoringQuery(copyId, copyId, target)).data;
    if (format === 'docx') { assert.equal((await reopened({ kind: 'word.paragraphs', limit: 1 })).paragraphs[0].text, marker); assert.ok((await reopened({ kind: 'word.tables' })).tables.length); }
    else if (format === 'xlsx') { assert.ok((await reopened({ kind: 'sheets.range', sheetName, range: 'Q1:S4' })).values.flat().includes(marker)); assert.equal((await reopened({ kind: 'sheets.charts', sheetName })).charts[0].type, 'column'); assert.ok((await reopened({ kind: 'sheets.pivots', sheetName })).pivots.length); const logical = await reopened({ kind: 'sheets.range', sheetName, range: 'AA10:AB14' }); assert.deepEqual(logical.kinds[0], ['formula', 'formula']); assert.deepEqual(logical.values[0], [true, false]); assert.equal(logical.values[1][0], true); assert.equal(logical.values[1][1], true); assert.deepEqual((await reopened({ kind: 'sheets.range', sheetName, range: 'AC10:AD11' })).values, [[1, 42], [false, true]]); }
    else { assert.equal((await reopened({ kind: 'slides.objectText', slideIndex: 2, objectPath: [0] })).text, marker); assert.equal((await reopened({ kind: 'slides.notes', slideIndex: 2 })).text, marker); }
    await runtime.close(copyId, { discard: true }); await runtime.close(documentId, { discard: true }); item.passed = true; item.savedCopy = { path, bytes: snapshot.bytes.length, sha256: sha(snapshot.bytes) };
  }
}

let failure: unknown;
try {
  assert.equal(process.platform, 'win32');
  phase('source-identities');
  report.identitiesBefore = await identities();
  if (process.env.AGENTVIEWER_AUTHORING_ONLY === '1') await verifyStructuredAuthoring();
  else for (const format of ['docx', 'xlsx', 'pptx'] as const) {
    const sourceBytes = new Uint8Array(await readFile(join(samplesRoot, names[format]))), sourcePath = join(directory, names[format]);
    await writeFile(sourcePath, sourceBytes);
    const item: Record<string, any> = { format, sourcePath, sourceSha256: sha(sourceBytes), sourceBytes: sourceBytes.length, exports: [] };
    report.formats.push(item);
    phase('open-source-file', item);
    const view = await core.openFile(sourcePath);
    const sourceProjection = core.getDocument(view.documentId).info.model;
    item.sourceProjection = { blocks: sourceProjection.blocks?.length, sheets: sourceProjection.sheets?.length, slides: sourceProjection.slides?.length };
    phase('open-native-document', item);
    const opened = await core.openNativeOffice(view.id, { deferInitialMirror: true });
    assert.equal(opened.nativePid, workerHandle()?.pid); assert.equal(runtime.statistics.transport, 'binary');
    // Native import may canonicalize paragraph/shape structure. Production
    // typed edits first synchronize the native mirror; select IDs from that
    // confirmed model rather than reusing the pre-import source projection.
    phase('canonical-native-mirror', item);
    const imported = await core.nativeOfficeState(view.id);
    await core.synchronizeNativeDocument(view.documentId);
    assert.deepEqual(guard(await core.nativeOfficeState(view.id)), guard(imported), 'Canonical synchronization preserves native source history and dirty state');
    const canonical = core.getDocument(view.documentId), initialModel = structuredClone(canonical.info.model);
    assert.equal(canonical.info.nativeOffice?.mirrorEngineRevision, imported.engineRevision);
    assert.equal(sha(await readFile(sourcePath)), item.sourceSha256);
    item.canonical = { sha256: sha(canonical.bytes), bytes: canonical.bytes.length, revision: canonical.info.revision, mirrorEngineRevision: canonical.info.nativeOffice?.mirrorEngineRevision, blocks: initialModel.blocks?.length, sheets: initialModel.sheets?.length, slides: initialModel.slides?.length };
    phase('resolve-confirmed-target', item);
    const target: Target = format === 'docx' ? { wordId: initialModel.blocks?.[0].id }
      : format === 'xlsx' ? { sheetId: initialModel.sheets?.[0].id, sheetName: initialModel.sheets?.[0].name }
        : { slideId: initialModel.slides?.[0].id, shapeId: initialModel.slides?.[0].blocks.find(block => block.text.trim())?.id };
    assert.ok(format === 'docx' ? target.wordId : format === 'xlsx' ? target.sheetId && target.sheetName : target.slideId && target.shapeId, 'Use an actual parsed target, not a guessed native ID');
    item.target = target;
    if (format === 'pptx') {
      const native = await runtime.query(opened.sessionId, view.id, { kind: 'shapes', slideIndex: 0 }) as { objects: { name: string; text: string }[] };
      const sourceText = initialModel.slides![0].blocks.find(block => block.id === target.shapeId)!.text;
      const matches = native.objects.filter(shape => shape.text === sourceText && shape.name && native.objects.filter(other => other.name === shape.name).length === 1);
      assert.equal(matches.length, 1, 'The real text shape has one unambiguous native name'); target.shapeName = matches[0].name;
    }
    const marker = 'AV_R30_' + format + '_' + randomUUID().slice(0, 8);
    phase('native-text-edit', item);
    await nativeEdit(view, textOperation(format, target, marker));
    // The next typed operation resolves its exact target against mappingBytes.
    // Match the production edit boundary: confirm the first change before
    // issuing another mapped edit. Later we intentionally leave one single
    // native edit unmirrored to exercise the public export's own barrier.
    phase('synchronize-before-next-typed-edit', item);
    await core.synchronizeNativeDocument(view.documentId);
    assert.ok(JSON.stringify(core.getDocument(view.documentId).info.model).includes(marker));
    if (format === 'pptx') {
      phase('construct-private-mixed-native-text-styles', item);
      const split = Math.floor(marker.length / 2);
      for (const [from, to, color, fontFamily] of [[0, split, 'aa3344', 'Times New Roman'], [split, marker.length, '225599', 'Arial']] as const) {
        await selectPptText(view, target, marker, from, to);
        // Match the live inspector's single-field contract. Each explicit
        // assignment keeps this real range; only the following actual shape
        // navigation commits Outliner before a full mirror can be requested.
        for (const values of [{ color }, { fontFamily }]) {
          const selection = await core.nativeOfficeState(view.id);
          assert.equal(selection.selection?.text, marker.slice(from, to));
          const applied = await runtime.execute({ sessionId: selection.sessionId, viewId: view.id, ...versions(selection), expectedSelectionEpoch: selection.selectionEpoch, requestId: randomUUID(), actor: 'human', style: { target: 'text', values } });
          assert.ok(applied.status === 'applied' || applied.status === 'no-change'); core.updateNativeOfficeState(applied.state);
          assert.equal(applied.historyScope, 'text'); assert.equal(applied.undoToken, undefined);
          assert.equal(applied.state.selection?.text, marker.slice(from, to));
          const inspected = await runtime.query(selection.sessionId, view.id, { kind: 'style', target: 'text' }) as NativeOfficeStyleInspection;
          for (const [field, expected] of Object.entries(values)) {
            assert.equal(inspected.fields[field].available, true); assert.notEqual(inspected.fields[field].state, 'mixed');
            assert.equal(inspected.fields[field].value?.toString().toLowerCase(), expected.toLowerCase());
          }
        }
        const textState = await core.nativeOfficeState(view.id);
        const committed = await runtime.navigate({ sessionId: textState.sessionId, viewId: view.id, ...versions(textState), requestId: randomUUID(), actor: 'human', target: { kind: 'shape', slideIndex: 0, name: target.shapeName! } });
        core.updateNativeOfficeState(committed.state); assert.equal(committed.state.pendingInput, false);
        await core.synchronizeNativeDocument(view.documentId);
      }
      // Retire only this test's completed text mode through its actual target.
      const state = await core.nativeOfficeState(view.id);
      const navigation = await runtime.navigate({ sessionId: state.sessionId, viewId: view.id, ...versions(state), requestId: randomUUID(), actor: 'human', target: { kind: 'shape', slideIndex: 0, name: target.shapeName! } });
      core.updateNativeOfficeState(navigation.state);
      item.styleUndoRedo = { before: await savePptStyleCopy(view, target, 'before') };
    }
    const colorOperation: EditOperation = format === 'docx' ? { kind: 'office.setTextStyle', blockId: target.wordId!, from: 0, to: marker.length, expectedText: marker, color: '166a71' }
      : format === 'xlsx' ? { kind: 'sheets.setCellFormat', sheetId: target.sheetId!, address: 'A1', color: '166a71', fill: 'e3d7b4' }
        : { kind: 'slides.setShapeStyle', slideId: target.slideId!, shapeId: target.shapeId!, color: '166a71', fill: '166a71', lineColor: '893b58' };
    phase('native-color-edit', item);
    await nativeEdit(view, colorOperation, 'style');
    if (format === 'pptx') {
      phase('save-and-reopen-typed-shape-style', item);
      const proof = item.styleUndoRedo;
      proof.after = await savePptStyleCopy(view, target, 'after');
      await verifyModel(new Uint8Array(await readFile(proof.after.path)), 'pptx', marker);
      proof.after.reopened = await reopenPptStyleCopy(proof.after.path, target, marker, '166a71', view.documentId);
      phase('undo-typed-shape-style', item);
      let current = await core.nativeOfficeState(view.id); assert.ok(current.undo?.canUndo && current.undo.token);
      const undo = await runtime.undo({ sessionId: current.sessionId, viewId: view.id, ...versions(current), undoToken: current.undo.token, actor: 'human' });
      core.updateNativeOfficeState(undo.state);
      proof.undo = await savePptStyleCopy(view, target, 'undo');
      assert.deepEqual(proof.undo.signature, proof.before.signature, 'Real style Undo restores every original text/shape theme and line-NONE representation in the independently saved PPTX');
      proof.undo.reopened = await reopenPptStyleCopy(proof.undo.path, target, marker, 'mixed', view.documentId);
      phase('redo-typed-shape-style', item);
      current = await core.nativeOfficeState(view.id);
      const redo = await runtime.execute({ sessionId: current.sessionId, viewId: view.id, ...versions(current), requestId: randomUUID(), actor: 'human', command: '.uno:Redo' });
      assert.equal(redo.status, 'applied'); core.updateNativeOfficeState(redo.state);
      proof.redo = await savePptStyleCopy(view, target, 'redo');
      assert.deepEqual(proof.redo.signature, proof.after.signature, 'Real style Redo restores the saved explicit RGB and preserves both fonts');
      await verifyModel(new Uint8Array(await readFile(proof.redo.path)), 'pptx', marker);
      proof.redo.reopened = await reopenPptStyleCopy(proof.redo.path, target, marker, '166a71', view.documentId);
      assert.equal(sha(await readFile(sourcePath)), item.sourceSha256);
      proof.passed = true;
    }
    phase('inspect-native-colors-before-snapshot', item);
    const colors = await inspectColors(view, format, target), beforeMirror = await core.nativeOfficeState(view.id);
    assert.equal(beforeMirror.dirty, true); assert.ok(beforeMirror.undo?.canUndo && beforeMirror.undo.token);
    phase('edited-native-snapshot', item);
    await core.synchronizeNativeDocument(view.documentId);
    const snapshot = core.getDocument(view.documentId).bytes.slice(), snapshotHash = sha(snapshot);
    const snapshotPath = join(directory, format + '-edited-native-snapshot.' + format);
    await writeFile(snapshotPath, snapshot, { flag: 'wx' });
    item.editedSnapshot = { path: snapshotPath, sha256: snapshotHash, bytes: snapshot.length };
    await verifyModel(snapshot, format, marker);
    assert.deepEqual(guard(await core.nativeOfficeState(view.id)), guard(beforeMirror), 'A real snapshot must preserve source Undo, dirty state and revision');
    assert.deepEqual(await inspectColors(view, format, target), colors, 'The first real serialization must preserve live source colors, including PPT read-only clone safety');
    item.initial = { target, marker, native: guard(beforeMirror), snapshotSha256: snapshotHash, snapshotBytes: snapshot.length, colors };
    await core.persist();

    for (let index = 0; index < iterations; index++) {
      phase('same-format-export-' + index, item);
      const state = await core.nativeOfficeState(view.id), output = join(directory, `${format}-native-copy-${index}.${format}`), callStart = driverCalls.length;
      const started = performance.now();
      const result = exported(await core.exportNativeOffice({ viewId: view.id, ...versions(state), path: output, format, idempotencyKey: randomUUID() }));
      const elapsedMs = performance.now() - started, bytes = new Uint8Array(await readFile(output));
      assert.equal(result.status, 'exported'); assert.equal(result.sha256, sha(bytes)); assert.equal(result.format, format);
      assert.equal(sha(bytes), snapshotHash, 'Each same-format copy exactly matches the verified snapshot');
      assert.notEqual(resolve(output).toLowerCase(), resolve(sourcePath).toLowerCase());
      assert.equal(sha(core.getDocument(view.documentId).bytes), snapshotHash, 'An export never replaces its source mirror');
      assert.equal(sha(await readFile(sourcePath)), item.sourceSha256, 'An export never writes back to the source file');
      assert.deepEqual(guard(await core.nativeOfficeState(view.id)), guard(state), 'Export preserves real source Undo, dirty state and revision');
      assert.deepEqual(await inspectColors(view, format, target), colors);
      await verifyModel(bytes, format, marker);
      const info = await stat(output), sourceInfo = await stat(sourcePath);
      if (info.ino && sourceInfo.ino) assert.notEqual(info.ino, sourceInfo.ino, 'The copy is a distinct filesystem object');
      item.exports.push({ path: output, sha256: sha(bytes), bytes: bytes.length, inode: info.ino, elapsedMs, driverCalls: driverCalls.slice(callStart) });
    }
    const last = item.exports.at(-1), copyOne = new Uint8Array(await readFile(item.exports[0].path));
    // A temporary alteration proves paths are independent even on filesystems
    // without useful inode IDs. Restore the valid exported file afterwards.
    phase('verify-independent-copy-paths', item);
    try { await writeFile(item.exports[0].path, Buffer.concat([copyOne, Buffer.from('\nAV_COPY_INDEPENDENCE\n')])); assert.equal(sha(await readFile(last.path)), snapshotHash); assert.equal(sha(await readFile(sourcePath)), item.sourceSha256); }
    finally { await writeFile(item.exports[0].path, copyOne); }
    phase('cross-format-pdf-export', item);
    const state = await core.nativeOfficeState(view.id), pdfPath = join(directory, format + '-cross-format.pdf'), callStart = driverCalls.length, pdfStarted = performance.now();
    const pdf = exported(await core.exportNativeOffice({ viewId: view.id, ...versions(state), path: pdfPath, format: 'pdf', idempotencyKey: randomUUID() }));
    const pdfElapsedMs = performance.now() - pdfStarted, pdfBytes = new Uint8Array(await readFile(pdfPath));
    assert.equal(pdf.format, 'pdf'); assert.equal(Buffer.from(pdfBytes.subarray(0, 5)).toString(), '%PDF-'); assert.notEqual(sha(pdfBytes), snapshotHash);
    const pdfModel = await core.registry.resolve('pdf').open(pdfBytes, 'pdf'); assert.ok(pdfModel.pageCount && pdfModel.pageCount > 0);
    assert.deepEqual(guard(await core.nativeOfficeState(view.id)), guard(state)); assert.deepEqual(await inspectColors(view, format, target), colors);
    assert.equal(sha(core.getDocument(view.documentId).bytes), snapshotHash); assert.equal(sha(await readFile(sourcePath)), item.sourceSha256);
    item.crossFormat = { path: pdfPath, sha256: sha(pdfBytes), bytes: pdfBytes.length, pages: pdfModel.pageCount, elapsedMs: pdfElapsedMs, driverCalls: driverCalls.slice(callStart) };

    // A new real acknowledged edit after the cached mirror must invalidate it.
    // Reuse is judged by actual content, never just an incremented version.
    const laterMarker = marker + '_LATER';
    phase('native-edit-after-cached-snapshot', item);
    const changed = await nativeEdit(view, textOperation(format, target, laterMarker));
    assert.equal(sha(core.getDocument(view.documentId).bytes), snapshotHash, 'The native change is intentionally not mirrored before public export');
    phase('export-after-native-edit', item);
    const changedPath = join(directory, format + '-after-native-edit.' + format), changedStart = performance.now();
    const changedCopy = exported(await core.exportNativeOffice({ viewId: view.id, ...versions(changed), path: changedPath, format, idempotencyKey: randomUUID() }));
    const changedElapsedMs = performance.now() - changedStart, changedBytes = new Uint8Array(await readFile(changedPath));
    assert.notEqual(sha(changedBytes), snapshotHash); assert.equal(changedCopy.sha256, sha(changedBytes));
    const changedModel = await core.registry.resolve(format).open(changedBytes, format);
    assert.ok(JSON.stringify(changedModel).includes(laterMarker), 'The new native text must reach the exported copy');
    const afterChanged = await core.nativeOfficeState(view.id); assert.deepEqual(guard(afterChanged), guard(changed));
    assert.equal(sha(await readFile(sourcePath)), item.sourceSha256);
    // Actual UNO history movement is also validated. This is the public native
    // Undo route, not an OS/Chromium key or proof of same-revision physical Undo.
    assert.ok(afterChanged.undo?.token);
    phase('native-undo-after-cached-snapshot', item);
    const undone = await runtime.undo({ sessionId: afterChanged.sessionId, viewId: view.id, ...versions(afterChanged), undoToken: afterChanged.undo.token, actor: 'human' });
    core.updateNativeOfficeState(undone.state);
    phase('export-after-native-undo', item);
    const undoPath = join(directory, format + '-after-native-undo.' + format), undoState = await core.nativeOfficeState(view.id);
    await core.exportNativeOffice({ viewId: view.id, ...versions(undoState), path: undoPath, format, idempotencyKey: randomUUID() });
    const undoBytes = new Uint8Array(await readFile(undoPath)), undoModel = await core.registry.resolve(format).open(undoBytes, format);
    assert.ok(JSON.stringify(undoModel).includes(marker)); assert.ok(!JSON.stringify(undoModel).includes(laterMarker));
    assert.deepEqual(guard(await core.nativeOfficeState(view.id)), guard(undoState));
    assert.equal(sha(await readFile(sourcePath)), item.sourceSha256); assert.equal(core.getDocument(view.documentId).info.dirty, true);
    item.changed = { marker: laterMarker, path: changedPath, sha256: sha(changedBytes), elapsedMs: changedElapsedMs, native: guard(changed) };
    item.undone = { path: undoPath, sha256: sha(undoBytes), native: guard(undoState), sameEngineRevisionAsChanged: undoState.engineRevision === changed.engineRevision, scope: 'Actual UNO undo token/history; not physical-key or guaranteed same-revision coverage' };
    if (format === 'pptx') {
      // One readable Unicode editing/Undo flow on the same verified shape.
      const typed: Record<string, any> = {};
      item.typedFullText = typed;
      async function readShapeText(expectedText: string) {
        const current = await core.nativeOfficeState(view.id);
        const actual = await runtime.query(current.sessionId, view.id, { kind: 'shape', slideIndex: 0, name: target.shapeName! }) as { name: string; text: string };
        assert.equal(actual.name, target.shapeName); assert.equal(actual.text, expectedText);
        assert.equal(current.pendingInput, false);
        assert.equal(sha(await readFile(sourcePath)), item.sourceSha256);
        return { textSha256: sha(actual.text), utf16Length: actual.text.length, native: guard(await core.nativeOfficeState(view.id)) };
      }
      phase('ppt-unicode-text-edit', item);
      await core.synchronizeNativeDocument(view.documentId);
      const previous = await core.nativeOfficeState(view.id), unicode = '多行中文 🧭\n第二行 😀';
      const changed = await nativeEdit(view, textOperation('pptx', target, unicode));
      assert.notEqual(changed.undo?.token, previous.undo?.token);
      typed.changed = await readShapeText(unicode);
      await core.synchronizeNativeDocument(view.documentId);
      phase('ppt-unicode-text-undo', item);
      const current = await core.nativeOfficeState(view.id); assert.ok(current.undo?.canUndo && current.undo.token);
      const restored = await runtime.undo({ sessionId: current.sessionId, viewId: view.id, ...versions(current), undoToken: current.undo.token, actor: 'human' });
      core.updateNativeOfficeState(restored.state);
      typed.restored = await readShapeText(marker);
      await core.synchronizeNativeDocument(view.documentId);
      assert.equal(sha(await readFile(sourcePath)), item.sourceSha256);
      typed.passed = true;
    }
    item.passed = true;
    phase('close-owned-native-document', item);
    await core.closeNativeOffice(view.documentId);
  }
  await verifyWordVisibleProjection();
  assert.equal(ackSavedCalls, 0, 'Copy export must never acknowledge the live source as saved');
  report.ackSavedCalls = ackSavedCalls; report.transport = runtime.statistics.transport; report.runtimeStatistics = runtime.statistics;
  report.persistence = repository.statistics; report.passed = true; phase('completed');
} catch (error) {
  failure = error; report.passed = false; report.failurePhase = report.currentPhase; report.errors.push(error instanceof Error ? { message: error.message, stack: error.stack } : String(error));
} finally {
  phase('cleanup');
  const worker = workerHandle(); report.ownedPid = worker?.pid; report.workerDirectory = runtime.workerDirectory;
  if (worker) try { report.workerSha256 = sha(await readFile(join(runtime.workerDirectory, 'office-worker.py'))); }
  catch (error) { report.passed = false; report.workerIdentityError = String(error); failure ??= error; }
  try { await core.shutdownNativeOffice(); } catch (error) { report.passed = false; report.coreCleanupError = String(error); failure ??= error; }
  try { await runtime.shutdown({ discard: true }); } catch (error) { report.passed = false; report.shutdownError = String(error); failure ??= error; }
  report.workerExited = await waitOwnedExit(worker);
  if (!report.workerExited) { report.passed = false; failure ??= new Error('The owned native worker did not exit normally'); }
  report.workerExitCode = worker?.exitCode ?? null; report.workerSignalCode = worker?.signalCode ?? null;
  report.workerNormalExit = !worker || report.workerExited && worker.exitCode === 0 && worker.signalCode === null;
  if (!report.workerNormalExit) { report.passed = false; failure ??= new Error('The owned native worker exited abnormally'); }
  try { report.identitiesAfter = await identities(); assert.deepEqual(report.identitiesAfter, report.identitiesBefore); report.sourcesStable = true; }
  catch (error) { report.passed = false; report.sourcesStable = false; report.identityError = String(error); failure ??= error; }
  report.driverCalls = driverCalls; report.ackSavedCalls = ackSavedCalls;
  await mkdir(directory, { recursive: true }); await writeFile(evidence, JSON.stringify(report, null, 2));
}
console.log('Native export-copy acceptance:', JSON.stringify({ passed: report.passed, workerExited: report.workerExited, sourcesStable: report.sourcesStable, ownedPid: report.ownedPid, evidence }));
if (failure) throw failure;
