import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(process.argv[2] ?? process.cwd()), mode = process.argv[3] ?? '--check';
assert(['--write', '--check'].includes(mode), 'Usage: build-buttons.mjs <AgentViewer-root> [--check|--write]');
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const renderer = join(sourceRoot, 'apps/desktop/src/renderer');
const sourceRequire = createRequire(join(sourceRoot, 'package.json'));
const { build } = sourceRequire('esbuild');
const entrySource = (await readFile(join(skillRoot, 'assets/button-preview.tsx'), 'utf8')).replaceAll('\r\n', '\n');
const sourceMain = await readFile(join(renderer, 'main.tsx'), 'utf8');
const styles = [...sourceMain.matchAll(/^import ['"]\.\/(.+\.css)['"];$/gm)].map(match => match[1]);
assert(styles.includes('glass-elasticity.css') && styles.includes('settings-redesign.css') && styles.includes('navigation-glass.css'), 'Renderer stylesheet imports changed; inspect the new order.');
const common = { absWorkingDir: sourceRoot, bundle: true, write: false, minify: true, platform: 'browser', target: ['chrome130'], metafile: true, legalComments: 'inline', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } };
const worker = await build({ ...common, entryPoints: [join(renderer, 'lib/liquid-glass-optics.worker.ts')], format: 'iife' });
const workerCode = worker.outputFiles[0].text;
const originalWorkerURL = "new URL('./liquid-glass-optics.worker.ts', import.meta.url)";
const result = await build({ ...common, entryPoints: ['agentviewer-button-preview-entry'], jsx: 'automatic', format: 'iife', outfile: 'button-preview.js', plugins: [{
  name: 'agentviewer-preview-source', setup(api) {
    // An installed skill lives outside the repo. A logical entry plus the repo
    // resolution directory keeps both dependency lookup and output location-free.
    api.onResolve({ filter: /^agentviewer-button-preview-entry$/ }, () => ({ path: 'entry', namespace: 'preview-entry' }));
    api.onLoad({ filter: /.*/, namespace: 'preview-entry' }, () => ({ contents: entrySource, loader: 'tsx', resolveDir: sourceRoot }));
    api.onResolve({ filter: /^@agentviewer\// }, args => args.path === '@agentviewer/preview-style-order' ? { path: 'styles', namespace: 'preview-styles' } : { path: join(renderer, args.path.slice('@agentviewer/'.length) + (args.path.includes('/components/') ? '.tsx' : '.ts')) });
    api.onLoad({ filter: /.*/, namespace: 'preview-styles' }, () => ({ contents: styles.map(name => `import ${JSON.stringify(join(renderer, name))};`).join('\n'), loader: 'js', resolveDir: renderer }));
    api.onLoad({ filter: /[\\/]liquid-glass-optics\.ts$/ }, async args => {
      const source = await readFile(args.path, 'utf8');
      assert(source.includes(originalWorkerURL) && source.indexOf(originalWorkerURL) === source.lastIndexOf(originalWorkerURL), 'Optics Worker creation changed; inspect the new adapter.');
      // The sole runtime adaptation is resource transport, not optics or motion:
      // bundle the existing Worker as a page-owned Blob for offline file:// use.
      const prefix = `const __buttonPreviewWorkerURL=URL.createObjectURL(new Blob([${JSON.stringify(workerCode)}],{type:'text/javascript'}));addEventListener('pagehide',()=>URL.revokeObjectURL(__buttonPreviewWorkerURL),{once:true});\n`;
      return { contents: prefix + source.replace(originalWorkerURL, '__buttonPreviewWorkerURL'), loader: 'ts', resolveDir: dirname(args.path) };
    });
  },
}] });
const script = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text;
assert(script && css, 'Preview must contain both executable components and exact source CSS.');
const inputFiles = [...Object.keys(worker.metafile.inputs), ...Object.keys(result.metafile.inputs)];
const sourceFiles = new Set(inputFiles.filter(path => !/^preview-(?:styles|entry):/.test(path) && !path.includes('node_modules')));
sourceFiles.add('apps/desktop/src/renderer/main.tsx');
sourceFiles.add('package.json'); sourceFiles.add('package-lock.json');
const files = [];
for (const path of [...sourceFiles].sort()) {
  const absolute = resolve(sourceRoot, path), bytes = (await readFile(absolute, 'utf8')).replaceAll('\r\n', '\n');
  files.push({ path: relative(sourceRoot, absolute).replaceAll('\\', '/'), sha256: createHash('sha256').update(bytes).digest('hex') });
}
files.push({ path: 'skills/best-liquid-glass/assets/button-preview.tsx', sha256: createHash('sha256').update(entrySource).digest('hex') });
files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
const dependencies = [...new Set(inputFiles.filter(path => path.includes('node_modules')).map(path => {
  const parts = path.replaceAll('\\', '/').split('node_modules/').at(-1).split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}))].sort();
const licenses = [];
for (const name of dependencies) {
  const manifestPath = sourceRequire.resolve(name + '/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  let licenseText;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING']) {
    try { licenseText = (await readFile(join(dirname(manifestPath), filename), 'utf8')).replaceAll('\r\n', '\n'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert(licenseText, 'Bundled dependency license missing: ' + name);
  licenses.push({ package: name, version: manifest.version, license: manifest.license, text: licenseText });
}
const provenance = { source: 'AgentViewer current renderer source', workerAdapter: 'Offline Blob URL only', styles, files, licenses: licenses.map(({ text, ...item }) => ({ ...item, sha256: createHash('sha256').update(text).digest('hex') })) };
const shell = `
.button-preview:not([data-preview-ready="true"]) .preview-control-row{visibility:hidden}
.button-preview{max-width:1120px;margin:auto;padding:42px 32px}.preview-header{display:flex;align-items:center;justify-content:space-between;gap:30px;margin-bottom:30px}.preview-header h1{font-size:25px;margin:0 0 8px;font-weight:650}.preview-header p,.preview-section>p{font-size:12px;line-height:1.7;color:var(--muted);margin:0}.preview-options{display:flex;align-items:center;flex-wrap:wrap;gap:12px;font-size:12px}.preview-options label{display:flex;align-items:center;gap:6px}.preview-options select{font:inherit;color:inherit;background:var(--glass-panel);border:1px solid var(--line);border-radius:7px;padding:5px}.preview-designs{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:28px}.preview-section{padding:24px;border:1px solid var(--line);border-radius:24px;min-width:0}.preview-section h2{font-size:17px;margin:0 0 8px}.preview-scene{position:relative;min-height:270px;margin:24px 0 16px;overflow:visible;background:repeating-linear-gradient(90deg,transparent 0 23px,rgb(81 138 165/.11) 23px 24px),repeating-linear-gradient(0deg,transparent 0 23px,rgb(81 138 165/.11) 23px 24px);border-radius:16px}.preview-copy{padding:22px 16px;display:grid;gap:12px;pointer-events:none;color:var(--ink)}.preview-copy strong{font-size:20px}.preview-copy span{font-size:11px;letter-spacing:.04em;color:var(--muted)}.preview-control-row{min-height:90px;display:flex;align-items:center;justify-content:center;padding:18px 10px}.preview-section output{display:block;min-height:23px;font-size:12px;color:var(--muted)}.preview-status{font-size:12px;margin:24px 0 8px}.preview-note{font-size:11px;line-height:1.8;color:var(--muted);margin:0}:root[data-theme] body{background:var(--paper,#f5f6f9)}
`;
// Only preview page layout uses the shell. No selector here matches or
// overrides a source button, optical leaf, segmented lens or spring property.
const html = `<!doctype html>\n<html lang="zh-CN" data-theme="light" data-glass="standard" data-motion="standard" data-contrast="standard" data-reduce-transparency="false"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>best-liquid-glass · 项目原生液态玻璃按钮</title><style>${css.replaceAll('</style', '<\\/style')}\n${shell}</style><body><div id="root"></div><script type="application/json" id="agentviewer-button-provenance">${JSON.stringify(provenance).replaceAll('<', '\\u003c')}</script><script type="application/json" id="agentviewer-button-licenses">${JSON.stringify(licenses).replaceAll('<', '\\u003c')}</script><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>\n`;
const destination = join(skillRoot, 'assets/buttons.html');
if (mode === '--write') await writeFile(destination, html);
else assert.equal((await readFile(destination, 'utf8')).replaceAll('\r\n', '\n'), html, 'Buttons preview differs from the current renderer sources; inspect and regenerate.');
console.log(`${mode === '--write' ? 'Built' : 'Verified'} exact-source buttons preview: ${files.length} source files, ${Buffer.byteLength(html)} bytes, offline Worker included.`);
