import { useEffect } from 'react';
import { createGlassElasticController } from '../lib/glass-elasticity';

/** One delegated coordinator, no hook/RAF per idle button. Each short spring
 * affects presentation only and preserves the existing click and focus path. */
export function GlassInteractionHost() {
  useEffect(() => {
    const controllers = new Map<HTMLElement, ReturnType<typeof createGlassElasticController>>();
    const pointers = new Map<number, ReturnType<typeof createGlassElasticController>[]>();
    const searchSelector = '.settings-search,.search-field,.navigation-capsule,.home-search-capsule';
    const searchController = (host: HTMLElement) => {
      let controller = controllers.get(host);
      if (!controller) {
        controller = createGlassElasticController(host, { preset: 'search', deform: !host.matches('.navigation-capsule'), disabled: () => !host.isConnected || !!host.closest('[inert]') });
        controllers.set(host, controller);
      }
      return controller;
    };
    for (const host of document.querySelectorAll<HTMLElement>(searchSelector)) searchController(host);
    const selector = 'button.icon-button,button.button,.activity-rail button,.ai-rail button,.view-modes button,.tab-select,.outline-item,.settings-nav button,.recent-card';
    const target = (event: Event) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      if (!element || element.closest('.glass-switch,.glass-range-control,.glass-preview-lens') || (element instanceof HTMLButtonElement && element.disabled) || element.closest('[inert]')) return;
      let controller = controllers.get(element);
      if (!controller) {
        controller = createGlassElasticController(element, { preset: 'button', disabled: () => !element.isConnected || (element instanceof HTMLButtonElement && element.disabled) });
        controllers.set(element, controller);
      }
      return controller;
    };
    const down = (event: PointerEvent) => {
      const controller = target(event), host = event.target instanceof Element ? event.target.closest<HTMLElement>(searchSelector) : null;
      const active = [controller, host ? searchController(host) : undefined].filter((value): value is ReturnType<typeof createGlassElasticController> => !!value);
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
      searchController(host).focus();
    };
    const focusOut = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      controllers.get(event.target)?.blur();
      const host = event.target.closest<HTMLElement>(searchSelector);
      if (host && !(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))) controllers.get(host)?.blur();
    };
    const blur = () => { pointers.clear(); for (const controller of controllers.values()) controller.reset(); };
    const cleanup = new MutationObserver(() => {
      for (const [element, controller] of controllers) if (!element.isConnected) { controller.destroy(); controllers.delete(element); }
      for (const host of document.querySelectorAll<HTMLElement>(searchSelector)) if (!controllers.has(host)) searchController(host);
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
