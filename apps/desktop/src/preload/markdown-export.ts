import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('markdownExportResource', (path: string, kind?: 'image'|'media') => ipcRenderer.invoke('agentviewer:export-resource', path, kind));
