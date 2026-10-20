import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import JSZip from 'jszip';
import { loadExcelJS } from '../../format-adapters/src/exceljs-loader';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parse, serialize } from 'parse5';
import type { Format } from '../../contracts/src/index';
import { ViewerError } from '../../contracts/src/index';
import type { ViewerCore } from '../../document-core/src/index';
import { abortable, assertTranslationActive, translationLanguage } from './request';

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
  assertTranslationActive(signal); language = translationLanguage(language);
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
    const ExcelJS = await loadExcelJS();
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as never);
    workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
      if (cell.type !== ExcelJS.ValueType.String || typeof cell.value !== 'string' || !cell.value.trim()) return;
      units.push({ text: cell.value, set: value => { cell.value = value; } });
    })));
    output = async () => new Uint8Array(await workbook.xlsx.writeBuffer());
  } else throw new ViewerError('CAPABILITY_UNSUPPORTED', `不支持 ${format} 全文翻译。`);
  let done = 0; progress(done, units.length);
  for (const [index, unit] of units.entries()) {
    assertTranslationActive(signal);
    const original = unit.text, leading = original.match(/^\s*/)?.[0] ?? '', trailing = original.match(/\s*$/)?.[0] ?? '';
    const result = resumeSegments[index] ?? await abortable(translate(original.trim(), language, signal), signal);
    assertTranslationActive(signal);
    if (!result.trim()) throw new ViewerError('TRANSLATION_EMPTY', '翻译结果为空，已停止生成。');
    unit.set(leading + result.trim() + trailing); progress(++done, units.length); if (!resumeSegments[index]) await onSegment(index, result.trim());
  }
  assertTranslationActive(signal); const generated = await output(); assertTranslationActive(signal);
  return { bytes: generated, units: units.length, warnings: format === 'pptx' ? ['幻灯片译文可能溢出原文本框，请逐页检查。'] : format === 'xlsx' ? ['复杂 Excel 扩展的往返保真取决于 ExcelJS；公式和数值单元格未翻译。'] : [] };
}

