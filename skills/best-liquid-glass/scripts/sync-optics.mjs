import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep a portable copy of the real kernel, without the application's UI,
// settings, IPC or native-view geometry. Nothing here changes the algorithm.
const sourceRoot = resolve(process.argv[2] ?? process.cwd());
const mode = process.argv[3] ?? '--check';
assert(['--check', '--write'].includes(mode), 'Usage: sync-optics.mjs <AgentViewer-root> [--check|--write]');
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = 'apps/desktop/src/renderer/lib/';
const read = async name => (await readFile(join(sourceRoot, prefix + name), 'utf8')).replaceAll('\r\n', '\n');
const navigation = await read('navigation-optics.ts');
function sliceBetween(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end);
  assert(from >= 0 && to > from && source.indexOf(start, from + start.length) < 0 && source.indexOf(end, to + end.length) < 0, 'Source boundaries changed; inspect the new kernel before syncing.');
  return source.slice(from, to).trimEnd() + '\n';
}
function rename(source, from, to) {
  assert(source.includes(from), 'Expected dependency missing: ' + from);
  return source.replaceAll(from, to);
}
const extracted = [
  ['ray-optics.ts', 'navigation-optics.ts', sliceBetween(navigation, 'export type BezelProfile', 'export type NavigationBounds')],
  ['optics-model.ts', 'liquid-glass-optics-model.ts', rename(await read('liquid-glass-optics-model.ts'), "'./navigation-optics'", "'./ray-optics'")],
  ['optics.worker.ts', 'liquid-glass-optics.worker.ts', rename(await read('liquid-glass-optics.worker.ts'), "'./liquid-glass-optics-model'", "'./optics-model'")],
  ['optics-cache.ts', 'liquid-glass-optics.ts', rename(rename(await read('liquid-glass-optics.ts'), "'./liquid-glass-optics-model'", "'./optics-model'"), "'./liquid-glass-optics.worker.ts'", "'./optics.worker.ts'")],
];
if (mode === '--write') await mkdir(join(skillRoot, 'assets'), { recursive: true });
for (const [name, origin, body] of extracted) {
  const content = '// Extracted from AgentViewer ' + prefix + origin + '.\n' + body;
  const destination = join(skillRoot, 'assets', name);
  if (mode === '--write') await writeFile(destination, content);
  else assert.equal((await readFile(destination, 'utf8')).replaceAll('\r\n', '\n'), content, 'Optics asset drift: ' + name);
}
console.log(`${mode === '--write' ? 'Synced' : 'Verified'} ${extracted.length} portable optical kernel files.`);
