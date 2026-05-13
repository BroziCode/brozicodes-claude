---
description: Use this instead of grep or reading full files. Supports glob patterns, content regex, multi-file reads, line ranges, and caching.
---

Use brozi_smart_search for all file discovery and reading:
- Finding files by pattern
- Grepping for content across a codebase
- Reading files (full or sliced to a line range)
- Getting a structural overview of JS/TS files without reading bodies

## Key parameters

- `file_glob_patterns` — array of glob patterns or exact paths. Entries may include `#N-M` suffix
  to read only those lines (e.g. `"src/foo.ts#50-100"`).
- `content_regex` — filter files by content (grep-style). Combine with `file_glob_patterns`
  to narrow by scope and content in one call.
- `output_mode`:
  - `"file_paths_with_content"` (default) — discover and read in one step
  - `"file_paths_only"` — just filenames with size/date
  - `"file_paths_with_match_count"` — filenames ranked by match count
- `summary: true` — for JS/TS files, return AST skeleton (signatures, exports, imports)
  instead of raw content. Typical reduction: 2,000 lines → 150 lines.
- `type` — filter by extension: `"ts"`, `"js"`, `"sql"`, etc.
- `file_limit` — cap number of files processed.
- `lines_before` / `lines_after` — context lines around each regex match.
- `lines_per_file` — max matching lines per file (default 500, 0 = unlimited).
- `max_line_length` — truncate long lines (default 1000, 0 = unlimited).
- `if_modified_since` — pass the `Results as of` timestamp from a previous call to skip
  unchanged files and save tokens.
- `ignore_case` / `multiline` — regex flags.

## Rules

1. Default to `output_mode: "file_paths_with_content"` — it discovers and reads in one call
2. Use `summary: true` for large JS/TS files when you only need structure
3. Pass `if_modified_since` on re-reads of files already in context
4. Combine `file_glob_patterns` + `content_regex` in one call instead of two separate calls
