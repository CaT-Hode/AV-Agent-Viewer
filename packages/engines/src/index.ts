import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type EngineLaunch = { command: string; argsPrefix: string[]; env?: NodeJS.ProcessEnv; source: 'bundled' | 'override' | 'system' };
export type EngineHealth = { available: boolean; source?: EngineLaunch['source']; path?: string; version?: string; license: string; offlineReady?: boolean; reason?: string };

const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
export function engineRoots(appRoot: string) {
  return [process.env.AGENTVIEWER_ENGINES_DIR, resourcesPath && join(resourcesPath, 'engines'), join(appRoot, '.engines')].filter((path): path is string => !!path).map(path => resolve(path));
}
function onPath(command: string) { return spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { windowsHide: true }).status === 0; }

export function pandocExecutable(appRoot: string) {
  const override = process.env.AGENTVIEWER_PANDOC;
  if (override) return existsSync(override) ? {path:override,source:'override' as const} : undefined;
  for (const base of engineRoots(appRoot)) { const path=join(base,'pandoc',process.platform==='win32'?'pandoc.exe':'pandoc'); if(existsSync(path))return {path,source:'bundled' as const}; }
  return onPath('pandoc') ? {path:'pandoc',source:'system' as const} : undefined;
}

export function babelDocLaunch(appRoot: string): EngineLaunch | undefined {
  const override = process.env.AGENTVIEWER_BABELDOC;
  if (override) return existsSync(override) || onPath(override) ? { command: override, argsPrefix: [], source: 'override' } : undefined;
  for (const base of engineRoots(appRoot)) {
    const home = join(base, 'babeldoc-home'), portable = join(base, 'babeldoc-runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python');
    if (existsSync(portable)) return { command: portable, argsPrefix: ['-m', 'babeldoc.main'], env: { USERPROFILE: home, HF_HUB_OFFLINE: '1' }, source: 'bundled' };
    const venv = join(base, 'babeldoc', process.platform === 'win32' ? 'Scripts/babeldoc.exe' : 'bin/babeldoc');
    if (existsSync(venv)) return { command: venv, argsPrefix: [], env: { USERPROFILE: home }, source: 'bundled' };
  }
  return onPath('babeldoc') ? { command: 'babeldoc', argsPrefix: [], source: 'system' } : undefined;
}

export function libreOfficeExecutable(appRoot: string) {
  const override = process.env.AGENTVIEWER_LIBREOFFICE;
  if (override) return existsSync(override) ? { path: override, source: 'override' as const } : undefined;
  for (const base of engineRoots(appRoot)) for (const folder of ['libreoffice', 'libreoffice-stage']) {
    const path = join(base, folder, 'program', process.platform === 'win32' ? 'soffice.com' : 'soffice');
    if (existsSync(path)) return { path, source: 'bundled' as const };
  }
  for (const path of ['C:/Program Files/LibreOffice/program/soffice.com', 'C:/Program Files (x86)/LibreOffice/program/soffice.com']) if (existsSync(path)) return { path, source: 'system' as const };
  return onPath('soffice') ? { path: 'soffice', source: 'system' as const } : undefined;
}

export function ocrLanguageDir(appRoot: string) {
  for (const base of [...engineRoots(appRoot), join(appRoot, 'assets'), resourcesPath && join(resourcesPath, 'assets')].filter((path): path is string => !!path)) {
    const path = join(base, 'ocr', 'lang');
    if (existsSync(join(path, 'eng.traineddata.gz')) && existsSync(join(path, 'chi_sim.traineddata.gz'))) return path;
  }
  return undefined;
}

export function engineHealth(appRoot: string) {
  const babeldoc = babelDocLaunch(appRoot), libreoffice = libreOfficeExecutable(appRoot), ocr = ocrLanguageDir(appRoot);
  const assets = babeldoc?.source === 'bundled' ? join(babeldoc.env!.USERPROFILE!, '.cache', 'babeldoc') : undefined;
  return {
    babeldoc: { available: !!babeldoc, source: babeldoc?.source, path: babeldoc?.command, version: babeldoc ? '0.6.4' : undefined, license: 'AGPL-3.0', offlineReady: !!assets && existsSync(join(assets, 'models')) && existsSync(join(assets, 'fonts')) && existsSync(join(assets, 'cmap')), reason: babeldoc ? undefined : '未找到随应用提供的 PDF 翻译引擎。' } satisfies EngineHealth,
    libreoffice: { available: !!libreoffice, source: libreoffice?.source, path: libreoffice?.path, version: libreoffice ? '26.8.1' : undefined, license: 'MPL-2.0 / LGPL-3.0+', offlineReady: !!libreoffice, reason: libreoffice ? undefined : '未找到随应用提供的旧 Office 转换器。' } satisfies EngineHealth,
    ocr: { available: !!ocr, source: ocr ? 'bundled' as const : undefined, path: ocr, version: ocr ? 'Tesseract.js 7.0.0' : undefined, license: 'Apache-2.0', offlineReady: !!ocr, reason: ocr ? undefined : '缺少本地中英文字库。' } satisfies EngineHealth,
    office: { available: !!libreoffice, source: libreoffice?.source, version: libreoffice ? 'LibreOffice 26.8.1 · 原生文档模型 / UNO' : undefined, license: 'LibreOffice MPL-2.0、LGPL-3.0+', offlineReady: !!libreoffice, reason: libreoffice ? undefined : '内置 Office 引擎不可用。' } satisfies EngineHealth,
  };
}
