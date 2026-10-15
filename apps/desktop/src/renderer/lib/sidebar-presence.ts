import { stepGlassSpring, type SpringAxis } from './glass-elasticity';
import type { MotionMode } from './motion-policy';

export function sidebarSpringParameters(mode: MotionMode) {
  const response = mode === 'elegant' ? .72 : .5, dampingRatio = mode === 'elegant' ? .72 : .79;
  const frequency = 2 * Math.PI / response;
  return { stiffness: frequency * frequency, damping: 2 * dampingRatio * frequency, mass: 1 };
}
export function advanceSidebarSpring(axis: SpringAxis, show: boolean, seconds: number, mode: MotionMode) {
  return stepGlassSpring(axis, show ? 1 : 0, seconds, sidebarSpringParameters(mode));
}
export function sidebarSpringSettled(axis: SpringAxis, show: boolean) { return Math.abs(axis.value - (show ? 1 : 0)) < .0005 && Math.abs(axis.velocity) < .008; }
/** The first closing crossing is fully invisible. Retaining an underdamped
 * tail after that point would let its material/shadow reappear without content.
 * An interrupted close before the crossing still carries its exact velocity. */
export function sidebarExitFinished(axis: SpringAxis) { return axis.value <= 0 && axis.velocity <= 0 || sidebarSpringSettled(axis, false); }
/** Opacity is independent of the physical overshoot, so a tiny bounce cannot
 * produce negative alpha or temporarily dim an already readable panel. */
export function sidebarSpringPresentation(progress: number, side: string) {
  const value = Math.max(-.12, Math.min(1.12, progress));
  // The owned webpage panel has a 12px transparent gutter. Keep the same
  // translation on DOM and owned surfaces so the visible rounded rim stays inside it.
  return { x: (side === 'left' ? -1 : 1) * 12 * (1 - value), scaleX: Math.max(.001,value), scaleY: .987 + .013 * value, alpha: Math.max(0, Math.min(1, value * 1.4)) };
}
/** A trusted popup owns only a fixed transparent gutter around its material.
 * Project its paint into that window without changing the physical spring. */
export function sidebarPopupProjection(side:string,width:number,translation:number,gutter=12) {
  const x=Math.max(-gutter,Math.min(gutter,translation));
  return {x,scaleX:width>0?Math.max(.001,1+(gutter+(side==='right'?x:-x))/width):1};
}
