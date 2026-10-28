import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'dist/build-info.json');
const outputs = ['dist/main/index.cjs', 'dist/main/preload.cjs', 'dist/main/browser-preload.cjs', 'dist/main/markdown-export-preload.cjs', 'dist/main/office-model-worker.cjs', 'dist/main/pdf-service-renderer.mjs', 'dist/main/pdf-service-worker.mjs', 'dist/renderer/index.html', 'dist/mcp/index.mjs', ...(process.platform === 'win32' ? ['dist/main/office-kit-windows.dll'] : [])];

async function outputInventory() {
  return Promise.all(outputs.map(async path => {
    const info = await stat(join(root, path));
    if (!info.isFile()) throw new Error('BUILD_OUTPUT_MISSING: ' + path);
    return { path, bytes: info.size, modifiedAt: info.mtimeMs };
  }));
}

export async function writeBuildIdentity() {
  const [outputFiles, source] = await Promise.all([outputInventory(), readFile(join(root, 'package.json'), 'utf8')]);
  const identity = { schemaVersion: 2, buildId: randomUUID(), version: JSON.parse(source).version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), builtAt: new Date().toISOString(), outputFiles };
  await writeFile(manifestPath, JSON.stringify(identity, null, 2) + '\n');
  console.log('Current desktop build recorded: ' + identity.buildId);
}

export async function assertCurrentBuild() {
  let identity;
  try { identity = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new Error('CURRENT_BUILD_REQUIRED: Run npm run build before desktop or engine validation.'); }
  const outputFiles = await outputInventory();
  if (identity.schemaVersion !== 2 || typeof identity.buildId !== 'string' || JSON.stringify(outputFiles) !== JSON.stringify(identity.outputFiles)) {
    throw new Error('STALE_DESKTOP_BUILD: Production entrypoints changed. Run npm run build before desktop or engine validation.');
  }
  const { outputFiles: _outputFiles, ...receipt } = identity;
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'write') await writeBuildIdentity();
  else if (process.argv[2] === 'check') console.log(JSON.stringify(await assertCurrentBuild()));
  else throw new Error('Usage: node scripts/build-identity.mjs write|check');
}
