---
description: Use this when editing 2 or more files, or making 2+ related changes to one file. Replaces Read→Edit→Verify loops with a single call.
---

Use brozi_batch_edit instead of sequential Read/Write/Edit calls when:
- Editing 2 or more files in the same task
- Making multiple related changes to a single file
- Refactoring (renames, import updates, interface changes)

## How to call it

Provide `oldContent` as a unique block of text that exists in the file.
It does not need to be the entire function — just enough context to be unique.
Whitespace differences are tolerated, but the content must uniquely identify
the location in the file.

## Validation

- For TypeScript projects: set validate to "tsc"
- For JavaScript/TypeScript with eslint: set validate to "eslint" or "both"
- Default is "none" — use when you are confident about the change

## Rules

1. NEVER re-read a file after calling brozi_batch_edit — trust the result
2. If the tool returns a match error, fix oldContent based on the suggestion
3. Batch as many edits as possible into ONE call
4. Do NOT use this for single-character or trivially small edits to one file
