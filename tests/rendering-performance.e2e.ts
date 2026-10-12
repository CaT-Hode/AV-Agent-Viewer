import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ReadingContext, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';
import type { glassOpticsCacheStats } from '../apps/desktop/src/renderer/lib/liquid-glass-optics';
import type { officeRenderStats } from '../apps/desktop/src/renderer/components/OfficeDocument';
import type { BackdropCacheStatistics } from '../apps/desktop/src/main/backdrop-cache';

// Real renderer/capture counters, fresh random port/profile. Never attaches to
// the installed app. Run serially after the final source/build freeze.
type Diagnostics = { glass: ReturnType<typeof glassOpticsCacheStats>; office: ReturnType<typeof officeRenderStats>; poll: { successfulPolls: number; changedRoot: number } };
type Sample = { sequence: number; capturedAt: number; sourceContentsId: number; navigationId: string; layoutRevision: number; sourceRevision: number; geometryRevision: number; scrollY: number; capsuleBounds: { x: number; y: number; width: number; height: number }; captureBounds: { x: number; y: number; width: number; height: number }; pixelSize: { width: number; height: number }; cssSize: { width: number; height: number } };
type ToolbarState = { viewId: string; busy?: boolean; backdropImage?: string; backdropSample?: Sample; backdropDiagnostics: BackdropCacheStatistics };
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-rendering-performance-'));
const evidence = join(directory, 'evidence'); await mkdir(evidence);
await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, revision: 0, values: { 'appearance.glass': 'off', 'appearance.motion': 'off', 'appearance.autoHideToolbar': false, 'appearance.theme': 'light' } }));
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: ['--force-device-scale-factor=1.5', '.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], results: Record<string, unknown> = {};
main.on('pageerror', error => errors.push(error.message)); app.context().on('page', page => page.on('pageerror', error => errors.push(error.message)));
const invoke = <T = unknown>(page: Page, method: string, args: Record<string, unknown> = {}) => page.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const diagnostics = (page: Page) => page.evaluate(() => { if (!window.__agentViewerRenderingDiagnostics) throw new Error('Missing trusted TESTMODE rendering diagnostics'); return window.__agentViewerRenderingDiagnostics(); }) as Promise<Diagnostics>;
const state = () => invoke<WorkspaceState>(main, 'state');
const toolbarState = (toolbar: Page) => invoke<ToolbarState>(toolbar, 'toolbar-state');
const until = async (predicate: () => Promise<boolean>, label: string) => { for (let attempt = 0; attempt < 180; attempt++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 60)); } throw new Error('等待失败：' + label); };
const createOffice = async (format: 'docx' | 'pptx' | 'xlsx') => {
  await main.getByRole('button', { name: '新建标签页', exact: true }).click(); await main.getByRole('button', { name: '新建文档', exact: true }).click();
  await main.getByRole('dialog').locator('.new-format-list button').filter({ has: main.getByText('.' + format, { exact: true }) }).click(); await main.locator('.office-document-' + format).waitFor();
  await main.waitForTimeout(850); const workspace = await state(), view = workspace.views.find(view => view.id === workspace.activeViewId)!; assert.ok(view); return view;
};
try {
  await main.locator('.prose h1').waitFor(); await main.locator('html[data-glass="off"]').waitFor();
  const startupOff = await diagnostics(main); assert.equal(startupOff.glass.builds, 0, 'disabled glass must not generate even hidden startup optical fields'); assert.equal(startupOff.glass.pngEncodes, 0);
  await invoke(main, 'settings-open', { category: '通用与多开' }); await until(async () => app.context().pages().some(page => page.url().includes('#/settings')), 'settings window');
  const settings = app.context().pages().find(page => page.url().includes('#/settings'))!;
  await settings.getByRole('button', { name: '通用与多开', exact: true }).click(); await settings.locator('html[data-glass="off"]').waitFor(); await settings.waitForTimeout(250);
  const settingsOff = await diagnostics(settings); assert.equal(settingsOff.glass.builds, 0); assert.equal(settingsOff.glass.pngEncodes, 0);
  await settings.getByRole('button', { name: '外观与布局', exact: true }).click();
  await settings.getByRole('radiogroup', { name: '玻璃效果', exact: true }).getByRole('radio', { name: '标准', exact: true }).click();
  await settings.locator('html[data-glass="standard"]').waitFor();
  assert.equal(await settings.locator('.glass-preview-lens').count(), 0, 'closed appearance preview is lazy instead of creating hidden optical fields');
  const controlInstances = await settings.locator('.glass-switch-thumb,.glass-segmented-thumb,.glass-range-thumb').evaluateAll(nodes => nodes.map(node => node.className));
  for (const selector of ['.glass-switch-thumb', '.glass-segmented-thumb', '.glass-range-thumb']) {
    assert.ok(await settings.locator(selector).count() > 0, 'actual appearance category mounts ' + selector);
    await until(async () => settings.locator(selector + ' > .liquid-glass-surface').evaluateAll(surfaces => surfaces.length > 0 && surfaces.every(surface => surface.getAttribute('data-glass-effect') === 'refractive' && !!surface.querySelector('feDisplacementMap') && [...surface.querySelectorAll('feImage')].every(image => image.getAttribute('href')?.startsWith('data:image/png;base64,')))), selector + ' has real cached optical assets');
  }
  const smallControls = await diagnostics(settings); await settings.waitForTimeout(350); const idleControls = await diagnostics(settings);
  assert.equal(idleControls.glass.builds, smallControls.glass.builds, 'idle switch/segmented/range controls create no additional maps'); assert.equal(idleControls.glass.pngEncodes, smallControls.glass.pngEncodes, 'idle small controls create no additional PNGs');
  await settings.getByRole('button', { name: '通用与多开', exact: true }).click();
  const additionalControls = settings.locator('details.settings-unavailable');
  if (await additionalControls.count() && await additionalControls.getAttribute('open') === null) await additionalControls.locator(':scope > summary').click();
  await settings.waitForTimeout(250);
  const ordinarySurfaces = await settings.locator('.liquid-glass-surface').evaluateAll(surfaces => surfaces.filter(surface => !surface.closest('.glass-switch-thumb,.glass-segmented-thumb,.glass-range-thumb,.glass-preview-lens')).map(surface => ({ effect: surface.getAttribute('data-glass-effect'), variant: surface.getAttribute('data-glass-variant'), opticalChildren: surface.querySelectorAll('svg,feDisplacementMap').length, filter: getComputedStyle(surface.querySelector('.liquid-glass-center')!).backdropFilter })));
  const switchCount = await settings.locator('.glass-switch-thumb .liquid-glass-surface').count();
  assert.ok(switchCount >= 2, 'actual settings mount multiple switch materials'); assert.ok(ordinarySurfaces.length > 0); assert.ok(ordinarySurfaces.every(surface => surface.effect === 'frosted' && surface.opticalChildren === 0 && !surface.filter.includes('url(')), 'ordinary panels/search do not generate optical SVG');
  await until(async () => settings.locator('.glass-switch-thumb .liquid-glass-surface').evaluateAll(surfaces => surfaces.length >= 2 && surfaces.every(surface => surface.getAttribute('data-glass-effect') === 'refractive' && !!surface.querySelector('feDisplacementMap'))), 'compact switches are explicit optical exceptions');
  assert.equal(await settings.locator('.glass-preview-lens').count(), 0, 'hidden material preview is not mounted or generating maps');
  const frosted = await diagnostics(settings); assert.ok(frosted.glass.builds > 0); assert.ok(frosted.glass.pngEncodes > 0);
  await settings.waitForTimeout(350); const stableSettings = await diagnostics(settings);
  assert.equal(stableSettings.glass.builds, frosted.glass.builds); assert.equal(stableSettings.glass.pngEncodes, frosted.glass.pngEncodes, 'idle optical switches and hidden preview create no new optical assets');
  await until(async () => (await main.locator('.navigation-glass[data-glass-effect="refractive"] [data-glass-displacement]').count()) === 1, 'actual reading navigation retains full optics');
  assert.ok(await main.locator('.liquid-glass-surface').evaluateAll(surfaces => surfaces.every(surface => !surface.querySelector('feDisplacementMap') || !!surface.closest('.navigation-capsule,.agent-capsule,.ai-result-popover,.translation-popover'))), 'reading optical surfaces use the declared navigation/Agent/result/translation exceptions');
  await settings.screenshot({ path: join(evidence, 'frosted-settings.png'), scale: 'css' }); await settings.close();
  results.glass = { startupOff: startupOff.glass, settingsOff: settingsOff.glass, frosted: frosted.glass, switchInstances: switchCount, controlInstances, smallControls: smallControls.glass, idleControls: idleControls.glass, ordinarySurfaces };
  console.log('Disabled glass generates zero maps; ordinary surfaces remain frosted; compact switch/segmented/range fields are cached at rest: PASS');

  const officeIdle: Record<string, unknown> = {};
  for (const format of ['docx', 'pptx', 'xlsx'] as const) {
    const view = await createOffice(format), before = await diagnostics(main); let context = await invoke<ReadingContext>(main, 'context', { viewId: view.id }); const firstContextRevision = context.viewRevision;
    for (let cycle = 0; cycle < 8; cycle++) {
      const poll = await diagnostics(main);
      // Publish the actual read-back context through the production reader
      // producer endpoint. Only timestamp/viewRevision changes; do not fake a
      // diagnostic count or omit these fields from state sharing.
      await invoke(main, 'report-context', { viewId: view.id, context });
      await until(async () => { const next = await diagnostics(main); return next.poll.successfulPolls > poll.poll.successfulPolls && next.poll.changedRoot > poll.poll.changedRoot; }, format + ': actual context refresh is consumed by the renderer poll');
      context = await invoke<ReadingContext>(main, 'context', { viewId: view.id }); assert.ok(context.viewRevision > firstContextRevision);
      assert.deepEqual((await diagnostics(main)).office, before.office, format + ': context-only refresh must not execute the Office body or leaf editors');
    }
    const after = await diagnostics(main); assert.ok(after.poll.successfulPolls >= before.poll.successfulPolls + 8); assert.ok(context.viewRevision >= firstContextRevision + 8);
    officeIdle[format] = { before, after, contextRevisions: context.viewRevision - firstContextRevision };
    console.log(format + ': eight real context/poll updates preserve body render counters: PASS');
    if (format === 'xlsx') {
      const cell = main.locator('.office-cell-input[data-cell-address="A1"]'), count = await main.locator('.office-cell-input').count(), editBefore = await diagnostics(main), docBefore = (await state()).documents.find(document => document.id === view.documentId)!;
      await cell.dblclick(); await cell.fill('Real renderer positive control'); await cell.press('Enter');
      await until(async () => (await state()).documents.find(document => document.id === view.documentId)!.revision > docBefore.revision, 'real A1 edit commits');
      await until(async () => { const current = await diagnostics(main); return current.office.spreadsheet > editBefore.office.spreadsheet && current.office.cell > editBefore.office.cell; }, 'real changed leaf/body positive control increments');
      const edited = await diagnostics(main); assert.ok(edited.office.cell - editBefore.office.cell < count, 'one cell edit must not execute every visible cell editor');
      officeIdle.positiveEdit = { cellsMounted: count, before: editBefore.office, after: edited.office }; await main.screenshot({ path: join(evidence, 'spreadsheet-real-edit.png'), scale: 'css' });
    }
  }
  results.office = officeIdle;

  const initial = await state(), native = initial.views.find(view => initial.documents.find(document => document.id === view.documentId)?.format === 'web')!; assert.ok(native);
  await main.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click();
  await until(async () => app.context().pages().some(page => page.url().includes('#/web-toolbar')), 'native toolbar'); const toolbar = app.context().pages().find(page => page.url().includes('#/web-toolbar'))!;
  await until(async () => { const current = await toolbarState(toolbar); return current.viewId === native.id && !!current.backdropSample && !!current.backdropImage; }, 'initial native sample');
  const sourceId = (await toolbarState(toolbar)).backdropSample!.sourceContentsId;
  const fixture = app.context().pages().find(page => page.url() === `http://127.0.0.1:${port}/fixtures/interaction.html`)!; assert.ok(fixture); assert.equal(await fixture.evaluate(() => typeof window.agentViewer), 'undefined');
  await fixture.mouse.move(25, 250); await toolbar.waitForTimeout(650);
  const steadyBefore = await toolbarState(toolbar), mapsBefore = await diagnostics(toolbar);
  const processedBefore=steadyBefore.backdropDiagnostics.captures+steadyBefore.backdropDiagnostics.frameCrops;
  await until(async () => { const counters=(await toolbarState(toolbar)).backdropDiagnostics;return counters.captures+counters.frameCrops>=processedBefore+3; }, 'unchanged page receives three actual capture or compositor-frame ROI reads');
  await toolbar.waitForTimeout(150); const steadyAfter = await toolbarState(toolbar), mapsAfter = await diagnostics(toolbar);
  assert.ok(steadyAfter.backdropDiagnostics.pngEncodes - steadyBefore.backdropDiagnostics.pngEncodes <= 1, 'three actual ROI reads need at most one PNG encoding');
  assert.ok(steadyAfter.backdropDiagnostics.backdropImageFrames - steadyBefore.backdropDiagnostics.backdropImageFrames <= 1, 'unchanged PNG must not be resent with every context/state update');
  assert.ok(steadyAfter.backdropDiagnostics.pngReuses >= steadyBefore.backdropDiagnostics.pngReuses + 2); assert.equal(steadyAfter.backdropImage, steadyBefore.backdropImage);
  assert.ok(steadyAfter.backdropSample!.capturedAt > steadyBefore.backdropSample!.capturedAt, 'timestamps represent a real new capture or presented frame even if PNG encoding is reused');
  assert.equal(mapsAfter.glass.builds, mapsBefore.glass.builds, 'native sample updates do not regenerate used-geometry optical maps');
  results.nativeIdle = { before: steadyBefore.backdropDiagnostics, after: steadyAfter.backdropDiagnostics, mapBuildsBefore: mapsBefore.glass.builds, mapBuildsAfter: mapsAfter.glass.builds };
  console.log('Three actual capture/compositor ROI reads reuse PNG/IPC pixels and optical maps: PASS');
  const assertCurrentPixels = async () => {
    // Navigation and resize deliberately clear stale samples. Wait for the
    // actual current navigation/layout identity, rather than treating a fixed
    // 100ms loading interval as a completed capture.
    let current!:ToolbarState;
    await until(async()=>{const candidate=await toolbarState(toolbar),context=await invoke<ReadingContext>(main,'context',{viewId:native.id});if(candidate.busy||!candidate.backdropSample||!candidate.backdropImage||context.quality!=='confirmed'||candidate.backdropSample.navigationId!==context.viewport?.navigationId||candidate.backdropSample.layoutRevision!==context.viewport?.layoutRevision)return false;current=candidate;return true;},'current confirmed source/navigation/layout has an available sample');
    assert.ok(current.backdropSample && current.backdropImage);
    const exact = await app.evaluate(async ({ webContents, nativeImage }, input) => { const captured = await webContents.fromId(input.sample.sourceContentsId)!.capturePage(input.sample.captureBounds), expected = nativeImage.createFromDataURL(input.image); return captured.toBitmap().equals(expected.toBitmap()); }, { sample: current.backdropSample, image: current.backdropImage });
    assert.equal(exact, true, 'cache still contains actual current source pixels at its reported coordinates'); return current;
  };
  const paragraphY = await fixture.locator('#selectable').evaluate(element => element.getBoundingClientRect().top + scrollY); await fixture.evaluate(y => scrollTo(0, y - 40), paragraphY);
  await until(async () => (await toolbarState(toolbar)).backdropSample?.scrollY === await fixture.evaluate(() => scrollY), 'real paragraph enters capture strip'); const domBefore = await assertCurrentPixels();
  await fixture.locator('#selectable').evaluate(element => { element.textContent = 'REAL DOM mutation changes pixels inside the capture strip.'; });
  await until(async () => { const current = await toolbarState(toolbar); return !!current.backdropImage && current.backdropImage !== domBefore.backdropImage && current.backdropSample!.sourceRevision > domBefore.backdropSample!.sourceRevision; }, 'actual DOM mutation invalidates source epoch and image');
  const domAfter = await assertCurrentPixels(); assert.equal(domAfter.backdropSample!.sourceContentsId, sourceId); assert.equal(domAfter.backdropSample!.navigationId, domBefore.backdropSample!.navigationId);
  await fixture.evaluate(() => scrollTo(0, 180)); await until(async () => (await toolbarState(toolbar)).backdropSample?.scrollY === 180, 'scroll invalidates coordinates'); const scrolled = await assertCurrentPixels();
  assert.ok(scrolled.backdropSample!.sourceRevision > domAfter.backdropSample!.sourceRevision);
  const address = toolbar.getByRole('textbox', { name: '网页地址', exact: true }); await address.fill(`http://127.0.0.1:${port}/fixtures/interaction.html?qa=performance-navigation`); await address.press('Enter'); await address.blur();
  await until(async () => { const current = await toolbarState(toolbar); return !!current.backdropSample && current.backdropSample.navigationId !== scrolled.backdropSample!.navigationId; }, 'navigation creates a new epoch'); const navigated = await assertCurrentPixels(); assert.equal(navigated.backdropSample!.sourceContentsId, sourceId);
  const contextBeforeResize = await invoke<ReadingContext>(main, 'context', { viewId: native.id }); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await until(async () => { const current = await invoke<ReadingContext>(main, 'context', { viewId: native.id }); return current.viewport!.width !== contextBeforeResize.viewport!.width; }, 'real native viewport resize');
  await until(async () => { const current = await toolbarState(toolbar); return !!current.backdropSample && current.backdropSample.sourceRevision > navigated.backdropSample!.sourceRevision && JSON.stringify(current.backdropSample.captureBounds) !== JSON.stringify(navigated.backdropSample!.captureBounds); }, 'resize invalidates source and bounded capture geometry');
  const resized = await assertCurrentPixels(); assert.equal(resized.backdropSample!.navigationId, navigated.backdropSample!.navigationId); assert.ok(resized.backdropSample!.layoutRevision > navigated.backdropSample!.layoutRevision, 'actual resize invalidates old coordinate-layout requests');
  const nativePng = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id)!.capturePage()).toPNG().toString('base64'), sourceId); await writeFile(join(evidence, 'native-actual-page.png'), Buffer.from(nativePng, 'base64')); await toolbar.screenshot({ path: join(evidence, 'native-cache-toolbar.png'), omitBackground: true, scale: 'css' });
  results.invalidations = { domBefore: domBefore.backdropSample, domAfter: domAfter.backdropSample, scrolled: scrolled.backdropSample, navigated: navigated.backdropSample, resized: resized.backdropSample, finalStats: resized.backdropDiagnostics };
  assert.deepEqual(errors, []); await writeFile(join(evidence, 'results.json'), JSON.stringify({ ...results, errors }, null, 2)); console.log('Real DOM/scroll/navigation/resize invalidations preserve current epochs and pixels: PASS', evidence);
} catch (error) {
  await main.screenshot({ path: join(evidence, 'failure-main.png'), scale: 'css' }).catch(() => {});
  const renderer = await diagnostics(main).catch(() => undefined), toolbar = app.context().pages().find(page => page.url().includes('#/web-toolbar'));
  const native = toolbar ? await toolbarState(toolbar).catch(() => undefined) : undefined;
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ ...results, error: String(error), renderer, native: native ? { ...native, backdropImage: native.backdropImage?.slice(0, 80) } : undefined, errors }, null, 2)); console.error('Rendering performance evidence:', evidence); throw error;
} finally { await app.close(); }
