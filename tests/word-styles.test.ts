import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { ViewerCore } from '../packages/document-core/src/index';
import { OfficeXmlAdapter } from '../packages/format-adapters/src/ooxml-editing';
import { ensureWordParagraphStyles, WORD_PARAGRAPH_STYLES } from '../packages/format-adapters/src/word-styles';
import { editOperationSchema, type EditOperation } from '../packages/contracts/src/index';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const O = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const parser = new DOMParser(), serializer = new XMLSerializer();
const proof = 'customXml/proof.xml';
const proofBytes = Buffer.from('<proof>原封保留用户部件</proof>');
const repository = () => ({ load: async <T>() => undefined as T | undefined, save: async (_value: unknown) => {} });
const parse = (xml: string) => parser.parseFromString(xml, 'text/xml');
const elements = (xml: string, ns: string, local: string) => Array.from(parse(xml).getElementsByTagNameNS(ns, local));
const attr = (element: Element, name: string) => element.getAttributeNS(W, name);
const styles = (xml: string) => elements(xml, W, 'style');
const relations = (target = 'styles.xml', extra = '', targetMode = '') => `<Relationships xmlns="${R}"><Relationship Id="rId7" Type="${O}/styles" Target="${target}"${targetMode ? ` TargetMode="${targetMode}"` : ''}/>${extra}</Relationships>`;
const styledParagraph = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;

function minimalWord(paragraphStyles: Array<string | undefined> = [undefined, undefined]) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/media/proof.png" ContentType="image/png"/></Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${R}"><Relationship Id="rId1" Type="${O}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${paragraphStyles.map((style, index) => styledParagraph('原文段落' + index, style)).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  zip.file(proof, proofBytes); zip.file('media/proof.png', new Uint8Array([1, 2, 3]));
  return zip;
}
async function setup(zip = minimalWord()) {
  const core = new ViewerCore(repository()); await core.initialize();
  const input = await zip.generateAsync({ type: 'uint8array' });
  const view = await core.openBytes('styles.docx', input, 'docx');
  let counter = 0;
  const edit = async (operation: EditOperation) => {
    const patch = core.prepare(view.documentId, core.getDocument(view.documentId).info.revision, operation);
    return core.commit(patch.id, 'styles-' + counter++);
  };
  return { core, view, input, edit, document: () => core.getDocument(view.documentId) };
}
async function checkedParts(zip: JSZip, path = 'word/styles.xml') {
  const definitions = await zip.file(path)!.async('string');
  const relationshipXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
  const typeXml = await zip.file('[Content_Types].xml')!.async('string');
  const styleRelations = elements(relationshipXml, R, 'Relationship').filter(relation => relation.getAttribute('Type') === O + '/styles');
  assert.equal(styleRelations.length, 1);
  const styleTypes = elements(typeXml, CT, 'Override').filter(type => decodeURIComponent(type.getAttribute('PartName')!) === '/' + path);
  assert.equal(styleTypes.length, 1); assert.equal(styleTypes[0].getAttribute('ContentType'), contentType);
  assert.deepEqual(await zip.file(proof)!.async('uint8array'), new Uint8Array(proofBytes));
  return { definitions, relationshipXml, typeXml, styleRelations };
}

