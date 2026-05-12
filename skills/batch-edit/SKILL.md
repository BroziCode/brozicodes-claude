---
description: Use this when editing 2 or more files, or making related changes across a codebase. Replaces the Read→Edit→Verify loop with a single batched operation.
---

Use the `brozi_batch_edit` MCP tool instead of sequential Read/Edit/Write calls when:
- The task involves editing 2 or more files
- You would otherwise need to read a file, edit it, then verify the result
- You are making related changes across multiple files (e.g. renaming, refactoring)

The tool accepts a JSON array of edits and applies them all in one operation,
running local TypeScript/ESLint validation before returning. You only hear back
if something actually breaks.

Do NOT use for single-line trivial edits to a single file.
