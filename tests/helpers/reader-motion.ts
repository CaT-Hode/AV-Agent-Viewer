import assert from 'node:assert/strict';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Locator, Page } from 'playwright';

type Sample = { t: number; top: number; elastic: number; phase?: string; inert?: boolean; opacity: number | null };

/** Real production input, with DOM Ranges used only to measure painted glyphs. */
export async function verifyReaderMotion(main: Page, directory: string, evidence: string) {
  const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => main.evaluate(input => window.agentViewer!.call(input.method, input.args), { method, args }) as Promise<T>;
  let chunk: string | undefined;
  for (const name of await readdir(resolve('dist/renderer/assets'))) if (name.endsWith('.js') && (await readFile(resolve('dist/renderer/assets', name), 'utf8')).includes('findFromDOM')) { chunk = name; break; }
  assert.ok(chunk);
  const url = new URL('assets/' + chunk, main.url()).href;
  const text = '---\ntitle: "Pointer and motion"\n---\n\n# Pointer alignment 中文\n\n[TOC]\n\nA **bold phrase** and normal words for caret placement.\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n\n## After table\n\nClick here after table 中文文字.\n\nPlain text for selection.\n\n' + Array.from({ length: 90 }, (_, i) => `Paragraph ${i} 中文测试。 A scrolling document with selectable text.`).join('\n\n');
  const path = join(directory, 'pointer-motion.md'); await writeFile(path, text);
  const view = await invoke<{ id: string }>('open', { uri: path, windowId: 'main' });
  const editor = main.locator('[data-markdown-view=' + JSON.stringify(view.id) + ']'), reader = main.locator('.document-content').first();
  await editor.locator('.md-heading-1').waitFor();
  await invoke('settings-set', { id: 'appearance.motion', value: 'standard' });
  const frames = () => main.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const navigate = async (needle: string) => {
    await editor.evaluate(async (node, input) => {
      const module = await import(input.url), E = Object.values(module).find((item: any) => item?.findFromDOM) as any;
      E.findFromDOM(node.querySelector('.cm-content')).dispatch({ effects: E.scrollIntoView(input.from, { y: 'center' }) });
    }, { url, from: text.indexOf(needle) });
    await frames();
  };
  const point = (target: Locator, needle: string, offset: number) => target.evaluate((node, input) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let leaf: Node | null;
    while ((leaf = walker.nextNode())) {
      const start = leaf.textContent!.indexOf(input.needle); if (start < 0) continue;
      const range = document.createRange(); range.setStart(leaf, start + input.offset); range.setEnd(leaf, start + input.offset);
      const box = range.getBoundingClientRect(); return { x: box.x, y: box.y + box.height / 2 };
    }
    throw new Error('Missing painted glyph: ' + input.needle);
  }, { needle, offset });
  const clicks: unknown[] = [];
  for (const zoom of [80, 100, 150]) {
    const input = main.getByRole('spinbutton', { name: '正文缩放比例', exact: true }); await input.fill(String(zoom)); await input.press('Enter'); await frames();
    for (const needle of ['Pointer alignment', 'normal words', 'Click here after table']) {
      await navigate(needle);
      const p = await point(editor, needle, 6);
      await main.mouse.click(p.x, p.y); await frames();
      const actual = await editor.evaluate(async (node, input) => {
        const module = await import(input.url), E = Object.values(module).find((item: any) => item?.findFromDOM) as any;
        const view = E.findFromDOM(node.querySelector('.cm-content')), head = view.state.selection.main.head, rect = view.coordsAtPos(head);
        const next = view.coordsAtPos(Math.min(head + 1, view.state.doc.length)), caret = node.querySelector('.cm-cursor')!;
        return { head, rect, next, width: caret.getBoundingClientRect().width, color: getComputedStyle(caret).borderLeftColor };
      }, { url });
      assert.ok(actual.rect && actual.next);
      const glyph = Math.abs(actual.next.left - actual.rect.left);
      assert.ok(Math.abs(actual.rect.left - p.x) <= Math.max(4, glyph * .6), `caret follows painted glyph at ${zoom}%: ${needle}`);
      assert.ok(p.y >= actual.rect.top - 1 && p.y <= actual.rect.bottom + 1, 'click stays on the painted text line after widgets');
      if (needle.startsWith('Click here')) assert.equal(actual.head, text.indexOf(needle) + 6, 'block spacing preserves the exact source offset');
      assert.ok(actual.width >= 1.5, 'insertion caret remains visible at document zoom');
      clicks.push({ zoom, needle, pointer: p, ...actual });
    }
    if (zoom === 100) await main.screenshot({ path: join(evidence, 'pointer-light.png'), scale: 'css' });
  }
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
  await main.mouse.move(1150, 600);
  const before = await reader.evaluate(e => e.scrollTop);
  const exit = await sample(() => main.mouse.wheel(0, 600));
  assert.ok(exit.some(s => s.phase === 'exit' && s.inert && s.opacity! > 0 && s.opacity! < 1), 'scroll dismissal retains an inert toolbar during the fade');
  assert.equal(exit.at(-1)!.phase, undefined, 'toolbar unmounts after exit');
  const enter = await sample(() => main.mouse.wheel(0, -600));
  assert.ok(enter.some(s => s.opacity! > 0 && s.opacity! < 1), 'scrolling the selection back fades the toolbar in');
  assert.equal(enter.at(-1)!.phase, 'open'); assert.ok(Math.abs(enter.at(-1)!.top - before) < 1);
  await main.screenshot({ path: join(evidence, 'selection-reappeared.png'), scale: 'css' });
  const result = { clicks, inertia, top, bottom, reduced, exit, enter };
  await writeFile(join(evidence, 'pointer-motion.json'), JSON.stringify(result, null, 2));
  await invoke('close', { viewId: view.id }); await invoke('settings-set', { id: 'appearance.motion', value: 'off' });
  return { caretClicks: clicks.length, edgeResistance: true, momentum: true, reducedMotion: true, selectionExitAndReturn: true };
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