test('missing styles are real package parts; same heading repair saves/reopens and target undo restores original bytes', async () => {
  const t = await setup(minimalWord(['Heading1', 'Heading2', 'Heading3']));
  const first = t.document().info.model.blocks![0], originalTexts = t.document().info.model.blocks!.map(block => block.text);
  const receipt = await t.edit({ kind: 'word.setParagraphFormat', blockId: first.id, style: 'Heading1' });
  const output = await JSZip.loadAsync(t.document().bytes);
  const parts = await checkedParts(output);
  assert.deepEqual(styles(parts.definitions).map(style => attr(style, 'styleId')), [...WORD_PARAGRAPH_STYLES]);
  const normal = styles(parts.definitions).find(style => attr(style, 'styleId') === 'Normal')!;
  assert.equal(attr(normal, 'default'), '1');
  for (const [index, id] of ['Heading1', 'Heading2', 'Heading3'].entries()) {
    const style = styles(parts.definitions).find(style => attr(style, 'styleId') === id)!;
    assert.equal(attr(style, 'type'), 'paragraph');
    assert.equal(attr(style.getElementsByTagNameNS(W, 'basedOn')[0], 'val'), 'Normal');
    assert.equal(attr(style.getElementsByTagNameNS(W, 'outlineLvl')[0], 'val'), String(index));
    assert.ok(style.getElementsByTagNameNS(W, 'b').length);
  }
  assert.deepEqual(t.document().info.model.blocks!.map(block => block.text), originalTexts);
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-word-styles-')), path = join(directory, 'saved.docx');
  await t.core.save(t.view.documentId, path);
  const reopened = new ViewerCore(repository()); await reopened.initialize();
  const reopenedView = await reopened.openFile(path);
  assert.deepEqual(reopened.getDocument(reopenedView.documentId).info.model.blocks!.map(block => block.style), ['Heading1', 'Heading2', 'Heading3']);
  await checkedParts(await JSZip.loadAsync(await readFile(path)));
  await t.core.undo(receipt.transactionId); assert.deepEqual(t.document().bytes, t.input);
  assert.equal((await JSZip.loadAsync(t.document().bytes)).file('word/styles.xml'), null);
  await t.edit({ kind: 'word.setParagraphFormat', blockId: first.id, style: 'Heading1' });
  const beforeRepeat = await checkedParts(await JSZip.loadAsync(t.document().bytes));
  await t.edit({ kind: 'word.setParagraphFormat', blockId: first.id, style: 'Heading1' });
  assert.deepEqual(await checkedParts(await JSZip.loadAsync(t.document().bytes)), beforeRepeat, 'valid styles/relationships/content types are not rewritten on repeated application');
});

test('paragraph and table insertions create Normal and requested heading definitions; plain edits do not touch styles', async () => {
  const t = await setup(), first = t.document().info.model.blocks![0].id;
  await t.edit({ kind: 'word.setBlock', blockId: first, text: '只改正文' });
  await t.edit({ kind: 'word.setParagraphFormat', blockId: first, alignment: 'center' });
  assert.equal((await JSZip.loadAsync(t.document().bytes)).file('word/styles.xml'), null);
  await t.edit({ kind: 'word.insertParagraph', afterBlockId: first, text: '新增小节', style: 'Heading2' });
  const parts = await checkedParts(await JSZip.loadAsync(t.document().bytes));
  assert.deepEqual(styles(parts.definitions).map(style => attr(style, 'styleId')), ['Normal', 'Heading2']);
  const tableOnly = await setup(), block = tableOnly.document().info.model.blocks![0].id;
  await tableOnly.edit({ kind: 'word.insertTable', afterBlockId: block, rows: [['甲', '乙']] });
  const tableParts = await checkedParts(await JSZip.loadAsync(tableOnly.document().bytes));
  assert.deepEqual(styles(tableParts.definitions).map(style => attr(style, 'styleId')), ['Normal']);
  assert.equal(tableOnly.document().info.model.blocks!.filter(block => block.tableId).length, 2);
  const defaultInsert = await setup();
  await defaultInsert.edit(editOperationSchema.parse({ kind: 'word.insertParagraph', afterBlockId: defaultInsert.document().info.model.blocks![0].id, text: '默认正文' }));
  assert.deepEqual(styles((await checkedParts(await JSZip.loadAsync(defaultInsert.document().bytes))).definitions).map(style => attr(style, 'styleId')), ['Normal']);
});

