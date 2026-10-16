import type { ChangeSet, Text } from '@codemirror/state';

export const MARKDOWN_PROJECTION_EVENT = 'agentviewer:markdown-projection';
export const MARKDOWN_PROJECTION_REQUEST = 'agentviewer:markdown-projection-request';

/** The writable source owns this immutable document. A mirror consumes the
 * actual change set immediately, without serializing a second full source or
 * waiting for an asynchronous Core acknowledgement to replace its DOM. */
export type MarkdownProjection = {
  documentId?: string; viewId?: string; document: Text; previous?: Text;
  changes?: ChangeSet; eol: string; ready: boolean; actor: 'human' | 'agent';
};
