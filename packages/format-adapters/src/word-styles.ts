import type JSZip from 'jszip';
import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { posix } from 'node:path';
import { ViewerError } from '../../contracts/src/index';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const STYLES_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const STYLES_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const RELATIONSHIPS_PATH = 'word/_rels/document.xml.rels';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const parser = new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new ViewerError('INVALID_DOCUMENT', message); } });
const serializer = new XMLSerializer();

export const WORD_PARAGRAPH_STYLES = ['Normal', 'Heading1', 'Heading2', 'Heading3'] as const;
export type WordParagraphStyle = typeof WORD_PARAGRAPH_STYLES[number];

function invalid(message: string): never { throw new ViewerError('INVALID_DOCUMENT', message); }
function directElements(node: Element, ns: string, name: string): Element[] {
  return Array.from(node.childNodes).filter(child => child.nodeType === 1 && child.namespaceURI === ns && child.localName === name) as Element[];
}
function wordAttribute(node: Element, name: string) { return node.getAttributeNS(W, name) ?? node.getAttribute('w:' + name); }
function parse(xml: string, ns: string, root: string, path: string): Document {
  const doc = parser.parseFromString(xml, 'text/xml');
  if (doc.documentElement?.namespaceURI !== ns || doc.documentElement.localName !== root) invalid(`无效的 Word 样式部件：${path}`);
  return doc;
}
async function load(zip: JSZip, path: string, ns: string, root: string) {
  const file = zip.file(path);
  if (!file) invalid(`缺少 Word 样式部件：${path}`);
  return parse(await file.async('string'), ns, root, path);
}

// Relationship targets are package URIs, never filesystem paths or external URLs.
function internalPart(target: string, baseDirectory: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return invalid('Word 样式关系目标编码无效。'); }
  if (!decoded || /[\\\u0000-\u001f\u007f:?#]/.test(decoded)) invalid('Word 样式关系必须指向安全的包内 XML 部件。');
  const parts = decoded.startsWith('/') ? [] : baseDirectory.split('/').filter(Boolean);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) invalid('Word 样式关系不能越过文档包根目录。'); parts.pop(); }
    else parts.push(part);
  }
  const path = parts.join('/');
  if (!path || !path.endsWith('.xml') || path === 'word/document.xml' || path === '[Content_Types].xml') invalid('Word 样式关系目标不是独立 XML 样式部件。');
  return path;
}
function appendWord(parent: Element, name: string, attributes: Record<string, string> = {}) {
  const element = parent.ownerDocument!.createElementNS(W, 'w:' + name);
  for (const [attribute, value] of Object.entries(attributes)) element.setAttributeNS(W, 'w:' + attribute, value);
  parent.appendChild(element);
  return element;
}
function createStyle(root: Element, id: WordParagraphStyle, useDefault: boolean) {
  const style = appendWord(root, 'style', { type: 'paragraph', styleId: id });
  if (id === 'Normal') {
    if (useDefault) style.setAttributeNS(W, 'w:default', '1');
    appendWord(style, 'name', { val: 'Normal' });
    appendWord(style, 'qFormat');
    return;
  }
  const level = Number(id.slice(-1)) - 1;
  appendWord(style, 'name', { val: 'heading ' + (level + 1) });
  appendWord(style, 'basedOn', { val: 'Normal' });
  appendWord(style, 'next', { val: 'Normal' });
  appendWord(style, 'uiPriority', { val: String(level + 1) });
  appendWord(style, 'qFormat');
  const paragraph = appendWord(style, 'pPr');
  appendWord(paragraph, 'keepNext'); appendWord(paragraph, 'keepLines');
  appendWord(paragraph, 'spacing', { before: '240', after: '120' });
  appendWord(paragraph, 'outlineLvl', { val: String(level) });
  const run = appendWord(style, 'rPr');
  appendWord(run, 'b'); appendWord(run, 'bCs');
  const size = String([40, 32, 28][level]);
  appendWord(run, 'sz', { val: size }); appendWord(run, 'szCs', { val: size });
}

