import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parse, serialize } from 'parse5';
import type { Format } from '../../contracts/src/index';
import { ViewerError } from '../../contracts/src/index';
import type { ViewerCore } from '../../document-core/src/index';

export type Translator = (source: string, targetLanguage: string, signal: AbortSignal) => Promise<string>;
export type TranslationArtifact = { id: string; sourceDocumentId: string; sourceRevision: number; sourceHash: string; sourceTitle: string; targetLanguage: string; path: string; format: Format; createdAt: string; model: string; warnings: string[]; documentId?: string };
export type TranslationJob = { id: string; sourceDocumentId: string; sourceRevision: number; targetLanguage: string; status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'; stage: string; completed: number; total: number; artifact?: TranslationArtifact; error?: string };
type TranslationCheckpoint = { job: TranslationJob; sourceHash: string; sourceTitle: string; sourcePath?: string; format: Format; windowId: string; outputMode: 'managed' | 'beside-source'; segments: string[]; modelFingerprint: string; modelName: string };
export type JobExecutionProfile = { fingerprint: string; model: string; translate: Translator; pdfTranslate?: (bytes: Uint8Array, language: string, signal: AbortSignal) => Promise<{ bytes: Uint8Array; warnings: string[] }> };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const enc = new TextEncoder(), dec = new TextDecoder();
const parser = new DOMParser(), serializer = new XMLSerializer();
const DOCX_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PPTX_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function selectedTextNodes(root: unknown, exclude = false): { value: string; replace: (value: string) => void }[] {
  const node = root as { nodeName?: string; value?: string; childNodes?: unknown[] };
  const tag = node.nodeName?.toLowerCase() ?? '';
  const skip = exclude || ['script','style','code','pre','textarea','input','svg','math'].includes(tag);
  if (tag === '#text' && !skip && node.value?.trim()) return [{ value: node.value, replace: value => { node.value = value; } }];
  return (node.childNodes ?? []).flatMap(child => selectedTextNodes(child, skip));
}

export async function translateDocumentBytes(format: Format, bytes: Uint8Array, language: string, translate: Translator, signal: AbortSignal, progress: (done: number, total: number) => void = () => {}, resumeSegments: string[] = [], onSegment: (index: number, value: string) => Promise<void> = async () => {}) {
  if (format === 'web') throw new ViewerError('CAPABILITY_UNSUPPORTED', '网页采用原地翻译。');
  if (format === 'pdf') throw new ViewerError('ENGINE_REQUIRED', 'PDF 同格式译文需要 BabelDOC 翻译引擎及模型连接；当前未配置。');
  const units: { text: string; set: (value: string) => void }[] = [];
  let output: () => Promise<Uint8Array>;
  if (format === 'markdown') {
    const lines = dec.decode(bytes).split(/(\r?\n)/), code = { active: false };
    lines.forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) { code.active = !code.active; return; }
      if (code.active || !line.trim() || /^\s*(\||[-*_]{3,}|\[[^\]]+\]:|<[^>]+>)/.test(line)) return;
      const match = /^(\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)?)(.*)$/.exec(line);
      if (match?.[2]?.trim()) units.push({ text: match[2], set: value => { lines[index] = match[1] + value; } });
    });
    output = async () => enc.encode(lines.join(''));
  } else if (format === 'html') {
    const tree = parse(dec.decode(bytes));
    for (const item of selectedTextNodes(tree)) units.push({ text: item.value, set: item.replace });
    output = async () => enc.encode(serialize(tree));
  } else if (format === 'docx' || format === 'pptx') {
    const zip = await JSZip.loadAsync(bytes), paths = Object.keys(zip.files).filter(path => format === 'docx' ? /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(path) : /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(path));
    const changed: { path: string; doc: ReturnType<typeof parser.parseFromString> }[] = [];
    for (const path of paths) {
      const doc = parser.parseFromString(await zip.file(path)!.async('string'), 'text/xml'); changed.push({ path, doc });
      const nodes = Array.from(doc.getElementsByTagNameNS(format === 'docx' ? DOCX_NS : PPTX_NS, 't'));
      for (const node of nodes) if (node.textContent?.trim()) {
        const original = node.textContent;
        units.push({ text: original, set: value => { node.textContent = value; if (format === 'docx') node.setAttribute('xml:space', 'preserve'); } });
      }
    }
    output = async () => { for (const item of changed) zip.file(item.path, serializer.serializeToString(item.doc)); return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }); };
  } else if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as never);
    workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
      if (cell.type !== ExcelJS.ValueType.String || typeof cell.value !== 'string' || !cell.value.trim()) return;
      units.push({ text: cell.value, set: value => { cell.value = value; } });
    })));
    output = async () => new Uint8Array(await workbook.xlsx.writeBuffer());
  } else throw new ViewerError('CAPABILITY_UNSUPPORTED', `不支持 ${format} 全文翻译。`);
  let done = 0; progress(done, units.length);
  for (const [index, unit] of units.entries()) {
    if (signal.aborted) throw new ViewerError('CANCELLED', '翻译已取消。');
    const original = unit.text, leading = original.match(/^\s*/)?.[0] ?? '', trailing = original.match(/\s*$/)?.[0] ?? '';
    const result = resumeSegments[index] ?? await translate(original.trim(), language, signal);
    if (!result.trim()) throw new ViewerError('TRANSLATION_EMPTY', '翻译结果为空，已停止生成。');
    unit.set(leading + result.trim() + trailing); if (!resumeSegments[index]) await onSegment(index, result.trim()); progress(++done, units.length);
  }
  return { bytes: await output(), units: units.length, warnings: format === 'pptx' ? ['幻灯片译文可能溢出原文本框，请逐页检查。'] : format === 'xlsx' ? ['复杂 Excel 扩展的往返保真取决于 ExcelJS；公式和数值单元格未翻译。'] : [] };
}

