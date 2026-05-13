---
description: Use this when editing 2 or more files, or making 2+ related changes to one file. Replaces Read→Edit→Verify loops with a single call.
---

Use brozi_batch_edit instead of sequential Read/Write/Edit calls when:
- Editing 2 or more files in the same task
- Making multiple related changes to a single file
- Refactoring (renames, import updates, interface changes)

## Parameters (per edit object)

- `file` — absolute path to the file.
- `oldContent` — the block of text to find and replace. **Omit entirely to create a new file.**
- `newContent` — the replacement text (or full content when creating/overwriting).
- `overwrite: true` — when combined with no `oldContent`, replaces the **entire** file content.
- `validate` — run post-edit validation: `"tsc"`, `"eslint"`, `"both"`, or `"none"` (default).

## Matching behavior

`oldContent` does not need to be the full function — just enough context to be unique.
Matching is fuzzy: whitespace differences are normalized automatically.
If matching fails, the error shows the nearest line found.

## Rules

1. NEVER re-read a file after calling brozi_batch_edit — trust the result
2. If the tool returns a match error, fix oldContent based on the suggestion
3. Batch as many edits as possible into ONE call
4. Do NOT use this for single-character or trivially small edits to one file
