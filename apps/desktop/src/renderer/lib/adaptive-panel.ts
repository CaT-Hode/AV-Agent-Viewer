import { stepGlassSpring, type SpringAxis } from './glass-elasticity';
import type { MotionMode } from './motion-policy';

export type PanelFlowBox = { height: number; marginTop?: number; marginBottom?: number };
const finite = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, value!) : 0;
/** Intrinsic content/chrome dimensions only. Presentation transforms are never inputs. */
export function panelNaturalHeight(content: number, chrome: readonly PanelFlowBox[], paddingAndBorder: number) {
  return Math.max(1, finite(content) + finite(paddingAndBorder) + chrome.reduce((height, item) => height + finite(item.height) + finite(item.marginTop) + finite(item.marginBottom), 0));
}
export function panelMaximumHeight(ownerHeight: number) { return Math.max(1, finite(ownerHeight) - 22); }
export function panelHeightTarget(natural: number, ownerHeight: number) { return Math.min(panelMaximumHeight(ownerHeight), Math.max(1, finite(natural))); }
type PanelMeasuredStyle = Pick<CSSStyleDeclaration, 'position' | 'display' | 'marginTop' | 'marginBottom' | 'paddingTop' | 'paddingBottom' | 'borderTopWidth' | 'borderBottomWidth'>;
export function measurePanelHeight(panel: HTMLElement, natural: HTMLElement, viewport: HTMLElement, ownerHeight: number, styleFor: (element: Element) => PanelMeasuredStyle = getComputedStyle) {
  const style = styleFor(panel), number = (value: string) => Number.parseFloat(value) || 0;
  const chrome = [...panel.children].filter(child => child !== viewport).flatMap(child => {
    const element = child as HTMLElement, computed = styleFor(element);
    return computed.position === 'absolute' || computed.position === 'fixed' || computed.display === 'none' ? [] : [{ height: element.offsetHeight, marginTop: number(computed.marginTop), marginBottom: number(computed.marginBottom) }];
  });
  const height = panelNaturalHeight(Math.max(natural.offsetHeight, natural.scrollHeight), chrome, number(style.paddingTop) + number(style.paddingBottom) + number(style.borderTopWidth) + number(style.borderBottomWidth));
  return { natural: height, target: panelHeightTarget(height, ownerHeight), maximum: panelMaximumHeight(ownerHeight) };
}
export function panelResizeSpring(mode: MotionMode) {
  const response = mode === 'elegant' ? .56 : .38, ratio = mode === 'elegant' ? .76 : .84, frequency = 2 * Math.PI / response;
  return { stiffness: frequency * frequency, damping: 2 * ratio * frequency, mass: 1 };
}
export function advancePanelHeight(axis: SpringAxis, target: number, seconds: number, mode: MotionMode, maximum: number): SpringAxis {
  if (mode === 'off' || mode === 'reduced') return { value: target, velocity: 0 };
  const next = stepGlassSpring(axis, target, seconds, panelResizeSpring(mode)), value = Math.max(1, Math.min(maximum, next.value));
  return { value, velocity: value !== next.value ? 0 : next.velocity };
}
export function panelHeightSettled(axis: SpringAxis, target: number) { return Math.abs(axis.value - target) < .08 && Math.abs(axis.velocity) < .4; }
export function panelContentPresentation(axis: SpringAxis) {
  return { alpha: Math.max(0, Math.min(1, axis.value)), y: 5 * (1 - Math.max(-.05, Math.min(1.05, axis.value))) };
}
