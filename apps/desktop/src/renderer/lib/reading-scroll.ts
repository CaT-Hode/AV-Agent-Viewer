// A document jump must never scroll the application chrome or another pane.
export function scrollReadingTarget(target: HTMLElement | null | undefined) {
  const pane = target?.closest<HTMLElement>('.document-content, .split-reading');
  if (!target || !pane) return;
  const clearance = parseFloat(getComputedStyle(pane).paddingTop) || 0;
  pane.scrollTop = Math.max(0, pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - clearance);
}
