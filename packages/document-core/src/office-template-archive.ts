import JSZip from 'jszip';

/** Change only package dates; retain all generated slides, styles and relations. */
export async function refreshOfficeTemplateDates(bytes: Uint8Array, format: 'pptx' | 'xlsx', createdAt: Date): Promise<Uint8Array> {
  if (!Number.isFinite(createdAt.getTime())) throw new Error('新文档创建时间无效。');
  const zip = await JSZip.loadAsync(bytes), core = zip.file('docProps/core.xml');
  if (!core) throw new Error('内置 Office 模板缺少文档属性。请重新生成模板。');
  // PptxGenJS writes seconds; ExcelJS preserves milliseconds. Match their
  // existing metadata precision instead of freezing new files at build time.
  const timestamp = format === 'pptx' ? createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z') : createdAt.toISOString();
  let xml = await core.async('string');
  for (const name of ['created', 'modified']) {
    const pattern = new RegExp(`(<dcterms:${name}\\b[^>]*>)[^<]*(</dcterms:${name}>)`, 'g');
    let count = 0;
    xml = xml.replace(pattern, (_match, opening: string, closing: string) => { count++; return opening + timestamp + closing; });
    if (count !== 1) throw new Error('内置 Office 模板的时间属性无效。请重新生成模板。');
  }
  zip.file('docProps/core.xml', xml, { date: new Date(createdAt.getTime()) });
  for (const entry of Object.values(zip.files)) entry.date = new Date(createdAt.getTime());
  // Preserve the original generators' archive policies: PPTX defaults to
  // stored entries; ExcelJS emits deflated entries. Untouched members may reuse
  // JSZip's original compressed data rather than running the Office generators.
  return zip.generateAsync({ type: 'uint8array', compression: format === 'pptx' ? 'STORE' : 'DEFLATE' });
}
