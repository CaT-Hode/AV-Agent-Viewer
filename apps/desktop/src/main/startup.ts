import './safe-stdio-init';
import { app, dialog, protocol, type BrowserWindow } from 'electron';
import { isAbsolute, join } from 'node:path';
import { dataDir } from '../../../../packages/sdk/src/discovery';
import { newReaderWindow, revealWindow, supportedDocument } from './reader-window';

const openingPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AgentViewer</title>
<style>:root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;place-content:center;text-align:center;
background:#f5f6f9;color:#273746;font:14px "Segoe UI",sans-serif;-webkit-app-region:drag}strong{font-size:23px}
@media(prefers-color-scheme:dark){body{background:#171c23;color:#edf2f6}}</style>
<strong>AgentViewer</strong><p role="status">正在打开工作区…</p></html>`;

app.setName('AgentViewer');
app.setPath('userData', dataDir());
protocol.registerSchemesAsPrivileged([{ scheme: 'agentviewer-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let initial: BrowserWindow | undefined, workbench: typeof import('./index') | undefined;
  const files = new Set<string>();
  const collect = (argv: string[]) => {
    for (const path of argv) if (isAbsolute(path) && supportedDocument.test(path)) files.add(path);
  };
  const activate = () => { if (!workbench?.activateWorkbench() && initial) revealWindow(initial); };
  collect(process.argv);
  app.on('second-instance', (_event, argv) => { collect(argv); activate(); });
  app.on('activate', activate);
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(async () => {
    initial = newReaderWindow('main');
    revealWindow(initial);
    await initial.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(openingPage));
    if (initial.isDestroyed()) return;
    // Parse and initialize document engines only after the opening page exists.
    workbench = require(join(__dirname, 'workbench.cjs')) as typeof import('./index');
    await workbench.startWorkbench(initial, files);
  }).catch(error => {
    if (initial?.isDestroyed()) return;
    dialog.showErrorBox('AgentViewer 启动失败', String(error));
    app.exit(1);
  });
}
