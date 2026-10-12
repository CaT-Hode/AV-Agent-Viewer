import type { NativeImage, Rectangle, WebContents } from 'electron';

/** The minimal compositor API is injectable without loading Electron in tests. */
export interface NativeBackdropFrameSource {
  readonly id: number;
  isDestroyed(): boolean;
  beginFrameSubscription(onlyDirty: boolean, callback: (image: NativeImage, dirtyRect: Rectangle) => void): void;
  endFrameSubscription(): void;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}

export type NativeBackdropFrame = Readonly<{ image: NativeImage; presentedAt: number }>;
export type NativeBackdropFrameListener = (image: NativeImage, presentedAt: number) => void;
export type NativeBackdropFrameHubStats = {
  /** Cumulative successfully started page subscriptions, including retired ones. */
  pageSubscriptions: number;
  receivedFrames: number;
  listenerErrors: number;
  activeSubscriptions: number;
  activeConsumers: number;
  startErrors: number;
  endErrors: number;
};

type Consumer = { listener: NativeBackdropFrameListener; active: boolean };
type SourceEntry = {
  source: NativeBackdropFrameSource;
  consumers: Set<Consumer>;
  destroyed: () => void;
  started: boolean;
  retired: boolean;
  latest?: NativeBackdropFrame;
};

/** Share one instance between all overlay hosts. Full compositor frames are
 * broadcast synchronously, with no per-consumer capture, encoding or frame
 * queue. Each active page retains only its latest NativeImage reference.
 * presentedAt is the wall-clock callback receipt time, not a hardware timestamp.
 * The host must guard navigation/layout identity before reusing peek(). */
export class NativeBackdropFrameHub {
  private readonly entries = new Map<number, SourceEntry>();
  private readonly now: () => number;
  private readonly counts = { pageSubscriptions: 0, receivedFrames: 0, listenerErrors: 0, startErrors: 0, endErrors: 0 };

  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  subscribe(source: WebContents | NativeBackdropFrameSource, listener: NativeBackdropFrameListener): () => void {
    if (source.isDestroyed()) return () => {};
    let entry = this.entries.get(source.id);
    if (entry && entry.source !== source) throw new Error('FRAME_SOURCE_ID_COLLISION');
    const consumer: Consumer = { listener, active: true };
    if (entry) entry.consumers.add(consumer);
    else {
      const created: SourceEntry = { source, consumers: new Set([consumer]), destroyed: () => this.retire(created), started: false, retired: false };
      entry = created;
      this.entries.set(source.id, created);
      try {
        source.once('destroyed', created.destroyed);
        // false delivers a complete page frame; a dirty-only image cannot be
        // safely cropped into independent navigation and bottom operation slots.
        created.started = true;
        source.beginFrameSubscription(false, image => this.present(created, image));
        this.counts.pageSubscriptions++;
      } catch (error) {
        this.counts.startErrors++;
        this.retire(created);
        throw error;
      }
    }
    const subscribedEntry = entry;
    return () => {
      if (!consumer.active) return;
      consumer.active = false;
      subscribedEntry.consumers.delete(consumer);
      if (!subscribedEntry.consumers.size) this.retire(subscribedEntry);
    };
  }

  peek(contentsId: number): NativeBackdropFrame | undefined { return this.entries.get(contentsId)?.latest; }

  stats(): NativeBackdropFrameHubStats {
    return { ...this.counts, activeSubscriptions: this.entries.size, activeConsumers: [...this.entries.values()].reduce((sum, entry) => sum + entry.consumers.size, 0) };
  }

  /** Retire every page, e.g. on application shutdown. Repeated disposal is safe. */
  dispose(): void { for (const entry of [...this.entries.values()]) this.retire(entry); }

  private present(entry: SourceEntry, image: NativeImage): void {
    if (entry.retired || this.entries.get(entry.source.id) !== entry) return;
    const presentedAt = this.now();
    entry.latest = { image, presentedAt };
    this.counts.receivedFrames++;
    // Membership may change inside a listener. A newly added consumer starts
    // on the next presentation, and a removed consumer receives no late frame.
    for (const consumer of [...entry.consumers]) {
      if (!consumer.active || entry.retired) continue;
      try { consumer.listener(image, presentedAt); } catch { this.counts.listenerErrors++; }
    }
  }

  private retire(entry: SourceEntry): void {
    if (entry.retired) return;
    entry.retired = true;
    if (this.entries.get(entry.source.id) === entry) this.entries.delete(entry.source.id);
    entry.latest = undefined;
    for (const consumer of entry.consumers) consumer.active = false;
    entry.consumers.clear();
    try { entry.source.removeListener('destroyed', entry.destroyed); } catch { /* An already destroyed source may reject methods. */ }
    try { if (entry.started && !entry.source.isDestroyed()) entry.source.endFrameSubscription(); } catch { this.counts.endErrors++; }
  }
}
