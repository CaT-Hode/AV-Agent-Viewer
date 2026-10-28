import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentTools, catalogVersion, formatInstructions } from '../packages/sdk/src/agent-tools.ts';
import { AgentSession } from '../packages/sdk/src/agent-session.ts';
import { ViewerCore } from '../packages/document-core/src/index.ts';
import { officeAuthoringCapabilities, officeAuthoringFormats } from '../packages/office-runtime/src/authoring.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const update = process.argv.slice(2).includes('--update');
if (process.argv.slice(2).some(argument => argument !== '--update')) throw new Error('Usage: npm run mcp:budget -- [--update]');
const lock = JSON.parse(await readFile(join(root, 'scripts/mcp-tokenizer.lock.json'), 'utf8'));
if (lock.limits.formatHard !== 5000 || lock.limits.formatRaw > 4500
  || lock.limits.sharedEntry > 1200 || lock.limits.sharedAll > 2500) {
  throw new Error('MCP context limits may not exceed the agreed 4500/5000 format and 1200/2500 shared budgets');
}
const tokenizerRoot = resolve(dirname(require.resolve('js-tiktoken/lite')), '..');
const tokenizerPackage = JSON.parse(await readFile(join(tokenizerRoot, 'package.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
if (tokenizerPackage.version !== lock.version) throw new Error(`Tokenizer version changed: ${tokenizerPackage.version}; expected ${lock.version}`);
// All encoding data is bundled by the exact npm dependency. No model lookup,
// network download, Python installation or character/byte estimate is used.
const { Tiktoken } = await import('js-tiktoken/lite');
const encoders = Object.fromEntries(await Promise.all(['o200k_base', 'cl100k_base'].map(async name => {
  const { default: ranks } = await import('js-tiktoken/ranks/' + name);
  return [name, new Tiktoken(ranks)];
})));
const count = value => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const profiles = Object.fromEntries(Object.entries(encoders).map(([name, encoder]) => [name, encoder.encode(serialized, [], []).length]));
  return { ...profiles, max: Math.max(...Object.values(profiles)) };
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const formats = ['markdown', 'html', 'docx', 'xlsx', 'pptx', 'pdf', 'web'];
const registry = new Map(agentTools.map(tool => [tool.name, tool]));
if (registry.size !== agentTools.length) throw new Error('Duplicate public tool names in registry');
for (const tool of agentTools) {
  if (tool.owner !== 'shared' && !formats.includes(tool.owner)) throw new Error('Invalid tool owner: ' + tool.name);
}
const initialNames = ['av_tools', 'av_workspace'];
const sortTools = tools => tools.map(canonical).sort((left, right) => left.name.localeCompare(right.name, 'en'));
const shared = new Map();
const sharedInstructions = await Promise.all(['reading', 'editing'].map(async name => ({
  name, text: (await readFile(join(root, 'plugins/agent-viewer/skills', name, 'SKILL.md'), 'utf8')).replaceAll('\r\n', '\n')
})));
const report = { version: 1, profile: lock.profile, host: 'Codex host overhead/tokenizer NOT certified', limits: lock.limits, entry: null, shared: null, formats: {} };
const errors = [];
const assertLimit = (name, tokens, limit) => { if (tokens.max > limit) errors.push(`${name}: ${tokens.max}/${limit} tokens`); };

async function listAllTools(client) {
  const tools = [], cursors = new Set();
  let cursor;
  do {
    const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000 });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 32)) throw new Error('Tool catalog cursor loop or unbounded pagination');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate tool names in wire catalog');
  return sortTools(tools);
}

