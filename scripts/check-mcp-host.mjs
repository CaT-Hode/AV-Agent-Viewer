import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Tiktoken } from 'js-tiktoken/lite';
import { catalogDigest, verifyMcpPackageManifest } from './mcp-package-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const certificatePath = resolve(process.env.AGENTVIEWER_MCP_HOST_CERTIFICATE ?? join(root, 'artifacts/mcp-host-certification.json'));
const fail = (code, message) => { throw new Error(`${code}: ${message}`); };
const stable = value => JSON.stringify(Array.isArray(value) ? value.map(value => JSON.parse(stable(value))) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stable(value[key]))])) : value);
const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const policy = await readJson(join(root, 'scripts/mcp-host-policy.json'));
const snapshot = await readJson(join(root, 'scripts/mcp-budget.snapshot.json'));
const digest = catalogDigest(snapshot);

async function fileEvidence(entry, directory) {
  if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) fail('CAPTURE_REQUIRED', '认证必须引用实际捕获文件及SHA256，不能只给通过布尔值。');
  const path = await realpath(resolve(directory, entry.path));
  const inside = relative(await realpath(directory), path);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) fail('CAPTURE_SCOPE', '认证捕获文件必须位于认证目录内。');
  const info = await stat(path);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) fail('CAPTURE_LIMIT', '单个工具上下文捕获必须为不超过2MiB的普通文件。');
  const bytes = await readFile(path);
  if (sha(bytes) !== entry.sha256) fail('CAPTURE_CHANGED', '认证捕获文件SHA256不匹配。');
  return bytes.toString('utf8');
}

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--package' || !isAbsolute(args[1]))) fail('INVALID_ARGUMENT', 'Usage: node scripts/check-mcp-host.mjs [--package ABSOLUTE_PACKAGE_DIRECTORY]');
  if (args.length) await verifyMcpPackageManifest(args[1], digest);
  let certificate;
  try { certificate = await readJson(certificatePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let observed = '';
    try {
      const report = await readJson(join(root, 'artifacts/codex-loopback-discovery-code-mode-incremental-search/summary.json'));
      observed = ` 已有独立CLI协议夹具：通知${report.notifications}次，后续工具可调用=${report.callableAfterDiscovery}；它不能替代桌面认证。`;
    } catch { /* No diagnostic fixture is required for a fail-closed gate. */ }
    fail('DESKTOP_CERTIFICATE_MISSING', `缺少当前目录对应的Codex桌面认证工件 ${certificatePath}。${observed}`);
  }
  if (certificate.schemaVersion !== 1 || certificate.catalogDigest !== digest) fail('CATALOG_CERTIFICATE_STALE', `认证目录摘要不匹配。当前catalogDigest=${digest}`);
  const host = certificate.host;
  if (host?.kind !== policy.requiredHost || !host.version || !isAbsolute(host.executable ?? '') || basename(host.executable).toLowerCase() !== 'codex.exe' || /[\\/]bin[\\/]/i.test(host.executable)) {
    fail('DESKTOP_HOST_REQUIRED', '需要实际Codex桌面版本及可执行文件，CLI/loopback/SDK验收不能作为桌面认证。');
  }
  const hash = createHash('sha256'); for await (const chunk of createReadStream(host.executable)) hash.update(chunk);
  if (hash.digest('hex') !== host.executableSha256) fail('HOST_VERSION_CHANGED', '当前桌面可执行文件与认证版本指纹不同。');
  if (process.platform !== 'win32') fail('DESKTOP_PLATFORM_REQUIRED', '本项目的桌面认证需要核对实际Windows版本文件。');
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const version = spawnSync(shell, ['-NoProfile', '-Command', '[Diagnostics.FileVersionInfo]::GetVersionInfo($env:AGENTVIEWER_HOST_EXECUTABLE).FileVersion'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENTVIEWER_HOST_EXECUTABLE: host.executable } });
  if (version.status !== 0 || version.stdout.trim() !== host.version) fail('HOST_VERSION_CHANGED', '认证桌面版本号与实际可执行文件不同。');
  const tokenizer = policy.exactTokenizers.find(value => value.id === certificate.tokenizer?.id && value.models?.includes(certificate.model));
  if (!tokenizer || !/^[a-f0-9]{64}$/.test(tokenizer.verifiedSourceSha256 ?? '') || !['o200k_base', 'cl100k_base'].includes(tokenizer.encoding)) {
    fail('EXACT_TOKENIZER_UNVERIFIED', '当前模型没有经核实的精确tokenizer及宿主序列化映射；未知计数或参考profile不能放行。');
  }
  const { default: ranks } = await import('js-tiktoken/ranks/' + tokenizer.encoding);
  if (sha(stable(ranks)) !== tokenizer.ranksSha256) fail('TOKENIZER_CHANGED', '精确tokenizer词表与认证策略不符。');
  const encoder = new Tiktoken(ranks);
  const directory = dirname(certificatePath), formats = Object.keys(snapshot.formats);
  for (const type of formats) {
    const entry = certificate.formats?.[type];
    if (!entry || entry.serialization !== 'model-visible-format-tool-context' || entry.sharedIncluded !== false || entry.retainedSchemasIncluded !== true) fail('FORMAT_CAPTURE_REQUIRED', `${type}缺少包含旧披露内容的实际格式工具上下文。`);
    const context = await fileEvidence(entry.context, directory), events = (await fileEvidence(entry.events, directory)).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const owned = snapshot.formats[type].tools.map(tool => tool.name);
    if (!owned.every(name => context.includes(name))) fail('INCOMPLETE_FORMAT_CAPTURE', `${type}捕获未包含基础及全部高级工具。`);
    const initial = events.find(event => event.event === 'tools/list' && event.phase === 'initial');
    const loaded = events.find(event => event.event === 'tools/list' && event.phase === 'loaded');
    if (stable([...(initial?.tools ?? [])].sort()) !== stable(['av_tools', 'av_workspace']) || !owned.every(name => loaded?.tools?.includes(name))) fail('ACTUAL_DISCLOSURE_REQUIRED', `${type}缺少真实两入口到格式工具的目录加载记录。`);
    const call = events.find(event => event.event === 'tools/call' && owned.includes(event.tool) && event.id === entry.verifiedCall);
    const result = events.find(event => event.event === 'tools/result' && event.id === entry.verifiedCall && event.status === 'success');
    if (!call || !result) fail('ACTUAL_TOOL_CALL_REQUIRED', `${type}缺少实际格式工具调用及成功回执。`);
    const tokens = encoder.encode(context, [], []).length;
    if (!Number.isSafeInteger(entry.tokens) || entry.tokens !== tokens || tokens <= 0 || tokens > policy.formatLimit) fail('FORMAT_TOKEN_LIMIT', `${type}实际注入计数${tokens}/${policy.formatLimit}，与认证记录不符或超限。`);
  }
  console.log(`Codex desktop host certified: ${host.version}; catalog ${digest}; ${formats.length} formats <= ${policy.formatLimit} exact tokens.`);
} catch (error) {
  console.error('MCP_HOST_RELEASE_BLOCKED: ' + (error instanceof Error ? error.message : String(error)));
  console.error('Build remains available. Portable packaging and local replacement require verified desktop evidence; no passing certificate is generated by this check.');
  process.exitCode = 1;
}
