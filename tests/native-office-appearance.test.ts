import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeOfficeAppearance, validateNativeOfficeAppearance } from '../packages/office-runtime/src/appearance';

test('Office display follows the explicit application theme rather than the Windows theme', () => {
  assert.deepEqual(nativeOfficeAppearance('light', 'paper', true), { theme: 'light', canvasColor: 0xf7f5f2 });
  assert.deepEqual(nativeOfficeAppearance('dark', 'paper', false), { theme: 'dark', canvasColor: 0x262626 });
  assert.equal(nativeOfficeAppearance('system', 'mist', true).theme, 'dark');
  assert.deepEqual(nativeOfficeAppearance('system', 'mist', false), { theme: 'light', canvasColor: 0xf6f8f8 });
});

test('native canvas preferences reject malformed colours and never accept document or path data', () => {
  for (const canvasColor of [-1, 0x1000000, 1.5, NaN, '#fff']) assert.throws(() => validateNativeOfficeAppearance({ theme: 'light', canvasColor } as any));
  assert.throws(() => validateNativeOfficeAppearance({ theme: 'system', canvasColor: 0xffffff } as any));
  assert.deepEqual(validateNativeOfficeAppearance({ theme: 'light', canvasColor: 0xffffff, path: 'ignored', pageColor: 'ignored' } as any), { theme: 'light', canvasColor: 0xffffff });
});
