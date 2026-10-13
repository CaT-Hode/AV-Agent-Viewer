import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGlassElasticController, glassElasticControllerOwner, glassPanelElasticTarget, glassPointerOrigin, shouldDelegateGlassInteraction } from '../apps/desktop/src/renderer/lib/glass-elasticity';

test('panel velocity compression is attenuated by real height and pointer origin is clamped', () => {
  const tall = glassPanelElasticTarget(true, { x: 5000, y: 0 }, 840);
  const small = glassPanelElasticTarget(true, { x: 5000, y: 0 }, 63);
  assert.ok(tall.scaleY > .96 && tall.scaleY < .99);
  assert.ok(tall.scaleX > 1 && tall.scaleX < 1.03);
  assert.ok(small.scaleY < tall.scaleY);
  assert.deepEqual(glassPanelElasticTarget(false), { scaleX: 1, scaleY: 1, x: 0, y: 0 });
  assert.deepEqual(glassPointerOrigin({ x: 700, y: 0 }, { left: 100, top: 50, width: 360, height: 840 }), { x: 100, y: 0 });
  assert.deepEqual(glassPointerOrigin({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 0 }), { x: 50, y: 50 });
});

test('surface-only ownership preserves foreground, retires doubled controllers, and keeps control expansion centered', () => {
  const names = ['window', 'document', 'HTMLElement', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let now = 0, sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  class ElementFixture extends EventTarget {
    dataset: Record<string, string> = {};
    children: ElementFixture[] = [];
    parentElement?: ElementFixture;
    values = new Map<string, string>();
    classes = new Set<string>();
    classList = { contains: (name: string) => this.classes.has(name), add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
    style = { getPropertyValue: (name: string) => this.values.get(name) ?? '', getPropertyPriority: () => '', setProperty: (name: string, value: string) => this.values.set(name, value), removeProperty: (name: string) => this.values.delete(name) };
    getAttribute(name: string) { return name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] ?? null : null; }
    setAttribute(name: string, value: string) { if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = value; }
    removeAttribute(name: string) { if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())]; }
    closest(selector: string) { if (selector.includes('data-glass-elastic-owner') && this.dataset.glassElasticOwner === 'explicit') return this; return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { left: 100, top: 50, width: 360, height: 840 } as DOMRect; }
  }
  const globals = { window: { matchMedia: () => ({ matches: false }) }, document: { documentElement: { dataset: { motion: 'standard' } } }, HTMLElement: ElementFixture, requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: (id: number) => frames.delete(id), performance: { now: () => now } };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globals[name] });
  const host = new ElementFixture(), surface = new ElementFixture(), foreground = new ElementFixture();
  surface.classes.add('liquid-glass-surface'); surface.parentElement = host; foreground.parentElement = host; host.children = [surface, foreground];
  foreground.values.set('scale', '1'); foreground.values.set('--control-fill-opacity', '1');
  const frame = () => { now += 1000 / 60; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); };
  let delegated: ReturnType<typeof createGlassElasticController> | undefined, explicit: ReturnType<typeof createGlassElasticController> | undefined;
  try {
    delegated = createGlassElasticController(host as unknown as HTMLElement, { preset: 'panel', layer: 'surface', owner: 'delegated' });
    delegated.pointerDown({ pointerId: 1, clientX: 430, clientY: 80, timeStamp: now, isPrimary: true, button: 0 });
    delegated.pointerMove({ pointerId: 1, clientX: 460, clientY: 80, timeStamp: 16 });
    for (let index = 0; index < 12; index++) frame();
    assert.ok(Number(surface.values.get('--glass-elastic-scale-y')) < .99);
    assert.ok(Number.parseFloat(surface.values.get('--glass-elastic-origin-x')!) > 90);
    assert.equal(host.values.has('--glass-elastic-scale-x'), false, 'the layout/native coordinate host is never scaled');
    assert.deepEqual([...foreground.values], [['scale', '1'], ['--control-fill-opacity', '1']], 'text and nested green fills are untouched');
    // Real DOM events, unlike realm-local WeakMaps, cross same-origin portals.
    host.dispatchEvent(new Event('agentviewer:glass-elastic-replace'));
    assert.equal(frames.size, 0); assert.equal(glassElasticControllerOwner(host as unknown as HTMLElement), undefined);
    explicit = createGlassElasticController(host as unknown as HTMLElement, { preset: 'switch' });
    assert.equal(shouldDelegateGlassInteraction(host as unknown as HTMLElement), false);
    assert.equal(glassElasticControllerOwner(host as unknown as HTMLElement), 'explicit');
    const retained = host.values.get('--glass-elastic-scale-x'); delegated.destroy();
    assert.equal(host.values.get('--glass-elastic-scale-x'), retained, 'late delegated cleanup cannot erase a newer explicit owner');
    explicit.destroy();
    // Drag controls already position their thumb. A press near either edge
    // must change size about the center, including externally managed scale.
    for (const options of [
      { preset: 'switch' }, { preset: 'slider' }, { preset: 'thumb' },
      { preset: 'button' }, { preset: 'search' },
      { preset: 'slider', deform: false },
      { preset: 'panel', deform: false }, { preset: 'lens', deform: false },
    ] as const) {
      explicit = createGlassElasticController(host as unknown as HTMLElement, options);
      explicit.pointerDown({ pointerId: 2, clientX: 430, clientY: 80, timeStamp: now, isPrimary: true, button: 0 });
      frame();
      assert.equal(host.values.get('--glass-elastic-origin-x'), '50.000%', `${options.preset} press has no horizontal center drift`);
      assert.equal(host.values.get('--glass-elastic-origin-y'), '50.000%', `${options.preset} press has no vertical center drift`);
      explicit.pointerMove({ pointerId: 2, clientX: 110, clientY: 860, timeStamp: now + 16 });
      frame();
      assert.equal(host.values.get('--glass-elastic-origin-x'), '50.000%', `${options.preset} drag remains centered`);
      assert.equal(host.values.get('--glass-elastic-origin-y'), '50.000%', `${options.preset} drag remains centered`);
      explicit.destroy();
    }
    for (const layer of ['host', 'surface'] as const) {
      delegated = createGlassElasticController(host as unknown as HTMLElement, { preset: layer === 'surface' ? 'panel' : 'button', layer, owner: 'delegated' });
      delegated.pointerDown({ pointerId: 3, clientX: 430, clientY: 80, timeStamp: now, isPrimary: true, button: 0 });
      delegated.keyDown({ key: ' ' });
      frame();
      const staleFrame = [...frames.values()][0];
      explicit = createGlassElasticController(host as unknown as HTMLElement, { preset: 'switch' });
      assert.equal(frames.size, 0, 'replacement cancels the old owner RAF');
      explicit.pointerDown({ pointerId: 4, clientX: 110, clientY: 860, timeStamp: now });
      const snapshot = () => ({ host: [...host.values], surface: [...surface.values], classes: [...host.classes], state: { ...host.dataset }, frames: [...frames.keys()], owner: glassElasticControllerOwner(host as unknown as HTMLElement) });
      const retained = snapshot();
      const lateEvents: [string, () => void][] = [
        ['pointer up', () => delegated!.pointerUp({ pointerId: 3 })],
        ['pointer cancel', () => delegated!.pointerCancel({ pointerId: 3 })],
        ['pointer move', () => delegated!.pointerMove({ pointerId: 3, clientX: 110, clientY: 860, timeStamp: now + 16 })],
        ['pointer down', () => delegated!.pointerDown({ pointerId: 5, clientX: 430, clientY: 80, timeStamp: now })],
        ['key up', () => delegated!.keyUp({ key: ' ' })],
        ['key down', () => delegated!.keyDown({ key: ' ' })],
        ['focus', () => delegated!.focus()], ['blur', () => delegated!.blur()],
        ['reset', () => delegated!.reset()], ['animated reset', () => delegated!.reset(false)],
        ['destroy again', () => delegated!.destroy()],
        ['already queued frame', () => staleFrame?.(now + 16)],
      ];
      for (const [name, event] of lateEvents) {
        event();
        assert.deepEqual(snapshot(), retained, `${layer}: retired ${name} cannot change the current owner or restart RAF`);
      }
      explicit.destroy();
      assert.equal(frames.size, 0);
      assert.equal(host.values.has('--glass-elastic-scale-x'), false, 'the live owner still restores its original presentation on first destroy');
      assert.equal(host.dataset.glassElasticOwner, undefined);
    }
  } finally {
    delegated?.destroy(); explicit?.destroy();
    for (const name of names) { const descriptor = descriptors.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
