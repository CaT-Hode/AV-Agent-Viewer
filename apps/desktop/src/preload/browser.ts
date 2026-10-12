import { ipcRenderer, webUtils } from 'electron';

// Untrusted pages receive no agentViewer bridge. Only this isolated preload can
// report bounded presentation metadata; no text, URLs or form values are sent.
let pending = 0, timer: ReturnType<typeof setTimeout> | undefined, sequence = 0, lastSent = -Infinity;
let reason = 'ready';
const report = () => {
  pending = 0; clearTimeout(timer); timer = undefined;
  const now = performance.now();
  if (now - lastSent < 32) { timer = setTimeout(() => { pending = requestAnimationFrame(report); }, 32 - (now - lastSent)); return; }
  lastSent = now;
  ipcRenderer.send('agentviewer:browser-surface', {
    reason, sequence: ++sequence, scrollAt: now, scrollX, scrollY,
    width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
  });
};
const invalidate = (nextReason: string) => {
  reason = nextReason;
  if (!pending && !timer) pending = requestAnimationFrame(report);
};
window.addEventListener('scroll', () => invalidate('scroll'), { capture: true, passive: true });
window.addEventListener('resize', () => invalidate('resize'), { passive: true });
window.addEventListener('pageshow', () => invalidate('ready'));
document.addEventListener('load', () => invalidate('resource'), true);
document.addEventListener('timeupdate', () => invalidate('media'), true);
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }, true);
document.addEventListener('drop', event => {
  if (!event.dataTransfer?.files.length) return;
  const paths = [...event.dataTransfer.files].map(file => webUtils.getPathForFile(file)).filter(Boolean);
  if (!paths.length) return;
  event.preventDefault(); event.stopImmediatePropagation();
  ipcRenderer.send('agentviewer:browser-drop', paths);
}, true);
const observe = () => {
  new MutationObserver(() => invalidate('content')).observe(document.documentElement, {
    childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'],
  });
  invalidate('ready');
};
if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe, { once: true });
