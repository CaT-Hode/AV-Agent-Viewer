import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile, appendFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const model = process.env.AGENTVIEWER_PROBE_MODEL ?? 'gpt-6.1-sol';
const option = process.argv.slice(2);
const incremental = option.includes('--incremental');
const codeMode = option.includes('--code-mode');
const search = option.includes('--search');
const positional = option.filter(value => !['--incremental', '--code-mode', '--search'].includes(value));
if (positional.length && !(positional.length === 2 && positional[0] === '--cli')) throw new Error('Usage: npm run mcp:host-probe -- [--cli /absolute/path/to/codex.exe] [--incremental] [--code-mode] [--search]');
if (search && !codeMode) throw new Error('--search requires --code-mode');
let cli = positional[1] ?? process.env.AGENTVIEWER_CODEX;
if (!cli) {
  const directory = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  const candidates = await Promise.all((await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(async entry => {
    const path = join(directory, entry.name, 'codex.exe');
    try { return { path, modified: (await stat(path)).mtimeMs }; } catch { return undefined; }
  }));
  cli = candidates.filter(Boolean).sort((left, right) => right.modified - left.modified)[0]?.path;
}
if (!cli) throw new Error('Set AGENTVIEWER_CODEX or pass --cli; this probe never downloads a client.');
const version = spawnSync(cli, ['--version'], { encoding: 'utf8', windowsHide: true });
if (version.status !== 0) throw new Error('Could not read the selected Codex CLI version.');
const cliVersion = version.stdout.trim();
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-host-fixture-'));
const artifact = join(root, 'artifacts', 'codex-loopback-discovery' + (codeMode ? '-code-mode' : '') + (incremental ? '-incremental' : '') + (search ? '-search' : ''));
await mkdir(artifact, { recursive: true });
const mcpLog = join(artifact, 'mcp.jsonl'), eventLog = join(artifact, 'cli-metadata.jsonl');
const targetFile = join(artifact, 'target.json');
await writeFile(mcpLog, ''); await writeFile(eventLog, '');
await rm(targetFile, { force: true });
const observations = [];
let requestIndex = 0;
function functions(tools, namespace = []) {
  const found = [];
  for (const tool of tools ?? []) {
    if (Array.isArray(tool.tools)) found.push(...functions(tool.tools, [...namespace, tool.name]));
    else if (typeof tool.name === 'string') found.push({ name: tool.name, namespace, definition: tool });
    else if (tool.function?.name) found.push({ name: tool.function.name, namespace, definition: tool.function });
  }
  return found;
}
function stream(response, index, item) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
  const envelope = { id: 'resp_fixture_' + index, object: 'response', created_at: 1, model, status: 'in_progress', output: [] };
  const emit = (type, value) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  emit('response.created', { response: envelope });
  emit('response.output_item.added', { output_index: 0, item });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: { ...envelope, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  response.end();
}
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 16 * 1024 * 1024) throw new Error('Fixture request too large'); }
    const value = JSON.parse(body), index = ++requestIndex, available = functions(value.tools);
    // Only tool metadata is retained. Headers, instructions, source text,
    // credentials and complete model inputs are never written to artifacts.
    await writeFile(join(artifact, 'request-' + index + '-tools.json'), JSON.stringify(value.tools ?? [], null, 2) + '\n');
    const names = available.map(tool => [...tool.namespace, tool.name].join('.'));
    const instructions = (Array.isArray(value.input) ? value.input : []).filter(item => ['developer', 'system'].includes(item.role));
    const promptNames = [...new Set(JSON.stringify(instructions).match(/\bmcp__av_probe(?:__|\.)[a-z0-9_]+/g) ?? [])];
    const toolOutputs = (Array.isArray(value.input) ? value.input : []).filter(item => /tool_call_output$/.test(item.type ?? '')).map(item => {
      const text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      return { type: item.type, diagnostic: /not a function|unknown tool|not available|tool.*not found|is not defined/i.test(text) ? 'TOOL_UNAVAILABLE' : /error|failed/i.test(text) ? 'ERROR' : 'NONE' };
    });
    observations.push({ request: index, requestKeys: Object.keys(value).sort(), names, promptNames, toolOutputs, hasMarkdownBlocks: names.some(name => name.endsWith('av_md_blocks')) });
    const steps = search ? ['load', 'search', 'blocks'] : ['load', 'blocks'];
    if (index <= steps.length) {
      const step = steps[index - 1];
      const base = available.find(tool => tool.name.endsWith('av_tools'));
      if (codeMode) {
        const symbol = promptNames.find(name => name.endsWith('av_tools'))?.replace('.', '__') ?? 'mcp__av_probe__av_tools';
        const name = step === 'load' ? symbol : symbol.replace(/av_tools$/, 'av_md_blocks');
        const target = await readFile(targetFile, 'utf8').then(JSON.parse);
        const input = step === 'search' ? 'await tools.tool_search({query:"av_md_blocks",limit:8});'
          : `await tools.${name}(${JSON.stringify(step === 'load' ? { type: 'markdown', pack: 'base' } : { ref: target.ref })});`;
        stream(response, index, { id: 'ct_fixture_' + index, type: 'custom_tool_call', call_id: 'call_fixture_' + index, name: 'exec', namespace: 'functions', input, status: 'completed' });
        return;
      }
      if (!base) throw new Error('Codex request did not advertise the av_tools bootstrap tool; code-mode-only models need --code-mode');
      const name = index === 1 ? base.name : base.name.replace(/av_tools$/, 'av_md_blocks');
      const target = await readFile(targetFile, 'utf8').then(JSON.parse);
      stream(response, index, { id: 'fc_fixture_' + index, type: 'function_call', call_id: 'call_fixture_' + index, name, ...(base.namespace.length ? { namespace: base.namespace.join('.') } : {}), arguments: JSON.stringify(index === 1 ? { type: 'markdown', pack: 'base' } : { ref: target.ref }), status: 'completed' });
    } else {
      stream(response, index, { id: 'msg_fixture_done', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"fixtureDone":true}', annotations: [] }] });
    }
  } catch (error) {
    await appendFile(eventLog, JSON.stringify({ event: 'fixture-error', message: error instanceof Error ? error.message : 'UNKNOWN' }) + '\n');
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end('{"error":{"message":"local discovery fixture failed"}}');
  }
});
server.listen(0, '127.0.0.1'); await new Promise(resolveListening => server.once('listening', resolveListening));
const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
const quote = JSON.stringify;
const mcp = '{command=' + quote(process.execPath) + ',args=' + quote([join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/codex-discovery-fixture.ts')]) + ',env={AGENTVIEWER_PROBE_LOG=' + quote(mcpLog) + ',AGENTVIEWER_PROBE_DIR=' + quote(directory) + ',AGENTVIEWER_PROBE_TARGET_FILE=' + quote(targetFile) + ',AGENTVIEWER_PROBE_SEED_REFS="1"},required=true,startup_timeout_sec=20,tool_timeout_sec=20}';
const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '--cd', directory,
  '-c', 'model=' + quote(model), '-c', 'model_provider="av_loopback"',
  '-c', 'model_providers.av_loopback={name="AgentViewer local protocol fixture",base_url=' + quote(baseUrl) + ',wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}',
  '-c', 'mcp_servers={av_probe=' + mcp + '}'];
