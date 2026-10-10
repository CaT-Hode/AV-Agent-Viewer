import { contextBridge, ipcRenderer } from 'electron';
const windowId = process.argv.find(arg => arg.startsWith('--agentviewer-window='))?.split('=')[1] ?? 'main';
contextBridge.exposeInMainWorld('agentViewer', {
  windowId,
  onSelectionTool: (callback: (value: Record<string, unknown>) => void) => { const listener = (_event: unknown, value: Record<string, unknown>) => callback(value); ipcRenderer.on('agentviewer:selection-tool', listener); return () => ipcRenderer.removeListener('agentviewer:selection-tool', listener); },
  onToolbar: (callback: (value: Record<string, unknown>) => void) => { const listener = (_event: unknown, value: Record<string, unknown>) => callback(value); ipcRenderer.on('agentviewer:toolbar', listener); return () => ipcRenderer.removeListener('agentviewer:toolbar', listener); },
  call: (method: string, args: Record<string, unknown> = {}) => ipcRenderer.invoke('agentviewer:command', { method, args }),
  onSettingsChanged: (callback: (snapshot: unknown) => void) => { const listener = (_event: unknown, snapshot: unknown) => callback(snapshot); ipcRenderer.on('agentviewer:settings-changed', listener); return () => ipcRenderer.removeListener('agentviewer:settings-changed', listener); },
  onSettingsNavigate: (callback: (category: string) => void) => { const listener = (_event: unknown, category: string) => callback(category); ipcRenderer.on('agentviewer:settings-navigate', listener); return () => ipcRenderer.removeListener('agentviewer:settings-navigate', listener); },
});
