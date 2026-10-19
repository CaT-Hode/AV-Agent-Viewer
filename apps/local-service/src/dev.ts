import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { ViewerCore } from '../../../packages/document-core/src/index';
import { JsonWorkspaceRepository } from '../../../packages/persistence/src/index';
import { startServer } from './server';
import { CodexDriver, codexExecutable } from '../../../packages/harness-adapters/src/codex';

const root = resolve('.'), directory = process.env.AGENTVIEWER_DATA_DIR ?? join(root, '.agentviewer/preview');
const core = new ViewerCore(new JsonWorkspaceRepository(join(directory, 'workspace.json'))); await core.initialize();
const runtime = await startServer(core, root, directory);
const codex = codexExecutable(); if (codex) core.drivers.set('codex', new CodexDriver(codex, root));
if (!core.views.size) { const welcome = await core.openFile(runtime.sampleFiles[0].path); await core.openWeb(runtime.endpoint + '/fixtures/interaction.html'); await core.openFile(runtime.sampleFiles.find(f => f.format === 'pdf')!.path); core.activate(welcome.id); }
const vite = await createServer(); await vite.listen();
console.log('AgentViewer 浏览器预览：http://127.0.0.1:5173（原生网页输入在桌面模式使用）');
process.on('SIGINT', () => { void core.persist().finally(() => process.exit()); });
