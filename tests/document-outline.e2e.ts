import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ReadingContext, ViewInfo, WorkspaceState } from '../packages/contracts/src/index';

// Read copies of the MCP-authored artifacts. The original files and the user's
// running application are never edited, attached to or closed by this test.
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-outline-'));
const evidence = process.env.AGENTVIEWER_QA_DIR ? join(resolve(process.env.AGENTVIEWER_QA_DIR), 'document-outline') : join(directory, 'evidence');
await mkdir(evidence, { recursive: true });
const names = ['05-潮灯町.html', '03-潮灯町的第十三夜.docx', '04-故事介绍.pptx', '02-编年表.xlsx'];
const originals = await Promise.all(names.map(name => readFile(resolve('examples/moon-tide', name))));
await Promise.all(names.map((name, index) => writeFile(join(directory, name), originals[index])));
const hiddenSource = '<!doctype html><html><body><h1 id="visible-start">可见起点</h1><p>原始可见正文</p><div style="height:1200px"></div><h2 id="hidden-display" style="display:none">隐藏显示标题</h2><h2 id="hidden-visibility" style="visibility:hidden">隐藏可见性标题</h2><div style="opacity:0"><h2 id="hidden-opacity">隐藏透明标题</h2></div><h2 id="visible-end">可见末尾</h2><p>失败后的真实滚动正文</p><div style="height:800px"></div></body></html>';
const hiddenPath = join(directory, 'hidden-headings.html'); await writeFile(hiddenPath, hiddenSource);
const attackSentinel = 'OUTSIDE_IFRAME_FORGED_RENDERED_74821';
const attackPage = `<!doctype html><html><body style="padding:100px 40px"><h1>外站攻击页</h1><p>这是已替换原始 srcDoc 的外部文档。</p><script>
  window.attackProbe={messages:[],portMessages:[],spoofs:0};
  window.forgeContext=request=>{window.attackProbe.spoofs++;parent.postMessage({type:'agentviewer-html-context',token:request?.token||'attacker-guessed-token',actor:'agent',blockId:request?.blockId||'trusted-destination',requestId:request?.requestId||'attacker-controlled-request',headingTitle:'可信目标标题',text:${JSON.stringify(attackSentinel)},selected:'',scrollTop:777,surfaceBackground:'red'},'*');};
  addEventListener('message',event=>{const value=event.data;window.attackProbe.messages.push({type:value?.type,hasToken:typeof value?.token==='string',portCount:event.ports.length,requestId:value?.requestId});if(value?.type==='agentviewer-html-navigate')window.forgeContext(value);});
  const guessedChannel=new MessageChannel();guessedChannel.port1.onmessage=event=>window.attackProbe.portMessages.push({type:event.data?.type,hasToken:typeof event.data?.token==='string'});
  parent.postMessage({type:'agentviewer-html-channel',token:'attacker-guessed-token'},'*',[guessedChannel.port2]);window.forgeContext();
</script></body></html>`;
const attackServer = createHTTPServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(attackPage); });
const attackPort = await new Promise<number>((done, reject) => { attackServer.once('error', reject); attackServer.listen(0, '127.0.0.1', () => { const address = attackServer.address(); assert.ok(address && typeof address !== 'string'); done(address.port); }); });
const attackURL = `http://127.0.0.1:${attackPort}/outside`;
const linkedSource = `<!doctype html><html><body style="padding:100px 40px"><h1 id="trusted-origin">可信源标题</h1><p>可信源的实际正文。</p><a href="${attackURL}">前往外站攻击页</a><div style="height:900px"></div><h2 id="trusted-destination">可信目标标题</h2><p>可信目标的实际正文。</p></body></html>`;
await writeFile(join(directory, 'external-navigation.html'), linkedSource);
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1', AGENTVIEWER_CONNECTION_FILE: join(directory, 'runtime', 'connection.json') };
delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTVIEWER_VITE_URL;
const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: resolve('.'), env, timeout: 45000 });
const main = await app.firstWindow(), errors: string[] = [], results: Record<string, unknown> = {};
const watch = (page: Page) => page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`));
app.context().pages().forEach(watch); app.context().on('page', watch);
const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => main.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
const until = async (check: () => Promise<boolean>, label: string) => { const end = Date.now() + 12000; while (Date.now() < end) { if (await check()) return; await new Promise(done => setTimeout(done, 60)); } throw new Error(`Outline verification timed out: ${label}`); };
const state = () => invoke<WorkspaceState>('state');
const context = (viewId: string) => invoke<ReadingContext>('context', { viewId });
const open = async (name: string, format: string) => { const view = await invoke<ViewInfo>('open', { uri: join(directory, name) }); await until(async () => await main.locator(`.reader-format-${format}`).count() === 1 && (await state()).activeViewId === view.id, `open ${format}`); return view; };
const showOutline = async () => { const button = main.getByRole('button', { name: '目录与结构', exact: true }); if (await button.getAttribute('aria-pressed') !== 'true') await button.click(); await main.locator('.format-sidebar .outline-item').first().waitFor(); };

try {
  await main.locator('.prose h1').waitFor();
  results.rendererAssets = await main.evaluate(() => [...document.scripts].map(script => script.src).filter(Boolean));
  const builtIndex = await readFile(resolve('dist/renderer/index.html'), 'utf8');
  const expectedRenderer = process.env.AGENTVIEWER_EXPECTED_RENDERER ?? /\/assets\/(index-[^"']+\.js)/.exec(builtIndex)?.[1];
  assert.ok(expectedRenderer, 'a built renderer asset is available'); results.expectedRenderer = expectedRenderer;
  assert.ok((results.rendererAssets as string[]).some(source => source.endsWith('/' + expectedRenderer)), 'the frozen renderer is actually loaded');
  await invoke('settings-set', { id: 'appearance.motion', value: 'off' });
  await invoke('settings-set', { id: 'appearance.autoHideToolbar', value: false });
  const html = await open(names[0], 'html'); await showOutline();
  const shared = await invoke<{ id: string; title: string; level?: number }[]>('outline', { documentId: html.documentId });
  assert.equal(shared.length, 18);
  await until(async () => await main.locator('.format-sidebar .outline-item').count() === 18, '18 real HTML outline entries');
  assert.deepEqual(await main.locator('.format-sidebar .outline-item').allTextContents(), shared.map(item => item.title));
  const preview = main.frameLocator('iframe.html-preview'), chapter = preview.locator('#chapter-5');
  await chapter.waitFor(); assert.equal(await chapter.getAttribute('open'), null, 'the fifth chapter starts collapsed');
  const fifth = shared.find(item => item.title === '新的初见')!; assert.ok(fifth);
  await main.locator('.format-sidebar .outline-item').filter({ hasText: '新的初见' }).click();
  await until(async () => await chapter.getAttribute('open') !== null, 'outline click opens the real details element');
  const geometry = await chapter.locator('h3').evaluate(node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, viewportHeight: innerHeight, scrollY }; });
  assert.ok(geometry.height > 0 && geometry.width > 0 && geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight, 'the heading is truly within the iframe viewport');
  await until(async () => { const current = await context(html.id); return current.quality === 'confirmed' && current.actor === 'human' && current.locator.blockId === fifth.id && current.visibleText.includes('天亮以后'); }, 'real HTML heading/visible text context');
  const fifthContext = await context(html.id);
  const closedChapterText = [
    { id: 'chapter-2', quote: '少年跨不过门槛。' },
    { id: 'chapter-3', quote: '第二天，澪趁纱婆睡着，拆开了主灯的木座。' },
    { id: 'chapter-4', quote: '第十三夜，第一盏来的是米糕铺的灯。' },
  ];
  const closedChapters = await Promise.all(closedChapterText.map(async item => {
    const details = preview.locator(`#${item.id}`);
    assert.equal(await details.getAttribute('open'), null, `${item.id} remains collapsed after fifth-chapter navigation`);
    const body = await details.locator('.chapter-body p').first().evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { text: node.textContent, painted: node.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }), rect: { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } };
    });
    assert.equal(body.text, item.quote, 'the excluded quote belongs to the actual collapsed chapter body');
    return { ...item, body, includedInVisibleText: fifthContext.visibleText.includes(item.quote) };
  }));
  results.html = { outline: shared, geometry, context: fifthContext, closedChapters };
  assert.ok(fifthContext.visibleText.includes('天亮以后'), 'visible context contains the rendered fifth-chapter opening');
  assert.deepEqual(closedChapters.filter(chapter => chapter.includedInVisibleText).map(chapter => chapter.id), [], 'visible context excludes the body of collapsed chapters 2, 3 and 4');
  const htmlDoc = (await state()).documents.find(document => document.id === html.documentId)!;
  assert.equal(htmlDoc.revision, 0); assert.equal(htmlDoc.dirty, false);
  await main.screenshot({ path: join(evidence, 'html-fifth-chapter.png'), scale: 'css' });

  const word = await open(names[1], 'docx'); await showOutline();
  const wordDoc = (await state()).documents.find(document => document.id === word.documentId)!;
  const headings = wordDoc.model.blocks!.filter(block => /^Heading[1-6]$/.test(block.style ?? ''));
  await until(async () => await main.locator('.format-sidebar .outline-item').count() === headings.length, 'actual Word heading count');
  assert.deepEqual(await main.locator('.format-sidebar .outline-item').allTextContents(), headings.map(block => block.text));
  const wordFifth = headings.find(block => block.text.includes('第五章'))!; assert.ok(wordFifth);
  const actualIndex = wordDoc.model.blocks!.findIndex(block => block.id === wordFifth.id), outlineIndex = headings.indexOf(wordFifth); assert.notEqual(actualIndex, outlineIndex);
  await main.locator('.format-sidebar .outline-item').filter({ hasText: '第五章' }).click();
  const wordGeometry = await main.locator(`[data-block-id="${wordFifth.id}"]`).evaluate(node => { const rect = node.getBoundingClientRect(), pane = node.closest('.document-content')!.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, paneTop: pane.top, paneBottom: pane.bottom }; });
  assert.ok(wordGeometry.top >= wordGeometry.paneTop && wordGeometry.bottom <= wordGeometry.paneBottom, 'the Word directory uses the real paragraph index');
  await until(async () => {
    const current = await context(word.id);
    return current.actor === 'human' && current.locator.kind === 'docx' && current.visibleText.includes(wordFifth.text);
  }, 'Word heading is part of actual human reading context');
  results.word = { actualIndex, outlineIndex, heading: wordFifth.text, geometry: wordGeometry, context: await context(word.id) };

  const ppt = await open(names[2], 'pptx'); await showOutline();
  const pptDoc = (await state()).documents.find(document => document.id === ppt.documentId)!, slides = pptDoc.model.slides!;
  await until(async () => await main.locator('.format-sidebar .outline-item').count() === slides.length, 'PowerPoint slide directory count');
  const slideIndex = Math.min(4, slides.length - 1); assert.ok(slideIndex > 0);
  await main.locator('.format-sidebar .outline-item').nth(slideIndex).click();
  await main.locator(`.office-slide-canvas[data-slide-id="${slides[slideIndex].id}"]`).waitFor();
  await until(async () => (await context(ppt.id)).locator.slideId === slides[slideIndex].id, 'PowerPoint context identifies the rendered slide');
  results.ppt = { count: slides.length, slideId: slides[slideIndex].id, context: await context(ppt.id) };

  const xlsx = await open(names[3], 'xlsx'); await showOutline();
  const sheetDoc = (await state()).documents.find(document => document.id === xlsx.documentId)!, sheets = sheetDoc.model.sheets!;
  await until(async () => await main.locator('.format-sidebar .outline-item').count() === sheets.length, 'Excel worksheet directory count');
  assert.deepEqual(await main.locator('.format-sidebar .outline-item').allTextContents(), sheets.map(sheet => sheet.name));
  const targetSheet = sheets.find(sheet => sheet.name === '人物')!; assert.ok(targetSheet);
  await main.locator('.format-sidebar .outline-item').filter({ hasText: '人物' }).click();
  await main.locator(`.office-spreadsheet-stage[data-sheet-id="${targetSheet.id}"]`).waitFor();
  await until(async () => { const current = await context(xlsx.id); return current.locator.sheetId === targetSheet.id && current.visibleText.includes('澪'); }, 'Excel context identifies the rendered worksheet');
  results.xlsx = { count: sheets.length, sheetId: targetSheet.id, context: await context(xlsx.id) };
  await main.screenshot({ path: join(evidence, 'excel-directory.png'), scale: 'css' });

  const hidden = await open('hidden-headings.html', 'html'); await showOutline();
  const connection = JSON.parse(await readFile(join(directory, 'runtime', 'connection.json'), 'utf8')) as { endpoint: string; token: string };
  const failures: unknown[] = [];
  results.hidden = failures;
  for (const blockId of ['hidden-display', 'hidden-visibility', 'hidden-opacity']) {
    results.hiddenAttempt = { blockId, before: await context(hidden.id) };
    await main.locator('.format-sidebar .outline-item').filter({ hasText: '可见起点' }).click();
    await until(async () => { const current = await context(hidden.id); return current.actor === 'human' && current.locator.blockId === 'visible-start'; }, 'human baseline before hidden target');
    const response = await fetch(connection.endpoint + '/api/command', { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'reader-navigate', args: { viewId: hidden.id, expectedRevision: 0, target: { kind: 'html-heading', blockId }, idempotencyKey: crypto.randomUUID() } }) });
    assert.equal(response.status, 200); const receipt = await response.json(); assert.equal(receipt.status, 'requested');
    await main.locator('.toast').filter({ hasText: 'HTML 标题未在当前视口' }).waitFor();
    const failedContext = await context(hidden.id); assert.notEqual(failedContext.actor, 'agent'); assert.notEqual(failedContext.locator.blockId, blockId);
    const box = await main.locator('iframe.html-preview').boundingBox(); assert.ok(box); await main.mouse.move(box.x + box.width * .8, box.y + box.height * .7); await main.mouse.wheel(0, 240);
    await until(async () => (await context(hidden.id)).viewRevision > failedContext.viewRevision, 'passive context after failure');
    const after = await context(hidden.id); assert.notEqual(after.actor, 'agent'); assert.notEqual(after.locator.blockId, blockId);
    // Chromium's wheel animation can outlive the first reported scroll event.
    // Finish that real movement before the next instant directory jump.
    let lastScroll: number | undefined, stableSince = Date.now();
    await until(async () => {
      const position = await main.frameLocator('iframe.html-preview').locator('body').evaluate(() => scrollY);
      if (position !== lastScroll) { lastScroll = position; stableSince = Date.now(); }
      return Date.now() - stableSince >= 240;
    }, 'actual iframe wheel scrolling settles before another directory jump');
    const settled = await context(hidden.id); assert.notEqual(settled.actor, 'agent'); assert.notEqual(settled.locator.blockId, blockId);
    failures.push({ blockId, receipt, failedContext, after, settledScrollY: lastScroll, settled });
  }
  results.hidden = failures;
  const linked = await open('external-navigation.html', 'html'); await showOutline();
  await until(async () => (await context(linked.id)).visibleText.includes('可信源的实际正文'), 'initial trusted srcDoc channel is ready');
  const previewElement = await main.locator('iframe.html-preview').elementHandle(); assert.ok(previewElement);
  const externalFrame = await previewElement.contentFrame(); assert.ok(externalFrame);
  await main.evaluate(() => { (window as unknown as { qaOriginalPreview: Window | null }).qaOriginalPreview = document.querySelector<HTMLIFrameElement>('iframe.html-preview')!.contentWindow; });
  await externalFrame.getByRole('link', { name: '前往外站攻击页', exact: true }).click();
  await externalFrame.getByRole('heading', { name: '外站攻击页', exact: true }).waitFor();
  assert.equal(externalFrame.url(), attackURL, 'the actual iframe navigated to the loopback external site');
  assert.equal(await main.evaluate(() => (window as unknown as { qaOriginalPreview: Window | null }).qaOriginalPreview === document.querySelector<HTMLIFrameElement>('iframe.html-preview')!.contentWindow), true, 'the same WindowProxy now owns an untrusted document');
  await until(async () => {
    const current = await context(linked.id);
    return current.actor === 'human' && current.quality === 'not-ready' && current.visibleText === '' && !current.locator.blockId && current.selection.kind === 'none';
  }, 'external load invalidates the original trusted reading context');
  const invalidatedContext = await context(linked.id);
  // The leave notification may display a transient warning independently of
  // the new request. Do not mistake that older toast for this request's failure.
  await until(async () => await main.locator('.toast').count() === 0, 'any prior leave warning has completed');
  const attackResponse = await fetch(connection.endpoint + '/api/command', { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'reader-navigate', args: { viewId: linked.id, expectedRevision: 0, target: { kind: 'html-heading', blockId: 'trusted-destination' }, idempotencyKey: crypto.randomUUID() } }) });
  assert.equal(attackResponse.status, 200); const attackReceipt = await attackResponse.json() as { status: string; requestId: string }; assert.equal(attackReceipt.status, 'requested');
  // Give the attacker the public request ID as an extra adversarial condition;
  // it still has neither the original MessagePort nor its private capability.
  await externalFrame.evaluate(input => { (window as unknown as { forgeContext(request: { requestId: string; blockId: string }): void }).forgeContext(input); }, { requestId: attackReceipt.requestId, blockId: 'trusted-destination' });
  await until(async () => {
    const current = await context(linked.id);
    assert.notEqual(current.actor, 'agent', 'external window messages never impersonate an agent navigation');
    assert.notEqual(current.locator.blockId, 'trusted-destination', 'the external page cannot acknowledge the original target');
    assert.ok(!current.visibleText.includes(attackSentinel), 'external forged body never becomes trusted reading context');
    return await main.locator('.toast').filter({ hasText: /目标视图未准备就绪|HTML.*(?:不可用|失效|离开|未准备|已导航|已跳转)/ }).count() > 0;
  }, 'external navigation fails rather than accepting a forged rendered acknowledgement');
  const attackProbe = await externalFrame.evaluate(() => (window as unknown as { attackProbe: { messages: { type?: string; hasToken: boolean; portCount: number }[]; portMessages: unknown[]; spoofs: number } }).attackProbe);
  results.externalNavigation = { attackURL, receipt: attackReceipt, probe: attackProbe, invalidatedContext, context: await context(linked.id), failureText: await main.locator('.toast').allTextContents() };
  assert.ok(attackProbe.spoofs >= 2, 'the external script actually attempted both spontaneous and request-specific forgeries');
  assert.ok(attackProbe.messages.every(message => !message.hasToken && message.type !== 'agentviewer-html-navigate' && message.portCount === 0), 'the external WindowProxy receives no token, navigation command or private port');
  assert.deepEqual(attackProbe.portMessages, [], 'a guessed bootstrap channel never receives private navigation');
  assert.deepEqual(await readFile(join(directory, 'external-navigation.html'), 'utf8'), linkedSource, 'external browsing never writes the local source document');
  await main.screenshot({ path: join(evidence, 'external-iframe-isolation.png'), scale: 'css' });
  for (let index = 0; index < names.length; index++) {
    assert.deepEqual(await readFile(resolve('examples/moon-tide', names[index])), originals[index], 'original creative artifact bytes are unchanged');
    assert.deepEqual(await readFile(join(directory, names[index])), originals[index], 'navigation never writes the copied file');
  }
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, directory, port, results, rendererErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence, checks: ['HTML 18 shared headings/details/human context', 'Word real paragraph indices', 'PowerPoint slide directory', 'Excel sheet directory', 'three invisible agent targets remain human after failure', 'external iframe cannot receive capabilities or forge rendered context', 'original and copied bytes unchanged'], rendererErrors: errors }, null, 2));
} catch (error) {
  try {
    const currentState = await state(), active = currentState.views.find(view => view.id === currentState.activeViewId);
    results.failureContext = active ? await context(active.id) : undefined;
    results.failureVisibleWord = await main.locator('.office-word-paragraph').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect(), pane = node.closest('.document-content')?.getBoundingClientRect();
      return { id: (node as HTMLElement).dataset.blockId, text: (node as HTMLElement).innerText, rect: { top: rect.top, bottom: rect.bottom }, pane: pane && { top: pane.top, bottom: pane.bottom } };
    }).filter(node => node.pane && node.rect.bottom > node.pane.top && node.rect.top < node.pane.bottom));
  } catch (diagnosticError) { results.failureDiagnosticError = String(diagnosticError); }
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), directory, results, rendererErrors: errors }, null, 2));
  await main.screenshot({ path: join(evidence, 'failure.png'), scale: 'css' }).catch(() => {}); throw error;
} finally { try { await app.close(); } finally { await new Promise<void>((done, reject) => attackServer.close(error => error ? reject(error) : done())); } }
