import { useEffect } from 'react';
import { createGlassElasticController, glassElasticControllerOwner, shouldDelegateGlassInteraction, type GlassElasticController, type GlassElasticPreset } from '../lib/glass-elasticity';

/** One lazy delegated coordinator for controls and material backgrounds. A
 * surface-only panel spring preserves foreground, layout and native bounds.
 * Explicit React thumb/lens controllers always own their gesture subtree. */
export function GlassInteractionHost() {
  useEffect(() => {
    const controllers = new Map<HTMLElement, GlassElasticController>();
    const pointers = new Map<number, GlassElasticController[]>();
    const searchSelector = '.settings-search,.search-field,.navigation-capsule,.home-search-capsule';
    const controllerFor = (host: HTMLElement, preset: GlassElasticPreset, layer: 'host' | 'surface' = 'host') => {
      if (!shouldDelegateGlassInteraction(host)) return;
      let controller = controllers.get(host);
      if (controller && glassElasticControllerOwner(host) !== 'delegated') { controllers.delete(host); controller = undefined; }
      if (!controller) {
        controller = createGlassElasticController(host, { preset, layer, owner: 'delegated', disabled: () => !host.isConnected || !shouldDelegateGlassInteraction(host) });
        controllers.set(host, controller);
      }
      return controller;
    };
    const searchController = (host: HTMLElement) => controllerFor(host, host.matches('.navigation-capsule') ? 'panel' : 'search', host.matches('.navigation-capsule') ? 'surface' : 'host');
    const discover = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches(searchSelector)) searchController(node);
      if (node.firstElementChild) node.querySelectorAll<HTMLElement>(searchSelector).forEach(searchController);
    };
    discover(document.body);
    const selector = 'button.icon-button,button.button,.activity-rail button,.ai-rail button,.view-modes button,.tab-select,.outline-item,.settings-nav button,.recent-card,.selection-tool-icons button,.translation-actions button,button.tab-close';
    const materialTarget = (event: Event) => {
      const host = event.target instanceof Element ? event.target.closest<HTMLElement>('.material-host') : null;
      if (!host || !shouldDelegateGlassInteraction(host) || !(event.target instanceof HTMLElement || event.target instanceof SVGElement) || event.target.closest('[data-glass-control-owner],.glass-switch,.glass-range-control,.glass-segmented,.glass-preview-lens,:disabled,[aria-disabled="true"],[inert]')) return;
      const surface = [...host.children].find(child => child.classList.contains('liquid-glass-surface')) as HTMLElement | undefined;
      if (!surface || surface.dataset.glassInteraction === 'none' || surface.dataset.glassVariant === 'tooltip') return;
      if (host.matches(searchSelector)) return searchController(host);
      return controllerFor(host, surface.dataset.glassVariant === 'button' ? 'button' : 'panel', 'surface');
    };
    const target = (event: Event) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      if (!element || !shouldDelegateGlassInteraction(element)) return;
      // A clickable card/material button is one host, not two stacked springs.
      if (element.classList.contains('material-host')) return materialTarget(event);
      return controllerFor(element, 'button');
    };
    const down = (event: PointerEvent) => {
      const active = [...new Set([target(event), materialTarget(event)].filter((value): value is GlassElasticController => !!value))];
      if (!active.length) return; pointers.set(event.pointerId, active); for (const item of active) item.pointerDown(event);
    };
    const move = (event: PointerEvent) => { for (const item of pointers.get(event.pointerId) ?? []) item.pointerMove(event); };
    const up = (event: PointerEvent) => { for (const item of pointers.get(event.pointerId) ?? []) item.pointerUp(event); pointers.delete(event.pointerId); };
    const cancel = (event: PointerEvent) => { for (const item of pointers.get(event.pointerId) ?? []) item.pointerCancel(event); pointers.delete(event.pointerId); };
    const keyDown = (event: KeyboardEvent) => { if (event.key === ' ' || event.key === 'Enter') target(event)?.keyDown(event); };
    const keyUp = (event: KeyboardEvent) => { if (event.key === ' ' || event.key === 'Enter') target(event)?.keyUp(event); };
    const focusIn = (event: FocusEvent) => {
      const host = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(searchSelector) : null;
      if (!host) return;
      searchController(host)?.focus();
    };
    const focusOut = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      controllers.get(event.target)?.blur();
      const host = event.target.closest<HTMLElement>(searchSelector);
      if (host && !(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))) controllers.get(host)?.blur();
    };
    const blur = () => { pointers.clear(); for (const controller of controllers.values()) controller.reset(); };
    const cleanup = new MutationObserver(changes => {
      // Preserve the initial material state, but inspect only added subtrees.
      // Editing document text must not rescan all search/navigation hosts.
      if (controllers.size && changes.some(change => change.removedNodes.length)) for (const [element, controller] of controllers) if (!element.isConnected || glassElasticControllerOwner(element) === 'explicit') { controller.destroy(); controllers.delete(element); }
      for (const change of changes) change.addedNodes.forEach(discover);
    });
    cleanup.observe(document.body, { childList: true, subtree: true });
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let motion = document.documentElement.dataset.motion, reduced = media.matches;
    const preferences = () => {
      const next = document.documentElement.dataset.motion;
      if (next === motion && reduced === media.matches) return;
      motion = next; reduced = media.matches; blur();
    };
    const observer = new MutationObserver(preferences); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    media.addEventListener('change', preferences);
    document.addEventListener('pointerdown', down, true); window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cancel, true);
    document.addEventListener('keydown', keyDown, true); document.addEventListener('keyup', keyUp, true);
    document.addEventListener('focusin', focusIn, true); document.addEventListener('focusout', focusOut, true); window.addEventListener('blur', blur);
    return () => {
      cleanup.disconnect(); observer.disconnect(); media.removeEventListener('change', preferences); for (const controller of controllers.values()) controller.destroy();
      document.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true);
      document.removeEventListener('keydown', keyDown, true); document.removeEventListener('keyup', keyUp, true);
      document.removeEventListener('focusin', focusIn, true); document.removeEventListener('focusout', focusOut, true); window.removeEventListener('blur', blur);
    };
  }, []);
  return null;
}
