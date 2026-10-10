import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const root = resolve('.'), source = join(root, '.engines'), destination = resolve(process.argv[2] ?? 'dist/engines');
assert.ok(!destination.toLowerCase().startsWith((source + sep).toLowerCase()) && destination.toLowerCase() !== source.toLowerCase(), '输出目录不能放在 .engines 内。');
execFileSync(process.execPath, [join(root, 'scripts', 'verify-engines.mjs')], { cwd: root, stdio: 'inherit' });
await mkdir(destination, { recursive: true });
for (const [from, to] of [
  [join(source, 'babeldoc-runtime'), join(destination, 'babeldoc-runtime')],
  [join(source, 'babeldoc-home'), join(destination, 'babeldoc-home')],
  [join(source, 'libreoffice-stage'), join(destination, 'libreoffice')],
  [join(root, 'assets', 'ocr'), join(destination, 'ocr')],
]) await cp(from, to, { recursive: true, force: true });
await writeFile(join(destination, 'engines.lock.json'), await readFile(join(root, 'engines.lock.json')));
console.log('内置引擎已复制到 ' + destination);
