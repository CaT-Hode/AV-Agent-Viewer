import test from 'node:test';
import assert from 'node:assert/strict';
import { readerPanelDestination, validReaderPanelRect } from '../apps/desktop/src/main/reader-panel-policy';

test('native sidebar only opens an exact same-origin route bound to its view and side', () => {
  const root = 'http://127.0.0.1:3211/', name = 'agentviewer-reader-panel-left-view-1';
  assert.deepEqual(readerPanelDestination(root + '#/reader-panel?side=left&view=view-1', root, name), { side: 'left', viewId: 'view-1' });
  for (const url of ['https://example.org/#/reader-panel?side=left&view=view-1', root + 'fixtures/interaction.html#/reader-panel?side=left&view=view-1', root + '?document=other#/reader-panel?side=left&view=view-1', root + '#/reader-panel?side=left&view=view-1&command=save', root + '#/reader-panel?side=left&view=%zz', root + '#/reader-panel?side=right&view=view-1']) assert.equal(readerPanelDestination(url, root, name), undefined);
  assert.equal(readerPanelDestination(root + '#/reader-panel?side=left&view=view-2', root, name), undefined);
});
test('native sidebars reject unbounded, nonfinite and outside-window geometry', () => {
  const viewport = { width: 1440, height: 900 }, box = { x: 73, y: 83, width: 248, height: 800 };
  assert.ok(validReaderPanelRect(box, viewport));
  for (const changes of [{ x: -100 }, { x: 1400 }, { y: 901 }, { width: Infinity }, { height: NaN }, { width: 1 }, { height: -1 }]) assert.equal(validReaderPanelRect({ ...box, ...changes }, viewport), false);
});
