import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'dist/test-build.json');
const inputs = ['apps', 'packages', 'assets', 'plugins', 'scripts', 'tests', 'docs', 'README.md', 'AGENTS.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'electron-builder.json', 'engines.lock.json', 'engines-requirements.txt'];
const outputs = ['dist/main', 'dist/renderer', 'dist/mcp'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function inventory(paths) {
  const files = [];
  async function visit(path) {
    let children;
    try { children = await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'ENOTDIR') throw error;
      const bytes = await readFile(path);
      files.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      return;
    }
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error('BUILD_IDENTITY_LINK: ' + child.name);
      await visit(join(path, child.name));
    }
  }
  for (const path of paths) await visit(join(root, path));
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function writeBuildIdentity() {
  const [sourceFiles, outputFiles, source] = await Promise.all([inventory(inputs), inventory(outputs), readFile(join(root, 'package.json'), 'utf8')]);
  const identity = { schemaVersion: 1, version: JSON.parse(source).version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), builtAt: new Date().toISOString(), sourceDigest: digest(sourceFiles), outputDigest: digest(outputFiles), sourceFiles, outputFiles };
  await writeFile(manifestPath, JSON.stringify(identity, null, 2) + '\n');
  console.log('Current desktop build recorded: ' + identity.sourceDigest.slice(0, 12));
}

export async function assertCurrentBuild() {
  let identity;
  try { identity = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new Error('CURRENT_BUILD_REQUIRED: Run npm run build before desktop or engine validation.'); }
  const [sourceFiles, outputFiles] = await Promise.all([inventory(inputs), inventory(outputs)]);
  if (identity.schemaVersion !== 1 || digest(identity.sourceFiles) !== identity.sourceDigest || digest(identity.outputFiles) !== identity.outputDigest || digest(sourceFiles) !== identity.sourceDigest || digest(outputFiles) !== identity.outputDigest) {
    throw new Error('STALE_DESKTOP_BUILD: Sources or production output changed. Run npm run build; old dist cannot be used as current evidence.');
  }
  const { sourceFiles: _sourceFiles, outputFiles: _outputFiles, ...receipt } = identity;
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'write') await writeBuildIdentity();
  else if (process.argv[2] === 'check') console.log(JSON.stringify(await assertCurrentBuild()));
  else throw new Error('Usage: node scripts/build-identity.mjs write|check');
}