/** Add only missing built-in paragraph styles; existing user definitions remain authoritative. */
export async function ensureWordParagraphStyles(zip: JSZip, styleIds: Iterable<WordParagraphStyle>): Promise<void> {
  const requested = new Set(styleIds);
  if (!requested.size) return;
  if ([...requested].some(id => !WORD_PARAGRAPH_STYLES.includes(id))) invalid('不支持的 Word 内置段落样式。');
  requested.add('Normal');
  if (!zip.file('word/document.xml')) invalid('缺少 Word 正文部件。');

  const relationships = zip.file(RELATIONSHIPS_PATH)
    ? await load(zip, RELATIONSHIPS_PATH, R, 'Relationships')
    : parse(`<Relationships xmlns="${R}"/>`, R, 'Relationships', RELATIONSHIPS_PATH);
  const relations = directElements(relationships.documentElement!, R, 'Relationship');
  const styleRelations = relations.filter(relation => relation.getAttribute('Type') === STYLES_RELATIONSHIP);
  if (styleRelations.length > 1) invalid('Word 文档包含多个样式关系，不能安全选择样式部件。');
  const relation = styleRelations[0];
  if (relation && relation.getAttribute('TargetMode') && relation.getAttribute('TargetMode') !== 'Internal') invalid('Word 样式不能从外部关系读取。');
  const path = relation ? internalPart(relation.getAttribute('Target') ?? '', 'word') : 'word/styles.xml';
  if (relation && !zip.file(path)) invalid(`Word 样式关系指向缺失部件：${path}`);
  const styles = zip.file(path)
    ? await load(zip, path, W, 'styles')
    : parse(`<w:styles xmlns:w="${W}"/>`, W, 'styles', path);
  const definitions = directElements(styles.documentElement!, W, 'style');
  for (const id of requested) {
    const existing = definitions.filter(style => wordAttribute(style, 'styleId') === id);
    if (existing.length > 1 || existing.length === 1 && wordAttribute(existing[0], 'type') !== 'paragraph') invalid(`Word 样式 ${id} 不是唯一的段落样式，不能安全补齐。`);
  }
  const contentTypes = await load(zip, '[Content_Types].xml', CT, 'Types');
  const matchingTypes = directElements(contentTypes.documentElement!, CT, 'Override').filter(override => {
    const name = override.getAttribute('PartName');
    try { return !!name?.startsWith('/') && decodeURIComponent(name) === '/' + path; } catch { return false; }
  });
  if (matchingTypes.length > 1 || matchingTypes.length === 1 && matchingTypes[0].getAttribute('ContentType') !== STYLES_CONTENT_TYPE) invalid('Word 样式部件的内容类型存在冲突。');

  // Stage every validation before mutating any ZIP entry, so callers may safely reuse it on failure.
  let changedStyles = false;
  const hasDefault = definitions.some(style => wordAttribute(style, 'type') === 'paragraph' && ['1', 'true', 'on'].includes(wordAttribute(style, 'default') ?? ''));
  for (const id of WORD_PARAGRAPH_STYLES) {
    if (requested.has(id) && !definitions.some(style => wordAttribute(style, 'styleId') === id)) {
      createStyle(styles.documentElement!, id, id === 'Normal' && !hasDefault);
      changedStyles = true;
    }
  }
  if (!relation) {
    const ids = new Set(relations.map(item => item.getAttribute('Id')));
    let index = 1; while (ids.has('rId' + index)) index++;
    const added = relationships.createElementNS(R, 'Relationship');
    added.setAttribute('Id', 'rId' + index); added.setAttribute('Type', STYLES_RELATIONSHIP);
    added.setAttribute('Target', posix.relative('word', path)); relationships.documentElement!.appendChild(added);
  }
  if (!matchingTypes.length) {
    const added = contentTypes.createElementNS(CT, 'Override');
    added.setAttribute('PartName', '/' + path.split('/').map(encodeURIComponent).join('/')); added.setAttribute('ContentType', STYLES_CONTENT_TYPE);
    contentTypes.documentElement!.appendChild(added);
  }
  if (changedStyles) {
    if (!styles.documentElement!.lookupNamespaceURI('w')) styles.documentElement!.setAttributeNS(XMLNS, 'xmlns:w', W);
    zip.file(path, serializer.serializeToString(styles));
  }
  if (!relation) zip.file(RELATIONSHIPS_PATH, serializer.serializeToString(relationships));
  if (!matchingTypes.length) zip.file('[Content_Types].xml', serializer.serializeToString(contentTypes));
}
