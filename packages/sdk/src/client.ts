import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './discovery';
import { PROTOCOL_VERSION } from '../../contracts/src/index';
import { requestLoopbackJson } from './loopback-json-request';
import type { SelectionContext, SelectionContextLease } from '../../contracts/src/index';

export async function connection() {
  const config = JSON.parse(await readFile(process.env.AGENTVIEWER_CONNECTION_FILE ?? join(dataDir(), 'runtime/connection.json'), 'utf8')) as { endpoint: string; token: string; protocolVersion: string };
  if (config.protocolVersion !== PROTOCOL_VERSION) throw new Error('AgentViewer 协议版本不兼容。');
  const url = new URL(config.endpoint); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('本地发现文件只能指向 loopback。');
  return config;
}
export async function call(method: string, args: Record<string, unknown> = {}) {
  const config = await connection();
  const response = await requestLoopbackJson(new URL(config.endpoint + '/api/command'), config.token, JSON.stringify({ method, args }));
  const data = response.data as { error?: { code: string; message: string } };
  if (!response.ok) throw new Error(`${data.error?.code}: ${data.error?.message}`); return data;
}
export async function selectionContext(viewId: string, expected?: SelectionContextLease) {
  return await call('selection-context', { viewId, expected }) as unknown as { selectionContext: SelectionContext; actions: { action: string; label: string }[] };
}
export async function exportRecovery(path: string) { return call('workspace-export-recovery',{path}); }
