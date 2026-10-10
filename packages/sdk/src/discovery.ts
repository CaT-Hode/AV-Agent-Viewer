import { join } from 'node:path';
export function dataDir() { return process.env.AGENTVIEWER_DATA_DIR ?? join(process.env.APPDATA ?? process.env.HOME ?? '.', 'AgentViewer'); }
