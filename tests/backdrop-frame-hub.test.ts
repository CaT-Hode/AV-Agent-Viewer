import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { NativeImage, Rectangle } from 'electron';
import { NativeBackdropFrameHub, type NativeBackdropFrameSource } from '../apps/desktop/src/main/backdrop-frame-hub';

const image = (id: number) => ({ id }) as unknown as NativeImage;
class FakeSource extends EventEmitter implements NativeBackdropFrameSource {
  dead = false;
  beginCalls: boolean[] = [];
  endCalls = 0;
  beginError = false;
  endError = false;
  callback?: (image: NativeImage, dirtyRect: Rectangle) => void;
  constructor(readonly id: number) { super(); }
  isDestroyed() { return this.dead; }
  beginFrameSubscription(onlyDirty: boolean, callback: (image: NativeImage, dirtyRect: Rectangle) => void) { this.beginCalls.push(onlyDirty); this.callback = callback; if (this.beginError) throw new Error('begin failed'); }
  endFrameSubscription() { this.endCalls++; if (this.endError) throw new Error('end failed'); }
  frame(value: NativeImage) { this.callback?.(value, { x: 0, y: 0, width: 2, height: 2 }); }
  destroy() { this.dead = true; this.emit('destroyed'); }
}

test('all consumers share one full source frame and the same presentation time', () => {
  let ticks = 0; const hub = new NativeBackdropFrameHub({ now: () => ++ticks }), source = new FakeSource(1), frame = image(1);
  const seen: { image: NativeImage; time: number }[] = [];
  const listener = (value: NativeImage, time: number) => seen.push({ image: value, time });
  const first = hub.subscribe(source, listener), second = hub.subscribe(source, listener), third = hub.subscribe(source, listener);
  assert.deepEqual(source.beginCalls, [false]); source.frame(frame);
  assert.equal(seen.length, 3); assert.ok(seen.every(value => value.image === frame && value.time === 1));
  assert.deepEqual(hub.stats(), { pageSubscriptions: 1, receivedFrames: 1, listenerErrors: 0, startErrors: 0, endErrors: 0, activeSubscriptions: 1, activeConsumers: 3 });
  first(); assert.equal(source.endCalls, 0); source.frame(image(2)); assert.equal(seen.length, 5);
  second(); third(); assert.equal(source.endCalls, 1); assert.equal(hub.stats().activeConsumers, 0);
});

test('different pages have independent subscriptions and latest frame identities', () => {
  const hub = new NativeBackdropFrameHub(), first = new FakeSource(1), second = new FakeSource(2), a = image(1), b = image(2);
  let firstCalls = 0, secondCalls = 0;
  hub.subscribe(first, () => firstCalls++); hub.subscribe(second, () => secondCalls++);
  first.frame(a); second.frame(b);
  assert.equal(firstCalls, 1); assert.equal(secondCalls, 1); assert.equal(hub.peek(1)?.image, a); assert.equal(hub.peek(2)?.image, b);
  assert.equal(hub.stats().activeSubscriptions, 2); hub.dispose();
  assert.equal(first.endCalls, 1); assert.equal(second.endCalls, 1); assert.equal(hub.stats().activeSubscriptions, 0);
});

test('frame delivery is synchronous and only the latest image is retained without a queue', () => {
  let ticks = 0, deliveries = 0; const hub = new NativeBackdropFrameHub({ now: () => ++ticks }), source = new FakeSource(1);
  hub.subscribe(source, () => deliveries++);
  let latest!: NativeImage;
  for (let index = 0; index < 1000; index++) { latest = image(index); source.frame(latest); assert.equal(deliveries, index + 1); assert.equal(hub.peek(1)?.image, latest); }
  assert.equal(hub.stats().receivedFrames, 1000); assert.deepEqual(hub.peek(1), { image: latest, presentedAt: 1000 });
  hub.dispose(); assert.equal(hub.peek(1), undefined);
});

test('last cancellation ends the subscription once and drops late callbacks', () => {
  const hub = new NativeBackdropFrameHub(), source = new FakeSource(1); let seen = 0;
  const cancel = hub.subscribe(source, () => seen++); source.frame(image(1)); cancel(); cancel(); source.frame(image(2));
  assert.equal(source.endCalls, 1); assert.equal(source.listenerCount('destroyed'), 0); assert.equal(seen, 1); assert.equal(hub.peek(1), undefined); assert.equal(hub.stats().receivedFrames, 1);
  const nextCancel = hub.subscribe(source, () => seen++); source.frame(image(3)); assert.deepEqual(source.beginCalls, [false, false]); assert.equal(seen, 2); nextCancel();
});

