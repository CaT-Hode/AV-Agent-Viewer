import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeOfficeState } from '../packages/contracts/src/native-office';
import { createNativeOfficeToolController, nativeOfficeCommandAvailability, nativeOfficeStateVersionOrder, nativeOfficeToolGroups, parseNativeOfficeArguments, type NativeOfficeRequest } from '../apps/desktop/src/renderer/lib/native-office-tools';
import { NativeOfficeCellDraft, nativeOfficeSingleCell } from '../apps/desktop/src/renderer/lib/native-office-cell-draft';

const initial = (format: NativeOfficeState['format'] = 'docx'): NativeOfficeState => ({ documentId: 'doc', viewId: 'view', sessionId: 'session', format, status: 'ready', engineEpoch: 'epoch', engineRevision: 4, selectionEpoch: 6, dirty: false, selection: format === 'xlsx' ? { kind: 'cells', text: '', sheetName: '数据', sheetIndex: 0, range: 'B2' } : { kind: 'text', text: '目标段落' } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

test('toolbox state revisions are ordered only inside one native session, so a same-worker reopen may restart at zero', () => {
  const previous = { ...initial(), engineRevision: 20, selectionEpoch: 18 };
  assert.equal(nativeOfficeStateVersionOrder({ ...previous, engineRevision: 19 }, previous), -1);
  assert.equal(nativeOfficeStateVersionOrder({ ...previous, selectionEpoch: 19 }, previous), 1);
  assert.equal(nativeOfficeStateVersionOrder({ ...previous, engineRevision: 21, selectionEpoch: 0 }, previous), 1);
  assert.equal(nativeOfficeStateVersionOrder({ ...previous }, previous), 0);
  const reopened = { ...previous, sessionId: 'reopened-session', engineRevision: 0, selectionEpoch: 0 };
  assert.equal(nativeOfficeStateVersionOrder(reopened, previous), undefined, 'a new session cannot be rejected as an old response');
  assert.equal(nativeOfficeStateVersionOrder(previous, reopened), undefined, 'the old high revision must not shadow a supplied reopened state');
  for (const change of [{ engineEpoch: 'new-worker' }, { documentId: 'other-doc' }, { viewId: 'other-view' }]) assert.equal(nativeOfficeStateVersionOrder({ ...previous, ...change }, previous), undefined);
  assert.equal(nativeOfficeStateVersionOrder(undefined, previous), undefined);
});

test('native defaults only expose discovered format-specific commands and never infer enablement', () => {
  const catalog = [{ command: '.uno:Bold', enabled: true }, { command: '.uno:InsertTable' }, { command: '.uno:InsertPage' }, { command: '.uno:AutoSum' }];
  assert.deepEqual(nativeOfficeToolGroups('docx', 'table', catalog).flatMap(group => group.commands.map(item => item.command)), ['.uno:InsertTable']);
  assert.deepEqual(nativeOfficeToolGroups('docx', 'insert', catalog).flatMap(group => group.commands.map(item => item.command)), []);
  assert.deepEqual(nativeOfficeToolGroups('pptx', 'slides', catalog).flatMap(group => group.commands.map(item => item.command)), ['.uno:InsertPage']);
  assert.deepEqual(nativeOfficeToolGroups('xlsx', 'formulas', catalog).flatMap(group => group.commands.map(item => item.command)), ['.uno:AutoSum']);
  assert.equal(nativeOfficeCommandAvailability({ command: '.uno:Bold' }, initial()).enabled, false);
  assert.equal(nativeOfficeCommandAvailability({ command: '.uno:Bold', enabled: true }, initial()).enabled, true);
  for (const state of [undefined, { ...initial(), status: 'opening' as const }, { ...initial(), pendingInput: true }]) assert.equal(nativeOfficeCommandAvailability({ command: '.uno:Bold', enabled: true }, state).enabled, false);
  for (const command of ['.uno:NewWindow', '.uno:Save', '.uno:Sidebar']) assert.equal(nativeOfficeCommandAvailability({ command, enabled: true }, initial()).enabled, false);
  assert.equal(nativeOfficeCommandAvailability({ command: '.uno:Bold', enabled: true, requiresSelection: true }, { ...initial(), selection: { kind: 'none', text: '' } }).enabled, false);
});

test('styles, transitions, animation and notes use discovered native controls rather than stale command aliases', () => {
  const ids = ['DesignerDialog', 'StyleCatalog', 'TableDialog', 'MergeCells', 'InsertReferenceField', 'InsertMultiIndex', 'Calculate', 'Recalc', 'ShowPrecedents', 'DefinePrintArea', 'PrintPreview', 'MasterSlidesPanel', 'MasterPage', 'SlideChangeWindow', 'CustomAnimation', 'PresentationDialog', 'NotesMode', 'NotesPage', 'PageMode', 'NotesMasterPage'];
  const catalog = ids.map(id => ({ command: '.uno:' + id, available: true, enabled: true }));
  const commands = (format: 'docx' | 'xlsx' | 'pptx', category: Parameters<typeof nativeOfficeToolGroups>[1]) => nativeOfficeToolGroups(format, category, catalog).flatMap(group => group.commands.map(item => item.command));
  assert.deepEqual(commands('docx', 'home').filter(command => /Designer|Catalog/.test(command)), ['.uno:DesignerDialog']);
  assert.deepEqual(commands('docx', 'table'), ['.uno:TableDialog', '.uno:MergeCells']);
  assert.deepEqual(commands('docx', 'references'), ['.uno:InsertReferenceField', '.uno:InsertMultiIndex']);
  assert.deepEqual(commands('xlsx', 'formulas'), ['.uno:Calculate', '.uno:ShowPrecedents']);
  assert.deepEqual(commands('xlsx', 'print'), ['.uno:DefinePrintArea', '.uno:PrintPreview']);
  assert.deepEqual(commands('pptx', 'transitions'), ['.uno:SlideChangeWindow']);
  assert.deepEqual(commands('pptx', 'animation'), ['.uno:CustomAnimation']);
  assert.deepEqual(commands('pptx', 'presentation'), ['.uno:PresentationDialog']);
  assert.deepEqual(commands('pptx', 'notes'), ['.uno:NotesMode', '.uno:PageMode', '.uno:NotesMasterPage']);
  assert.deepEqual(commands('pptx', 'design'), ['.uno:MasterSlidesPanel', '.uno:MasterPage']);
  assert.deepEqual(nativeOfficeToolGroups('pptx', 'animation', []), []);
  assert.equal(nativeOfficeCommandAvailability({ command: '.uno:CustomAnimation', enabled: undefined }, initial('pptx')).enabled, false);
});

test('Calc width and height controls use Calc commands rather than Writer table commands', () => {
  const catalog = ['ColumnWidth', 'RowHeight', 'SetColumnWidth', 'SetRowHeight', 'SetOptimalColumnWidth', 'SetOptimalRowHeight'].map(name => ({ command: '.uno:' + name, available: true, enabled: true }));
  const commands = nativeOfficeToolGroups('xlsx', 'worksheet', catalog).flatMap(group => group.commands.map(item => item.command));
  assert.deepEqual(commands, ['.uno:ColumnWidth', '.uno:RowHeight', '.uno:SetOptimalColumnWidth', '.uno:SetOptimalRowHeight']);
});

test('native deck command remains versioned and keeps dispatched distinct from an applied document edit', async () => {
  const state = initial('pptx'), calls: { method: string; args?: Record<string, unknown> }[] = [];
  const request = (async (method, args) => { calls.push({ method, args }); return method === 'office-command-status' ? { state, commands: [{ command: '.uno:CustomAnimation', available: true, enabled: true }] } : { receipt: { status: 'dispatched' }, state }; }) as NativeOfficeRequest;
  const owner = createNativeOfficeToolController({ documentId: 'doc', viewId: 'view' }, { current: () => state, request, accept: () => {}, makeKey: () => 'animation-deck' });
  assert.equal((await owner.controller.execute('.uno:CustomAnimation')).status, 'dispatched');
  assert.equal(calls[1].args?.command, '.uno:CustomAnimation');
  assert.equal(calls[1].args?.expectedSelectionEpoch, 6);
  assert.equal(calls[1].args?.expectedEngineRevision, 4);
  assert.equal(calls[1].args?.idempotencyKey, 'animation-deck');
  owner.dispose();
});

test('UNO arguments require explicit primitive types and reject ambiguity, duplicate properties and overflow', () => {
  const args = [{ name: 'Enabled', type: 'boolean', value: false }, { name: 'Page', type: 'short', value: 12 }, { name: 'Title', type: 'string', value: '<script>plain text</script>' }];
  assert.deepEqual(parseNativeOfficeArguments(JSON.stringify(args)), args); assert.deepEqual(parseNativeOfficeArguments(''), []);
  for (const source of ['{}', '[{"name":"X","value":1}]', '[{"name":"X","type":"string","value":{}}]', '[{"name":"X","type":"short","value":32768}]', '[{"name":"X","type":"long","value":1.2}]', '[{"name":"X","type":"string","value":"a","execute":true}]', '[{"name":"X","type":"string","value":"a"},{"name":"X","type":"string","value":"b"}]']) assert.throws(() => parseNativeOfficeArguments(source));
});

test('commands recheck actual status and send the captured engine and selection version exactly once', async () => {
  let state = initial(), mutations = 0;
  const calls: { method: string; args?: Record<string, unknown> }[] = [];
  const request = (async (method, args) => { calls.push({ method, args }); if (method === 'office-command-status') return { state, commands: [{ command: '.uno:Bold', available: true, enabled: true }] }; mutations++; return { receipt: { status: 'dispatched' }, state }; }) as NativeOfficeRequest;
  const owner = createNativeOfficeToolController({ documentId: 'doc', viewId: 'view' }, { current: () => state, request, accept: value => { state = value; }, makeKey: () => 'key-1' });
  const result = await owner.controller.execute('.uno:Bold');
  assert.equal(result.status, 'dispatched', 'dialog dispatch must not be reported as an applied edit'); assert.equal(mutations, 1);
  assert.deepEqual(calls[1], { method: 'office-execute', args: { viewId: 'view', expectedEngineEpoch: 'epoch', expectedEngineRevision: 4, expectedSelectionEpoch: 6, idempotencyKey: 'key-1', command: '.uno:Bold', args: undefined } });
  owner.dispose();
});

test('selection changes during the status request reject before any command dispatch', async () => {
  let state = initial(), dispatched = 0; const gate = deferred<unknown>();
  const request = (async (method) => { if (method === 'office-command-status') return gate.promise; dispatched++; }) as NativeOfficeRequest;
  const owner = createNativeOfficeToolController({ documentId: 'doc', viewId: 'view' }, { current: () => state, request, accept: () => {} });
  const operation = owner.controller.execute('.uno:Bold'), rejected = assert.rejects(operation, /文档或选区已变化/);
  state = { ...state, selectionEpoch: 7, selection: { kind: 'text', text: '新选区' } };
  gate.resolve({ state: initial(), commands: [{ command: '.uno:Bold', enabled: true }] }); await rejected; assert.equal(dispatched, 0); owner.dispose();
});

test('unknown or managed commands, pending input, replaced owners, and unmount cannot dispatch', async () => {
  for (const scenario of ['unknown', 'managed', 'input', 'owner', 'disposed'] as const) {
    let state = initial(), mutations = 0;
    const request = (async (method) => { if (method === 'office-command-status') return { state, commands: [] }; mutations++; }) as NativeOfficeRequest;
    const owner = createNativeOfficeToolController({ documentId: 'doc', viewId: 'view' }, { current: () => state, request, accept: () => {} });
    if (scenario === 'input') state = { ...state, pendingInput: true };
    if (scenario === 'owner') state = { ...state, viewId: 'other-view' };
    if (scenario === 'disposed') owner.dispose();
    await assert.rejects(owner.controller.execute(scenario === 'managed' ? '.uno:NewWindow' : '.uno:Bold')); assert.equal(mutations, 0); owner.dispose();
  }
});

test('one mutation remains in flight, late results never roll back a newer native selection', async () => {
  let state = initial(), accepts = 0; const gate = deferred<unknown>();
  const request = (async (method) => method === 'office-command-status' ? { state, commands: [{ command: '.uno:Bold', enabled: true }] } : gate.promise) as NativeOfficeRequest;
  const owner = createNativeOfficeToolController({ documentId: 'doc', viewId: 'view' }, { current: () => state, request, accept: value => { accepts++; state = value; }, makeKey: () => 'key' });
  const first = owner.controller.execute('.uno:Bold'); await Promise.resolve();
  await assert.rejects(owner.controller.execute('.uno:Bold'), /上一条/);
  state = { ...state, engineRevision: 5, selectionEpoch: 10 };
  gate.resolve({ receipt: { status: 'applied' }, state: { ...initial(), engineRevision: 5, selectionEpoch: 7 } });
  assert.equal((await first).status, 'applied'); assert.equal(accepts, 0); assert.equal(state.selectionEpoch, 10); owner.dispose();
});

test('typed navigation preserves exact engine targets and requested versus rendered status', async () => {
  const state = initial('pptx'); let args: Record<string, unknown> | undefined;
  const request = (async (method, value) => { assert.equal(method, 'office-navigate'); args = value; return { status: 'requested', state }; }) as NativeOfficeRequest;
  const owner = createNativeOfficeToolController({ documentId: 'doc', viewId: 'view' }, { current: () => state, request, accept: () => {}, makeKey: () => 'navigation-key' });
  const result = await owner.controller.navigate({ kind: 'slide', index: 3 }); assert.equal(result.status, 'requested'); assert.deepEqual(args?.target, { kind: 'slide', index: 3 }); assert.equal(args?.expectedEngineRevision, 4); assert.equal(args?.expectedSelectionEpoch, 6); owner.dispose();
});

test('tool actions flush formula drafts before capturing the new revision and reject lease changes during preparation', async () => {
  for (const changedSelection of [false, true]) {
    let state = initial(), mutations = 0;
    const request = (async (method, args) => { if (method === 'office-command-status') return { state, commands: [{ command: '.uno:Bold', enabled: true }] }; mutations++; assert.equal(args?.expectedEngineRevision, 5); return { receipt: { status: 'no-change' }, state }; }) as NativeOfficeRequest;
    const owner = createNativeOfficeToolController({ documentId: 'doc', viewId: 'view' }, { current: () => state, request, accept: value => { state = value; }, beforeAction: async () => ({ ...state, engineRevision: 5, selectionEpoch: changedSelection ? 7 : 6 }), makeKey: () => 'prepared' });
    if (changedSelection) { await assert.rejects(owner.controller.execute('.uno:Bold'), /提交草稿时选区/); assert.equal(mutations, 0); }
    else { assert.equal((await owner.controller.execute('.uno:Bold')).status, 'no-change'); assert.equal(mutations, 1); }
    owner.dispose();
  }
});

test('formula drafts own only a single actual cell, never the first cell of a multi-range', () => {
  const state = initial('xlsx'); assert.deepEqual(nativeOfficeSingleCell(state), { sheetName: '数据', address: 'B2' });
  assert.deepEqual(nativeOfficeSingleCell({ ...state, selection: { ...state.selection!, range: '$B$2:$B$2' } }), { sheetName: '数据', address: 'B2' });
  for (const range of ['B2:C3', 'B2,B4', '', '0', 'Sheet1!B2']) assert.equal(nativeOfficeSingleCell({ ...state, selection: { ...state.selection!, range } }), undefined);
});

test('formula flush is shared, retains in-flight new input, and rebases the next submission on its receipt', async () => {
  let state = initial('xlsx'); const gate = deferred<unknown>(), calls: Record<string, unknown>[] = [];
  const request = (async (method, args) => { assert.equal(method, 'office-cell-set'); calls.push(args!); return calls.length === 1 ? gate.promise : { receipt: { status: 'applied' }, state: { ...state, engineRevision: 6 } }; }) as NativeOfficeRequest;
  const draft = new NativeOfficeCellDraft('view', 'doc', { current: () => state, request, changed: () => {}, accept: value => { state = value; }, makeKey: () => 'cell-' + calls.length });
  draft.load(state, '=SUM(A1:A2)'); draft.setValue('=SUM(A1:A3)'); const first = draft.flush(); assert.equal(draft.flush(), first);
  draft.setValue('=SUM(A1:A4)'); gate.resolve({ receipt: { status: 'applied' }, state: { ...state, engineRevision: 5 } }); await first;
  assert.equal(draft.value, '=SUM(A1:A4)'); assert.equal(draft.hasDrafts(), true); assert.equal(calls.length, 1);
  await draft.flush(); assert.equal(calls[1].expectedEngineRevision, 5); assert.equal(calls[1].content, '=SUM(A1:A4)'); assert.equal(draft.hasDrafts(), false); draft.dispose();
});

test('failed, unconfirmed, stale-selection, external-edit and IME formula submissions preserve the draft', async () => {
  for (const scenario of ['failure', 'unconfirmed', 'selection', 'engine', 'ime', 'owner'] as const) {
    let state = initial('xlsx'), calls = 0;
    const request = (async () => { calls++; if (scenario === 'failure') throw new Error('实际连接失败'); return { receipt: { status: 'dispatched' }, state }; }) as NativeOfficeRequest;
    const draft = new NativeOfficeCellDraft('view', 'doc', { current: () => state, request, changed: () => {}, accept: () => {} });
    draft.load(state, '原值'); draft.setValue('新值');
    if (scenario === 'selection') state = { ...state, selection: { ...state.selection!, range: 'C3' }, selectionEpoch: 7 };
    if (scenario === 'engine') state = { ...state, engineRevision: 5 };
    if (scenario === 'ime') draft.setComposing(true);
    if (scenario === 'owner') state = { ...state, viewId: 'other' };
    await assert.rejects(draft.flush()); assert.equal(draft.hasDrafts(), true); assert.equal(draft.value, '新值'); assert.equal(calls, ['failure', 'unconfirmed'].includes(scenario) ? 1 : 0); draft.dispose();
  }
});

test('formula source requery cannot replace a draft; returning to the same cell uses the current selection lease', async () => {
  let state = initial('xlsx'), submitted: Record<string, unknown> | undefined;
  const request = (async (_method, args) => { submitted = args; return { receipt: { status: 'no-change' }, state }; }) as NativeOfficeRequest;
  const draft = new NativeOfficeCellDraft('view', 'doc', { current: () => state, request, changed: () => {}, accept: () => {} });
  draft.load(state, '1'); draft.setValue('2'); assert.equal(draft.load({ ...state, selection: { ...state.selection!, range: 'C3' } }, '999'), false);
  state = { ...state, selectionEpoch: 8 }; await draft.flush(); assert.equal(submitted?.expectedSelectionEpoch, 8); assert.equal(submitted?.address, 'B2'); assert.equal(draft.hasDrafts(), false);
  draft.setValue('3'); draft.discard(); assert.equal(draft.value, '2'); assert.equal(draft.hasDrafts(), false); draft.dispose();
});

test('late formula receipts do not restore an old session or supersede the latest native selection', async () => {
  for (const replaced of [true, false]) {
    let state = initial('xlsx'), accepts = 0; const gate = deferred<unknown>();
    const request = (async () => gate.promise) as NativeOfficeRequest;
    const draft = new NativeOfficeCellDraft('view', 'doc', { current: () => state, request, changed: () => {}, accept: () => { accepts++; } });
    draft.load(state, '1'); draft.setValue('2'); const pending = draft.flush();
    state = { ...state, engineEpoch: replaced ? 'new-session' : state.engineEpoch, engineRevision: 6, selectionEpoch: 9 };
    const rejected = replaced ? assert.rejects(pending, /原生会话已变化/) : pending;
    gate.resolve({ receipt: { status: 'applied' }, state: { ...initial('xlsx'), engineRevision: 5, selectionEpoch: 7 } }); await rejected;
    assert.equal(accepts, 0); assert.equal(draft.hasDrafts(), replaced); draft.dispose();
  }
});
