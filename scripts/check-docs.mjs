import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'docs/manifest.json'), 'utf8'));
const excluded = new Set(['.git', 'node_modules', '.engines', 'dist', 'release', 'artifacts', '.agentviewer', '.claude', 'coverage', 'test-results', 'playwright-report']);
const documentFile = /\.(md|mdx|rst)$/i;
const errors = [], registered = new Set(), moduleNames = new Set();
let longest = { file: '', length: 0 };

for (const module of manifest.modules) {
  if (!module.name || moduleNames.has(module.name)) errors.push('Missing or duplicate module: ' + module.name);
  moduleNames.add(module.name);
  if (!Array.isArray(module.files) || module.files.length < 1 || module.files.length > 2) {
    errors.push(module.name + ': each module must contain 1–2 documents'); continue;
  }
  for (const file of module.files) {
    const path = resolve(root, file), local = relative(root, path);
    if (isAbsolute(file) || local === '..' || local.startsWith('..' + sep) || !documentFile.test(file) || file.includes('\\')) {
      errors.push('Invalid document path: ' + file); continue;
    }
    if (registered.has(file)) { errors.push('Document registered twice: ' + file); continue; }
    registered.add(file);
    let source;
    try { source = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n'); }
    catch { errors.push('Missing document: ' + file); continue; }
    const length = [...source].length;
    if (!source.trim() || length > 2000) errors.push(`${file}: ${length}/2000 characters`);
    if (length > longest.length) longest = { file, length };
    // Inline Markdown links and images; remote URLs and same-page anchors need
    // no filesystem access. Include paths in code examples in the length budget.
    for (const match of source.matchAll(/\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*)?\)/g)) {
      const href = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) continue;
      try { await access(resolve(dirname(path), decodeURIComponent(href.split(/[?#]/)[0]))); }
      catch { errors.push(`${file}: broken local link ${href}`); }
    }
  }
}

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else if (entry.isFile() && documentFile.test(entry.name)) {
      const file = relative(root, path).split(sep).join('/');
      if (!registered.has(file)) errors.push('Unregistered document: ' + file);
    }
  }
}
await inspect(root);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Docs: ${registered.size} documents, ${moduleNames.size} modules, max 2/module; longest ${longest.length}/2000 (${longest.file}); local links OK.`);
