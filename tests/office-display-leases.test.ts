import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeDisplayLeases, withdrawnOfficeDisplayState } from '../apps/desktop/src/main/office-display-leases';
import type { NativeOfficeState } from '../packages/contracts/src/native-office';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('display withdrawal retires only its exact mount, and an old release cannot hide a remount or another window', () => {
  const leases = new OfficeDisplayLeases<object>(), firstWindow = {}, secondWindow = {};
  const first = leases.acquire(firstWindow, 'view-a', 'mount-a');
  const other = leases.acquire(secondWindow, 'view-b', 'mount-b');
  assert.equal(leases.release(firstWindow, 'view-a', 'mount-a').changed, true);assert.equal(leases.active(first), false);
  const remount = leases.acquire(firstWindow, 'view-a', 'mount-a2');assert.ok(remount.generation > first.generation);
  assert.equal(leases.release(firstWindow, 'view-a', 'mount-a').changed, false);assert.equal(leases.active(remount), true);assert.equal(leases.active(other), true);
  assert.throws(() => leases.require(firstWindow, 'view-a', 'mount-a'), { code: 'OFFICE_DISPLAY_EXPIRED' });
  assert.throws(() => leases.acquire(firstWindow, 'view-a', 'mount-a'), { code: 'OFFICE_DISPLAY_EXPIRED' });
  assert.throws(() => leases.require(secondWindow, 'view-a', 'mount-a2'), { code: 'OFFICE_DISPLAY_EXPIRED' });
});

test('release before its pending acquire arrival prevents a late mount from becoming visible', () => {
  const leases = new OfficeDisplayLeases<object>(), owner = {};
  const release = leases.release(owner, 'loading-view', 'old-pending-mount');assert.equal(release.changed, true);
  assert.throws(() => leases.acquire(owner, 'loading-view', 'old-pending-mount'), { code: 'OFFICE_DISPLAY_EXPIRED' });
  const next = leases.acquire(owner, 'loading-view', 'current-mount');assert.equal(leases.active(next), true);
});

test('presentation belongs to its exact active mount and native source, while later edits keep the visible model',()=>{
  const leases=new OfficeDisplayLeases<object>(),owner={},proof={sessionId:'session',engineEpoch:'epoch',engineRevision:3,layoutRevision:8},first=leases.acquire(owner,'view','first');
  assert.equal(leases.presented(first,proof),false);leases.confirm(first,proof);assert.equal(leases.presented(first,proof),true);
  assert.equal(leases.presented(first,{sessionId:'different',engineEpoch:'epoch'}),false);assert.equal(leases.presented(first,{sessionId:'session',engineEpoch:'next-epoch'}),false);
  assert.equal(leases.presented(first,{...proof,engineRevision:4} as typeof proof),true,'editing the already presented model does not replace it with a preview');
  leases.release(owner,'view','first');assert.equal(leases.presented(first,proof),false);const current=leases.acquire(owner,'view','current');
  assert.equal(leases.presented(current,proof),false);assert.throws(()=>leases.confirm(first,proof),{code:'OFFICE_DISPLAY_EXPIRED'});assert.equal(leases.presented(current,proof),false,'a late first-frame ACK cannot present the new mount');
  leases.confirm(current,proof);leases.release(owner,'view','first');assert.equal(leases.presented(current,proof),true,'an old release cannot erase a new presentation');
});

test('queued native layouts and hides keep FIFO but discard obsolete leases before execution', async () => {
  const leases = new OfficeDisplayLeases<object>(), owner = {}, first = leases.acquire(owner, 'view', 'old'), entered = gate(), finished = gate(), actions: string[] = [];
  const oldLayout = leases.serialize('view', async () => { assert.equal(leases.active(first), true);actions.push('old-layout-start');entered.resolve();await finished.promise;actions.push('old-layout-return');return leases.active(first); });
  await entered.promise;
  const retired = leases.release(owner, 'view', 'old').ticket!;
  const oldHide = leases.serialize('view', async () => { if (leases.matches(retired)) actions.push('old-hide'); });
  const remount = leases.acquire(owner, 'view', 'new');
  const newLayout = leases.serialize('view', async () => { leases.require(owner, 'view', 'new');actions.push('new-layout');return leases.active(remount); });
  finished.resolve();assert.equal(await oldLayout, false);await oldHide;assert.equal(await newLayout, true);
  assert.deepEqual(actions, ['old-layout-start','old-layout-return','new-layout']);
});

test('a failed old layout cannot poison later valid display writes or a separate view queue', async () => {
  const leases = new OfficeDisplayLeases<object>(), owner = {}, first = leases.acquire(owner, 'a', 'a'), waiting = gate(), actions: string[] = [];
  const failing = leases.serialize('a', async () => { await waiting.promise;throw new Error('actual layout failure'); }), rejected = assert.rejects(failing, /actual layout failure/);
  const next = leases.serialize('a', async () => { actions.push('next-a');return leases.active(first); });
  await leases.serialize('b', async () => { actions.push('independent-b'); });assert.deepEqual(actions, ['independent-b']);
  waiting.resolve();await rejected;assert.equal(await next, true);assert.deepEqual(actions, ['independent-b','next-a']);
});

test('withdrawing display clears viewport claims while preserving exact model, source, pending input and selection provenance', () => {
  const state: NativeOfficeState = { sessionId: 'same-writer', documentId: 'doc', viewId: 'view', format: 'docx', engineEpoch: 'engine', engineRevision: 17, selectionEpoch: 9, dirty: true, unsavedContentChanges: true, pendingInput: true, actor: 'human', visible: true, focused: true, nativeGeometry: true, visibleText: 'old visible paragraph', visibleTextReady: true, visibleTextSource: 'actual-model-projection', selection: { kind: 'text', text: 'selected text', locator: { kind: 'paragraph', blockId: 'paragraph-2' }, rect: { x: 2, y: 3, width: 40, height: 20 } } };
  const hidden = withdrawnOfficeDisplayState(state);
  assert.equal(hidden.visible, false);assert.equal(hidden.focused, false);assert.equal(hidden.nativeGeometry, false);assert.equal(hidden.visibleTextReady, false);assert.equal(hidden.visibleText, '');assert.equal(hidden.selection?.rect, undefined);
  assert.deepEqual([hidden.sessionId, hidden.engineEpoch, hidden.engineRevision, hidden.dirty, hidden.unsavedContentChanges, hidden.pendingInput, hidden.selection?.text, hidden.selection?.locator], [state.sessionId, state.engineEpoch, state.engineRevision, true, true, true, state.selection?.text, state.selection?.locator]);
  assert.equal(state.visible, true);assert.ok(state.selection?.rect);
});
