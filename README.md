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
| `brozi_run` | Bash with raw output | 800-line logs → 50 lines |

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
- In-process file cache — zero disk I/O on repeated reads within a session
- `lines_before` / `lines_after` context around matches
- `type`, `file_limit`, `max_line_length` controls
- Compact response headers with relative paths

### brozi_run

Run a shell command and get compressed, ANSI-stripped output. Supports:
- Automatic truncation to `max_lines` (default: 50)
- Error/warning line preservation even when truncating (`keep_errors: true`)
- ANSI escape code stripping (`strip_ansi: true`)
- Runs in `CLAUDE_PROJECT_DIR`

## Smart hooks

BroziCode installs Claude Code hooks that activate automatically every session:

| Hook | Trigger | Action |
|---|---|---|
| SessionStart | session open | init savings tracking + build repo map (`.brozicode/repo-map.md`) |
| PreToolUse | `Read\|Grep\|Glob` | **hard block** — outputs targeted `brozi_smart_search` alternative |
| PostToolUse | `Bash\|Read` | rewrite: strip ANSI, truncate (100/200 lines), preserve errors |
| PreCompact | compaction | snapshot recent files + git diff → `.brozicode/snapshot-{id}.md` |
| PostCompact | after compaction | re-anchor agent to tool rules + point to snapshot |

## Session savings display

After each session, BroziCode prints:

```
 brozicode · session saved: ~$5.58 · 2.9k tokens · 17 roundtrips  [7× batch-edit, 3× smart-search, 2× run]
```

## Using the brozicode agent

After install, your default `claude` session still runs the standard Claude agent.
The plugin registers `brozicode:brozicode` as a sub-agent. Four ways to use it:

**1. Per-session — CLI flag**
```bash
claude --agent brozicode:brozicode
```
Every task in that session routes through the brozicode agent.

**2. Global default — `~/.claude/settings.json`**
```json
{
  "defaultAgent": "brozicode:brozicode"
}
```
Every `claude` session on your machine uses brozicode by default.

**3. Per-project — `CLAUDE.md`**
```markdown
## File operations
- NEVER use Read, Edit, Write, Grep, Glob for file work
- ALWAYS use `brozi_smart_search` to find / read files
- ALWAYS use `brozi_batch_edit` for all file writes and edits
- ALWAYS use `brozi_run` instead of Bash for command output
- Batch as many edits as possible into a single `brozi_batch_edit` call
```
The default agent picks up these rules and behaves like brozicode for that project.

**4. Explicit per-task**

Ask Claude in any session:
```
Use the brozicode agent to refactor this module.
```
Claude delegates that task to `brozicode:brozicode` without any config change.

## Version

**v0.6.1**

## License

MIT
