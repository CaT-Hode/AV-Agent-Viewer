import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const catalogDigest = snapshot => sha(JSON.stringify(canonical({ entry: snapshot.entry.hash, shared: snapshot.shared.hash, formats: Object.fromEntries(Object.entries(snapshot.formats).map(([type, value]) => [type, value.hash])) })));
const appFiles = ['dist/main/index.cjs', 'dist/mcp/index.mjs'];
const pluginFiles = ['skills/reading/SKILL.md', 'skills/editing/SKILL.md'];
async function fingerprints(root, files) { return Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(join(root, file)))]))); }

/** Bind the package's MCP implementation and shipped instructions to its catalog. */
export async function writeMcpPackageManifest(root) {
  const snapshot = JSON.parse(await readFile(join(root, 'scripts/mcp-budget.snapshot.json'), 'utf8'));
  const manifest = { schemaVersion: 1, catalogDigest: catalogDigest(snapshot), app: await fingerprints(root, appFiles), plugin: await fingerprints(join(root, 'plugins/agent-viewer'), pluginFiles) };
  await writeFile(join(root, 'dist/mcp/catalog-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

export async function verifyMcpPackageManifest(packageRoot, expectedDigest) {
  const appRoot = join(packageRoot, 'resources/app'), pluginRoot = join(packageRoot, 'resources/plugin/agent-viewer');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(appRoot, 'dist/mcp/catalog-manifest.json'), 'utf8')); }
  catch { throw new Error('PACKAGE_CATALOG_REQUIRED: 待安装包缺少有效MCP目录构建清单，请重新构建。'); }
  if (manifest.schemaVersion !== 1 || manifest.catalogDigest !== expectedDigest) throw new Error('PACKAGE_CATALOG_STALE: 待安装包的MCP目录摘要与当前认证目录不同。');
  for (const [group, directory, files] of [['app', appRoot, appFiles], ['plugin', pluginRoot, pluginFiles]]) {
    for (const file of files) {
      const expected = manifest[group]?.[file];
      if (!/^[a-f0-9]{64}$/.test(expected ?? '') || sha(await readFile(join(directory, file))) !== expected) throw new Error('PACKAGE_CONTENT_CHANGED: 待安装包的MCP文件指纹不匹配: ' + file);
    }
  }
  return manifest;
}
