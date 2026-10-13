import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clampReaderPanelWidth, createReaderPanelLayoutStore, DEFAULT_READER_PANEL_LAYOUT, parseReaderPanelLayout, readerPanelDragWidth, readerPanelKeyWidth, readerPanelLimits, READER_PANEL_LAYOUT_KEY } from '../apps/desktop/src/renderer/lib/reader-panel-layout';
import { SettingsService, settingsRegistry } from '../packages/settings/src/index';

test('edge dragging uses global pointer displacement in opposite directions and clamps to the unchanged reading canvas', () => {
  const limits = readerPanelLimits('left', 1000), left = { side: 'left' as const, pointerId: 3, startX: 900, startWidth: 248 };
  assert.equal(readerPanelDragWidth(left, 952, limits), 300);
  assert.equal(readerPanelDragWidth(left, 480, limits), 180);
  assert.equal(readerPanelDragWidth(left, 1600, limits), 484);
  const right = { side: 'right' as const, pointerId: 4, startX: 1200, startWidth: 380 };
  assert.equal(readerPanelDragWidth(right, 1130, readerPanelLimits('right', 1000)), 450);
  assert.equal(readerPanelDragWidth(right, 1480, readerPanelLimits('right', 1000)), 280);
  assert.equal(readerPanelDragWidth(left, NaN, limits), 248, 'invalid pointer samples retain the start width');
  assert.deepEqual(readerPanelLimits('left', 1920), { min: 180, max: 620 });
  assert.deepEqual(readerPanelLimits('right', 1920), { min: 280, max: 720 });
  assert.equal(clampReaderPanelWidth('left', 620, readerPanelLimits('left', 800)), 384);
  assert.equal(clampReaderPanelWidth('left', 620, readerPanelLimits('left', 1920)), 620, 'a small viewport does not destroy the persisted wider layout');
});

test('separator keyboard arrows move the physical inner edge, with large steps and accessible endpoints', () => {
  const left = readerPanelLimits('left', 1000), right = readerPanelLimits('right', 1000);
  assert.equal(readerPanelKeyWidth('left', 248, 'ArrowRight', false, left), 256);
  assert.equal(readerPanelKeyWidth('right', 380, 'ArrowRight', false, right), 372);
  assert.equal(readerPanelKeyWidth('right', 380, 'ArrowLeft', true, right), 412);
  assert.equal(readerPanelKeyWidth('left', 248, 'Home', false, left), 180);
  assert.equal(readerPanelKeyWidth('right', 380, 'End', false, right), 484);
  assert.equal(readerPanelKeyWidth('left', 248, 'Escape', false, left), undefined, 'Escape is handled as cancellation, never as a width commit');
});

test('versioned panel layout validates damaged values and is independent from appearance preferences', () => {
  for (const raw of [null, '', 'invalid', '[]', '{"schemaVersion":2,"leftWidth":400}', '{"schemaVersion":1,"leftWidth":"420"}']) assert.deepEqual(parseReaderPanelLayout(raw), DEFAULT_READER_PANEL_LAYOUT);
  assert.deepEqual(parseReaderPanelLayout('{"schemaVersion":1,"leftWidth":800,"rightWidth":200}'), { schemaVersion: 1, leftWidth: 620, rightWidth: 280 });
  const data = new Map<string, string>(), writes: string[] = [];
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); writes.push(key); } };
  const store = createReaderPanelLayoutStore(storage); const original = store.getSnapshot(); let notices = 0;
  const stop = store.subscribe(() => { notices++; });
  store.setWidth('left', 248); assert.strictEqual(store.getSnapshot(), original); assert.equal(writes.length, 0);
  store.setWidth('left', 333); assert.equal(writes.length, 1); assert.equal(notices, 1);
  assert.deepEqual(writes, [READER_PANEL_LAYOUT_KEY]); assert.equal(store.getSnapshot().rightWidth, 380);
  assert.deepEqual(createReaderPanelLayoutStore(storage).getSnapshot(), { schemaVersion: 1, leftWidth: 333, rightWidth: 380 });
  store.receive(JSON.stringify({ schemaVersion: 1, leftWidth: 420, rightWidth: 560 }));
  assert.equal(notices, 2); assert.equal(writes.length, 1, 'cross-window updates do not echo back to storage');
  const shared = store.getSnapshot(); store.receive(JSON.stringify(shared)); assert.strictEqual(store.getSnapshot(), shared); assert.equal(notices, 2);
  stop(); store.setWidth('right', 400); assert.equal(notices, 2);
});

test('blocked storage does not break resizing or subscription cleanup', () => {
  const store = createReaderPanelLayoutStore({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
  let updates = 0; const stop = store.subscribe(() => { updates++; });
  store.setWidth('right', 480); assert.equal(store.getSnapshot().rightWidth, 480); assert.equal(updates, 1);
  stop(); store.setWidth('right', 500); assert.equal(updates, 1);
});

test('old preference files load safely without exposing or writing obsolete panel width settings', async () => {
  assert.ok(!settingsRegistry.some(setting => ['appearance.leftWidth', 'appearance.rightWidth'].includes(setting.id)));
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-panel-layout-unit-')), path = join(directory, 'settings.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, revision: 8, values: { 'appearance.leftWidth': 333, 'appearance.rightWidth': 540, 'appearance.theme': 'dark' } }));
  const preferences = new SettingsService(path); await preferences.load();
  assert.equal(preferences.get('appearance.theme'), 'dark'); assert.equal(preferences.snapshot().revision, 8);
  for (const id of ['appearance.leftWidth', 'appearance.rightWidth']) { assert.ok(!(id in preferences.snapshot().values)); await assert.rejects(preferences.set(id, 300), /未知设置/); }
  await preferences.set('appearance.theme', 'light');
  const saved = JSON.parse(await readFile(path, 'utf8')); assert.equal(saved.values['appearance.theme'], 'light');
  assert.ok(!('appearance.leftWidth' in saved.values) && !('appearance.rightWidth' in saved.values));
});
