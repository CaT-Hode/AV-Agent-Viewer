export type BackdropPixels = { image: string; pixelSize: { width: number; height: number }; capturedAt: number };
export type BackdropCacheStatistics = { captures: number; sampleReuses: number; pngEncodes: number; pngReuses: number; discarded: number; sentFrames: number; sentBytes: number; backdropImageFrames: number; backdropBytes: number; captureMs: number; bitmapMs: number; encodeMs: number; framePresentations: number; frameCrops: number; frameReuses: number; frameErrors: number; cropMs: number };
export const backdropStatistics = (): BackdropCacheStatistics => ({ captures: 0, sampleReuses: 0, pngEncodes: 0, pngReuses: 0, discarded: 0, sentFrames: 0, sentBytes: 0, backdropImageFrames: 0, backdropBytes: 0, captureMs: 0, bitmapMs: 0, encodeMs: 0, framePresentations: 0, frameCrops: 0, frameReuses: 0, frameErrors: 0, cropMs: 0 });

/** One bounded native strip. Identity checks use all authoritative coordinates
 * and source epochs; optical metadata may move independently inside the strip. */
export class NativeBackdropCache {
  private sample?: { key: string; shape: string; bitmap: Uint8Array; pixels: BackdropPixels };
  reuse(key: string) { return this.sample?.key === key ? this.sample.pixels : undefined; }
  accept(key: string, shape: string, bitmap: Uint8Array, encode: () => Omit<BackdropPixels, 'capturedAt'>, capturedAt: number) {
    const prior = this.sample, equal = !!prior && prior.shape === shape && prior.bitmap.byteLength === bitmap.byteLength && Buffer.from(prior.bitmap.buffer, prior.bitmap.byteOffset, prior.bitmap.byteLength).equals(Buffer.from(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength));
    const pixels = { ...(equal ? prior!.pixels : encode()), capturedAt };
    this.sample = { key, shape, bitmap, pixels };
    return { pixels, reusedEncoding: equal };
  }
  clear() { this.sample = undefined; }
}
