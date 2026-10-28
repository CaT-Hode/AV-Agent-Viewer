import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, copyFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function buildOfficeKitAdapter() {
  if (process.platform !== 'win32') return;
  const root = resolve('.'), output = join(root, 'dist', 'main');
  await mkdir(output, { recursive: true });
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const result = existsSync(vswhere) ? spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }) : undefined;
  const installation = result?.status === 0 ? result.stdout.trim() : '';
  const vcvars = join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!installation || !existsSync(vcvars)) throw new Error('Windows embedded Office build needs MSVC x64 Build Tools.');
  const source = join(root, 'packages', 'office-runtime', 'native', 'office-kit-windows.cpp');
  const options = '/LD /O2 /EHsc /W4 /WX /guard:cf', destination = join(output, 'office-kit-windows.dll'), manifest = join(output, 'office-kit-windows.build.json');
  if (existsSync(destination) && existsSync(manifest)) {
    const cached = JSON.parse(await readFile(manifest, 'utf8'));
    const [sourceInfo, compilerInfo, binaryInfo] = await Promise.all([stat(source), stat(vcvars), stat(destination)]);
    if (cached.options === options && binaryInfo.mtimeMs >= sourceInfo.mtimeMs && binaryInfo.mtimeMs >= compilerInfo.mtimeMs) return;
  }
  const temp = await mkdtemp(join(tmpdir(), 'agentviewer-kit-build-'));
  const binary = join(temp, 'office-kit-windows.dll');
  const quote = value => '"' + value.replaceAll('"', '').replaceAll('%','%%') + '"';
  const batch = join(temp, 'build.cmd');
  // Native Windows shell end to end; no path deletion or cross-shell mutation.
  await writeFile(batch, `@echo off\r\nsetlocal DisableDelayedExpansion\r\ncall ${quote(vcvars)} >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo ${options} ${quote(source)} /Fo${quote(join(temp, 'adapter.obj'))} /link /OUT:${quote(binary)} /IMPLIB:${quote(join(temp, 'adapter.lib'))} /PDB:${quote(join(temp, 'adapter.pdb'))}\r\nexit /b %errorlevel%\r\n`, 'utf8');
  const compiled = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', batch], { cwd: temp, encoding: 'utf8', windowsHide: true });
  if (compiled.status !== 0) throw new Error(`Office adapter compilation failed:\n${compiled.stdout}\n${compiled.stderr}`);
  await copyFile(binary, destination);
  await writeFile(manifest, JSON.stringify({ options }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildOfficeKitAdapter();
