import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import type { ElectronApplication, Locator, Page } from 'playwright';
import type { createGlassOptics } from '../apps/desktop/src/renderer/lib/liquid-glass-optics';
import type { glassCaptureOverscan } from '../apps/desktop/src/renderer/lib/navigation-optics';

type Rect = { x: number; y: number; width: number; height: number };
type Bitmap = { width: number; height: number; data: Buffer };
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const pngBytes = (value: string) => Buffer.from(value.split(',')[1], 'base64');

/** Runs the real settings range on its own track. Only optical field/scale and
 * equally-neutralized lighting change between captures: no generated labels,
 * grid, background, or replacement control is inserted into the substrate. */
export async function verifyRangeReferenceOptics(page: Page, app: ElectronApplication, control: Locator, evidence: string) {
  const input = control.locator('input[type=range]'), thumb = control.locator('.glass-range-thumb'), surface = thumb.locator(':scope > .liquid-glass-surface');
  const lighting = surface.locator('feColorMatrix,feFuncA'), field = surface.locator('feImage[result="glass-map"]'), displacement = surface.locator('feDisplacementMap[data-glass-displacement]');
  let pointerId: number | undefined, mouseDown = false, phase = 'positioning';
  let originalMap: string | null = null, originalScale: string | null = null;
  let originalFieldBounds: Record<string,string | null> | undefined;
  let originalLighting: { attribute: string; value: string | null }[] = [];
  const frames = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const actualGeometry = () => input.evaluate(node => {
    const input = node as HTMLInputElement, root = input.closest('.glass-range-control')!, knob = root.querySelector<HTMLElement>('.glass-range-thumb')!, inputRect = input.getBoundingClientRect(), knobRect = knob.getBoundingClientRect();
    const x = knobRect.x + knobRect.width / 2, y = knobRect.y + knobRect.height / 2, hit = document.elementFromPoint(x,y), style = getComputedStyle(knob);
    return { input:{x:inputRect.x,y:inputRect.y,width:inputRect.width,height:inputRect.height},thumb:{x:knobRect.x,y:knobRect.y,width:knobRect.width,height:knobRect.height},point:{x,y},hitInput:hit === input,hitTag:hit?.tagName,hitClass:typeof hit?.className === 'string' ? hit.className : '',viewport:{width:innerWidth,height:innerHeight},scrollTop:document.querySelector('.settings-main')?.scrollTop,disabled:input.disabled,pointerId:input.dataset.qaOpticsPointerId,pointerReceived:input.dataset.qaOpticsPointerReceived,elasticState:knob.dataset.glassElasticState,scale:style.scale,willChange:knob.style.willChange,motion:document.documentElement.dataset.motion };
  });
  try {
    // Settings RPC/appearance updates can reflow or reset the scroll container.
    // Acquire fresh geometry only after those updates, never reuse a prior box.
    await input.scrollIntoViewIfNeeded();
    let previous: Awaited<ReturnType<typeof actualGeometry>> | undefined, positionStable = 0;
    for (let i = 0; i < 100; i++) {
      const current = await actualGeometry();
      if (previous && current.hitInput && !current.disabled && current.point.x > 0 && current.point.x < current.viewport.width && current.point.y > 0 && current.point.y < current.viewport.height && Math.abs(current.point.x - previous.point.x) < .1 && Math.abs(current.point.y - previous.point.y) < .1 && Math.abs(current.input.width - previous.input.width) < .1 && Math.abs(current.thumb.width - previous.thumb.width) < .1) positionStable++; else positionStable = 0;
      previous = current;
      if (positionStable >= 3) break;
      if (!current.hitInput || current.point.y < 0 || current.point.y >= current.viewport.height) await input.scrollIntoViewIfNeeded();
      await frames();
    }
    assert.ok(positionStable >= 3,'fresh range geometry is stable and its real center hits the native input');
    assert.ok(previous && previous.hitInput && !previous.disabled);
    await input.evaluate(node => { const input = node as HTMLInputElement; delete input.dataset.qaOpticsPointerId; delete input.dataset.qaOpticsPointerReceived; input.addEventListener('pointerdown',event => { input.dataset.qaOpticsPointerId = String((event as PointerEvent).pointerId); input.dataset.qaOpticsPointerReceived = 'true'; },{once:true}); });
    await page.mouse.move(previous.point.x,previous.point.y);
    const downGeometry = await actualGeometry();
    assert.ok(downGeometry.hitInput,'elementFromPoint still resolves to the actual range input immediately before press');
    assert.ok(Math.abs(downGeometry.point.x - previous.point.x) < .1 && Math.abs(downGeometry.point.y - previous.point.y) < .1,'hover does not invalidate the measured pointer location');
    phase = 'press'; await page.mouse.down(); mouseDown = true; await frames();
    const received = await actualGeometry(); pointerId = Number(received.pointerId);
    assert.ok(received.pointerReceived === 'true' && received.pointerId !== undefined && Number.isFinite(pointerId),'actual native range receives pointerdown with a finite pointer ID');
    phase = 'settling';
    let settled = false;
    for (let i = 0; i < 160; i++) {
      settled = await thumb.evaluate(node => { const box = node.getBoundingClientRect(); return Math.abs(box.width - 90) < .1 && Math.abs(box.height - 60) < .1 && (node as HTMLElement).style.willChange === ''; });
      if (settled) break; await new Promise(done => setTimeout(done, 30));
    }
    assert.ok(settled, 'actual range grows to the source 90x60 geometry and settles while held');
    phase = 'optics';
    const bounds = await thumb.boundingBox(); assert.ok(bounds);
    const clipping = await thumb.evaluate(node => {
      const box = node.getBoundingClientRect(), clipped: string[] = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) { const style = getComputedStyle(parent), rect = parent.getBoundingClientRect(); if (['hidden','clip','scroll','auto'].includes(style.overflowX) && (box.left < rect.left - .5 || box.right > rect.right + .5) || ['hidden','clip','scroll','auto'].includes(style.overflowY) && (box.top < rect.top - .5 || box.bottom > rect.bottom + .5)) clipped.push(parent.className); }
      return clipped;
    });
    assert.deepEqual(clipping, [], 'parent settings row/card/viewport does not clip the active source lens');
    // Compile only the existing production field generator for this isolated
    // pixel probe. It is not another visual component or third-party script.
    const bundle = buildSync({ stdin: { contents: "export { createGlassOptics } from './apps/desktop/src/renderer/lib/liquid-glass-optics'; export { glassCaptureOverscan } from './apps/desktop/src/renderer/lib/navigation-optics';", resolveDir: resolve('.'), sourcefile: 'production-range-optics-probe.ts' }, bundle: true, write: false, format: 'iife', globalName: 'AgentViewerRangeOpticsProbe', platform: 'browser', target: 'es2022' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const fields = await page.evaluate(() => {
      const api = (window as unknown as { AgentViewerRangeOpticsProbe: { createGlassOptics: typeof createGlassOptics; glassCaptureOverscan: typeof glassCaptureOverscan } }).AgentViewerRangeOpticsProbe;
      const fullRadius = { x: 30, y: 30 }, oldRadius = { x: 18, y: 18 };
      const full = api.createGlassOptics({ width: 90, height: 60, radii: { topLeft: fullRadius, topRight: fullRadius, bottomRight: fullRadius, bottomLeft: fullRadius }, density: 2, bezelWidth: 16, glassThickness: 80, refractiveIndex: 1.45, strength: 1, profile: 'convex', concave: false, overscan: api.glassCaptureOverscan(16, 80, 1.45, 'convex', 1, 0) });
      const old = api.createGlassOptics({ width: 54, height: 36, radii: { topLeft: oldRadius, topRight: oldRadius, bottomRight: oldRadius, bottomLeft: oldRadius }, density: 2, bezelWidth: 9.6, glassThickness: 48, refractiveIndex: 1.45, strength: 1, profile: 'convex', concave: false, overscan: api.glassCaptureOverscan(9.6, 48, 1.45, 'convex', 1, 0) });
      return { old: { map: old.map, maximum: old.maximumDisplacement, overscan: old.overscan }, full: { map: full.map, maximum: full.maximumDisplacement, overscan: full.overscan } };
    });
    originalMap = await field.getAttribute('href'); originalScale = await displacement.getAttribute('scale');
    assert.ok(originalMap && originalScale);
    originalFieldBounds = await field.evaluate(node => Object.fromEntries(['x','y','width','height'].map(name => [name,node.getAttribute(name)])));
    const fullFieldBounds = { x:Number(originalFieldBounds.x),y:Number(originalFieldBounds.y),width:Number(originalFieldBounds.width),height:Number(originalFieldBounds.height) };
    assert.equal(fullFieldBounds.width,90 + fields.full.overscan * 2,'production field width includes its actual source overscan');
    assert.equal(fullFieldBounds.height,60 + fields.full.overscan * 2,'production field height includes its actual source overscan');
    assert.equal(await field.getAttribute('preserveAspectRatio'),'none','field comparison uses the same explicit source image mapping');
    assert.equal(hash(pngBytes(originalMap)), hash(pngBytes(fields.full.map)), 'new comparison field is exactly the currently rendered production field');
    assert.ok(Math.abs(Number(originalScale) - fields.full.maximum * .9) < .00001, 'source active multiplier .9 is retained, not mislabeled as app attenuation');
    originalLighting = await lighting.evaluateAll(nodes => nodes.map(node => { const attribute = node.tagName === 'feColorMatrix' ? 'values' : 'slope', value = node.getAttribute(attribute); node.setAttribute(attribute, attribute === 'values' ? '1' : '0'); return { attribute, value }; }));
    const clip = { x: Math.max(0, bounds.x - 8), y: Math.max(0, bounds.y - 8), width: bounds.width + 16, height: bounds.height + 16 };
    const placement = await input.evaluate(node => { const rect = node.getBoundingClientRect(); return { value: (node as HTMLInputElement).value, x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
    const sample = async () => { await frames(); assert.deepEqual(await input.evaluate(node => { const rect = node.getBoundingClientRect(); return { value: (node as HTMLInputElement).value, x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }), placement, 'every optical capture uses the same actual range position and value'); return page.screenshot({ clip, scale: 'device' }); };
    const full = await sample();
    // Register the compact field's INNER contour, not its whole overscan PNG,
    // to the same current lens. Uniform 5/3 scaling maps 54x36/r18 to 90x60/r30;
    // its own 14px gutter must become 23.333px, rather than the new 37px gutter.
    // Encoded amplitudes and SVG scale remain the historical physical values.
    const projectionFactor = 90 / 54;
    assert.equal(projectionFactor,60 / 36,'baseline contour has one uniform projection scale');
    const oldFieldBounds = { x:fullFieldBounds.x + fields.full.overscan - fields.old.overscan * projectionFactor,y:fullFieldBounds.y + fields.full.overscan - fields.old.overscan * projectionFactor,width:(54 + fields.old.overscan * 2) * projectionFactor,height:(36 + fields.old.overscan * 2) * projectionFactor };
    assert.ok(Math.abs(oldFieldBounds.x + fields.old.overscan * projectionFactor - fullFieldBounds.x - fields.full.overscan) < .000001 && Math.abs(oldFieldBounds.y + fields.old.overscan * projectionFactor - fullFieldBounds.y - fields.full.overscan) < .000001,'old/new inner-contour origins coincide exactly');
    assert.ok(Math.abs(oldFieldBounds.width - fields.old.overscan * 2 * projectionFactor - 90) < .000001 && Math.abs(oldFieldBounds.height - fields.old.overscan * 2 * projectionFactor - 60) < .000001,'old/new inner contours cover exactly the same real 90x60 lens');
    await field.evaluate((node,input) => { node.setAttribute('href',input.map); for (const [name,value] of Object.entries(input.bounds)) node.setAttribute(name,String(value)); },{map:fields.old.map,bounds:oldFieldBounds});
    await displacement.evaluate((node, scale) => node.setAttribute('scale', String(scale)), fields.old.maximum * .9);
    const old = await sample();
    const layers = surface.locator('.liquid-glass-center,.liquid-glass-edge');
    const filterStyles = await layers.evaluateAll(nodes => nodes.map(node => { const element = node as HTMLElement, value = element.style.getPropertyValue('backdrop-filter'), priority = element.style.getPropertyPriority('backdrop-filter'); element.style.setProperty('backdrop-filter', 'none', 'important'); return { value, priority }; }));
    let off: Buffer;
    try { off = await sample(); } finally { await layers.evaluateAll((nodes, styles) => nodes.forEach((node, index) => { const element = node as HTMLElement; if (styles[index].value) element.style.setProperty('backdrop-filter', styles[index].value, styles[index].priority); else element.style.removeProperty('backdrop-filter'); }), filterStyles); }
    await field.evaluate((node,input) => { node.setAttribute('href',input.map); for (const [name,value] of Object.entries(input.bounds)) { if (value === null) node.removeAttribute(name); else node.setAttribute(name,value); } },{map:originalMap,bounds:originalFieldBounds});
    await displacement.evaluate((node, scale) => node.setAttribute('scale', scale), originalScale);
    const restored = await sample();
    await Promise.all([writeFile(join(evidence,'range-reference-neutral.png'),full),writeFile(join(evidence,'range-old-compact-field-neutral.png'),old),writeFile(join(evidence,'range-filters-off.png'),off!),writeFile(join(evidence,'range-reference-restored.png'),restored),writeFile(join(evidence,'range-old-field.png'),pngBytes(fields.old.map)),writeFile(join(evidence,'range-reference-field.png'),pngBytes(fields.full.map))]);
    const decode = async (png: Buffer): Promise<Bitmap> => { const value = await app.evaluate(({ nativeImage }, base64) => { const image = nativeImage.createFromBuffer(Buffer.from(base64,'base64')); return { ...image.getSize(), bitmap: image.toBitmap().toString('base64') }; }, png.toString('base64')); return { width: value.width, height: value.height, data: Buffer.from(value.bitmap,'base64') }; };
    const [fullImage,oldImage,offImage,restoredImage] = await Promise.all([decode(full),decode(old),decode(off!),decode(restored)]);
    for (const other of [oldImage,offImage,restoredImage]) { assert.equal(other.width,fullImage.width); assert.equal(other.height,fullImage.height); }
    const density = { x: fullImage.width / clip.width, y: fullImage.height / clip.height };
    let fullError = 0, oldError = 0, fullChanged = 0, oldChanged = 0, strongerPixels = 0, restoredChanged = 0, exteriorChanged = 0;
    for (let y = 0; y < fullImage.height; y++) for (let x = 0; x < fullImage.width; x++) {
      const index = (y * fullImage.width + x) * 4, cssX = clip.x + (x + .5) / density.x, cssY = clip.y + (y + .5) / density.y;
      const inside = cssX >= bounds.x && cssX <= bounds.x + bounds.width && cssY >= bounds.y && cssY <= bounds.y + bounds.height;
      const fullDifference = Math.max(...[0,1,2].map(channel => Math.abs(fullImage.data[index + channel] - offImage.data[index + channel]))), oldDifference = Math.max(...[0,1,2].map(channel => Math.abs(oldImage.data[index + channel] - offImage.data[index + channel])));
      const repeatDifference = Math.max(...[0,1,2].map(channel => Math.abs(fullImage.data[index + channel] - restoredImage.data[index + channel])));
      if (repeatDifference > 2) restoredChanged++;
      if (inside) { fullError += fullDifference; oldError += oldDifference; if (fullDifference >= 8) fullChanged++; if (oldDifference >= 8) oldChanged++; if (fullDifference >= oldDifference + 10) strongerPixels++; }
      else if (fullDifference > 2 || oldDifference > 2 || repeatDifference > 2) exteriorChanged++;
    }
    const result = { comparison:'same real range/track and exactly registered inner contour; historical compact field uniformly projected by 5/3 with its own overscan offset; saturation=1/specular=0 in all captures; no substrate replacement', bounds, density, baseline:{sourceCommit:'9f32541',width:54,height:36,bezel:9.6,thickness:48,activeMultiplier:.9,mapSha256:hash(pngBytes(fields.old.map)),svgScale:fields.old.maximum*.9,overscan:fields.old.overscan,projectionFactor,imageBounds:oldFieldBounds},reference:{width:90,height:60,bezel:16,thickness:80,activeMultiplier:.9,mapSha256:hash(pngBytes(fields.full.map)),svgScale:Number(originalScale),overscan:fields.full.overscan,imageBounds:fullFieldBounds},fullError,oldError,fullChanged,oldChanged,strongerPixels,restoredChanged,exteriorChanged };
    await writeFile(join(evidence,'range-optics-comparison.json'),JSON.stringify(result,null,2));
    assert.ok(fullChanged >= 20 && oldChanged >= 8,'both production fields visibly displace the real native range track');
    assert.ok(fullError > oldError * 1.15 && strongerPixels >= 10,'reference geometry yields measurably stronger range edge displacement than the former compact field');
    assert.ok(restoredChanged <= 2,'restored production optics reproduce the original frame without animation noise');
    assert.ok(exteriorChanged <= 2,'changing the optical field leaves pixels outside the real lens unchanged');
    return result;
  } catch (error) {
    await writeFile(join(evidence,'range-optics-fixture-failure.json'),JSON.stringify({phase,error:String(error),pointerId,mouseDown,geometry:await actualGeometry().catch(() => undefined)},null,2));
    throw error;
  } finally {
    if (originalMap !== null) await field.evaluate((node,input) => { node.setAttribute('href',input.map); if (input.bounds) for (const [name,value] of Object.entries(input.bounds)) { if (value === null) node.removeAttribute(name); else node.setAttribute(name,value); } },{map:originalMap,bounds:originalFieldBounds}).catch(() => {});
    if (originalScale !== null) await displacement.evaluate((node,scale) => node.setAttribute('scale',scale),originalScale).catch(() => {});
    if (originalLighting.length) await lighting.evaluateAll((nodes,values) => nodes.forEach((node,index) => { if (values[index].value === null) node.removeAttribute(values[index].attribute); else node.setAttribute(values[index].attribute,values[index].value!); }),originalLighting).catch(() => {});
    if (pointerId !== undefined && Number.isFinite(pointerId)) await input.dispatchEvent('pointercancel',{pointerId}).catch(() => {});
    if (mouseDown) await page.mouse.up();
  }
}
