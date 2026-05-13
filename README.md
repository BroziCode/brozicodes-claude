# brozicodes-claude

> Stop burning tokens on the loop.

BroziCode is a free, open-source Claude Code plugin that replaces native micro-tool
agentic loops with Macro-tools — cutting API round-trips from 12 to 2 on complex edits.

## Install

Open Claude Code and run:

```
/plugin marketplace add broziden/brozicodes-claude
/plugin install brozicode@brozicode-marketplace
```

That's it. The agent calls the tools. You just code.

## What it does

| Tool | Replaces | Savings |
|---|---|---|
| `brozi_batch_edit` | Read→Edit→Verify loop | ~5 round-trips per task |
| `brozi_smart_search` | Full file reads + grep | 2,000 lines → 150 lines |

### brozi_batch_edit

Apply multiple file edits in one call with fuzzy matching. Supports:
- Multi-file edits in a single operation
- `overwrite: true` for full-file replacement
- File creation (omit `old_string`)
- `#N-M` line-range constraint on matching
- Unicode typography normalization (smart quotes, em-dashes match ASCII)
- Jupyter notebook cell operations (`#cell=<target>`, `cell_action`)
- Optional post-edit validation (`tsc`, `eslint`, `both`)

### brozi_smart_search

Combined file discovery, grep, and reading in one call. Supports:
- Glob patterns (`src/**/*.ts`) with multi-pattern arrays
- Content regex filtering across files
- Three output modes: `file_paths_with_content`, `file_paths_only`, `file_paths_with_match_count`
- `summary: true` for JS/TS AST skeleton (signatures, exports, imports)
- `#N-M` line-range suffix for targeted reads
- `if_modified_since` caching — skip unchanged files
- `lines_before` / `lines_after` context around matches
- `type`, `file_limit`, `max_line_length` controls

## Session savings display

After each session, BroziCode prints:

```
 brozicode · 💸 est. savings: $5.58 · 2.9k tokens · 17min · 41 roundtrips saved  [7× batch-edit, 3× smart-search]
```

## Version

**v0.2.0**

## License

MIT