async function inspect(format) {
  // Type-only discovery must not touch documents or engines. Compare the real
  // service path with the isolated wire path so its budget cannot accidentally
  // certify a smaller, divergent catalog-only implementation.
  const service = new AgentSession(new ViewerCore({ load: async () => undefined, save: async () => {} }), 'budget:' + format, root);
  const client = new Client({ name: 'agentviewer-context-budget', version: '0.2.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', join(root, 'apps/local-service/src/mcp.ts')], cwd: root,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), AGENTVIEWER_CATALOG_ONLY: '1' },
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
  try {
    await client.connect(transport, { timeout: 15000 });
    const initial = await listAllTools(client);
    if (stable(initial.map(tool => tool.name)) !== stable(initialNames)) throw new Error('Bootstrap catalog must contain only av_tools and av_workspace');
    if (!report.entry) {
      report.entry = { tokens: count(stable(initial)), hash: hash(stable(initial)), tools: initial.map(tool => tool.name) };
      assertLimit('shared entry', report.entry.tokens, lock.limits.sharedEntry);
    }
    const disclosures = [];
    const packs = ['base', ...new Set(agentTools.filter(tool => tool.owner === format && tool.pack !== 'base').map(tool => tool.pack)), 'all'];
    for (const pack of packs) {
      const discovery = await client.callTool({ name: 'av_tools', arguments: { type: format, pack } }, undefined, { timeout: 15000 });
      if (discovery.isError) throw new Error('Catalog discovery failed: ' + JSON.stringify(discovery));
      const serviceDisclosure = await service.invoke('av_tools', { type: format, pack });
      const textBlock = discovery.content?.find(block => block.type === 'text');
      if (!textBlock || stable(JSON.parse(textBlock.text)) !== stable(serviceDisclosure)) throw new Error(`${format}/${pack}: catalog-only and live AgentSession discovery differ`);
      disclosures.push(canonical(discovery));
      const stage = await listAllTools(client);
      for (const actual of stage) {
        const owner = registry.get(actual.name)?.owner;
        if (owner !== 'shared' && owner !== format) throw new Error(`${format}/${pack} leaks a tool from ${owner}: ${actual.name}`);
      }
    }
    const tools = await listAllTools(client);
    const owned = [];
    for (const tool of tools) {
      const registered = registry.get(tool.name);
      if (!registered) throw new Error('Wire catalog tool is absent from registry: ' + tool.name);
      if (registered.owner === 'shared') {
        if (shared.has(tool.name) && stable(shared.get(tool.name)) !== stable(tool)) throw new Error('Shared schema changed between formats: ' + tool.name);
        shared.set(tool.name, tool);
      } else if (registered.owner !== format) {
        throw new Error(`${format} catalog leaks ${registered.owner} tool ${tool.name}`);
      } else owned.push(tool);
    }
    const missing = agentTools.filter(tool => tool.owner === format && !owned.some(actual => actual.name === tool.name));
    if (missing.length) throw new Error(`${format} pack=all omitted registered advanced tools: ${missing.map(tool => tool.name).join(', ')}`);
    const instruction = formatInstructions[format];
    if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('Missing format instructions: ' + format);
    // Count every distinct pack discovery, including wrappers and action
    // catalogs carried as results. Format instructions must appear once during
    // progressive loading. Moving schemas into results cannot evade the budget.
    const instructionOccurrences = disclosures.filter(value => stable(value).includes(JSON.stringify(instruction).slice(1, -1))).length;
    if (instructionOccurrences !== 1) throw new Error(`${format} instructions must be disclosed once; received ${instructionOccurrences}`);
    // A type-only discovery cannot query a live driver. A later ref-based
    // discovery can still disclose its native capabilities once. Count that
    // complete additional MCP response, using the exact worker manifest and
    // both actual driver variants, for every legal pack. No duplicate list of
    // operation names or character/byte estimate is allowed here.
    const capabilityVariants = officeAuthoringFormats.includes(format) ? [false, true].flatMap(docCall =>
      [...new Set([...packs, 'read', 'lifecycle', 'files', 'analysis'])].map(pack => ({
        docCall, pack, disclosure: { content: [{ type: 'text', text: JSON.stringify({ version: catalogVersion, type: format, pack, tools: [], capabilities: officeAuthoringCapabilities(format, docCall) }) }] }
      }))) : [];
    const contexts = capabilityVariants.length ? capabilityVariants.map(value => ({ tools: owned, disclosures: [...disclosures, value.disclosure] })) : [{ tools: owned, disclosures }];
    const contextCounts = contexts.map(value => count(stable(value)));
    const tokens = Object.fromEntries([...Object.keys(encoders), 'max'].map(profile => [profile, Math.max(...contextCounts.map(value => value[profile]))]));
    const context = { tools: owned, disclosures, ...(capabilityVariants.length ? { capabilityVariants } : {}) };
    assertLimit(format + ' raw', tokens, lock.limits.formatRaw);
    assertLimit(format + ' hard', tokens, lock.limits.formatHard);
    report.formats[format] = {
      tokens, reservedHostTokens: lock.limits.formatHard - lock.limits.formatRaw,
      hash: hash(stable(context)), packs,
      ...(capabilityVariants.length ? { capabilities: capabilityVariants.map(value => ({ docCall: value.docCall, pack: value.pack, tokens: count(stable(value.disclosure)) })) } : {}),
      tools: owned.map(tool => ({ name: tool.name, pack: registry.get(tool.name).pack, tokens: count(stable(tool)) }))
    };
  } catch (error) {
    throw new Error(`${format}: ${error instanceof Error ? error.message : error}${stderr ? '\nMCP stderr: ' + stderr : ''}`);
  } finally {
    await client.close();
    await service.dispose();
  }
}

for (const format of formats) await inspect(format);
const missingShared = agentTools.filter(tool => tool.owner === 'shared' && !shared.has(tool.name));
if (missingShared.length) throw new Error('Shared tools never disclosed by pack=all: ' + missingShared.map(tool => tool.name).join(', '));
const sharedTools = sortTools([...shared.values()]);
const sharedContext = { tools: sharedTools, instructions: sharedInstructions };
report.shared = { tokens: count(stable(sharedContext)), hash: hash(stable(sharedContext)), tools: sharedTools.map(tool => tool.name) };
assertLimit('shared all', report.shared.tokens, lock.limits.sharedAll);
const snapshotPath = join(root, 'scripts/mcp-budget.snapshot.json');
const serializedReport = JSON.stringify(report, null, 2) + '\n';
await mkdir(join(root, 'artifacts'), { recursive: true });
await writeFile(join(root, 'artifacts/mcp-budget.json'), serializedReport);
console.log(`MCP context: ${lock.profile}; shared entry ${report.entry.tokens.max}/${lock.limits.sharedEntry}; all shared ${report.shared.tokens.max}/${lock.limits.sharedAll}`);
for (const [format, value] of Object.entries(report.formats)) console.log(`  ${format}: ${value.tokens.max}/${lock.limits.formatRaw} raw tokens, ${value.tools.length} tools, ${value.reservedHostTokens} reserved for host`);
console.log('Reference tokenizer profile only. Codex host serialization/current-model tokenizer is not certified.');
if (errors.length) throw new Error('MCP context budget exceeded:\n' + errors.join('\n'));
if (update) {
  await writeFile(snapshotPath, serializedReport);
  console.log('Updated scripts/mcp-budget.snapshot.json; review catalog and token deltas.');
} else {
  let snapshot;
  try { snapshot = (await readFile(snapshotPath, 'utf8')).replaceAll('\r\n', '\n'); } catch { throw new Error('Missing MCP budget snapshot. Run npm run mcp:budget -- --update and review it.'); }
  if (snapshot !== serializedReport) throw new Error('MCP catalog snapshot changed. Review artifacts/mcp-budget.json, then run npm run mcp:budget -- --update.');
}