export class DocumentTranslationService {
  readonly jobs = new Map<string, TranslationJob>();
  readonly artifacts = new Map<string, TranslationArtifact>();
  private controllers = new Map<string, AbortController>();
  private running = new Map<string, Promise<void>>();
  private preparing = new Map<string, Promise<void>>();
  private starting = new Set<Promise<TranslationJob>>();
  private profileFingerprints = new Map<string,string>();
  private pauseEpoch = 0;
  private pauseFlight?: Promise<void>;
  private pausing = new Set<string>();
  private publishing = new Set<string>();
  private publicationQueue: Promise<void> = Promise.resolve();
  constructor(readonly core: ViewerCore, readonly directory: string, readonly translate: Translator, readonly model = 'codex', readonly pdfTranslate?: (bytes: Uint8Array, language: string, signal: AbortSignal) => Promise<{ bytes: Uint8Array; warnings: string[] }>, readonly profileFactory?: () => JobExecutionProfile) {}
  private executionProfile(): JobExecutionProfile { return this.profileFactory?.() ?? { fingerprint: this.model, model: this.model, translate: this.translate, pdfTranslate: this.pdfTranslate }; }
  list() { return { jobs: [...this.jobs.values()], artifacts: [...this.artifacts.values()] }; }
  private checkpointPath(id: string) { return join(this.directory, 'checkpoints', id + '.json'); }
  private snapshotPath(id: string) { return join(this.directory, 'checkpoints', id + '.bin'); }
  private async saveCheckpoint(value: TranslationCheckpoint) { const path = this.checkpointPath(value.job.id), temporary = path + '.' + randomUUID() + '.tmp'; await mkdir(dirname(path), { recursive: true }); await writeFile(temporary, JSON.stringify(value)); await rename(temporary, path); }
  private async saveArtifacts() { const path = join(this.directory, 'artifacts.json'), temporary = path + '.' + randomUUID() + '.tmp'; await writeFile(temporary, JSON.stringify([...this.artifacts.values()], null, 2)); await rename(temporary, path); }
  private publish<T>(work: () => Promise<T>): Promise<T> { const result = this.publicationQueue.catch(() => {}).then(work); this.publicationQueue = result.then(() => {}, () => {}); return result; }
  private validCheckpoint(value: TranslationCheckpoint, id: string) {
    if (value?.job?.id !== id || !/^[0-9a-f-]{36}$/i.test(id) || typeof value.job.sourceDocumentId !== 'string' || !Number.isInteger(value.job.sourceRevision) || value.job.sourceRevision < 0 || typeof value.sourceTitle !== 'string' || !['managed','beside-source'].includes(value.outputMode) || !/^[0-9a-f]{64}$/i.test(value.sourceHash) || !Array.isArray(value.segments) || value.segments.some(segment => typeof segment !== 'string') || !['markdown','html','docx','pptx','xlsx','pdf'].includes(value.format) || typeof value.modelFingerprint !== 'string') throw new ViewerError('CHECKPOINT_CORRUPT', '翻译恢复点损坏；已保留原文件，请重新生成译文。');
    translationLanguage(value.job.targetLanguage);
  }
  async load() {
    try { const list = JSON.parse(await readFile(join(this.directory, 'artifacts.json'), 'utf8')) as TranslationArtifact[]; for (const artifact of list) this.artifacts.set(artifact.id, artifact); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const checkpointDir = join(this.directory, 'checkpoints');
    for (const file of await readdir(checkpointDir).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]; throw error; })) {
      if (!file.endsWith('.json')) continue;
      try {
        const checkpoint = JSON.parse(await readFile(join(checkpointDir, file), 'utf8')) as TranslationCheckpoint; this.validCheckpoint(checkpoint, file.slice(0, -5));
        if (checkpoint.job.status !== 'completed') { this.jobs.set(checkpoint.job.id, { ...checkpoint.job, status: 'paused', stage: '可恢复' });this.profileFingerprints.set(checkpoint.job.id,checkpoint.modelFingerprint); }
      } catch { this.core.event('translation.recovery-error', { file, error: '恢复点损坏，未自动加载；原恢复点文件已保留。' }); }
    }
  }
  async start(documentId: string, targetLanguage: string, windowId = 'main', outputMode: 'managed' | 'beside-source' = 'managed') {
    // Register before the first source-freeze await: shutdown must also account
    // for requests which do not have a validated source or public job ID yet.
    const work = this.startSource(documentId, targetLanguage, windowId, outputMode, this.pauseEpoch, !!this.pauseFlight);
    this.starting.add(work);
    try { return await work; } finally { this.starting.delete(work); }
  }
  private async startSource(documentId: string, targetLanguage: string, windowId: string, outputMode: 'managed' | 'beside-source', epoch: number, pausedAtEntry: boolean) {
    targetLanguage = translationLanguage(targetLanguage);
    const initialFormat = this.core.getDocument(documentId).info.format;
    if (initialFormat === 'web') throw new ViewerError('CAPABILITY_UNSUPPORTED', '网页翻译请使用原地翻译。');
    const profile = this.executionProfile();
    if (initialFormat === 'pdf' && !profile.pdfTranslate) throw new ViewerError('ENGINE_REQUIRED', 'PDF 同格式译文需要已配置的 BabelDOC 引擎。');
    // Renderer draft acknowledgement is not a native mirror barrier. Freeze
    // bytes and their matching model/revision inside Core's one document queue,
    // including already committed edits not yet checkpointed by the idle poll.
    const source = await this.core.freezeDocumentSource(documentId), format = source.document.format;
    const bytes = source.bytes, sourceRevision = source.document.revision, sourceHash = source.sha256, sourceTitle = source.document.title, sourcePath = source.document.path;
    const duplicate = [...this.jobs.values()].find(j => j.sourceDocumentId === documentId && j.sourceRevision === sourceRevision && j.targetLanguage === targetLanguage && this.profileFingerprints.get(j.id)===profile.fingerprint && ['running','paused'].includes(j.status));
    if (duplicate) return duplicate;
    const job: TranslationJob = { id: randomUUID(), sourceDocumentId: documentId, sourceRevision, targetLanguage, status: 'running', stage: '翻译文本', completed: 0, total: 0 };
    const checkpoint: TranslationCheckpoint = { job, sourceHash, sourceTitle, sourcePath, format, windowId, outputMode, segments: [], modelFingerprint: profile.fingerprint, modelName: profile.model };
    this.jobs.set(job.id, job); this.profileFingerprints.set(job.id,profile.fingerprint);const controller = new AbortController(); this.controllers.set(job.id, controller);
    const pauseRequested = () => pausedAtEntry || epoch !== this.pauseEpoch || this.pausing.has(job.id);
    const markPaused = () => { job.status = 'paused'; job.stage = '可恢复'; job.error = undefined; };
    const preparation = (async () => {
      await mkdir(dirname(this.snapshotPath(job.id)), { recursive: true }); await writeFile(this.snapshotPath(job.id), bytes);
      if (pauseRequested()) markPaused();
      await this.saveCheckpoint(checkpoint);
    })(); this.preparing.set(job.id, preparation);
    try {
      await preparation;
      if (pauseRequested()) {
        // A pause may arrive while the initial JSON write is in flight. Save
        // its durable paused state before start/pauseAll are allowed to finish.
        if (job.status !== 'paused') { markPaused(); await this.saveCheckpoint(checkpoint); }
        this.controllers.delete(job.id); this.pausing.delete(job.id);
        this.core.event('translation.paused', { jobId: job.id });
      } else this.run(checkpoint, bytes, profile, controller);
    }
    catch (error) { job.status = 'failed'; job.error = String(error); this.controllers.delete(job.id); this.pausing.delete(job.id); throw error; }
    finally { this.preparing.delete(job.id); }
    return job;
  }
  async resume(id: string) {
    const job = this.jobs.get(id); if (!job || !['paused','failed','cancelled'].includes(job.status)) throw new ViewerError('TARGET_NOT_FOUND', '任务当前不能恢复。');
    if (this.controllers.has(id) || this.running.has(id) || this.preparing.has(id)) throw new ViewerError('TASK_BUSY', '恢复点正在保存，请稍后继续。');
    const previousStatus = job.status, controller = new AbortController(); job.status = 'running'; this.controllers.set(id, controller);
    const preparation = (async () => {
      const checkpoint = JSON.parse(await readFile(this.checkpointPath(id), 'utf8')) as TranslationCheckpoint; this.validCheckpoint(checkpoint, id);
      const bytes = new Uint8Array(await readFile(this.snapshotPath(id)));
      if (sha(bytes) !== checkpoint.sourceHash) throw new ViewerError('CHECKPOINT_CORRUPT', '冻结原文与恢复点不一致。');
      const profile = this.executionProfile(); if (profile.fingerprint !== checkpoint.modelFingerprint) throw new ViewerError('MODEL_CONFIG_CHANGED', '任务创建时的模型配置已变化，请恢复原配置后继续，或重新生成新译文。');
      checkpoint.job = job; job.stage = '继续翻译'; job.error = undefined; await this.saveCheckpoint(checkpoint); this.run(checkpoint, bytes, profile, controller);
    })(); this.preparing.set(id, preparation);
    try { await preparation; return job; } catch (error) { job.status = previousStatus; this.controllers.delete(id); throw error; } finally { this.preparing.delete(id); }
  }
  private run(checkpoint: TranslationCheckpoint, bytes: Uint8Array, profile: JobExecutionProfile, controller: AbortController) {
    const job = checkpoint.job, { format, targetLanguage, sourceDocumentId: documentId, sourceRevision } = { ...checkpoint, ...job }, { sourceHash, sourceTitle, sourcePath, outputMode } = checkpoint;
    this.core.event('translation.started', { jobId: job.id, documentId });
    const work = (async () => {
      try {
        assertTranslationActive(controller.signal);
        const result = format === 'pdf' ? { ...(await abortable(profile.pdfTranslate!(bytes, targetLanguage, controller.signal), controller.signal)), units: 1 } : await translateDocumentBytes(format, bytes, targetLanguage, profile.translate, controller.signal, (done, total) => { job.completed = done; job.total = total; }, checkpoint.segments, async (index, value) => { checkpoint.segments[index] = value; await this.saveCheckpoint(checkpoint); });
        assertTranslationActive(controller.signal);
        await this.publish(async () => {
        assertTranslationActive(controller.signal); this.publishing.add(job.id);
        job.stage = '检查与保存';
        const extension = format === 'markdown' ? '.md' : '.' + format, stem = basename(sourceTitle, extname(sourceTitle));
        const outputRoot = outputMode === 'beside-source' && sourcePath ? dirname(sourcePath) : join(this.directory, 'documents');
        await mkdir(outputRoot, { recursive: true });
        let path = join(outputRoot, `${stem}.${targetLanguage}${extension}`), serial = 2;
        if (sourcePath && resolve(path).toLowerCase() === resolve(sourcePath).toLowerCase()) throw new ViewerError('OUTPUT_CONFLICT', '译文不能覆盖原文件。');
        const temporary = join(outputRoot, '.' + randomUUID() + '.translation.tmp');
        try {
          await writeFile(temporary, result.bytes, { flag: 'wx' });
          while (true) {
            try {
              try { await link(temporary, path); }
              catch (error) { if (!['EPERM','ENOTSUP','ENOSYS','EOPNOTSUPP','EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await copyFile(temporary, path, fsConstants.COPYFILE_EXCL); }
              break;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; path = join(outputRoot, `${stem}.${targetLanguage}.${serial++}${extension}`); }
          }
        } finally { await unlink(temporary).catch(() => {}); }
        const opened = await this.core.importArtifact(path, result.bytes, format), artifact: TranslationArtifact = { id: randomUUID(), sourceDocumentId: documentId, sourceRevision, sourceHash, sourceTitle, targetLanguage, path, format, createdAt: new Date().toISOString(), model: profile.model, warnings: result.warnings, documentId: opened.id };
        this.artifacts.set(artifact.id, artifact); job.artifact = artifact;
        await this.saveArtifacts();
        job.status = 'completed'; job.stage = '已完成';
        await unlink(this.checkpointPath(job.id)).catch(() => {}); await unlink(this.snapshotPath(job.id)).catch(() => {});
        this.core.event('translation.completed', { jobId: job.id, artifactId: artifact.id });
        });
      } catch (error) {
        const status = this.pausing.has(job.id) ? 'paused' : controller.signal.aborted ? 'cancelled' : 'failed';
        const message = status === 'paused' ? undefined : error instanceof Error ? error.message : String(error);
        await this.saveCheckpoint({ ...checkpoint, job: { ...job, status, error: message, stage: '可恢复' } }).catch(() => {});
        job.status = status; job.error = message; job.stage = '可恢复';
        this.core.event(status === 'paused' ? 'translation.paused' : 'translation.failed', { jobId: job.id, error: job.error });
      }
      finally { this.controllers.delete(job.id); this.publishing.delete(job.id); this.pausing.delete(job.id); this.running.delete(job.id); }
    })();
    this.running.set(job.id, work);
  }
  cancel(id: string) { const controller = this.controllers.get(id); if (!controller) throw new ViewerError('TARGET_NOT_FOUND', '任务不在运行。'); if (this.publishing.has(id)) throw new ViewerError('TASK_FINALIZING', '译文正在发布，稍后即可打开。'); controller.abort(); }
  pauseAll(): Promise<void> {
    if (this.pauseFlight) return this.pauseFlight;
    this.pauseEpoch++;
    const work = this.drainPaused(); this.pauseFlight = work;
    void work.finally(() => { if (this.pauseFlight === work) this.pauseFlight = undefined; }).catch(() => {});
    return work;
  }
  private async drainPaused() {
    let failed = false, failure: unknown;
    while (true) {
      for (const [id, controller] of this.controllers) if (!this.publishing.has(id)) { this.pausing.add(id); controller.abort(); }
      const pending = [...new Set<Promise<unknown>>([...this.starting, ...this.preparing.values(), ...this.running.values()])];
      if (!pending.length) {
        // Let starts invoked in the same turn register before concluding that
        // the service is quiescent. New starts during this pause are paused too.
        await Promise.resolve();
        if (!this.starting.size && !this.preparing.size && !this.running.size) break;
        continue;
      }
      const results = await Promise.allSettled(pending);
      for (const result of results) if (result.status === 'rejected' && !failed) { failed = true; failure = result.reason; }
    }
    // Preparation failures remain visible to start's caller and must not turn
    // a shutdown barrier into an apparent successful recovery checkpoint.
    if (failed) throw failure;
  }
}
