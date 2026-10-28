import type { WorkspaceState } from '../../../../../packages/contracts/src/index';

declare global { interface Window { agentViewer?: { windowId: string; onBeforeClose(callback: (options: { documentId?: string; checkOnly?: boolean }) => Promise<void>): () => void; openDroppedFiles(files: File[]): Promise<{ views: import('../../../../../packages/contracts/src/index').ViewInfo[]; errors: string[] }>; onSelectionTool(callback: (value: Record<string, unknown>) => void): () => void; onToolbar(callback: (value: Record<string, unknown>) => void): () => void; call(method: string, args?: Record<string, unknown>): Promise<unknown>; onSettingsChanged(callback: (snapshot: unknown) => void): () => void; onSettingsNavigate(callback: (category: string) => void): () => void } } }
export const desktop = !!window.agentViewer;
export const windowId = window.agentViewer?.windowId ?? 'main';
export const ready = fetch('/internal/bootstrap', { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('本地服务连接失败'); });
export async function call<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  await ready;
  if (window.agentViewer) return window.agentViewer.call(method, args) as Promise<T>;
  const response = await fetch('/internal/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ method, args }) });
  const data = await response.json(); if (!response.ok) throw new Error(`${data.error?.code}: ${data.error?.message}`); return data as T;
}
export const state = () => call<WorkspaceState>('state');
export async function samples() { await ready; const r = await fetch('/internal/samples', { credentials: 'include' }); return r.json() as Promise<{ name: string; format: string; path: string }[]>; }
export async function bytes(id: string) { await ready; const r = await fetch('/internal/documents/' + id + '/bytes', { credentials: 'include' }); if (!r.ok) throw new Error('文件读取失败'); return new Uint8Array(await r.arrayBuffer()); }
