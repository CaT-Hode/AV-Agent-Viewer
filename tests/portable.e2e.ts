import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const root = resolve(process.env.AGENTVIEWER_PACKAGE_DIR ?? 'release/win-unpacked');
const executable = join(root, 'AgentViewer.exe');
assert.ok(existsSync(executable), '请先运行 npm run package:portable');
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-portable-'));
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete environment.ELECTRON_RUN_AS_NODE;
Object.assign(environment, { AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: '3212', AGENTVIEWER_TEST_MODE: '1' });
const application = await electron.launch({ executablePath: executable, args: [], cwd: root, env: environment, timeout: 60_000 });
try {
  const page = await application.firstWindow();
  await page.locator('.reader-panel').waitFor({ timeout: 30_000 });
  const engine = await page.evaluate(() => window.agentViewer!.call('engine-status', {})) as Record<string, { available: boolean; offlineReady: boolean; source: string; path: string }>;
  for (const id of ['babeldoc', 'libreoffice', 'ocr'] as const) {
    assert.equal(engine[id].available, true, `${id} 不可用`);
    assert.equal(engine[id].offlineReady, true, `${id} 缺少离线资源`);
    assert.equal(engine[id].source, 'bundled', `${id} 未使用目录包资源`);
  }
  const bundledHome = join(root, 'resources', 'engines', 'babeldoc-home');
  const babel = spawnSync(engine.babeldoc.path, ['-m', 'babeldoc.main', '--version'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, USERPROFILE: bundledHome, HF_HUB_OFFLINE: '1' } });
  assert.equal(babel.status, 0, babel.stderr || String(babel.error));
  assert.match(babel.stdout, /0\.6\.4/);
  const office = spawnSync(engine.libreoffice.path, ['--version'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(office.status, 0, office.stderr || String(office.error));
  assert.match(office.stdout, /26\.8\.1/);
  await page.locator('.tab').filter({ hasText: '示例.pdf' }).locator('.tab-select').click();
  await page.locator('.pdf-page .textLayer span').first().waitFor();
  await page.locator('.activity-rail button[aria-label="PDF工具"]').click();
  await page.getByRole('button', { name: '识别本页' }).click();
  await page.locator('.pdf-side-result').waitFor({ timeout: 45_000 });
  assert.match(await page.locator('.pdf-side-result').innerText(), /AgentViewer/);
  const connection = JSON.parse(await readFile(join(directory, 'runtime/connection.json'), 'utf8')) as { mcpPath: string };
  assert.ok(existsSync(connection.mcpPath), '目录包 MCP 入口不存在');
  console.log(JSON.stringify({ passed: true, executable, engines: Object.keys(engine), mcpPath: connection.mcpPath, dataDirectory: directory }, null, 2));
} finally { await application.close(); }
