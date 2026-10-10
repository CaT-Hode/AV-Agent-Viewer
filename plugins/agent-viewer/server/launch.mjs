import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = process.env.AGENTVIEWER_DATA_DIR ?? join(process.env.APPDATA ?? process.env.HOME ?? '.', 'AgentViewer');
const configPath = process.env.AGENTVIEWER_CONNECTION_FILE ?? join(dataDir, 'runtime/connection.json');
try {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.protocolVersion !== '1.0') throw new Error('AgentViewer 协议版本不兼容。');
  const serverPath = config.mcpPath ?? join(root, 'dist/mcp/index.mjs');
  if (!existsSync(serverPath)) throw new Error('请先在 AgentViewer 项目执行 npm run build。');
  const child = spawn(process.execPath, [serverPath], { stdio: 'inherit', env: { ...process.env, AGENTVIEWER_CONNECTION_FILE: configPath }, windowsHide: true });
  child.on('exit', code => process.exit(code ?? 1));
  child.on('error', error => { process.stderr.write(String(error) + '\n'); process.exit(1); });
} catch (error) { process.stderr.write('AgentViewer MCP 连接失败：' + String(error) + '\n'); process.exit(1); }
