import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { WorkspaceState } from '../packages/contracts/src/index';
import { NAVIGATION_METRICS } from '../apps/desktop/src/renderer/lib/navigation-optics';
import { REFRACTIVE_BLUR_LIMIT_PX } from '../apps/desktop/src/renderer/lib/glass-presets';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-navigation-'));
const qa = process.env.AGENTVIEWER_QA_DIR ? resolve(process.env.AGENTVIEWER_QA_DIR, 'ui-navigation') : join(directory, 'evidence');
await mkdir(qa, { recursive: true });
const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    server.close(error => error ? reject(error) : resolvePort(address.port));
  });
});
const env: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1', AGENTVIEWER_TEST_TRANSLATOR: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: resolve('.'), env, timeout: 45000 });
const page = await app.firstWindow(), errors: string[] = [];
const watch = (target: Page) => {
  target.on('pageerror', error => errors.push(`${target.url()}: ${error.message}`));
  target.on('console', message => { if (/same key|unique.*key|Encountered two children/i.test(message.text())) errors.push(`${target.url()}: ${message.text()}`); });
};
app.context().pages().forEach(watch); app.context().on('page', watch);
const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => page.evaluate(value => window.agentViewer!.call(value.method, value.args), { method, args }) as Promise<T>;
const state = () => invoke<WorkspaceState>('state');
const until = async (check: () => Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
  throw new Error(`等待失败：${label}`);
};
const setting = (id: string, value: unknown) => invoke('settings-set', { id, value });
const activeFormat = async () => { const current = await state(); return current.documents.find(document => document.id === current.views.find(view => view.id === current.activeViewId)?.documentId)?.format; };
const capsuleSelector = '.reader-toolbar > .floating-capsule.navigation-capsule';
const capsuleStyle = (target: Page) => target.locator(capsuleSelector).evaluate(element => {
  const style = getComputedStyle(element), glass = element.querySelector<HTMLElement>('.navigation-glass');
  const center = glass?.querySelector('.navigation-glass-center');
  const optical = center ? getComputedStyle(center) : undefined;
  const button = element.querySelector<HTMLButtonElement>('.icon-button')!, buttonStyle = getComputedStyle(button);
  return {
    height: element.getBoundingClientRect().height, border: style.borderTopWidth, borderStyle: style.borderTopStyle,
    radius: style.borderTopLeftRadius, blur: style.getPropertyValue('--navigation-blur').trim(),
    refractionWidth: style.getPropertyValue('--navigation-refraction-width').trim(),
    opticalFilter: optical ? optical.filter + ' ' + optical.backdropFilter : style.backdropFilter,
    gaussianBlur: Number(element.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')),
    buttonWidth: button.getBoundingClientRect().width, buttonHeight: button.getBoundingClientRect().height,
    buttonRadius: buttonStyle.borderTopLeftRadius,
  };
});
const noOuterMask = async (target: Page, native = false) => {
  const surfaces = await target.evaluate(nativeSurface => {
    const selectors = nativeSurface ? ['html', 'body', '#root', '.native-toolbar', '.reader-toolbar'] : ['.reader-toolbar'];
    return selectors.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)].map(element => {
      const style = getComputedStyle(element);
      return { selector, color: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, filter: style.backdropFilter, border: style.borderBottomWidth };
    }));
  }, native);
  for (const surface of surfaces) {
    assert.match(surface.color, /^(transparent|rgba\([^)]*,\s*0\))$/, `${surface.selector} draws a rectangular background`);
    assert.equal(surface.image, 'none', `${surface.selector} background image extends beyond the capsule`);
    assert.equal(surface.shadow, 'none', `${surface.selector} outer shadow`);
    assert.equal(surface.filter, 'none', `${surface.selector} outer backdrop`);
    assert.equal(surface.border, '0px', `${surface.selector} outer border`);
  }
  const geometry = await target.locator(capsuleSelector).evaluate(element => {
    const capsule = element.getBoundingClientRect(), glass = element.querySelector('.navigation-glass')!.getBoundingClientRect();
    return { opticalVisible: getComputedStyle(element.querySelector('.navigation-glass')!).display !== 'none', capsule: { x: capsule.x, y: capsule.y, width: capsule.width, height: capsule.height }, glass: { x: glass.x, y: glass.y, width: glass.width, height: glass.height } };
  });
  if (geometry.opticalVisible) {
    assert.ok(Math.abs(geometry.capsule.width - geometry.glass.width) <= 2, 'optical layer follows capsule width');
    assert.ok(Math.abs(geometry.capsule.height - geometry.glass.height) <= 2, 'optical layer follows capsule height');
  }
};
const nativeGeometry = () => app.evaluate(({ BrowserWindow }, rootUrl) => {
  const windows = BrowserWindow.getAllWindows(), root = windows.find(window => window.webContents.getURL() === rootUrl)!; const origin = root.getContentBounds();
  return windows.filter(window => window === root || window.getParentWindow() === root).flatMap(window => window.contentView.children.map((view: any) => {
    const rect = view.getBounds(), position = window.getContentBounds();
    return { url: view.webContents?.getURL() as string | undefined, bounds: { ...rect, x: rect.x + position.x - origin.x, y: rect.y + position.y - origin.y }, visible: view.getVisible() && window.isVisible(), host: window === root ? 'reader' : 'owned-overlay' };
  }));
}, page.url());
const toolbarVisible = async () => !!(await nativeGeometry()).find(view => view.url?.includes('#/web-toolbar'))?.visible;
const fixtureScript = <T = unknown>(script: string) => app.evaluate(async ({ webContents }, expression) => {
  const target = webContents.getAllWebContents().find(contents => contents.getURL().includes('/fixtures/interaction.html'));
  if (!target) throw new Error('fixture WebContents is unavailable');
  return target.executeJavaScript(expression);
}, script) as Promise<T>;
const webScroll = (y: number) => fixtureScript<number>(`window.scrollTo(0,${y}); window.scrollY`);
const fixtureUrl = `http://127.0.0.1:${port}/fixtures/interaction.html`;
const awaitFixtureUrl = (url: string) => until(async () => await fixtureScript<string>('location.href') === url, `fixture navigated to ${url}`);
const noRefraction = async (target: Page) => {
  const layers = await target.locator('.navigation-glass').evaluate(element => getComputedStyle(element).display === 'none' ? [] : [element, ...element.querySelectorAll<HTMLElement>('*')].flatMap(layer => [null, '::before', '::after'].map(pseudo => {
    const style = getComputedStyle(layer, pseudo);
    return { display: style.display, opacity: style.opacity, filter: style.filter, backdrop: style.backdropFilter };
  })));
  assert.ok(layers.every(layer => layer.display === 'none' || layer.opacity === '0' || !/url\(/.test(layer.filter + layer.backdrop)), 'refraction filters are disabled');
};

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.locator('.prose h1').waitFor();
  await setting('appearance.theme', 'light'); await setting('appearance.motion', 'off');
  await setting('appearance.toolbarDelayMs', 10000); await setting('appearance.autoHideToolbar', true);
  await page.locator('html[data-theme="light"][data-motion="off"]').waitFor();
  await page.locator(capsuleSelector).waitFor();
  assert.equal(await page.locator(capsuleSelector).count(), 1);
  assert.equal((await page.locator('.capsule-document-title').innerText()).trim(), '欢迎.md');
  assert.doesNotMatch(await page.locator(capsuleSelector).innerText(), /[A-Z]:[\\/]|file:\/\//i, 'document path is absent');
  const localStyle = await capsuleStyle(page);
  assert.equal(localStyle.blur, NAVIGATION_METRICS.blur + 'px'); assert.equal(localStyle.refractionWidth, NAVIGATION_METRICS.bezelWidth + 'px');
  assert.match(localStyle.opticalFilter, /url\(/, 'document glass uses the source SVG optical pipeline');
  assert.equal(localStyle.gaussianBlur, Math.min(NAVIGATION_METRICS.blur, REFRACTIVE_BLUR_LIMIT_PX));
  assert.equal(localStyle.height, NAVIGATION_METRICS.height); assert.equal(localStyle.radius, NAVIGATION_METRICS.radius + 'px'); await noOuterMask(page);
  await page.screenshot({ path: join(qa, 'document-navigation.png'), scale: 'css' });

  // Real document history is exercised through the same common controls.
  await page.locator('.tab').filter({ hasText: '示例.pdf' }).locator('.tab-select').click();
  await page.locator('.pdf-page .textLayer span').first().waitFor();
  await page.locator(capsuleSelector).getByRole('button', { name: '后退', exact: true }).click();
  await page.locator('.prose h1').waitFor(); assert.equal(await activeFormat(), 'markdown');
  await page.locator(capsuleSelector).getByRole('button', { name: '前进', exact: true }).click();
  await page.locator('.pdf-page .textLayer span').first().waitFor(); assert.equal(await activeFormat(), 'pdf');
  await page.locator(capsuleSelector).getByRole('button', { name: '后退', exact: true }).click();
  await page.locator('.prose h1').waitFor();
  await page.mouse.move(700, 500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('.document-content').evaluate(element => { element.scrollTop = 20; });
  await page.waitForTimeout(250); // Must observe the small-scroll frame, not just the final hidden state.
  assert.equal(await page.locator('.reader-toolbar').evaluate(element => getComputedStyle(element).opacity), '1', 'small scroll preserves navigation');
  await page.locator('.document-content').evaluate(element => { element.scrollTop = 180; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.navigation-module')!).opacity === '0');
  await page.locator('.document-content').evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.navigation-module')!).opacity === '1');

  await page.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click();
  await page.locator('.reader-format-web').waitFor();
  await until(async () => app.context().pages().some(target => target.url().includes('#/web-toolbar')), 'native shared toolbar created');
  const toolbar = app.context().pages().find(target => target.url().includes('#/web-toolbar'))!;
  await toolbar.locator(capsuleSelector).waitFor(); await until(toolbarVisible, 'native toolbar visible');
  await toolbar.locator('html[data-theme="light"][data-motion="off"]').waitFor();
  await toolbar.locator('.navigation-glass[data-source="sampled"]').waitFor();
  const nativeStyle = await capsuleStyle(toolbar);
  assert.match(nativeStyle.opticalFilter, /url\(/, 'sampled native glass uses the same source SVG pipeline');
  assert.equal(nativeStyle.gaussianBlur, Math.min(NAVIGATION_METRICS.blur, REFRACTIVE_BLUR_LIMIT_PX));
  for (const key of ['height', 'border', 'borderStyle', 'radius', 'blur', 'refractionWidth', 'buttonWidth', 'buttonHeight', 'buttonRadius'] as const) {
    assert.equal(nativeStyle[key], localStyle[key], `local/native shared style: ${key}`);
  }
  await noOuterMask(toolbar, true);
  const native = (await nativeGeometry()).find(view => view.url?.startsWith(fixtureUrl))!;
  const overlay = (await nativeGeometry()).find(view => view.url?.includes('#/web-toolbar'))!;
  const reader = await page.locator('.reader-panel').boundingBox(); assert.ok(reader);
  assert.ok(Math.abs(native.bounds.y - reader.y) <= 2, 'native page begins at reader top, without a reserved rectangular header');
  assert.ok(overlay.bounds.width < native.bounds.width, 'only capsule-sized native overlay is present');
  assert.equal(overlay.bounds.height, NAVIGATION_METRICS.height + 2 * NAVIGATION_METRICS.shadowGutter);
  for (const name of ['源码', '分栏', '撤销最近修改', '保存']) assert.equal(await toolbar.getByRole('button', { name, exact: true }).count(), 0, `web has no ${name} module`);
  assert.equal(await toolbar.locator('.view-modes').count(), 0);
  assert.equal(await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '建立阅读副本', exact: true }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '翻译网页', exact: true }).count(), 1);

  // All navigation stays on the bundled fixture; query variants exercise genuine native history.
  const firstUrl = fixtureUrl + '?navigation=first', secondUrl = fixtureUrl + '?navigation=second';
  await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).fill(firstUrl); await toolbar.keyboard.press('Enter'); await awaitFixtureUrl(firstUrl);
  await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).fill(secondUrl); await toolbar.keyboard.press('Enter'); await awaitFixtureUrl(secondUrl);
  await toolbar.getByRole('button', { name: '后退', exact: true }).click(); await awaitFixtureUrl(firstUrl);
  await toolbar.getByRole('button', { name: '前进', exact: true }).click(); await awaitFixtureUrl(secondUrl);
  await toolbar.getByRole('button', { name: '刷新', exact: true }).click(); await awaitFixtureUrl(secondUrl);
  await until(async () => await fixtureScript<string>('document.readyState') === 'complete', 'fixture reload complete');

  const sourceText = await fixtureScript<string>('document.getElementById("selectable").textContent');
  await toolbar.getByRole('button', { name: '翻译网页', exact: true }).click();
  await toolbar.getByRole('button', { name: '显示原文', exact: true }).waitFor();
  await until(async () => (await fixtureScript<string>('document.getElementById("selectable").textContent')).startsWith('【'), 'real in-place translation');
  assert.equal(await fixtureScript<string>('document.getElementById("name").placeholder'), '支持中文键盘输入', 'form input is excluded from replacement');
  await toolbar.getByRole('button', { name: '显示原文', exact: true }).click();
  await until(async () => await fixtureScript<string>('document.getElementById("selectable").textContent') === sourceText, 'restore original text');
  await toolbar.getByRole('button', { name: '翻译网页', exact: true }).waitFor();

  for (const [id, enabled, disabled] of [
    ['appearance.glass', 'off', 'standard'], ['appearance.highContrast', true, false], ['appearance.reduceTransparency', true, false],
  ] as const) {
    await setting(id, enabled);
    await until(async () => await toolbar.locator('html').getAttribute(id === 'appearance.highContrast' ? 'data-contrast' : 'data-glass') === (id === 'appearance.highContrast' ? 'high' : 'off'), `${id} synchronized to native`);
    await noRefraction(toolbar); await noOuterMask(toolbar, true);
    await setting(id, disabled);
    await until(async () => await toolbar.locator('html').getAttribute(id === 'appearance.highContrast' ? 'data-contrast' : 'data-glass') === 'standard', `${id} restored`);
  }

  // Address keyboard focus prevents scroll hiding; after blur the native page remains usable.
  await page.keyboard.press('Control+l');
  await toolbar.waitForFunction(() => document.activeElement?.classList.contains('address-input'));
  await webScroll(180); await page.waitForTimeout(1000); assert.equal(await toolbarVisible(), true, 'address focus retains toolbar');
  await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).blur();
  await toolbar.mouse.move(2, 60); // Leave the capsule before exercising scroll; hover deliberately holds it open.
  await webScroll(0); await until(toolbarVisible, 'upward scroll restores native toolbar');
  await webScroll(20); await page.waitForTimeout(1000); assert.equal(await toolbarVisible(), true, 'small native scroll does not hide toolbar');
  await webScroll(220); await until(async () => !await toolbarVisible(), 'downward native scroll hides the complete overlay');
  await webScroll(0); await until(toolbarVisible, 'upward native scroll reveals capsule');
  await noOuterMask(toolbar, true);
  await toolbar.screenshot({ path: join(qa, 'native-navigation.png'), omitBackground: true, scale: 'css' });

  await toolbar.getByRole('button', { name: '建立阅读副本', exact: true }).click();
  await until(async () => await activeFormat() === 'html', 'reading copy opens a local HTML view');
  const copyState = await state(), copyView = copyState.views.find(view => view.id === copyState.activeViewId)!;
  const copy = copyState.documents.find(document => document.id === copyView.documentId)!;
  assert.match(copy.model.text ?? '', /这段文字用于验证/);
  assert.doesNotMatch(copy.model.text ?? '', /sample-secret-e2e|hidden-secret-e2e|<script[\s>]/i, 'reading copy excludes scripts and sensitive input values');
  await until(async () => !await toolbarVisible(), 'native navigation hides after local copy activation');
  await page.locator(capsuleSelector).waitFor();
  assert.equal((await page.locator(capsuleSelector).innerText()).includes(fixtureUrl), false, 'local copy uses its name rather than source URL');
  const chrome = await page.evaluate(() => ({ top: document.querySelector('.tab-strip')!.getBoundingClientRect().top, bottom: document.querySelector('.workbench')!.getBoundingClientRect().bottom, footers: document.querySelectorAll('.status-bar').length, shellScroll: document.querySelector('.app-shell')!.scrollTop, scroll: scrollY, height: innerHeight }));
  assert.equal(chrome.footers, 0, 'main window has no persistent footer');
  assert.ok(Math.abs(chrome.top) < 1 && Math.abs(chrome.bottom - chrome.height) < 1); assert.equal(chrome.shellScroll, 0); assert.equal(chrome.scroll, 0);
  await writeFile(join(qa, 'navigation-styles.json'), JSON.stringify({ localStyle, nativeStyle, native, overlay, chrome }, null, 2));
  assert.deepEqual(errors, []);
  console.log('Shared local/native navigation, capsule-only glass, module gating, history, translation, copy and scroll/focus: PASS', qa);
} catch (error) {
  await page.screenshot({ path: join(qa, 'failure-main.png'), scale: 'css' }).catch(() => {});
  const diagnostics = await page.evaluate(() => ({ url: location.href, navigation: [...document.querySelectorAll('.reader-toolbar')].map(element => ({
    format: element.getAttribute('data-navigation-format'), native: !!element.closest('.native-toolbar'), reader: element.closest('.reader-panel')?.className,
    ancestors: [...(function* () { let parent = element.parentElement; while (parent) { yield parent.tagName + '.' + parent.className; parent = parent.parentElement; } })()],
    html: element.outerHTML,
  })) })).catch(() => ({ unavailable: true }));
  await writeFile(join(qa, 'failure.json'), JSON.stringify({ error: String(error), diagnostics }, null, 2));
  console.error('Navigation regression evidence:', qa); throw error;
} finally { await app.close(); }
