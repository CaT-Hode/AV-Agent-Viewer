import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packages = [];
for (const [scope, dependencies] of [['runtime', pkg.dependencies], ['development', pkg.devDependencies]]) {
  for (const name of Object.keys(dependencies)) {
    const metadata = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    packages.push({ name, requested: dependencies[name], version: metadata.version, license: metadata.license ?? null, scope });
  }
}
const output = join(root, 'artifacts/dependencies.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), scope: 'Installed direct npm packages; not a complete distribution NOTICE.', packages }, null, 2) + '\n');
console.log(`Dependency report: ${packages.length} direct packages → ${output}`);
