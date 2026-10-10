import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';

const root = resolve('.'), engineDir = join(root, '.engines');
const lock = JSON.parse(await readFile(join(root, 'engines.lock.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('内置引擎准备目前仅支持 Windows x64。');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const verifyFile = async (path, expected) => existsSync(path) && hash(await readFile(path)) === expected;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 600_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} 执行失败：${result.error ?? result.status}`);
};
async function download(url, target, expected) {
  if (await verifyFile(target, expected)) return;
  await mkdir(resolve(target, '..'), { recursive: true });
  const temporary = target + '.partial';
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载失败：${url} (${response.status})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  assert.equal(hash(await readFile(temporary)), expected, `下载摘要不匹配：${url}`);
  await rename(temporary, target);
}

await mkdir(engineDir, { recursive: true });
const downloads = join(engineDir, 'downloads');
const pythonArchive = join(downloads, 'python-3.12.10-embed-amd64.zip');
const officeInstaller = join(downloads, 'LibreOffice_26.8.1_Win_x86-64.msi');
const pythonRoot = join(engineDir, 'babeldoc-runtime'), python = join(pythonRoot, 'python.exe');
const babelHome = join(engineDir, 'babeldoc-home');
if (!existsSync(python)) {
  await download(lock.babeldoc.pythonEmbedUrl, pythonArchive, lock.babeldoc.pythonEmbedSha256);
  const zip = await JSZip.loadAsync(await readFile(pythonArchive));
  await mkdir(pythonRoot, { recursive: true });
  for (const entry of Object.values(zip.files)) {
    const target = resolve(pythonRoot, entry.name);
    assert.ok(target.startsWith(pythonRoot + sep) || target === pythonRoot, 'Python 压缩包包含越界路径');
    if (entry.dir) await mkdir(target, { recursive: true });
    else { await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, await entry.async('nodebuffer')); }
  }
}
const sitePackages = join(pythonRoot, 'Lib', 'site-packages');
if (!existsSync(join(sitePackages, 'babeldoc'))) {
  const uv = process.env.AGENTVIEWER_UV ?? 'uv';
  const venv = join(engineDir, 'babeldoc'), venvPython = join(venv, 'Scripts', 'python.exe');
  if (!existsSync(venvPython)) run(uv, ['venv', venv, '--python', '3.12']);
  run(uv, ['pip', 'install', '--python', venvPython, '-r', join(root, 'engines-requirements.txt')]);
  await cp(join(venv, 'Lib', 'site-packages'), sitePackages, { recursive: true, force: true });
  await writeFile(join(pythonRoot, 'python312._pth'), 'python312.zip\n.\nLib\\site-packages\nimport site\n');
}
if (!existsSync(join(babelHome, '.cache', 'babeldoc', 'models'))) {
  await mkdir(babelHome, { recursive: true });
  run(python, ['-m', 'babeldoc.main', '--warmup'], { env: { ...process.env, USERPROFILE: babelHome } });
}
const office = join(engineDir, 'libreoffice-stage', 'program', 'soffice.com');
if (!existsSync(office)) {
  await download(lock.libreoffice.installerUrl, officeInstaller, lock.libreoffice.installerSha256);
  run('msiexec.exe', ['/a', officeInstaller, '/qn', `TARGETDIR=${join(engineDir, 'libreoffice-stage')}`]);
  assert.ok(existsSync(office), 'LibreOffice 管理安装未产生 soffice.com');
}
for (const [language, source] of Object.entries(lock.ocr.sources)) {
  const target = join(root, 'assets', 'ocr', 'lang', `${language}.traineddata.gz`);
  if (await verifyFile(target, lock.ocr.languages[language])) continue;
  const raw = join(downloads, `${language}.traineddata`);
  await download(source.url, raw, source.sha256);
  const compressed = gzipSync(await readFile(raw), { level: 9 });
  assert.equal(hash(compressed), lock.ocr.languages[language], `OCR 语言包摘要不匹配：${language}`);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, compressed);
}
run(process.execPath, [join(root, 'scripts', 'verify-engines.mjs')]);
