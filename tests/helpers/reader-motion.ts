import assert from 'node:assert/strict';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Locator, Page } from 'playwright';

type Sample = { t: number; top: number; elastic: number; phase?: string; inert?: boolean; opacity: number | null };

/** Real production input, with DOM Ranges used only to measure painted glyphs. */
export async function verifyReaderMotion(main: Page, directory: string, evidence: string) {
  const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => main.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
  const closeFixture = async (viewId: string) => {
    // Closing through the real UI drains renderer drafts before retiring its
    // view. A raw Core close can strand a queued draft for the next test tab.
    const tab = main.locator('.tab[data-view-id=' + JSON.stringify(viewId) + ']');
    await tab.locator('.tab-close').click();
    await main.waitForFunction(id => !document.querySelector('.tab[data-view-id=' + JSON.stringify(id) + ']') || !!document.querySelector('.confirm-dialog'), viewId);
    const dialog = main.getByRole('dialog', { name: '保存文档更改？', exact: true });
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
    await tab.waitFor({ state: 'detached' });
  };
  let chunk: string | undefined;
  for (const name of await readdir(resolve('dist/renderer/assets'))) if (name.endsWith('.js') && (await readFile(resolve('dist/renderer/assets', name), 'utf8')).includes('findFromDOM')) { chunk = name; break; }
  assert.ok(chunk);
  const url = new URL('assets/' + chunk, main.url()).href;
  const text = '---\ntitle: "Pointer and motion"\n---\n\n# Pointer alignment 中文\n\n[TOC]\n\nA **bold phrase** and normal words for caret placement.\n\nA [linked phrase](https://example.test/long-target) and `inline code`.\n\n> Quoted phrase.\n\n- Listed phrase.\n\nSetext heading\n--------------\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n\n## After table\n\nClick here after table 中文文字.\n\nPlain text for selection.\n\n' + Array.from({ length: 90 }, (_, i) => `Paragraph ${i} 中文测试。 A scrolling document with selectable text.`).join('\n\n') + '\n\nLong edit target ' + 'Large paragraph 中文. '.repeat(4000) + ' trailing 中文. '.repeat(4000) + '\n';
  const path = join(directory, 'pointer-motion.md'); await writeFile(path, text);
  const view = await invoke<{ id: string; documentId: string }>('open', { uri: path, windowId: 'main' });
  const editor = main.locator('[data-markdown-view=' + JSON.stringify(view.id) + ']'), reader = main.locator('.document-content').first();
  await editor.locator('.md-heading-1').waitFor();
  const selectedRail = main.locator('.activity-rail button[aria-pressed="true"]'); if (await selectedRail.count()) { await selectedRail.first().click(); await main.locator('#format-tools').waitFor({ state: 'hidden' }); }
  await invoke('settings-set', { id: 'appearance.motion', value: 'standard' });
  const frames = () => main.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const navigate = async (needle: string, select = false) => {
    await editor.evaluate(async (node, input) => {
      const module = await import(input.url), E = Object.values(module).find((item: any) => item?.findFromDOM) as any;
      E.findFromDOM(node.querySelector('.cm-content')).dispatch({ ...(input.select ? { selection: { anchor: input.from } } : {}), effects: E.scrollIntoView(input.from, { y: 'center' }) });
    }, { url, from: text.indexOf(needle) + (select ? 6 : 0), select });
    await frames();
    await editor.evaluate(async (node, input) => {
      const module = await import(input.url), E = Object.values(module).find((item: any) => item?.findFromDOM) as any, view = E.findFromDOM(node.querySelector('.cm-content'));
      const dom = view.domAtPos(input.position), element = dom.node.nodeType === Node.ELEMENT_NODE ? dom.node as Element : dom.node.parentElement;
      element?.closest('.cm-line')?.scrollIntoView({ block: input.select ? 'start' : 'center', inline: 'nearest' });
    }, { url, position: text.indexOf(needle) + (select ? 6 : 0), select });
    await frames();
  };
  const point = (target: Locator, needle: string, offset: number) => target.evaluate(async (node, input) => {
    const module = await import(input.url), E = Object.values(module).find((item: any) => item?.findFromDOM) as any, view = E.findFromDOM(node.querySelector('.cm-content'));
    // TOC labels can repeat a heading, and giant lines split words across DOM
    // tiles. Use public source mapping, then verify the real DOM Range roundtrip.
    let dom = view.domAtPos(input.position);
    // At a hidden delimiter boundary CM may return an element child offset.
    // The adjacent glyph's text node can represent that same source caret.
    if (dom.node.nodeType !== Node.TEXT_NODE) for (const distance of [-1, 1]) {
      const adjacent = input.position + distance; if (adjacent < 0 || adjacent > view.state.doc.length) continue;
      const candidate = view.domAtPos(adjacent), offset = candidate.offset - distance;
      if (candidate.node.nodeType === Node.TEXT_NODE && offset >= 0 && offset <= candidate.node.textContent!.length && view.posAtDOM(candidate.node, offset) === input.position) { dom = { node: candidate.node, offset }; break; }
    }
    const position = view.posAtDOM(dom.node, dom.offset) as number;
    if (position !== input.position || dom.node.nodeType !== Node.TEXT_NODE || !dom.node.parentElement?.closest('.cm-line')) throw new Error('Missing painted source glyph: ' + input.needle);
    const range = document.createRange(); range.setStart(dom.node, dom.offset); range.collapse(true);
    const box = range.getBoundingClientRect(), viewport = node.closest('.document-content')!.getBoundingClientRect(), y = box.y + box.height / 2;
    if (box.x < Math.max(0, viewport.left) || box.x > Math.min(innerWidth, viewport.right) || y < Math.max(0, viewport.top) || y > Math.min(innerHeight, viewport.bottom)) throw new Error('Source glyph is outside the visible reader: ' + input.needle + ' at ' + box.x + ',' + y);
    return { x: box.x, y, position };
  }, { needle, position: text.indexOf(needle) + offset, url });
  const clicks: unknown[] = [];
  for (const zoom of [80, 100, 125, 150, 200]) {
    const input = main.getByRole('spinbutton', { name: '正文缩放比例', exact: true }); await input.fill(String(zoom)); await input.press('Enter'); await frames();
    for (const needle of ['Pointer alignment', 'bold phrase', 'normal words', 'linked phrase', 'inline code', 'Quoted phrase', 'Listed phrase', 'Setext heading', 'Click here after table']) {
      // Start on another line so the first click must preserve both the
      // source character and painted position as live decorations update.
      await editor.evaluate(async (node, url) => { const m = await import(url), E = Object.values(m).find((v: any) => v?.findFromDOM) as any; E.findFromDOM(node.querySelector('.cm-content')).dispatch({ selection: { anchor: 0 } }); }, url);
      await navigate(needle);
      const p = await point(editor, needle, 6);
      assert.equal(p.position, text.indexOf(needle) + 6, 'the measured DOM glyph maps to the intended source offset before clicking');
      await main.mouse.click(p.x, p.y); await frames();
      const actual = await editor.evaluate(async (node, input) => {
        const module = await import(input.url), E = Object.values(module).find((item: any) => item?.findFromDOM) as any;
        const view = E.findFromDOM(node.querySelector('.cm-content')), head = view.state.selection.main.head, rect = view.coordsAtPos(head);
        const next = view.coordsAtPos(Math.min(head + 1, view.state.doc.length)), caret = node.querySelector('.cm-cursor')!;
        return { head, rect, next, width: caret.getBoundingClientRect().width, color: getComputedStyle(caret).borderLeftColor };
      }, { url });
      assert.ok(actual.rect && actual.next);
      const glyph = Math.abs(actual.next.left - actual.rect.left);
      if (Math.abs(actual.rect.left - p.x) > Math.max(4, glyph * .6) || p.y < actual.rect.top - 1 || p.y > actual.rect.bottom + 1 || actual.head !== text.indexOf(needle) + 6) await writeFile(join(evidence, 'pointer-click-failure.json'), JSON.stringify({ zoom, needle, pointer: p, expectedHead: text.indexOf(needle) + 6, ...actual }, null, 2));
      assert.ok(Math.abs(actual.rect.left - p.x) <= Math.max(4, glyph * .6), `caret follows painted glyph at ${zoom}%: ${needle}`);
      assert.ok(p.y >= actual.rect.top - 1 && p.y <= actual.rect.bottom + 1, 'click stays on the painted text line after widgets');
      assert.equal(actual.head, text.indexOf(needle) + 6, `first click preserves the exact source offset at ${zoom}%: ${needle}`);
      assert.ok(actual.width >= 1.5, 'insertion caret remains visible at document zoom');
      clicks.push({ zoom, needle, pointer: p, ...actual });
    }
    if (zoom === 100) await main.screenshot({ path: join(evidence, 'pointer-light.png'), scale: 'css' });
  }
  const zoomInput = main.getByRole('spinbutton', { name: '正文缩放比例', exact: true }); await zoomInput.fill('100'); await zoomInput.press('Enter'); await frames();
  for (const [startText, startOffset, endText, endOffset] of [['bold phrase', 1, 'bold phrase', 10], ['bold phrase', 2, 'normal words', 6], ['linked phrase', 2, 'inline code', 6]] as const) for (const reverse of [false, true]) {
    // A second drag starting inside the previous selection starts native
    // drag/drop rather than creating a fresh reverse text selection.
    await editor.evaluate(async (node, url) => { const m = await import(url), E = Object.values(m).find((v: any) => v?.findFromDOM) as any; E.findFromDOM(node.querySelector('.cm-content')).dispatch({ selection: { anchor: 0 } }); }, url);
    await navigate(startText);
    const first = await point(editor, startText, startOffset), last = await point(editor, endText, endOffset), from = reverse ? last : first, to = reverse ? first : last;
    await main.mouse.move(from.x + (reverse ? -.2 : .2), from.y); await main.mouse.down(); await main.mouse.move(to.x + (reverse ? .2 : -.2), to.y, { steps: 8 }); await main.mouse.up(); await frames();
    const selection = await editor.evaluate(async (node, url) => { const m = await import(url), E = Object.values(m).find((v: any) => v?.findFromDOM) as any; const v = E.findFromDOM(node.querySelector('.cm-content')), r = v.state.selection.main; return { from: r.from, to: r.to, head: r.head, text: v.state.sliceDoc(r.from, r.to), box: v.coordsAtPos(r.head) }; }, url);
    const startPosition = text.indexOf(startText) + startOffset, endPosition = text.indexOf(endText) + endOffset;
    assert.deepEqual({ from: selection.from, to: selection.to, text: selection.text }, { from: startPosition, to: endPosition, text: text.slice(startPosition, endPosition) }, 'dragging within and across formatted text preserves its exact source range in either direction');
    assert.equal(selection.head, reverse ? startPosition : endPosition, 'a fresh drag places the selection head at the actual mouse endpoint');
    if (!selection.box || Math.abs(selection.box.left - to.x) >= 1 || to.y < selection.box.top - 1 || to.y > selection.box.bottom + 1) await writeFile(join(evidence, 'pointer-drag-failure.json'), JSON.stringify({ startText, startOffset, endText, endOffset, reverse, from, to, selection }, null, 2));
    assert.ok(selection.box && Math.abs(selection.box.left - to.x) < 1 && to.y >= selection.box.top - 1 && to.y <= selection.box.bottom + 1, 'cross-format dragging leaves its final caret at the mouse position');
  }
  // Modes reuse one editor and history. Test real insertion inside a large
  // wrapped line, then undo after changing modes and redo in the live view.
  // Browser source avoids tsx's Node-only keepNames helper on event handlers.
  await main.evaluate(`((viewId) => {
    const node = document.querySelector('[data-markdown-view=' + JSON.stringify(viewId) + ']');
    const events = [], record = event => { if (events.length >= 100) events.shift(); events.push({ type: event.type, key: event.key, inputType: event.inputType, time: performance.now(), prevented: event.defaultPrevented }); };
    for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'focusin', 'focusout']) node.addEventListener(type, record, true);
    const history = event => { const detail = event.detail; if (detail?.viewId === viewId) { if (events.length >= 100) events.shift(); events.push({ type: event.type, ...detail, time: performance.now() }); } };
    window.addEventListener('agentviewer:markdown-editor-history', history); window.__markdownHistoryProbe = { events, history, record };
  })(${JSON.stringify(view.id)})`);
  const waitForSource = async (expected: string, label: string) => {
    try {
      await main.waitForFunction(async input => { const node = document.querySelector('[data-markdown-view=' + JSON.stringify(input.viewId) + '] .cm-content'); if (!node) return false; const module = await import(input.url), E = Object.values(module).find((item: any) => item?.findFromDOM) as any; return E.findFromDOM(node).state.doc.toString() === input.expected; }, { url, viewId: view.id, expected }, { timeout: 10000, polling: 50 });
    } catch (error) {
      const diagnostic = await editor.evaluate(async (node, url) => { const module = await import(url), E = Object.values(module).find((item: any) => item?.findFromDOM) as any, view = E.findFromDOM(node.querySelector('.cm-content')), state = view.state, history = state.values?.find((value: any) => Array.isArray(value?.done) && Array.isArray(value?.undone)); return { activeElement: { tag: document.activeElement?.tagName, className: document.activeElement?.className, editorFocused: view.hasFocus }, selection: state.selection.toJSON(), length: state.doc.length, nearbyText: state.doc.sliceString(Math.max(0, state.selection.main.head - 40), Math.min(state.doc.length, state.selection.main.head + 40)), history: history ? { undoDepth: history.done.length, redoDepth: history.undone.length } : undefined, events: (window as any).__markdownHistoryProbe?.events }; }, url);
      await writeFile(join(evidence, 'markdown-history-timeout.json'), JSON.stringify({ label, expectedLength: expected.length, diagnostic }, null, 2)); throw error;
    }
    const actual = await editor.evaluate(async (node, url) => { const module = await import(url), E = Object.values(module).find((item: any) => item?.findFromDOM) as any; return E.findFromDOM(node.querySelector('.cm-content')).state.doc.toString() as string; }, url);
    assert.equal(actual, expected, label);
  };
  await invoke('mode', { viewId: view.id, mode: 'source' }); await editor.locator(':scope:not(.markdown-live)').waitFor();
  await navigate('Long edit target', true); const longPoint = await point(editor, 'Long edit target', 6); await main.mouse.click(longPoint.x, longPoint.y); await frames();
  const expectedLongPosition = text.indexOf('Long edit target') + 6;
  const sourcePosition = await editor.evaluate(async (node, url) => { const m = await import(url), E = Object.values(m).find((v: any) => v?.findFromDOM) as any; return E.findFromDOM(node.querySelector('.cm-content')).state.selection.main.head; }, url); assert.equal(sourcePosition, expectedLongPosition);
  await main.keyboard.insertText('编辑🙂');
  const expectedEdited = text.slice(0, expectedLongPosition) + '编辑🙂' + text.slice(expectedLongPosition);
  await waitForSource(expectedEdited, 'large-line insertion changes the clicked source position');
  await invoke('mode', { viewId: view.id, mode: 'read' }); await editor.locator(':scope.markdown-live').waitFor(); await editor.locator('.cm-content').focus(); await main.keyboard.press('Control+z'); await waitForSource(text, 'switching source/live retains the insertion undo history');
  await main.keyboard.press('Control+y'); await waitForSource(expectedEdited, 'redo restores the exact insertion'); await main.keyboard.press('Control+z'); await waitForSource(text, 'undo restores the exact original document');
  await main.waitForFunction(async input => { const state = await window.agentViewer!.call('state') as { documents: { id: string; model: { text?: string } }[] }; return state.documents.find(document => document.id === input.documentId)?.model.text === input.text; }, { documentId: view.documentId, text }, { timeout: 10000, polling: 50 }); await frames();
  await editor.evaluate(node => { const probe = (window as any).__markdownHistoryProbe; if (!probe) return; for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'focusin', 'focusout']) node.removeEventListener(type, probe.record, true); window.removeEventListener('agentviewer:markdown-editor-history', probe.history); delete (window as any).__markdownHistoryProbe; });
  const paperWidth = (await editor.boundingBox())!.width, emptyPath = join(directory, 'empty-pointer.md'); await writeFile(emptyPath, '');
  const empty = await invoke<{ id: string; documentId: string }>('open', { uri: emptyPath, windowId: 'main' }), emptyEditor = main.locator('[data-markdown-view=' + JSON.stringify(empty.id) + ']'); await main.getByRole('button', { name: 'empty-pointer.md', exact: true }).click(); await emptyEditor.locator('.cm-content').waitFor(); await frames();
  assert.ok(Math.abs((await emptyEditor.boundingBox())!.width - paperWidth) < 1, 'an empty document retains the full paper width');
  const emptyPoint = await emptyEditor.evaluate(async (node, url) => { const m = await import(url), E = Object.values(m).find((v: any) => v?.findFromDOM) as any; const box = E.findFromDOM(node.querySelector('.cm-content')).coordsAtPos(0); return { x: box.left + 30, y: (box.top + box.bottom) / 2 }; }, url); await main.mouse.click(emptyPoint.x, emptyPoint.y); await main.keyboard.insertText('空白正文🙂');
  await main.waitForFunction(async id => { const state = await window.agentViewer!.call('state') as { documents: { id: string; model: { text?: string } }[] }; return state.documents.find(d => d.id === id)?.model.text === '空白正文🙂'; }, empty.documentId);
  await closeFixture(empty.id); await invoke('activate', { viewId: view.id }); await editor.locator('.cm-content').waitFor();
  await invoke('settings-set', { id: 'appearance.theme', value: 'dark' }); await frames();
  await main.screenshot({ path: join(evidence, 'pointer-dark.png'), scale: 'css' });
  await invoke('settings-set', { id: 'appearance.theme', value: 'light' });
  const zoom = main.getByRole('spinbutton', { name: '正文缩放比例', exact: true }); await zoom.fill('100'); await zoom.press('Enter'); await frames();
  const sample = async (action: () => Promise<unknown>) => {
    // A plain browser script avoids tsx's Node-only keepNames helper being
    // serialized along with the recursive requestAnimationFrame callback.
    await main.evaluate(`(() => {
      const w = window; w.readerMotionSamples = []; w.readerMotionSampling = true; const start = performance.now();
      const tick = (now) => {
        const e = document.querySelector('.document-content'), t = document.querySelector('.selection-tools'), row = t?.querySelector('.selection-tool-row');
        w.readerMotionSamples.push({ t: now - start, top: e.scrollTop, elastic: Number(e.dataset.scrollElastic || 0), phase: t?.dataset.motionPhase, inert: t?.inert, opacity: row ? Number(getComputedStyle(row).opacity) : null });
        if (now - start < 850) requestAnimationFrame(tick); else w.readerMotionSampling = false;
      }; requestAnimationFrame(tick);
    })()`);
    await action(); await main.waitForFunction(() => !(window as any).readerMotionSampling);
    const samples = await main.evaluate(() => (window as any).readerMotionSamples as Sample[]);
    await writeFile(join(evidence, 'motion-last-sample.json'), JSON.stringify(samples, null, 2));
    return samples;
  };
  await reader.evaluate(e => { e.scrollTop = 250; }); await frames(); await main.mouse.move(1100, 600);
  const inertia = await sample(() => main.mouse.wheel(0, 120));
  assert.ok(inertia.some(s => s.top > 251 && s.top < 369), 'wheel paints intermediate positions');
  assert.ok(Math.abs(inertia.at(-1)!.top - 370) < 1, 'wheel preserves requested distance after deceleration');
  await reader.evaluate(e => { e.scrollTop = 0; }); await frames();
  const top = await sample(async () => { await main.mouse.wheel(0, -120); await main.waitForTimeout(45); await main.mouse.wheel(0, -120); });
  assert.ok(Math.max(...top.map(s => s.elastic)) > 5 && Math.max(...top.map(s => s.elastic)) < 96, 'top edge resists repeated pulls');
  assert.equal(top.at(-1)!.elastic, 0); assert.ok(top.every(s => Math.abs(s.top) < 1), 'top bounce does not move the logical selection viewport');
  await reader.evaluate(e => { e.scrollTop = e.scrollHeight; }); await frames();
  const bottom = await sample(() => main.mouse.wheel(0, 120));
  assert.ok(Math.min(...bottom.map(s => s.elastic)) < -5, 'bottom edge rebounds in the opposite direction'); assert.equal(bottom.at(-1)!.elastic, 0);
  await invoke('settings-set', { id: 'appearance.motion', value: 'reduced' }); await reader.evaluate(e => { e.scrollTop = 0; }); await frames();
  const reduced = await sample(() => main.mouse.wheel(0, -120)); assert.ok(reduced.every(s => s.elastic === 0), 'reduced motion disables elasticity');
  await invoke('settings-set', { id: 'appearance.motion', value: 'standard' });
  const split = main.getByRole('button', { name: '分栏', exact: true }); if (!await split.isVisible()) await main.getByRole('button', { name: '更多导航工具', exact: true }).click(); await split.click();
  const preview = main.locator('[data-markdown-preview=' + JSON.stringify(view.id) + ']'); await preview.waitFor();
  const needle = 'Plain text for selection.';
  await preview.evaluate(async (node, input) => { const m = await import(input.url), E = Object.values(m).find((v: any) => v?.findFromDOM) as any; E.findFromDOM(node.querySelector('.cm-content')).dispatch({ effects: E.scrollIntoView(input.from, { y: 'center' }) }); }, { url, from: text.indexOf(needle) }); await frames();
  const start = await point(preview, needle, 0), end = await point(preview, needle, needle.length);
  await main.mouse.move(start.x + .2, start.y); await main.mouse.down(); await main.mouse.move(end.x - .2, end.y, { steps: 8 }); await main.mouse.up();
  assert.equal(await main.evaluate(() => window.getSelection()?.toString()), needle, 'drag selects real preview text after metadata, TOC and table');
  await main.locator('.selection-tools[data-motion-phase="open"]').waitFor(); await main.waitForTimeout(220);
  const selectionToolbar = main.locator('.selection-tools'), hoveredAction = selectionToolbar.getByRole('button').first();
  const hoverBefore = await selectionToolbar.boundingBox(); assert.ok(hoverBefore);
  await hoveredAction.hover();
  await main.locator('#app-tooltip[data-floating-owner="selection"][data-tooltip-ready="true"][data-motion-phase="open"]').waitFor();
  const hoverAfter = await selectionToolbar.boundingBox(); assert.ok(hoverAfter);
  assert.ok(Math.abs(hoverAfter.x - hoverBefore.x) < 1 && Math.abs(hoverAfter.y - hoverBefore.y) < 1, 'the selection toolbar never avoids its own button tooltip');
  assert.equal(await main.evaluate(() => window.getSelection()?.toString()), needle, 'hovering an action preserves the selected preview text');
  await main.locator('.selection-tools[data-selection-material-ready="true"]').waitFor();
  const stationary = await main.evaluate(`new Promise(resolve => {
    const toolbar = document.querySelector('.selection-tools'), capsule = document.querySelector('.reader-toolbar:not([aria-hidden="true"]) .navigation-capsule');
    const texture = () => [...toolbar.querySelectorAll('feImage')].map(node => node.getAttribute('href'));
    const before = texture(), durations = []; let writes = 0, iteration = 0, previous = performance.now();
    const observer = new MutationObserver(records => { writes += records.length; }); observer.observe(toolbar, { attributes:true, attributeFilter:['style'] });
    const tick = now => {
      durations.push(now - previous); previous = now;
      const rect = capsule?.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent('agentviewer:selection-navigation-bounds', { detail: rect ? { visible:true, bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height} } : { visible:false } }));
      if (++iteration < 100) requestAnimationFrame(tick);
      else requestAnimationFrame(() => { observer.disconnect(); resolve({ samples:iteration, writes, before, after:texture(), durations }); });
    }; requestAnimationFrame(tick);
  })`) as { samples:number; writes:number; before:(string|null)[]; after:(string|null)[]; durations:number[] };
  assert.equal(stationary.samples, 100);
  assert.equal(stationary.writes, 0, 'unchanged navigation/hover geometry never rewrites the stationary toolbar style');
  assert.ok(stationary.before.length > 0, 'the selection toolbar is using its real decoded glass texture');
  assert.deepEqual(stationary.after, stationary.before, 'stationary hover refresh reuses the decoded glass field');
  const hover = { label: await hoveredAction.getAttribute('aria-label'), before: hoverBefore, after: hoverAfter, stationary };
  await main.mouse.move(1150, 600);
  const before = await reader.evaluate(e => e.scrollTop);
  const dismissalDelta = await reader.evaluate(e => e.clientHeight + 128);
  const exit = await sample(() => main.mouse.wheel(0, dismissalDelta));
  assert.ok(exit.some(s => s.phase === 'exit' && s.inert && s.opacity! > 0 && s.opacity! < 1), 'scroll dismissal retains an inert toolbar during the fade');
  assert.equal(exit.at(-1)!.phase, undefined, 'toolbar unmounts after exit');
  const enter = await sample(() => main.mouse.wheel(0, -dismissalDelta));
  assert.ok(enter.some(s => s.opacity! > 0 && s.opacity! < 1), 'scrolling the selection back fades the toolbar in');
  assert.equal(enter.at(-1)!.phase, 'open'); assert.ok(Math.abs(enter.at(-1)!.top - before) < 1);
  await main.screenshot({ path: join(evidence, 'selection-reappeared.png'), scale: 'css' });
  const result = { clicks, inertia, top, bottom, reduced, hover, dismissalDelta, exit, enter };
  await writeFile(join(evidence, 'pointer-motion.json'), JSON.stringify(result, null, 2));
  await closeFixture(view.id); await invoke('settings-set', { id: 'appearance.motion', value: 'off' });
  return { caretClicks: clicks.length, edgeResistance: true, momentum: true, reducedMotion: true, selectionHoverStable: true, selectionExitAndReturn: true };
}