test('alternate-prefix custom styles and custom relationship targets remain authoritative', async () => {
  const zip = minimalWord(['Heading1', 'Heading2']);
  const customStyles = `<s:styles xmlns:s="${W}"><s:docDefaults><s:rPrDefault><s:rPr><s:color s:val="123456"/></s:rPr></s:rPrDefault></s:docDefaults><s:style s:type="paragraph" s:styleId="Normal" s:default="1"><s:name s:val="用户正文"/><s:rPr><s:rFonts s:ascii="User Font"/><s:color s:val="AA1122"/></s:rPr></s:style><s:style s:type="paragraph" s:styleId="Heading1" s:customStyle="1"><s:name s:val="用户章标题"/><s:basedOn s:val="Normal"/><s:rPr><s:color s:val="BB2244"/></s:rPr></s:style></s:styles>`;
  zip.file('word/custom-styles.xml', customStyles);
  const extraRelation = `<Relationship Id="rId1" Type="${O}/settings" Target="settings.xml"/>`;
  zip.file('word/_rels/document.xml.rels', relations('custom-styles.xml', extraRelation));
  zip.file('word/settings.xml', `<w:settings xmlns:w="${W}"/>`);
  const beforeRelations = await zip.file('word/_rels/document.xml.rels')!.async('string');
  const beforeType = await zip.file('[Content_Types].xml')!.async('string');
  zip.file('[Content_Types].xml', beforeType.replace('</Types>', `<Override PartName="/word/custom-styles.xml" ContentType="${contentType}"/></Types>`));
  const originalDefinitions = styles(customStyles).map(style => serializer.serializeToString(style));
  const t = await setup(zip); await t.edit({ kind: 'word.setParagraphFormat', blockId: t.document().info.model.blocks![1].id, style: 'Heading2' });
  const output = await JSZip.loadAsync(t.document().bytes), parts = await checkedParts(output, 'word/custom-styles.xml');
  assert.equal(output.file('word/styles.xml'), null);
  assert.equal(parts.relationshipXml, beforeRelations, 'existing relationships retain bytes');
  assert.equal(parts.typeXml, await zip.file('[Content_Types].xml')!.async('string'), 'valid existing content type retains bytes');
  assert.deepEqual(styles(parts.definitions).slice(0, 2).map(style => serializer.serializeToString(style)), originalDefinitions);
  assert.equal(styles(parts.definitions).filter(style => attr(style, 'styleId') === 'Heading1').length, 1);
  assert.equal(await output.file('word/settings.xml')!.async('string'), await zip.file('word/settings.xml')!.async('string'));
});

