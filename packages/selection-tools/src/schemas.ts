import { z } from 'zod';

/** Wire contracts stay independent of HTML parsing and document execution. */
export const selectionActionSchema = z.object({ snapshotId: z.string().optional(), selectionContextId: z.string().optional(), action: z.enum(['copy','citation','extract','note','highlight','underline','strike','bold','italic','code','replace','heading','align-left','align-center','center-object','translate','ask']), value: z.string().max(100000).optional(), idempotencyKey: z.string().min(1) });
export type SelectionAction = z.infer<typeof selectionActionSchema>;
