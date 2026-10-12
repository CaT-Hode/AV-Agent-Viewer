import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-motion-'));
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: '3218', AGENTVIEWER_TEST_MODE: '1', AGENTVIEWER_TEST_TRANSLATOR: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: resolve('.'), env, timeout: 45000 });
const page = await app.firstWindow(), errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
const invoke = (method: string, args: Record<string, unknown> = {}) => page.evaluate(v => window.agentViewer!.call(v.method, v.args), { method, args });
const stableChrome = async () => {
  const layout = await page.evaluate(() => ({ top: document.querySelector('.tab-strip')!.getBoundingClientRect().top, bottom: document.querySelector('.workbench')!.getBoundingClientRect().bottom, footer: !!document.querySelector('.status-bar'), shellScroll: document.querySelector('.app-shell')!.scrollTop, windowScroll: scrollY, height: innerHeight }));
  assert.ok(Math.abs(layout.top) < 1); assert.ok(Math.abs(layout.bottom - layout.height) < 1); assert.equal(layout.footer, false); assert.equal(layout.shellScroll, 0); assert.equal(layout.windowScroll, 0);
};
try {
  await page.locator('.prose h1').waitFor();
  await invoke('settings-set', { id: 'appearance.toolbarDelayMs', value: 10000 });
  await page.locator('.activity-rail').evaluate(async e => { await Promise.all(e.getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
  await page.locator('.tab').filter({ hasText: '示例.pdf' }).locator('.tab-select').click();
  await page.locator('.textLayer span').first().waitFor();
  for (const number of [2, 1, 3, 1]) { await page.getByRole('button', { name: `第 ${number} 页`, exact: true }).click(); await stableChrome(); }
  const toggle = page.getByRole('button', { name: '目录与结构', exact: true });
  const startWidth = await page.locator('.reader-panel').evaluate(e => e.getBoundingClientRect().width);
  await toggle.click();
  assert.equal(await page.locator('.format-sidebar').getAttribute('data-motion-phase'), 'exit');
  assert.notEqual(await page.locator('.format-sidebar').getAttribute('inert'), null);
  await page.waitForTimeout(70); // Observe a real intermediate frame, then reverse the transition.
  const midWidth = await page.locator('.reader-panel').evaluate(e => e.getBoundingClientRect().width);
  assert.ok(midWidth > startWidth && midWidth < startWidth + 270);
  await toggle.click();
  await page.waitForFunction(width => Math.abs(document.querySelector('.reader-panel')!.getBoundingClientRect().width - width) < 1, startWidth);
  await stableChrome();
  await page.getByRole('button', { name: 'AI 工具', exact: true }).click();
  await page.locator('.ai-drawer').waitFor();
  await page.getByRole('button', { name: '关闭 AI 抽屉', exact: true }).click();
  assert.equal(await page.locator('.ai-drawer').getAttribute('data-motion-phase'), 'exit');
  await page.locator('.ai-drawer').waitFor({ state: 'detached' }); await stableChrome();
  await page.keyboard.press('Control+l');
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.locator('.modal-backdrop').getAttribute('data-motion-phase'), 'open');
  await page.keyboard.press('Escape'); await page.locator('.modal-backdrop').waitFor({ state: 'detached' });
  await page.locator('.tab').filter({ hasText: '欢迎.md' }).locator('.tab-select').click();
  await page.locator('.prose p').first().evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const s = getSelection()!; s.removeAllRanges(); s.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  const tools = page.getByRole('toolbar', { name: '选区工具' }); await tools.waitFor();
  await tools.getByRole('button', { name: '添加批注', exact: true }).click(); await page.getByRole('textbox', { name: '添加批注', exact: true }).waitFor();
  await tools.getByRole('button', { name: '添加批注', exact: true }).click();
  assert.equal(await page.locator('.selection-input').getAttribute('data-motion-phase'), 'exit');
  await page.locator('.selection-input').waitFor({ state: 'detached' }); assert.equal(await tools.count(), 1);
  await tools.getByRole('button', { name: '翻译选区', exact: true }).click();
  await page.locator('.translation-result').waitFor();
  const disclosure = page.getByRole('button', { name: '查看原文', exact: true });
  await disclosure.click(); assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
  await page.waitForFunction(() => document.querySelector('.disclosure-body')!.getBoundingClientRect().height > 10);
  await disclosure.click(); await page.waitForFunction(() => document.querySelector('.disclosure-body')!.getBoundingClientRect().height < 1);
  await invoke('settings-set', { id: 'appearance.motion', value: 'reduced' }); await page.locator('html[data-motion="reduced"]').waitFor();
  await page.getByRole('button', { name: '选区译文', exact: true }).click();
  await page.locator('.ai-drawer').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'AI 工具', exact: true }).click(); await page.locator('.ai-drawer').waitFor();
  // Check the stable reduced-motion surface. Its 80ms exit may legitimately
  // finish before Playwright returns from a click on a busy compositing frame.
  assert.equal(await page.locator('.ai-drawer').evaluate(e => getComputedStyle(e).translate), 'none');
  await invoke('settings-set', { id: 'appearance.motion', value: 'off' }); await page.locator('html[data-motion="off"]').waitFor();
  await page.getByRole('button', { name: 'AI 工具', exact: true }).click(); await page.locator('.ai-drawer').waitFor({ state: 'detached' });
  await toggle.click(); await page.locator('.format-sidebar').waitFor({ state: 'detached' }); await stableChrome();
  assert.deepEqual(errors, []);
  const qa = join(directory, 'screenshots'); await mkdir(qa); await page.screenshot({ path: join(qa, 'motion-complete.png'), scale: 'css' });
  console.log('Motion, rapid reversal, keyboard/reduced settings, selection/disclosure and stable window chrome: PASS', qa);
} finally { await app.close(); }
