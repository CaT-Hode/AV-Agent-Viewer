---
name: agentviewer-editing
description: Apply user-requested local edits to documents or reading copies in AgentViewer using supported operations and version checks.
---

Operate within the user's requested scope and existing authorization. Obtain the target document, current content revision and document_capabilities. Use a format-specific operation supported by the active adapter; preparing a patch does not change content.

Call document_plan_patch, inspect the before/after and warnings, then document_apply_patch using the returned patchId and a unique idempotency key. A version conflict requires reading and preparing again. Retry an uncertain submission with the same key instead of generating a new insertion.

Verify the resulting content and revision. document_save confirms persisted output; an applied edit or visual DOM change does not confirm disk/remote persistence. New documents need a target path. HTML reading copies edit a local copy of the source webpage. PDF overlays add content and do not remove original text. Keep existing source files when converting old Office formats.

Selection tools share the desktop action implementation. Call reader_selection_tools for the exact view to freeze a selection and discover available actions. Pass the returned snapshot.id, an advertised action, optional value, and a stable idempotencyKey to reader_selection_action. Copy/citation return text; extract returns a new document view; edits return a receipt. Tool availability depends on the actual selection (Office object/cell identity, PDF line rectangles, or unambiguous source text).

PDF highlight/underline/strike use page-relative rectangles and support rotated pages. They add visible marks; they are not redaction. Word/PPT inline formatting preserves surrounding text runs and rejects complex unsupported runs. Application-side notes and non-file highlights are persisted separately; document_annotations lists them, and document_remove_annotation removes one. Translation follows the existing rule: documents display a separate result, websites replace the current selection in place.
