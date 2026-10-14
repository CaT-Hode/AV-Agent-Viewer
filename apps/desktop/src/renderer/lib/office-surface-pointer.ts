/** PointerEvent.detail is usually zero. Track click count without synthesizing duplicate engine clicks. */
export class OfficePointerClickTracker {
  private previous?: { at: number; x: number; y: number; button: number; count: number };
  constructor(private intervalMs = 500, private distanceCss = 5) {}
  down(event: { timeStamp: number; clientX: number; clientY: number; button: number; detail?: number }): number {
    const old = this.previous, close = old && event.timeStamp >= old.at && event.timeStamp - old.at <= this.intervalMs && old.button === event.button && Math.hypot(event.clientX - old.x, event.clientY - old.y) <= this.distanceCss;
    const count = event.detail && event.detail > 0 ? Math.min(3, event.detail) : close ? old.count % 3 + 1 : 1;
    this.previous = { at: event.timeStamp, x: event.clientX, y: event.clientY, button: event.button, count }; return count;
  }
  move(event: { clientX: number; clientY: number }) { if (this.previous && Math.hypot(event.clientX - this.previous.x, event.clientY - this.previous.y) > this.distanceCss) this.reset(); }
  reset() { this.previous = undefined; }
}
export type OfficePointerCapture = { id: number; button: number; clickCount: number };
