import { useSyncExternalStore } from 'react';
import { DEFAULT_DOCUMENT_PAPER_COLOR, normalizeDocumentPaperColor } from '../../../../../packages/settings/src/document-paper';

export const readDocumentPaperColor = () => normalizeDocumentPaperColor(document.documentElement.dataset.documentPaper) ?? DEFAULT_DOCUMENT_PAPER_COLOR;
function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-document-paper'] });
  return () => observer.disconnect();
}
export const useDocumentPaperColor = () => useSyncExternalStore(subscribe, readDocumentPaperColor, () => DEFAULT_DOCUMENT_PAPER_COLOR);
