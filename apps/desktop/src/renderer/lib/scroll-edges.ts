export type ScrollEdgeMetrics = { scrollTop: number; scrollLeft: number; scrollHeight: number; scrollWidth: number; clientHeight: number; clientWidth: number };
/** One CSS pixel tolerates fractional scroll offsets and native end rounding. */
export function scrollEdges(value: ScrollEdgeMetrics) {
  return {
    top: value.scrollTop > 1,
    bottom: value.scrollHeight - value.clientHeight - value.scrollTop > 1,
    left: value.scrollLeft > 1,
    right: value.scrollWidth - value.clientWidth - value.scrollLeft > 1,
  };
}
