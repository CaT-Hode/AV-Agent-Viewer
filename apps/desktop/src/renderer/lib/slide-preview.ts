/** OOXML slide dimensions are EMU; older renderer models may already use pixels. */
export function slidePreviewMetrics(width = 960, height = 540, thumbnailWidth = 116) {
  const emu = width > 10000 || height > 10000, logicalWidth = Math.max(1, emu ? width / 9525 : width), logicalHeight = Math.max(1, emu ? height / 9525 : height);
  const scale = Math.max(1, thumbnailWidth - 2) / logicalWidth;
  return { logicalWidth, logicalHeight, scale, width: thumbnailWidth, height: logicalHeight * scale + 2 };
}
