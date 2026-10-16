---
name: agentviewer-editing
description: Apply authorized AgentViewer edits with explicit targets, versions, draft barriers and save checks.
---

Identify document/view, read revision and document_capabilities. Retain controlId for collaboration indication. Never infer a target from later focus.

Ordinary edits use document_plan_patch, inspect the preview, then document_apply_patch with patchId and a unique idempotency key. Retry the same logical submission with the same key; version conflicts require fresh reading. Verify content and receipt, then document_save. Preserve local drafts and external file conflicts.

reader_selection_tools may return a ReadingSnapshot or lightweight Office SelectionContext. Submit the matching source identity to reader_selection_action. Notes are separate annotations; PDF overlays are not redaction.

For native Office read office_status/office_query. Submit explicit command, cell, replacement or style through office_execute with required engine and selection versions. Distinguish object and internal text ranges. Retain mixed/unsupported fields; font/line width uses pt, style lengths mm, shape bounds 1/100mm.

Dispatched proves delivery only. Applied confirms the engine change; recoverable requires a completed recovery checkpoint, and saved confirms a frozen disk version. Default SDK calls keep their durability barrier. Reconcile uncertain outcomes before another write; never blindly replay mutations or external uploads.

Native undo needs its current token/version; never restore an old mirror over a live writer. Text undo stores an inverse range and remains subject to revision/draft/control checks. Evicted history does not authorize replaying an old mutation.

Independent export uses a new path. Resource batches flush drafts and check revision; stale lists must refresh before retry. Release the view controlId when finished. See [editing capabilities](../../../../docs/editing/README.md).
