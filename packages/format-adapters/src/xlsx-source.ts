import JSZip from 'jszip';

/** One open attempt owns this package and its decoded XML. Original entry
 * objects stay distinct from the private preview replacements. Never retain
 * this scope in a document/model or share it between calls or byte buffers. */
export interface XlsxSource {
  readonly zip: JSZip;
  readonly entries: readonly (readonly [string, JSZip.JSZipObject])[];
  xml(path: string): Promise<string>;
  xmlFeature(path: string): Promise<boolean>;
  release(): void;
}

export async function openXlsxSource(bytes: Uint8Array): Promise<XlsxSource> {
  const zip = await JSZip.loadAsync(bytes), entries = Object.entries(zip.files);
  const originals = new Map(entries), inspected = new Map<string, boolean>();
  let decoded: { path: string; value: Promise<string> } | undefined;
  let released = false;
  const xml = (path: string) => {
    if (released) throw new Error('XLSX source scope has been released.');
    if (decoded?.path === path) return decoded.value;
    const file = originals.get(path);
    if (!file || file.dir) throw new Error('XLSX source XML is unavailable.');
    const value = file.async('string').then(text => {
      // Keep only classification metadata across files, not a string for every
      // worksheet. The preview may replace zip.files[path] after this read.
      if (!released && /^xl\/(worksheets\/sheet\d+|workbook|styles)\.xml$/.test(path)) inspected.set(path, xmlFeature(path, text));
      return text;
    });
    decoded = { path, value }; return value;
  };
  return {
    zip, entries,
    xml,
    async xmlFeature(path) {
      if (released) throw new Error('XLSX source scope has been released.');
      if (!inspected.has(path)) await xml(path);
      return inspected.get(path) ?? false;
    },
    release() { released = true; decoded = undefined; inspected.clear(); originals.clear(); entries.length = 0; },
  };
}

function xmlFeature(path: string, source: string) {
  if (path === 'xl/styles.xml') source = source.replace(/<ext\b[^>]*>\s*<(?:\w+:)?(?:slicerStyles|timelineStyles)\b[^>]*\/>\s*<\/ext>/g, '').replace(/<extLst>\s*<\/extLst>/g, '');
  return /<(?:\w+:)?(?:extLst|conditionalFormatting|legacyDrawing|controls|oleObjects)\b/.test(source);
}

/** Keep the original package inspector's entry ordering and lexical matching.
 * In particular this scans the untouched XML, including out-of-preview rows,
 * and preserves the existing style-extension exceptions and unknown topology. */
export async function xlsxSourceFeatures(source: XlsxSource): Promise<string[]> {
  const found = new Set<string>();
  for (const [path, file] of source.entries) {
    if (file.dir) continue;
    if (/^xl\/(charts|drawings|pivot|externalLinks|slicer|embeddings|tables|connections|queryTables|threadedComments)|vbaProject/i.test(path)) found.add('图表、绘图、透视表、外部链接、表对象或扩展部件');
    if (/^xl\/(worksheets\/sheet\d+|workbook|styles)\.xml$/.test(path)) {
      if (await source.xmlFeature(path)) found.add('条件格式、控件、批注绘图或扩展 XML');
    }
  }
  return [...found];
}

export async function inspectXlsxFeatures(bytes: Uint8Array): Promise<string[]> {
  const source = await openXlsxSource(bytes);
  try { return await xlsxSourceFeatures(source); } finally { source.release(); }
}
