---
name: agentviewer-editing
description: Apply user-requested local edits to documents or reading copies in AgentViewer using supported operations and version checks.
---

Operate within the user's requested scope and existing authorization. Obtain the target document, current content revision and document_capabilities. Use a format-specific operation supported by the active adapter; preparing a patch does not change content.

Call document_plan_patch, inspect the before/after and warnings, then document_apply_patch using the returned patchId and a unique idempotency key. A version conflict requires reading and preparing again. Retry an uncertain submission with the same key instead of generating a new insertion.

Verify the resulting content and revision. document_save confirms persisted output; an applied edit or visual DOM change does not confirm disk/remote persistence. New documents need a target path. HTML reading copies edit a local copy of the source webpage. PDF overlays add content and do not remove original text. Keep existing source files when converting old Office formats.

Selection tools share the desktop action implementation. Call reader_selection_tools for the exact view to freeze a selection and discover available actions. Pass the returned snapshot.id, an advertised action, optional value, and a stable idempotencyKey to reader_selection_action. Copy/citation return text; extract returns a new document view; edits return a receipt. Tool availability depends on the actual selection (Office object/cell identity, PDF line rectangles, or unambiguous source text).

PDF highlight/underline/strike use page-relative rectangles and support rotated pages. They add visible marks; they are not redaction. For active native Word/PPT sessions, use the actual native selection and typed style transactions; the old OOXML mirror is not an independent write source. Application-side notes and non-file highlights are persisted separately; document_annotations lists them, and document_remove_annotation removes one. Translation follows the existing rule: documents display a separate result, websites replace the current selection in place.


For native Office edits, obtain fresh office_status and office_query style inspection. office_execute accepts exactly one command, cell, replacement or style action. A typed style patch requires expectedEngineEpoch, expectedEngineRevision, expectedSelectionEpoch and idempotencyKey; submit only explicitly changed fields. Mixed/unsupported fields must not be replaced with guessed defaults. Font sizes and line widths use pt; paragraph/shape lengths use mm. Actual shape queries use bounds in 1/100mm.

Discover Impress objects with office_query shapes, navigate by a unique actual name, then inspect/apply the current shape selection. Do not infer an engine object from an OOXML id. Validate the returned values and one real undo token; office_undo only acts on its captured current target/history. Preserve failures and checkpoint information, especially NATIVE_STYLE_ROLLBACK_UNVERIFIED. An uncertain native outcome requires reconciling actual status and checkpoints before any further edit; an idempotency key does not prove that a failed operation left content unchanged. Document save confirms disk persistence. Release the view controlId after completing the requested operation.
