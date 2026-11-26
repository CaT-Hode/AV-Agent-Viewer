import { BrowserWindow, nativeTheme } from 'electron';
import { join } from 'node:path';

export const supportedDocument = /\.(?:md|markdown|mdown|txt|doc|docx|ppt|pptx|xls|xlsx|pdf|html?)$/i;

export function newReaderWindow(id: string) {
  return new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, frame: false, show: false,
    title: 'AgentViewer', icon: join(__dirname, '../../assets/agentviewer.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171c23' : '#f5f6f9',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, additionalArguments: ['--agentviewer-window=' + id] },
  });
}

export function revealWindow(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