for (const feature of ['apps', 'plugins', 'memories', 'multi_agent', 'shell_tool', 'unified_exec', 'code_mode']) args.push('-c', 'features.' + feature + '=false');
if (codeMode) args.push('-c', 'features.code_mode=true');
if (incremental) args.push('-c', 'features.incremental_tools=true');
if (search) args.push('-c', 'features.code_mode_tool_search=true');
args.push('Local deterministic protocol fixture. Execute the supplied MCP calls; do not use shell or filesystem tools.');
const environment = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }; delete environment.ELECTRON_RUN_AS_NODE;
delete environment.OPENAI_API_KEY; delete environment.CODEX_API_KEY; delete environment.OPENAI_BASE_URL;
const child = spawn(cli, args, { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let pending = '', timedOut = false, stderrBytes = 0;
child.stdout.on('data', chunk => {
  pending += chunk.toString(); let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try {
      const value = JSON.parse(line), item = value.item ?? {};
      const error = item.type === 'error' ? String(item.message ?? item.error?.message ?? '') : value.type === 'error' ? String(value.message ?? value.error?.message ?? '') : '';
      const redacted = error.replace(/https?:\/\/[^\s)]+/g, '[url]').replace(/[A-Z]:\\[^\s]+/gi, '[path]').replace(/(?:Bearer\s+|sk-)[\w.-]+/gi, '[secret]').slice(0, 400);
      void appendFile(eventLog, JSON.stringify({ event: value.type, itemType: item.type, tool: item.tool, server: item.server, status: item.status, ...(error ? { diagnostic: redacted } : {}) }) + '\n');
    } catch { /* Human diagnostics are not retained. */ }
  }
});
child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
const exitCode = await new Promise(resolveExit => child.once('exit', resolveExit)); clearTimeout(timeout);
server.closeAllConnections(); await new Promise(resolveClosed => server.close(resolveClosed));
const wire = (await readFile(mcpLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const result = {
  kind: 'deterministic loopback Responses protocol fixture; not model semantic acceptance', cliVersion, model,
  discoveryFlags: { incremental_tools: incremental ? true : 'default', code_mode: codeMode, code_mode_tool_search: search ? true : 'default' }, exitCode, timedOut, requests: observations,
  notifications: wire.filter(event => event.event === 'wire-list-changed').length,
  catalogs: wire.filter(event => event.event === 'wire-tools-list').map(event => event.tools),
  actualMcpCalls: wire.filter(event => event.event === 'invoke').map(event => event.tool),
  callableAfterDiscovery: wire.some(event => event.event === 'result' && event.tool === 'av_md_blocks'),
  schemaInjectedAfterDiscovery: observations.slice(1).some(value => value.hasMarkdownBlocks),
  declaredNameInSystemPromptAfterDiscovery: observations.slice(1).some(value => value.promptNames.some(name => name.endsWith('av_md_blocks'))),
  tokenizerCertified: false, desktopHostCertified: false, stderrBytes
};
await writeFile(join(artifact, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
const absoluteDirectory = resolve(directory);
if (dirname(absoluteDirectory) !== resolve(tmpdir()) || !basename(absoluteDirectory).startsWith('agentviewer-host-fixture-') || (await lstat(absoluteDirectory)).isSymbolicLink()) throw new Error('Unexpected owned fixture directory');
await rm(absoluteDirectory, { recursive: true, force: true });
if (exitCode !== 0 || timedOut || !result.callableAfterDiscovery || !codeMode && !result.schemaInjectedAfterDiscovery) process.exitCode = 1;