test('orphan styles are adopted; custom default is preserved and Normal does not become a second default', async () => {
  const zip = minimalWord();
  const userStyle = `<w:style w:type="paragraph" w:default="1" w:styleId="BodyCustom"><w:name w:val="保留默认正文"/></w:style>`;
  zip.file('word/styles.xml', `<w:styles xmlns:w="${W}">${userStyle}</w:styles>`);
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="${R}"><Relationship Id="rId1" Type="${O}/settings" Target="settings.xml"/></Relationships>`);
  await ensureWordParagraphStyles(zip, ['Heading3']);
  const parts = await checkedParts(zip), definitions = styles(parts.definitions);
  assert.equal(definitions.find(style => attr(style, 'styleId') === 'Normal')!.hasAttributeNS(W, 'default'), false);
  assert.equal(definitions.filter(style => attr(style, 'default') === '1').length, 1);
  assert.equal(attr(definitions.find(style => attr(style, 'styleId') === 'BodyCustom')!, 'default'), '1');
  assert.equal(parts.styleRelations[0].getAttribute('Id'), 'rId2');
  assert.equal(elements(parts.relationshipXml, R, 'Relationship').filter(relation => relation.getAttribute('Type') === O + '/settings').length, 1);
  await ensureWordParagraphStyles(zip, ['Normal']);
  assert.deepEqual(await checkedParts(zip), parts);
});

test('unsafe style packages fail atomically without changing bytes, revisions, receipts, or existing ZIP parts', async () => {
  const cases: Array<[string, (zip: JSZip) => void]> = [
    ['wrong style type', zip => { zip.file('word/styles.xml', `<w:styles xmlns:w="${W}"><w:style w:type="character" w:styleId="Heading1"/></w:styles>`); }],
    ['duplicate style id', zip => { zip.file('word/styles.xml', `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"/><w:style w:type="paragraph" w:styleId="Heading1"/></w:styles>`); }],
    ['external styles', zip => { zip.file('word/_rels/document.xml.rels', relations('https://example.invalid/styles.xml', '', 'External')); }],
    ['missing related part', zip => { zip.file('word/_rels/document.xml.rels', relations('missing.xml')); }],
    ['escaping target', zip => { zip.file('word/_rels/document.xml.rels', relations('../../styles.xml')); }],
    ['multiple relationships', zip => { zip.file('word/styles.xml', `<w:styles xmlns:w="${W}"/>`); zip.file('word/_rels/document.xml.rels', relations('styles.xml', `<Relationship Id="rId8" Type="${O}/styles" Target="styles.xml"/>`)); }],
    ['invalid styles root', zip => { zip.file('word/styles.xml', `<w:document xmlns:w="${W}"/>`); }],
    ['conflicting content type', zip => { zip.file('[Content_Types].xml', `<Types xmlns="${CT}"><Override PartName="/word/styles.xml" ContentType="application/xml"/></Types>`); }],
  ];
  for (const [label, corrupt] of cases) {
    const zip = minimalWord(); corrupt(zip);
    const zipBefore = new Map(await Promise.all(Object.keys(zip.files).filter(path => !zip.files[path].dir).map(async path => [path, await zip.file(path)!.async('uint8array')] as const)));
    await assert.rejects(ensureWordParagraphStyles(zip, ['Heading1']), /Word|XML|样式|部件/, label);
    assert.deepEqual(Object.keys(zip.files).filter(path => !zip.files[path].dir).sort(), [...zipBefore.keys()].sort(), label);
    for (const [path, bytes] of zipBefore) assert.deepEqual(await zip.file(path)!.async('uint8array'), bytes, label + ':' + path);
    const t = await setup(zip), before = t.document().bytes.slice(), revision = t.document().info.revision;
    await assert.rejects(t.edit({ kind: 'word.setParagraphFormat', blockId: t.document().info.model.blocks![0].id, style: 'Heading1' }), /Word|XML|样式|部件/, label);
    assert.deepEqual(t.document().bytes, before, label); assert.equal(t.document().info.revision, revision, label);
    assert.equal(t.core.receipts.size, 0, label); assert.equal(t.core.transactions.size, 0, label);
  }
});

test('helper creates reusable blank-template styles without introducing body paragraphs', async () => {
  const zip = minimalWord(), original = await zip.file('word/document.xml')!.async('string');
  await ensureWordParagraphStyles(zip, ['Normal']);
  assert.equal(await zip.file('word/document.xml')!.async('string'), original);
  const parts = await checkedParts(zip);
  assert.deepEqual(styles(parts.definitions).map(style => attr(style, 'styleId')), ['Normal']);
  const stylesBefore = parts.definitions;
  await ensureWordParagraphStyles(zip, []); assert.equal(await zip.file('word/styles.xml')!.async('string'), stylesBefore);
});

test('Word capabilities, preview, and committed warnings never contain PowerPoint-only limitations', async () => {
  const adapter = new OfficeXmlAdapter();
  const wordWarnings = adapter.capabilities('docx').limitations;
  assert.ok(wordWarnings.length); assert.equal(wordWarnings.some(warning => /幻灯片|母版|动画|自定义放映/.test(warning)), false);
  assert.ok(adapter.capabilities('pptx').limitations.some(warning => /幻灯片删除/.test(warning)));
  const t = await setup(), operation: EditOperation = { kind: 'word.setParagraphFormat', blockId: t.document().info.model.blocks![0].id, style: 'Heading1' };
  assert.deepEqual(adapter.preview(t.document().info.model, operation).warnings, wordWarnings);
  await t.edit(operation); assert.deepEqual(t.document().info.warnings, wordWarnings);
});
