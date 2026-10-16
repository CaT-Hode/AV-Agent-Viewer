import { createReadStream } from 'node:fs';
import { lstat, link, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ViewerError } from '../../../../packages/contracts/src/index';

interface FileIdentity { dev: number; ino: number; size: number; mtime: number; sha256: string }
interface ExportStage { target: string; temporary: string; baseline?: FileIdentity; prepared?: FileIdentity; backup?: string; published?: boolean }
async function identity(path: string): Promise<FileIdentity | undefined> {
  let before;
  try { before = await lstat(path); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause; }
  if (!before.isFile() || before.isSymbolicLink()) throw new ViewerError('FILE_CONFLICT', '导出目标必须是普通文件，不能是目录或链接。');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ViewerError('FILE_CONFLICT', '校验期间导出目标已变化。');
  return { dev: after.dev, ino: after.ino, size: after.size, mtime: after.mtimeMs, sha256: digest.digest('hex') };
}
const same = (left?: FileIdentity, right?: FileIdentity) => left === undefined || right === undefined ? left === right : left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtime === right.mtime && left.sha256 === right.sha256;

/** Files become visible only after every output is complete. Publication never
 * overwrites a file created in the destination gap; rollback removes only the
 * exact unchanged inode/content we published, retaining recoverable backups. */
export class AtomicExportSet {
  private stages: ExportStage[] = [];
  async reserve(path: string, allowExisting = true) {
    const target = resolve(path);
    if (this.stages.some(stage => stage.target.toLowerCase() === target.toLowerCase())) throw new ViewerError('FILE_CONFLICT', '导出目标重复。');
    const baseline = await identity(target);
    if (baseline && !allowExisting) throw new ViewerError('FILE_CONFLICT', '分页图片目标已存在，请选择新的文件名以保留已有图片。');
    const temporary = target + '.agentviewer-export-' + randomUUID() + '.tmp';
    await writeFile(temporary, new Uint8Array(), { flag: 'wx', mode: 0o600 });
    this.stages.push({ target, temporary, baseline }); return temporary;
  }
  async write(path: string, bytes: string | Uint8Array, allowExisting = true) {
    const temporary = await this.reserve(path, allowExisting); await writeFile(temporary, bytes); return temporary;
  }
  async commit(validate: () => void | Promise<void>) {
    try {
      for (const stage of this.stages) { stage.prepared = await identity(stage.temporary); if (!stage.prepared) throw new ViewerError('SAVE_VERIFY_FAILED', '导出临时文件丢失。'); }
      await validate();
      for (const stage of this.stages) if (!same(await identity(stage.target), stage.baseline)) throw new ViewerError('FILE_CONFLICT', '导出期间目标文件已变化，未覆盖新内容。');
      for (const stage of this.stages) {
        await validate();
        if (stage.baseline) {
          const backup = stage.target + '.agentviewer-export-backup-' + randomUUID();
          await rename(stage.target, backup); stage.backup = backup;
          if (!same(await identity(stage.backup), stage.baseline)) throw new ViewerError('FILE_CONFLICT', '发布导出文件前目标已变化，已保留其原内容。');
        }
        await link(stage.temporary, stage.target); stage.published = true;
      }
      for (const stage of this.stages) {
        // Publication has completed. A backup cleanup failure must never roll
        // back outputs after an earlier backup was already removed.
        try { if (stage.backup && same(await identity(stage.backup), stage.baseline)) { await unlink(stage.backup); stage.backup = undefined; } } catch { /* Retain recoverable original. */ }
      }
      return this.stages.map(stage => stage.target);
    } catch (cause) {
      const recovery: string[] = [];
      for (const stage of [...this.stages].reverse()) {
        try {
          if (stage.published && same(await identity(stage.target), stage.prepared)) await unlink(stage.target);
          if (stage.backup) {
            const backup=stage.backup;
            try { await link(backup, stage.target); await unlink(backup); stage.backup = undefined; }
            catch { recovery.push(backup); }
          }
        } catch { if (stage.backup) recovery.push(stage.backup); }
      }
      if (recovery.length) throw new ViewerError('EXPORT_RECOVERY_REQUIRED', '导出失败；目标的新变化已保留，原文件备份位于：' + recovery.join('、'), { cause: String(cause), recovery });
      throw cause;
    }
  }
  async cleanup() { for (const stage of this.stages) { try { await unlink(stage.temporary); } catch { /* A completed publication remains successful; keep an owned leftover for recovery. */ } } }
}