test('destroying a source releases every consumer without calling end on a destroyed object', () => {
  const hub = new NativeBackdropFrameHub(), source = new FakeSource(1); let seen = 0;
  const cancel = hub.subscribe(source, () => seen++); hub.subscribe(source, () => seen++); source.frame(image(1)); source.destroy(); cancel(); source.frame(image(2));
  assert.equal(source.endCalls, 0); assert.equal(source.listenerCount('destroyed'), 0); assert.equal(seen, 2); assert.equal(hub.stats().activeSubscriptions, 0); assert.equal(hub.peek(1), undefined);
  const noop = hub.subscribe(source, () => seen++); noop(); assert.equal(source.beginCalls.length, 1);
});

test('a throwing listener cannot interrupt other consumers or the next frame', () => {
  const hub = new NativeBackdropFrameHub(), source = new FakeSource(1); let seen = 0;
  hub.subscribe(source, () => { throw new Error('consumer failed'); }); hub.subscribe(source, () => seen++);
  assert.doesNotThrow(() => { source.frame(image(1)); source.frame(image(2)); });
  assert.equal(seen, 2); assert.equal(hub.stats().listenerErrors, 2); assert.equal(hub.stats().receivedFrames, 2); hub.dispose();
});

test('failed start cleans up listeners and allows a fresh subscription attempt', () => {
  const hub = new NativeBackdropFrameHub(), source = new FakeSource(1); source.beginError = true;
  assert.throws(() => hub.subscribe(source, () => {}), /begin failed/);
  assert.equal(source.listenerCount('destroyed'), 0); assert.equal(hub.stats().activeSubscriptions, 0); assert.equal(hub.stats().startErrors, 1); assert.equal(hub.stats().pageSubscriptions, 0);
  source.beginError = false; const cancel = hub.subscribe(source, () => {}); assert.equal(hub.stats().pageSubscriptions, 1); cancel();
});

test('failed end is isolated, while cancellation and disposal remain idempotent', () => {
  const hub = new NativeBackdropFrameHub(), source = new FakeSource(1); source.endError = true;
  const cancel = hub.subscribe(source, () => {}); source.frame(image(1));
  assert.doesNotThrow(() => { cancel(); cancel(); hub.dispose(); hub.dispose(); });
  assert.equal(source.endCalls, 1); assert.equal(hub.stats().endErrors, 1); assert.equal(hub.stats().activeSubscriptions, 0); assert.equal(hub.peek(1), undefined);
});

test('listener changes during a frame apply safely without recursively dispatching added consumers', () => {
  const hub = new NativeBackdropFrameHub(), source = new FakeSource(1), seen: string[] = []; let removeSecond = () => {}, added = false;
  hub.subscribe(source, () => { seen.push('first'); removeSecond(); if (!added) { added = true; hub.subscribe(source, () => seen.push('new')); } });
  removeSecond = hub.subscribe(source, () => seen.push('removed'));
  source.frame(image(1)); assert.deepEqual(seen, ['first']); source.frame(image(2)); assert.deepEqual(seen, ['first', 'first', 'new']);
  assert.deepEqual(source.beginCalls, [false]); hub.dispose();
});

test('disposal inside a callback prevents remaining and subsequent deliveries', () => {
  const hub = new NativeBackdropFrameHub(), source = new FakeSource(1); let later = 0;
  hub.subscribe(source, () => hub.dispose()); hub.subscribe(source, () => later++); source.frame(image(1)); source.frame(image(2));
  assert.equal(later, 0); assert.equal(source.endCalls, 1); assert.equal(hub.stats().receivedFrames, 1);
});

test('a stale callback cannot attach its image to a newer subscription with the same page id', () => {
  const hub = new NativeBackdropFrameHub(), source = new FakeSource(1); const cancel = hub.subscribe(source, () => {}), old = source.callback!;
  cancel(); hub.subscribe(source, () => {}); const fresh = image(2); source.frame(fresh); old(image(1), { x: 0, y: 0, width: 2, height: 2 });
  assert.equal(hub.peek(1)?.image, fresh); assert.equal(hub.stats().receivedFrames, 1); hub.dispose();
});

test('active source id collisions are rejected rather than mixing page pixels', () => {
  const hub = new NativeBackdropFrameHub(), first = new FakeSource(1), collision = new FakeSource(1); hub.subscribe(first, () => {});
  assert.throws(() => hub.subscribe(collision, () => {}), /FRAME_SOURCE_ID_COLLISION/); assert.equal(collision.beginCalls.length, 0); hub.dispose();
});
