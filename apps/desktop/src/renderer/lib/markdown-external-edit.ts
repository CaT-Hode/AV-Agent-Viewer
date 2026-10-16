export const MARKDOWN_EXTERNAL_EDIT_EVENT = 'agentviewer:markdown-external-edit';
export const MARKDOWN_SELECTION_EDITS = new Set(['bold', 'italic', 'strike', 'code', 'replace']);

type Identity = { documentId: string; viewId: string; requestId: string; baseRevision: number; action: string };
/** A toolbar write is announced before IPC so a faster state refresh cannot
 * silently install the human edit outside the source editor's undo history. */
export type MarkdownExternalEdit = Identity & (
  | { phase: 'pending' }
  | { phase: 'canceled' }
  | { phase: 'committed'; revision: number; transactionId: string }
);
