import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ViewerError } from '../../../packages/contracts/src/index';
import { libreOfficeExecutable } from '../../../packages/engines/src/index';

export function libreOfficePath() { return libreOfficeExecutable(process.cwd())?.path; }

const formats = { doc: 'docx', ppt: 'pptx', xls: 'xlsx' } as const;
const prefix = 'agentviewer-convert-';
type Identity = Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>;
type Entry = { path: string; identity: Identity; directory: boolean; parents: Entry[] };
type OwnedDirectory = { root: Entry; directory: Entry };
export type LegacyConversionCleanup = { status: 'removed' } | { status: 'retained'; recoveryPath: string; reason: string };
type ProcessOptions = { timeout: number; windowsHide: true };
type Launch = (executable: string, args: string[], options: ProcessOptions, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => ChildProcess;
type ConversionFileSystem = {
  lstat(path: string): Promise<BigIntStats>;
  realpath: typeof realpath;
  mkdtemp: typeof mkdtemp;
  readdir(path: string): Promise<string[]>;
  open: typeof open;
  unlink: typeof unlink;
  rmdir: typeof rmdir;
};
type ConversionDependencies = { findExecutable?: () => string | undefined; launch?: Launch; tempRoot?: () => string; timeoutMs?: number; fileSystem?: Partial<ConversionFileSystem> };
const fileSystem: ConversionFileSystem = { lstat: path => lstat(path, { bigint: true }), realpath, mkdtemp, readdir: path => readdir(path), open, unlink, rmdir };
const launch: Launch = (executable, args, options, callback) => execFile(executable, args, options, callback);
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const inside = (root: string, path: string) => { const part = relative(root, path); return !!part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const refusal = (message: string) => new Error('临时转换目录安全校验未通过：' + message);

async function inspect(fs: ConversionFileSystem, path: string, parents: Entry[]): Promise<Entry> {
  const stats = await fs.lstat(path);
  if (stats.isSymbolicLink() || !samePath(await fs.realpath(path), path) || !stats.ino || !stats.isDirectory() && !stats.isFile()) throw refusal('存在链接、非普通文件或无法确认的目录身份。');
  return { path, identity: stats, directory: stats.isDirectory(), parents };
}

async function verify(fs: ConversionFileSystem, entry: Entry) {
  const current = await inspect(fs, entry.path, entry.parents);
  if (entry.directory !== current.directory || !sameIdentity(entry.identity, current.identity)) throw refusal('本次创建的目录或文件已被替换。');
}

function verifyOwnedBoundary(owned: OwnedDirectory) {
  const { root, directory } = owned;
  if (!root.directory || !directory.directory || !samePath(resolve(root.path), root.path) || !samePath(dirname(directory.path), root.path) || !inside(root.path, directory.path) || !basename(directory.path).startsWith(prefix)) throw refusal('清理目标不属于本次 TEMP 直接子目录。');
}

async function verifyOwned(fs: ConversionFileSystem, owned: OwnedDirectory) {
  verifyOwnedBoundary(owned);
  const { root, directory } = owned;
  await verify(fs, root); await verify(fs, directory);
}

/** No verification is shared between a traversal or deletion phase. Only
 * duplicate paths within this one phase are collapsed. Establish the TEMP and
 * allocated directory first, then settle every bounded read-only probe before
 * permitting readdir/unlink/rmdir. This is still not atomic path-based deletion. */
async function verifyCleanupStage(fs: ConversionFileSystem, owned: OwnedDirectory, target: Entry) {
  verifyOwnedBoundary(owned);
  const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const unique = new Map<string, Entry>();
  for (const entry of [owned.root, owned.directory, ...target.parents, target]) {
    if (!samePath(entry.path, owned.root.path) && !samePath(entry.path, owned.directory.path) && !inside(owned.directory.path, entry.path)) throw refusal('祖先校验目标超出了本次临时目录。');
    const previous = unique.get(key(entry.path));
    if (previous && (previous.directory !== entry.directory || !sameIdentity(previous.identity, entry.identity))) throw refusal('同一路径的预期身份记录不一致。');
    unique.set(key(entry.path), entry);
  }
  await verify(fs, owned.root); unique.delete(key(owned.root.path));
  await verify(fs, owned.directory); unique.delete(key(owned.directory.path));
  const remaining = [...unique.values()];
  for (let start = 0; start < remaining.length; start += 4) {
    // inspect() still rejects a symlink before realpath on each path. Probes
    // only read metadata; all results must settle and pass before any mutation.
    const results = await Promise.allSettled(remaining.slice(start, start + 4).map(entry => verify(fs, entry)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

async function readOutput(fs: ConversionFileSystem, owned: OwnedDirectory, format: string) {
  await verifyOwned(fs, owned);
  const file = (await fs.readdir(owned.directory.path)).find(name => name.endsWith('.' + format));
  if (!file) throw new ViewerError('CONVERSION_FAILED', '转换器没有返回文件。原件保留。');
  const output = join(owned.directory.path, file), entry = await inspect(fs, output, [owned.directory]);
  if (!samePath(dirname(output), owned.directory.path) || entry.directory || (await fs.lstat(output)).nlink !== 1n) throw refusal('转换输出不是本次目录中的独立普通文件。');
  // Open first, then check the opened identity and its ancestry before reading.
  // O_NOFOLLOW also prevents symlink following on platforms that implement it.
  const handle = await fs.open(output, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile() || actual.nlink !== 1n || !sameIdentity(entry.identity, actual)) throw refusal('转换输出在读取前发生了替换。');
    await verifyOwned(fs, owned); await verify(fs, entry);
    return new Uint8Array(await handle.readFile());
  } finally { await handle.close(); }
}

async function cleanup(fs: ConversionFileSystem, owned: OwnedDirectory): Promise<LegacyConversionCleanup> {
  try {
    const entries: Entry[] = [], maximumEntries = 100_000;
    async function visit(directory: Entry, depth: number) {
      if (depth > 32) throw refusal('临时目录层级超过清理上限。');
      await verifyCleanupStage(fs, owned, directory);
      for (const name of await fs.readdir(directory.path)) {
        const path = join(directory.path, name);
        if (!inside(owned.directory.path, path) || !samePath(dirname(path), directory.path)) throw refusal('目录项超出了本次临时目录。');
        if (name === '.lock' || name.startsWith('.~lock.') && name.endsWith('#')) throw refusal('转换目录仍含 Office 锁，未确认其使用者已退出。');
        const entry = await inspect(fs, path, [...directory.parents, directory]);
        if (entries.length >= maximumEntries) throw refusal('临时目录项超过清理上限。');
        entries.push(entry);
        if (entry.directory) await visit(entry, depth + 1);
      }
    }
    // Validate the complete tree before any deletion, then recheck each ancestry.
    // No recursive removal primitive follows a link encountered during traversal.
    // These path-based checks are conservative guards, not an atomic openat-style
    // guarantee against a hostile same-user mutation between filesystem calls.
    await visit(owned.directory, 0);
    for (const entry of entries.reverse()) {
      await verifyCleanupStage(fs, owned, entry);
      if (entry.directory) await fs.rmdir(entry.path); else await fs.unlink(entry.path);
    }
    await verifyCleanupStage(fs, owned, owned.directory); await fs.rmdir(owned.directory.path);
    return { status: 'removed' };
  } catch (error) { return { status: 'retained', recoveryPath: owned.directory.path, reason: error instanceof Error ? error.message : String(error) }; }
}

async function run(executable: string, args: string[], options: ProcessOptions, spawn: Launch) {
  return new Promise<{ error?: unknown; cleanupSafe: boolean }>(done => {
    let child: ChildProcess | undefined, spawned = false;
    try {
      child = spawn(executable, args, options, (error, stdout, stderr) => {
        if (error) {
          // Preserve execFile/promisify's stdout/stderr and original error code.
          Object.assign(error, { stdout, stderr });
          done({ error, cleanupSafe: !spawned });
        } else if (child?.exitCode === 0 && !child.signalCode) done({ cleanupSafe: true });
        else done({ error: new ViewerError('CONVERSION_FAILED', '转换进程退出状态尚未确认。原件保留。'), cleanupSafe: false });
      });
      child.once('spawn', () => { spawned = true; });
    } catch (error) { done({ error, cleanupSafe: !spawned }); }
  });
}

function attachCleanup(error: unknown, diagnostic: LegacyConversionCleanup): Error {
  const failure = error instanceof Error ? error : new Error(String(error), { cause: error });
  if (diagnostic.status === 'retained') {
    const note = `转换临时资料未清理，保留位置：${diagnostic.recoveryPath}。${diagnostic.reason}`;
    // IPC and HTTP currently transport the message; retain structured diagnostics too.
    failure.message += '\n' + note;
    Object.assign(failure, { conversionCleanup: diagnostic });
  }
  return failure;
}

/** Narrow dependencies support isolated subprocess/filesystem verification without Office. */
export function createLegacyConverter(dependencies: ConversionDependencies = {}) {
  const fs = { ...fileSystem, ...dependencies.fileSystem }, findExecutable = dependencies.findExecutable ?? libreOfficePath, spawn = dependencies.launch ?? launch;
  return async (path: string, extension: string) => {
    if (!Object.hasOwn(formats, extension)) throw new ViewerError('CAPABILITY_UNSUPPORTED', '旧格式转换仅支持 doc、ppt、xls 扩展名。原文件未修改。');
    const executable = findExecutable();
    if (!executable) throw new ViewerError('ENGINE_UNAVAILABLE', '旧 Office 格式需要 LibreOffice 转换器。安装后可自动发现，或设置 AGENTVIEWER_LIBREOFFICE。原文件未修改。');
    const convertedFormat = formats[extension as keyof typeof formats], rootPath = resolve(await fs.realpath(resolve((dependencies.tempRoot ?? tmpdir)()))), root = await inspect(fs, rootPath, []);
    if (!root.directory) throw refusal('TEMP 不是普通目录。');
    let outputDir: string | undefined, owned: OwnedDirectory | undefined, cleanupSafe = true, bytes: Uint8Array | undefined, failure: unknown, failed = false;
    try {
      outputDir = resolve(await fs.mkdtemp(join(rootPath, prefix)));
      owned = { root, directory: await inspect(fs, outputDir, [root]) };
      await verifyOwned(fs, owned);
      const profile = pathToFileURL(join(outputDir, 'profile')).href;
      const outcome = await run(executable, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', convertedFormat, '--outdir', outputDir, path], { timeout: dependencies.timeoutMs ?? 120_000, windowsHide: true }, spawn);
      cleanupSafe = outcome.cleanupSafe;
      if (outcome.error) throw outcome.error;
      bytes = await readOutput(fs, owned, convertedFormat);
    } catch (error) { failed = true; failure = error; }
    if (!outputDir && failed) throw failure;
    const diagnostic: LegacyConversionCleanup = owned && cleanupSafe ? await cleanup(fs, owned) : { status: 'retained', recoveryPath: outputDir ?? rootPath, reason: cleanupSafe ? '未确认本次临时目录身份，未执行删除。' : '转换进程异常结束，后代进程退出状态未经确认，未执行删除。' };
    if (failed) throw attachCleanup(failure, diagnostic);
    const warnings = ['旧格式已转换；请另存现代格式并检查字体、对象和公式的保真。'];
    if (diagnostic.status === 'retained') warnings.push(`转换成功，但临时资料未清理，保留位置：${diagnostic.recoveryPath}。${diagnostic.reason}`);
    return { bytes: bytes!, format: convertedFormat, sourcePath: path, warnings, cleanup: diagnostic };
  };
}

export const convertLegacy = createLegacyConverter();
