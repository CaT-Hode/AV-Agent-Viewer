import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsService, settingsAvailability } from '../packages/settings/src/index';
import { documentPaperAppearance, normalizeDocumentPaperColor } from '../packages/settings/src/document-paper';
import JSZip from 'jszip';
import { OfficeXmlAdapter } from '../packages/format-adapters/src/ooxml-editing';

test('paper colors accept bounded hex values and choose readable automatic ink', () => {
  assert.equal(normalizeDocumentPaperColor(' #AbC '),'#aabbcc');
  assert.equal(normalizeDocumentPaperColor('#FAF0E8'),'#faf0e8');
  for (const value of ['red','#abcd','#12345678','url(secret)','var(--x)',null,true]) assert.equal(normalizeDocumentPaperColor(value),undefined);
  assert.equal(documentPaperAppearance(undefined).color,'#ffffff');
  assert.equal(documentPaperAppearance('#ffffff').ink,'#24303b');
  assert.equal(documentPaperAppearance('#000000').ink,'#f7f9fb');
  assert.notEqual(documentPaperAppearance('#ffffff').ink,documentPaperAppearance('#000000').ink);
});

test('paper preference is validated, persisted and undone independently of surrounding background', async () => {
  const path = join(await mkdtemp(join(tmpdir(),'agentviewer-paper-preference-')),'settings.json');
  const service = new SettingsService(path); await service.load();
  assert.equal(service.get('appearance.documentPaperColor'),'#ffffff'); assert.equal(settingsAvailability('appearance.documentPaperColor').available,true);
  await service.set('appearance.documentBackground','spectrum'); await service.set('appearance.documentPaperColor','#EeD');
  const beforeInvalid = await readFile(path,'utf8');
  await assert.rejects(service.set('appearance.documentPaperColor','rgba(0,0,0,.5)'),/纸面颜色/);
  assert.equal(await readFile(path,'utf8'),beforeInvalid,'invalid color never changes persisted preferences');
  const restored = new SettingsService(path); await restored.load(); assert.equal(restored.get('appearance.documentPaperColor'),'#eeeedd'); assert.equal(restored.get('appearance.documentBackground'),'spectrum');
  await service.undo(); assert.equal(service.get('appearance.documentPaperColor'),'#ffffff'); assert.equal(service.get('appearance.documentBackground'),'spectrum');
});

test('Word explicitly authored page fill remains separate from the paper preference', async () => {
  const zip = new JSZip();
  zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:background w:color="376D95"/><w:body><w:p><w:r><w:t>Keep authored page color</w:t></w:r></w:p></w:body></w:document>');
  const bytes = await zip.generateAsync({type:'uint8array'}), before = bytes.slice();
  const model = await new OfficeXmlAdapter().open(bytes,'docx');
  assert.equal(model.pageBackground,'376D95'); assert.deepEqual(bytes,before,'reading the authored color never rewrites the package');
});
