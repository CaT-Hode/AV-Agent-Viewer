import { useLayoutEffect, useState, type RefObject } from 'react';

const FORMULA_SLOT = '[data-navigation-module="formula"]';

/** Finds a single stable slot; the document continues to own its actual draft. */
export function useOfficeFormulaNavigationHost(host: RefObject<HTMLElement | null>): HTMLElement | undefined {
  const [slot, setSlot] = useState<HTMLElement>();
  useLayoutEffect(() => {
    const reader = host.current?.closest<HTMLElement>('.reader-panel');
    if (!reader) { setSlot(undefined); return; }
    const update = () => {
      const next = reader.querySelector<HTMLElement>(`.navigation-toolbar[data-navigation-format="xlsx"] ${FORMULA_SLOT}`) ?? undefined;
      setSlot(previous => previous === next ? previous : next);
    };
    update();
    // Optical transforms, opacity and hidden classes do not change the host.
    // Ignore the portal's own contents and observe only slot mount/removal.
    const changes = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches(FORMULA_SLOT) || !!node.querySelector(FORMULA_SLOT))))) update();
    });
    changes.observe(reader, { childList: true, subtree: true });
    return () => changes.disconnect();
  }, [host]);
  return slot;
}
