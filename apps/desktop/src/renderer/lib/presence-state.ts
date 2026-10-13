export type PresencePhase = 'enter' | 'open' | 'exit';
export type PresenceState = { present: boolean; phase: PresencePhase; identity?: unknown };

/** Reopening an exiting surface retargets its existing transition. A different
 * source must start a fresh entrance instead of displaying the retained body. */
export function presenceTarget(previous: PresenceState, show: boolean, identity: unknown, immediate: boolean): PresenceState {
  if (immediate) return { present: show, phase: show ? 'open' : 'exit', identity };
  if (!show) return { present: previous.identity === identity && previous.present, phase: 'exit', identity };
  const fresh = previous.identity !== identity || !previous.present;
  return { present: true, phase: fresh || previous.phase === 'enter' ? 'enter' : 'open', identity };
}

/** Hide a stale identity during the render preceding its layout effect. */
export function presencePresentation(state: PresenceState, show: boolean, identity: unknown, immediate: boolean) {
  const changed = state.identity !== identity;
  return {
    present: changed || immediate ? show : show || state.present,
    phase: immediate ? (show ? 'open' : 'exit') : changed ? (show ? 'enter' : 'exit') : !show ? 'exit' : state.phase,
  };
}
