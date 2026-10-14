import assert from 'node:assert/strict';
import { test } from 'node:test';
import { officeTileRgba } from '../apps/desktop/src/renderer/lib/office-surface-pixels';
import { officeSurfaceWindowOwned, officeWindowPoint } from '../apps/desktop/src/renderer/lib/office-surface-window';
import { OfficePointerClickTracker } from '../apps/desktop/src/renderer/lib/office-surface-pointer';
import { officeSurfaceStaleRead } from '../apps/desktop/src/renderer/lib/office-surface-errors';
import type { OfficeSurfaceState, OfficeSurfaceWindowIdentity } from '../packages/contracts/src/office-surface';

test('window ownership survives repaint but rejects ID reuse and a replaced engine', () => {
  const state = { sessionId: 'session', engineEpoch: 'epoch', viewId: 'view', windows: [{ id: 42, instanceId: '42:created-3', visible: true, generation: 5 }] } as OfficeSurfaceState;
  const identity: OfficeSurfaceWindowIdentity = { sessionId: 'session', engineEpoch: 'epoch', viewId: 'view', windowId: 42, windowInstanceId: '42:created-3' };
  assert.equal(officeSurfaceWindowOwned(state, identity)?.generation, 5);
  assert.equal(officeSurfaceWindowOwned({ ...state, windows: [{ ...state.windows![0], generation: 6 }] }, identity)?.generation, 6);
  assert.equal(officeSurfaceWindowOwned({ ...state, windows: [{ ...state.windows![0], instanceId: '42:created-9' }] }, identity), undefined);
  assert.equal(officeSurfaceWindowOwned({ ...state, engineEpoch: 'replacement' }, identity), undefined);
  assert.equal(officeSurfaceWindowOwned({ ...state, windows: [{ ...state.windows![0], visible: false }] }, identity), undefined);
});
test('native window mouse coordinates use logical pixels even when the canvas bitmap uses DPR', () => {
  const point = officeWindowPoint({ x: 150, y: 180 }, { x: 50, y: 80, width: 200, height: 150 }, { width: 400, height: 300 });
  assert.deepEqual(point, { x: 200, y: 200 });
  // The actual buffer may be 800×600 at DPR2; it must never be passed as the logical window size.
  assert.throws(() => officeWindowPoint({ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 1 }, { width: 400, height: 300 }), /坐标/);
});
test('double and triple clicks survive zero PointerEvent detail without treating distant clicks as selection gestures', () => {
  const clicks = new OfficePointerClickTracker(), event = { timeStamp: 100, clientX: 40, clientY: 50, button: 0, detail: 0 };
  assert.equal(clicks.down(event), 1); assert.equal(clicks.down({ ...event, timeStamp: 300 }), 2); assert.equal(clicks.down({ ...event, timeStamp: 450 }), 3);
  assert.equal(clicks.down({ ...event, timeStamp: 500, clientX: 55 }), 1); assert.equal(clicks.down({ ...event, timeStamp: 600, button: 2 }), 1);
  clicks.reset(); assert.equal(clicks.down({ ...event, timeStamp: 700 }), 1);
});
test('native tile pixels convert BGRA and premultiplied alpha without tinting document content', () => {
  const tile = { key: 'tile', rectTwips: { x: 0, y: 0, width: 15, height: 15 }, width: 2, height: 1, pixelFormat: 'bgra' as const, alphaMode: 'premultiplied' as const, data: new Uint8Array([0, 0, 128, 128, 8, 4, 2, 0]) };
  assert.deepEqual([...officeTileRgba(tile)], [255, 0, 0, 128, 0, 0, 0, 0]);
  assert.throws(() => officeTileRgba({ ...tile, data: tile.data.subarray(0, 7) }), /长度/);
  assert.deepEqual([...officeTileRgba({ ...tile, alphaMode: 'straight', pixelFormat: 'rgba', data: new Uint8Array([19, 37, 81, 255, 240, 243, 246, 255]) })], [19, 37, 81, 255, 240, 243, 246, 255]);
});
test('paint retries classify only precise read version races, keeping unknown edit outcomes visible', () => {
  assert.equal(officeSurfaceStaleRead({ code: 'STALE_OFFICE_SURFACE_LAYOUT' }, 'document'), true);
  assert.equal(officeSurfaceStaleRead(new Error("Error invoking remote method 'agentviewer:command': Error: STALE_OFFICE_WINDOW: resized"), 'window'), true);
  assert.equal(officeSurfaceStaleRead(new Error('NATIVE_OUTCOME_UNKNOWN: edit outcome missing'), 'document'), false);
  assert.equal(officeSurfaceStaleRead(new Error('STALE_OFFICE_WINDOW_SUFFIX'), 'window'), false);
});
