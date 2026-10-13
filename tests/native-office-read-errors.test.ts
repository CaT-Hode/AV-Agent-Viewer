import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeOfficeReadMessages, updateNativeOfficeReadErrors, type NativeOfficeReadErrors } from '../apps/desktop/src/renderer/lib/native-office-read-errors';

const keys = { poll: 'view-A', catalog: 'session-A', status: 'selection-A', navigation: 'revision-A' };

test('an expired pre-binding poll shows initialization, then an owned successful poll clears its old failure', () => {
  const cause = Object.assign(new Error('会话已关闭'), { code: 'NATIVE_SESSION_EXPIRED' });
  const failed = updateNativeOfficeReadErrors({}, { kind: 'poll', key: keys.poll, outcome: 'failure', cause });
  assert.deepEqual(nativeOfficeReadMessages(failed, keys, true), []);
  assert.deepEqual(nativeOfficeReadMessages(failed, keys, false), ['会话已关闭'], 'a lost ready session remains a real read error');
  const recovered = updateNativeOfficeReadErrors(failed, { kind: 'poll', key: keys.poll, outcome: 'success' });
  assert.deepEqual(nativeOfficeReadMessages(recovered, keys, false), []);
});

test('reading one capability cannot clear another failed read or a pending edit error', () => {
  const editError = '修改失败，原文未应用';
  let reads: NativeOfficeReadErrors = {};
  reads = updateNativeOfficeReadErrors(reads, { kind: 'catalog', key: keys.catalog, outcome: 'failure', cause: new Error('目录加载失败') });
  reads = updateNativeOfficeReadErrors(reads, { kind: 'status', key: keys.status, outcome: 'failure', cause: new Error('可用状态读取失败') });
  reads = updateNativeOfficeReadErrors(reads, { kind: 'poll', key: keys.poll, outcome: 'success' });
  reads = updateNativeOfficeReadErrors(reads, { kind: 'catalog', key: keys.catalog, outcome: 'success' });
  assert.deepEqual([editError, ...nativeOfficeReadMessages(reads, keys, false)], ['修改失败，原文未应用', '可用状态读取失败']);
  reads = updateNativeOfficeReadErrors(reads, { kind: 'status', key: keys.status, outcome: 'success' });
  assert.deepEqual([editError, ...nativeOfficeReadMessages(reads, keys, false)], ['修改失败，原文未应用']);
});

test('old view, engine, document revision or selection failures cannot surface in new request scopes', () => {
  let reads: NativeOfficeReadErrors = {};
  for (const kind of ['poll', 'catalog', 'status', 'navigation'] as const) reads = updateNativeOfficeReadErrors(reads, { kind, key: keys[kind], outcome: 'failure', cause: new Error(kind + '旧请求失败') });
  const fresh = { poll: 'view-B', catalog: 'session-B', status: 'selection-B', navigation: 'revision-B' };
  assert.deepEqual(nativeOfficeReadMessages(reads, fresh, false), []);
  reads = updateNativeOfficeReadErrors(reads, { kind: 'status', key: fresh.status, outcome: 'failure', cause: new Error('新的选区读取失败') });
  const lateOldSuccess = updateNativeOfficeReadErrors(reads, { kind: 'status', key: keys.status, outcome: 'success' });
  assert.equal(lateOldSuccess, reads);
  assert.deepEqual(nativeOfficeReadMessages(lateOldSuccess, fresh, false), ['新的选区读取失败']);
});

test('ordinary initialization failures remain visible and transport-formatted expiration is recognized', () => {
  const transportError = updateNativeOfficeReadErrors({}, { kind: 'poll', key: keys.poll, outcome: 'failure', cause: new Error('NATIVE_SESSION_EXPIRED: binding尚未建立') });
  assert.deepEqual(nativeOfficeReadMessages(transportError, keys, true), []);
  const ipcError = updateNativeOfficeReadErrors({}, { kind: 'poll', key: keys.poll, outcome: 'failure', cause: new Error("Error invoking remote method 'agentviewer:command': Error: 原生Office会话已关闭或不可用，请重新打开。") });
  assert.deepEqual(nativeOfficeReadMessages(ipcError, keys, true), [], 'actual Electron IPC omits the custom error code');
  const unavailable = updateNativeOfficeReadErrors({}, { kind: 'poll', key: keys.poll, outcome: 'failure', cause: new Error('本地服务连接失败') });
  assert.deepEqual(nativeOfficeReadMessages(unavailable, keys, true), ['本地服务连接失败']);
});
