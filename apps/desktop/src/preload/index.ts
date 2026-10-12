import { contextBridge, ipcRenderer, webUtils } from 'electron';
const windowId = process.argv.find(arg => arg.startsWith('--agentviewer-window='))?.split('=')[1] ?? 'main';
contextBridge.exposeInMainWorld('agentViewer', {
  windowId,
  testMode: process.argv.includes('--agentviewer-test-mode=1'),
  onBeforeClose: (callback: (options: { documentId?: string; checkOnly?: boolean }) => Promise<void>) => { const listener = (_event: unknown, request: { id: string; documentId?: string; checkOnly?: boolean }) => { const id = request.id; void Promise.resolve().then(() => callback(request)).then(() => ipcRenderer.invoke('agentviewer:close-flushed', { id }), error => ipcRenderer.invoke('agentviewer:close-flushed', { id, error: String(error) })); }; ipcRenderer.on('agentviewer:before-close', listener); return () => ipcRenderer.removeListener('agentviewer:before-close', listener); },
  openDroppedFiles: (files: File[]) => ipcRenderer.invoke('agentviewer:command', { method: 'drop-files', args: { paths: files.map(file => webUtils.getPathForFile(file)).filter(Boolean) } }),
  onSelectionTool: (callback: (value: Record<string, unknown>) => void) => { const listener = (_event: unknown, value: Record<string, unknown>) => callback(value); ipcRenderer.on('agentviewer:selection-tool', listener); return () => ipcRenderer.removeListener('agentviewer:selection-tool', listener); },
  onToolbar: (callback: (value: Record<string, unknown>) => void) => { const listener = (_event: unknown, value: Record<string, unknown>) => callback(value); ipcRenderer.on('agentviewer:toolbar', listener); return () => ipcRenderer.removeListener('agentviewer:toolbar', listener); },
  call: (method: string, args: Record<string, unknown> = {}) => ipcRenderer.invoke('agentviewer:command', { method, args }),
  onSettingsChanged: (callback: (snapshot: unknown) => void) => { const listener = (_event: unknown, snapshot: unknown) => callback(snapshot); ipcRenderer.on('agentviewer:settings-changed', listener); return () => ipcRenderer.removeListener('agentviewer:settings-changed', listener); },
  onSettingsNavigate: (callback: (category: string) => void) => { const listener = (_event: unknown, category: string) => callback(category); ipcRenderer.on('agentviewer:settings-navigate', listener); return () => ipcRenderer.removeListener('agentviewer:settings-navigate', listener); },
});
