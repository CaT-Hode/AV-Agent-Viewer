export type ReaderPanelRect = { x: number; y: number; width: number; height: number };
export function readerPanelDestination(url: string, rendererUrl: string, frameName: string): { side: 'left' | 'right' | 'translation'; viewId: string } | undefined {
  try {
    const requested = new URL(url), base = new URL(rendererUrl);
    if (requested.origin !== base.origin || requested.pathname !== base.pathname || requested.search !== base.search) return;
    const match = /^#\/reader-panel\?side=(left|right|translation)&view=([^&]+)$/.exec(requested.hash); if (!match) return;
    const side = match[1] as 'left' | 'right' | 'translation', viewId = decodeURIComponent(match[2]);
    if (!viewId || frameName !== 'agentviewer-reader-panel-' + side + '-' + viewId) return;
    return { side, viewId };
  } catch { return; }
}
export function validReaderPanelRect(rect: ReaderPanelRect, viewport: { width: number; height: number }) {
  return !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 90 && rect.width <= 1500 && rect.height >= 50 && rect.height <= viewport.height + 2 && rect.x >= -2 && rect.y >= -2 && rect.x + rect.width <= viewport.width + 2 && rect.y + rect.height <= viewport.height + 2;
}
