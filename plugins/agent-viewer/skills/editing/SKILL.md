---
name: agentviewer-editing
description: Edit exact AgentViewer targets, verify effects, and save explicitly.
---

Load the target format through av_tools. Read the exact target and submit its concrete ref with flat fields and a distinct req. Reuse req only for retrying the same logical payload; inspect uncertain outcomes before another mutation. Expired refs never authorize guessing a new target.

Edits normally apply and read back the affected target. av_save is explicit. Applied, verified, recoverable and saved are separate states; a returned job requires av_task. Cancellation does not undo completed effects. Frozen disk revision can coexist with newer unsaved content.

Background operations must preserve human page, selection and editing state. Foreground changes require explicit av_view. Respect drafts, user pause, composition and modal barriers. If isolated Office editing is unsupported, stop that action and report the capability limitation.

Use returned history tokens for undo. Native undo groups are not atomic rollback. Unsupported atomic batches must fail before effects; do not assume cross-file or website atomicity. Never replace a live native model with an old mirror.

See [MCP protocol](../../../../docs/automation/mcp.md).