export class DocumentTranslationService {
  readonly jobs = new Map<string, TranslationJob>();
  readonly artifacts = new Map<string, TranslationArtifact>();
  private controllers = new Map<string, AbortController>();
  constructor(readonly core: ViewerCore, readonly directory: string, readonly translate: Translator, readonly model = 'codex', readonly pdfTranslate?: (bytes: Uint8Array, language: string, signal: AbortSignal) => Promise<{ bytes: Uint8Array; warnings: string[] }>, readonly profileFactory?: () => JobExecutionProfile) {}
  private executionProfile(): JobExecutionProfile { return this.profileFactory?.() ?? { fingerprint: this.model, model: this.model, translate: this.translate, pdfTranslate: this.pdfTranslate }; }
  list() { return { jobs: [...this.jobs.values()], artifacts: [...this.artifacts.values()] }; }
  private checkpointPath(id: string) { return join(this.directory, 'checkpoints', id + '.json'); }
  private snapshotPath(id: string) { return join(this.directory, 'checkpoints', id + '.bin'); }
  private async saveCheckpoint(value: TranslationCheckpoint) { const path = this.checkpointPath(value.job.id), temporary = path + '.' + randomUUID() + '.tmp'; await mkdir(dirname(path), { recursive: true }); await writeFile(temporary, JSON.stringify(value)); await rename(temporary, path); }
  async load() {
    try { const list = JSON.parse(await readFile(join(this.directory, 'artifacts.json'), 'utf8')) as TranslationArtifact[]; for (const artifact of list) this.artifacts.set(artifact.id, artifact); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const checkpointDir = join(this.directory, 'checkpoints');
    for (const file of await readdir(checkpointDir).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]; throw error; })) {
      if (!file.endsWith('.json')) continue;
      const checkpoint = JSON.parse(await readFile(join(checkpointDir, file), 'utf8')) as TranslationCheckpoint;
      if (checkpoint.job.status !== 'completed') this.jobs.set(checkpoint.job.id, { ...checkpoint.job, status: 'paused', stage: '可恢复' });
    }
  }
  async start(documentId: string, targetLanguage: string, windowId = 'main', outputMode: 'managed' | 'beside-source' = 'managed') {
    const source = this.core.getDocument(documentId), format = source.info.format;
    if (format === 'web') throw new ViewerError('CAPABILITY_UNSUPPORTED', '网页翻译请使用原地翻译。');
    const profile = this.executionProfile();
    if (format === 'pdf' && !profile.pdfTranslate) throw new ViewerError('ENGINE_REQUIRED', 'PDF 同格式译文需要已配置的 BabelDOC 引擎。');
    const bytes = source.bytes.slice(), sourceRevision = source.info.revision, sourceHash = sha(bytes), sourceTitle = source.info.title, sourcePath = source.info.path;
    const duplicate = [...this.jobs.values()].find(j => j.sourceDocumentId === documentId && j.sourceRevision === sourceRevision && j.targetLanguage === targetLanguage && ['running','paused'].includes(j.status));
    if (duplicate) return duplicate;
    const job: TranslationJob = { id: randomUUID(), sourceDocumentId: documentId, sourceRevision, targetLanguage, status: 'running', stage: '翻译文本', completed: 0, total: 0 };
    const checkpoint: TranslationCheckpoint = { job, sourceHash, sourceTitle, sourcePath, format, windowId, outputMode, segments: [], modelFingerprint: profile.fingerprint, modelName: profile.model };
    await mkdir(dirname(this.snapshotPath(job.id)), { recursive: true }); await writeFile(this.snapshotPath(job.id), bytes); await this.saveCheckpoint(checkpoint);
    this.jobs.set(job.id, job); this.run(checkpoint, bytes, profile);
    return job;
  }
  async resume(id: string) {
    const job = this.jobs.get(id); if (!job || !['paused','failed','cancelled'].includes(job.status)) throw new ViewerError('TARGET_NOT_FOUND', '任务当前不能恢复。');
    const checkpoint = JSON.parse(await readFile(this.checkpointPath(id), 'utf8')) as TranslationCheckpoint, bytes = new Uint8Array(await readFile(this.snapshotPath(id)));
    if (sha(bytes) !== checkpoint.sourceHash) throw new ViewerError('CHECKPOINT_CORRUPT', '冻结原文与恢复点不一致。');
    const profile = this.executionProfile(); if (profile.fingerprint !== checkpoint.modelFingerprint) throw new ViewerError('MODEL_CONFIG_CHANGED', '任务创建时的模型配置已变化，请恢复原配置后继续，或重新生成新译文。');
    checkpoint.job = job; job.status = 'running'; job.stage = '继续翻译'; job.error = undefined; await this.saveCheckpoint(checkpoint); this.run(checkpoint, bytes, profile); return job;
  }
  private run(checkpoint: TranslationCheckpoint, bytes: Uint8Array, profile: JobExecutionProfile) {
    const job = checkpoint.job, { format, targetLanguage, sourceDocumentId: documentId, sourceRevision } = { ...checkpoint, ...job }, { sourceHash, sourceTitle, sourcePath, outputMode } = checkpoint;
    const controller = new AbortController(); this.controllers.set(job.id, controller); this.core.event('translation.started', { jobId: job.id, documentId });
    void (async () => {
      try {
        const result = format === 'pdf' ? { ...(await profile.pdfTranslate!(bytes, targetLanguage, controller.signal)), units: 1 } : await translateDocumentBytes(format, bytes, targetLanguage, profile.translate, controller.signal, (done, total) => { job.completed = done; job.total = total; }, checkpoint.segments, async (index, value) => { checkpoint.segments[index] = value; await this.saveCheckpoint(checkpoint); });
        job.stage = '检查与保存';
        const extension = format === 'markdown' ? '.md' : '.' + format, stem = basename(sourceTitle, extname(sourceTitle));
        const outputRoot = outputMode === 'beside-source' && sourcePath ? dirname(sourcePath) : join(this.directory, 'documents');
        await mkdir(outputRoot, { recursive: true });
        let path = join(outputRoot, `${stem}.${targetLanguage}${extension}`), serial = 2;
        while (await stat(path).then(() => true).catch(() => false)) path = join(outputRoot, `${stem}.${targetLanguage}.${serial++}${extension}`);
        if (sourcePath && resolve(path).toLowerCase() === resolve(sourcePath).toLowerCase()) throw new ViewerError('OUTPUT_CONFLICT', '译文不能覆盖原文件。');
        const temporary = path + '.' + randomUUID() + '.tmp'; await writeFile(temporary, result.bytes); await rename(temporary, path);
        const opened = await this.core.importArtifact(path, result.bytes, format), artifact: TranslationArtifact = { id: randomUUID(), sourceDocumentId: documentId, sourceRevision, sourceHash, sourceTitle, targetLanguage, path, format, createdAt: new Date().toISOString(), model: profile.model, warnings: result.warnings, documentId: opened.id };
        this.artifacts.set(artifact.id, artifact); job.artifact = artifact; job.status = 'completed'; job.stage = '已完成';
        await writeFile(join(this.directory, 'artifacts.json'), JSON.stringify([...this.artifacts.values()], null, 2));
        await unlink(this.checkpointPath(job.id)).catch(() => {}); await unlink(this.snapshotPath(job.id)).catch(() => {});
        this.core.event('translation.completed', { jobId: job.id, artifactId: artifact.id });
      } catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error instanceof Error ? error.message : String(error); job.stage = '可恢复'; await this.saveCheckpoint(checkpoint).catch(() => {}); this.core.event('translation.failed', { jobId: job.id, error: job.error }); }
      finally { this.controllers.delete(job.id); }
    })();
  }
  cancel(id: string) { const controller = this.controllers.get(id); if (!controller) throw new ViewerError('TARGET_NOT_FOUND', '任务不在运行。'); controller.abort(); }
}
