---
description: Use this when editing 2 or more files, or making 2+ related changes to one file. Replaces Read→Edit→Verify loops with a single call.
---

Use brozi_batch_edit instead of sequential Read/Write/Edit calls when:
- Editing 2 or more files in the same task
- Making multiple related changes to a single file
- Refactoring (renames, import updates, interface changes)

## Parameters

- `file_path` — path to the file. Supports `#N-M` suffix to constrain matching to those lines.
  For `.ipynb` notebooks, use `#cell=<N|id|first|last>` to target a specific cell.
- `old_string` — the block of text to find and replace. Omit entirely to **create a new file**.
- `new_string` — the replacement text (required).
- `overwrite: true` — combined with no `old_string`: replaces the entire file content.
- `cell_action` — notebook-only: `insert_after`, `insert_before`, `delete`, `move_after`, `move_before`.
- `validate` — run post-edit validation: `"tsc"`, `"eslint"`, `"both"`, or `"none"` (default).

## Matching behavior

`old_string` does not need to be the full function — just enough context to be unique.
Matching is fuzzy: whitespace differences and Unicode typography (smart quotes, em-dashes)
are normalized automatically. If matching fails, the error shows the nearest line found.

## Rules

1. NEVER re-read a file after calling brozi_batch_edit — trust the result
2. If the tool returns a match error, fix old_string based on the suggestion
3. Batch as many edits as possible into ONE call
4. Do NOT use this for single-character or trivially small edits to one file
