/**
 * Layout and coordinate input belong to one ordered renderer stream. Waiting
 * for a layout before enqueueing an input is insufficient: a focus/scroll
 * observer could otherwise submit another layout between that wait and input.
 * Failures are returned to their caller; no operation is repeated.
 */
export class OfficeSurfaceDispatchQueue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
