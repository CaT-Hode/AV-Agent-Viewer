import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ViewerError } from '../../../packages/contracts/src/index';
import { libreOfficeExecutable } from '../../../packages/engines/src/index';

export function libreOfficePath() { return libreOfficeExecutable(process.cwd())?.path; }
export async function convertLegacy(path: string, extension: string) {
  const executable = libreOfficePath();
  if (!executable) throw new ViewerError('ENGINE_UNAVAILABLE', '旧 Office 格式需要 LibreOffice 转换器。安装后可自动发现，或设置 AGENTVIEWER_LIBREOFFICE。原文件未修改。');
  const outputDir = await mkdtemp(join(tmpdir(), 'agentviewer-convert-'));
  const profile = pathToFileURL(join(outputDir, 'profile')).href;
  const convertedFormat = ({ doc: 'docx', ppt: 'pptx', xls: 'xlsx' } as Record<string, string>)[extension];
  await promisify(execFile)(executable, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', convertedFormat, '--outdir', outputDir, path], { timeout: 120_000, windowsHide: true });
  const file = (await readdir(outputDir)).find(f => f.endsWith('.' + convertedFormat));
  if (!file) throw new ViewerError('CONVERSION_FAILED', '转换器没有返回文件。原件保留。');
  return { bytes: new Uint8Array(await readFile(join(outputDir, file))), format: convertedFormat, sourcePath: path, warnings: ['旧格式已转换；请另存现代格式并检查字体、对象和公式的保真。'] };
}