/** The Kit canvas, paper and selection overlays share the same elastic stage. */
export async function verifyOfficeElasticity(main: Page) {
  const invoke = (method: string, args: Record<string, unknown>) => main.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args });
  const scroll = main.locator('.embedded-office-content');
  await invoke('settings-set', { id: 'appearance.motion', value: 'standard' });
  await main.locator('html[data-motion="standard"]').waitFor();
  await scroll.evaluate(e => { e.scrollTop = 0; });
  const box = await scroll.boundingBox(); assert.ok(box);
  const maximum = await scroll.evaluate(e => e.scrollHeight - e.clientHeight); assert.ok(maximum > 1, 'native document has a vertical scroll extent');
  await main.mouse.move(box.x + box.width * .6, box.y + box.height * .6);
  const sampling = main.evaluate(`new Promise(resolve => {
    const samples = [], start = performance.now();
    const tick = now => { const e = document.querySelector('.embedded-office-content'); samples.push({t:now-start,top:e.scrollTop,elastic:Number(e.dataset.scrollElastic||0)}); if(now-start<850)requestAnimationFrame(tick);else resolve(samples); }; requestAnimationFrame(tick);
  })`) as Promise<Sample[]>;
  await main.mouse.wheel(0, -120); const samples = await sampling;
  assert.ok(samples.some(s => s.elastic > 5), 'actual native Office stage resists the edge pull');
  assert.ok(samples.every(s => Math.abs(s.top) < 1), 'Office logical input coordinates stay at the top edge');
  assert.equal(samples.at(-1)!.elastic, 0);
  assert.equal(await scroll.locator('.embedded-office-stage').evaluate(e => getComputedStyle(e).translate), 'none', 'no transform remains before native editing resumes');
  await invoke('settings-set', { id: 'appearance.motion', value: 'off' });
  return { maximum, samples };
}
