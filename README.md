# brozicodes-claude

> Stop burning tokens on the loop.

BroziCode is a free, open-source Claude Code plugin that replaces native micro-tool
agentic loops with Macro-tools — cutting API round-trips from 12 to 2 on complex edits.

## Install

Open Claude Code and run:

```
/plugin marketplace add BroziCode/brozicodes-claude
/plugin install brozicode@brozicode-marketplace
```

That's it. The agent calls the tools. You just code.

## What it does

| Tool | Replaces | Savings |
|---|---|---|
| `brozi_batch_edit` | Read→Edit→Verify loop | ~5 round-trips per task |
| `brozi_smart_search` | Full file reads + grep | 2,000 lines → 150 lines |
| `brozi_run` | Bash with raw output | 800-line logs → errors + head + tail |
| `brozi_script` | Chains of 3+ dependent calls | intermediate data never enters context |

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
- **`focus`** — plain keywords; returns only matching regions with ±2 lines of context
- **Stale-read detection** — re-reads of unchanged files return the skeleton only
- **Auto-skeleton gate** — JS/TS files >300 lines without a line range are auto-skeletonized (prevents token spirals)
- **TOON output** — `file_paths_only` and `file_paths_with_match_count` use compact `relpath:count` format (~70% smaller)
- `lines_before` / `lines_after` context around matches
- `type`, `file_limit`, `max_line_length` controls
- Compact response headers with relative paths

### brozi_run

Run a shell command and get compressed, ANSI-stripped output. Supports:
- Per-command noise filters: passing tests, install/progress spam, git transfer progress, repeated lines
- Output over `max_lines` (default: 50) becomes one ordered digest: every error line, every `focus`
  match, head and tail — the answer is in the first response, not behind a follow-up query
- Full output stored; `query: "regex"` searches it without re-running
- Runs in `CLAUDE_PROJECT_DIR`

### brozi_script

Code mode: one async JS snippet chains `read`, `glob`, `sh`, `search`, `edit`, `run` and returns only
the final value, so intermediate data never touches the context. Not a security sandbox (`node:vm`) —
it has the same reach as `brozi_run`.

All four tools are marked `anthropic/alwaysLoad`, so Claude Code doesn't defer them behind tool search
(which cost an extra ToolSearch round-trip on first use).

## Smart hooks

BroziCode installs Claude Code hooks that activate automatically every session:

| Hook | Trigger | Action |
|---|---|---|
| SessionStart | session open | auto-configure `~/.claude/settings.json` on version change; init savings tracking; inject a ~1K-token repo map (imported files only) |
| SessionStart (`compact`) | after compaction | re-anchor agent to its tools + point to snapshot |
| UserPromptSubmit | each prompt | warn once at 50/70/90% of context budget, from real transcript usage |
| PostToolUse | `Bash\|Read` | compress native output in place: Bash → noise filter / digest (full output spilled to a temp file); whole-file Read >400 lines → skeleton |
| PreCompact | compaction | snapshot recent files + git diff → `.brozicode/snapshot-{id}.md` |

Native Read/Grep/Glob are no longer blocked. Blocking cost 2–3 extra model steps per attempt
(denied call → error → retry); compressing their output in place keeps the tools the model is
trained on and still cuts what reaches the context.

## Session savings display

After each session, BroziCode prints:

```
 brozicode · ~$5.58 saved · 2.9k tokens (input+output est.) · 17 roundtrips  [7× batch-edit, 3× smart-search, 2× run]
```

The dollar estimate accounts for both input tokens avoided and their downstream output reduction
(Sonnet pricing: $3/M input + conservative 15% output multiplier at $15/M).

## Agents

BroziCode ships two agents. Both run in caveman mode (ultra-compressed responses) by default.

### `brozicode:brozicode`

Main coding agent. Prefers `brozi_batch_edit`, `brozi_smart_search`, `brozi_run`, `brozi_script`;
falls back to native tools when they fit better (their large outputs are compressed by hooks).

### `brozicode:explore`

Fast read-only search sub-agent (Haiku, low effort, max 15 turns).
Uses `brozi_smart_search` only. Spawned automatically by the main agent for multi-step discovery.
Do NOT use for code review or open-ended analysis — it reads excerpts, not full files.

Specify search breadth when spawning: `"quick"` / `"medium"` / `"very thorough"`.

---

## Using the brozicode agent

After install, your default `claude` session still runs the standard Claude agent.
The plugin registers `brozicode:brozicode` as a sub-agent. Four ways to use it:

**1. Per-session — CLI flag**
```bash
claude --agent brozicode:brozicode
```
Every task in that session routes through the brozicode agent.

**2. Global default — auto-configured on install/update**

BroziCode automatically writes `~/.claude/settings.json` on every install or version update, setting:
- `agent: brozicode:brozicode` as the default
- `statusLine` pointing to the installed version's status script
- `spinnerVerbs` with BroziCode-flavoured messages

No manual config needed. Re-runs whenever the plugin version changes.

**3. Per-project — `CLAUDE.md`**
```markdown
## File operations
- Prefer `brozi_smart_search` to find / read files
- Prefer `brozi_batch_edit` for file writes, batching edits into one call
- Prefer `brozi_run` over Bash for command output
- Use `brozi_script` for chains of 3+ dependent lookups
```
The default agent picks up these rules and behaves like brozicode for that project.

**4. Explicit per-task**

Ask Claude in any session:
```
Use the brozicode agent to refactor this module.
```
Claude delegates that task to `brozicode:brozicode` without any config change.

## Version

**v0.12.0**

### Measuring

- `npm run bench` — deterministic model of context-injection tokens (CI regression guard)
- `npm run bench:live -- --model sonnet --runs 3` — real `claude -p` sessions, BroziCode off / on /
  on-without-caveman; reports billed tokens, cost and task pass rate. Costs real money; not in CI.

### Changelog

**v0.12.0**
- **Compress, don't block** — removed the PreToolUse hard block on Read/Grep/Glob (2–3 wasted model steps per attempt). Native Bash/Read output is now compressed in place via PostToolUse `updatedToolOutput` (shapes verified against Claude Code 2.1.312)
- **`alwaysLoad`** — all tools marked `anthropic/alwaysLoad`; no ToolSearch round-trip before first use
- **`brozi_run` digest** — errors, focus hits, head and tail in the first response (was: first 30 lines); failing commands get the same treatment (was: head only, hiding tail failures)
- **Per-command noise filters** — test runners, package managers, git transfer progress, build chatter, `\r` progress bars, repeated lines; shared by `brozi_run` and the Bash hook
- **`focus` param** on `brozi_run` and `brozi_smart_search`
- **`brozi_script`** — code-mode tool: chain read/glob/sh/search/edit/run in one snippet, return only the result
- **Repo map** — imported files only (was flooded by unrelated leaf files), hard ~1K-token budget, no timestamp, injected into context instead of printed as a path
- **Budget guard** — real context size from transcript usage (was a tool-output sum that over-counted, incl. subagents); re-arms after /compact
- **Re-anchor fix** — moved to SessionStart(`compact`); PostCompact stdout never reached the model
- **Results capped at 45K chars** — Claude Code spills MCP results over 50K to a file
- **Honest numbers** — e2e bench no longer charges native edits a phantom re-read; caveman's "~75%" claim removed; new live A/B harness

**v0.8.4**
- **Update notifications** — on session start, BroziCode checks GitHub for newer versions (at most once per 24h) and prints a one-liner if an update is available: `⚡ Update available: vX.X.X → vY.Y.Y. Run: /plugin update brozicode`

**v0.8.3**
- **BroziCode Agent co-authorship** — all commits made by BroziCode agents include `Co-Authored-By: BroziCode Agent <agent@brozi.codes>` alongside the Claude trailer

**v0.8.2**
- **explore agent caveman** — `brozicode:explore` now has full inline caveman rules (pattern, Auto-Clarity Exception); was using incomplete stub
- **explore key params** — added `if_modified_since` to documented params
- **README agents section** — documents both agents with constraints and caveman-always-on behavior

**v0.8.1**
- **Auto-configure settings** — on every install or update, BroziCode rewrites `~/.claude/settings.json` with the correct `agent`, `statusLine` (versioned path), and `spinnerVerbs`; only triggers when the plugin version changes
- **BroziCode spinnerVerbs** — replaces default Claude spinner text with BroziCode-flavoured messages
- **Versioned statusLine path** — status line command resolves to the newest versioned cache dir automatically

**v0.8.0**
- **Caveman mode always-on** — ultra-compressed communication style active by default across all BroziCode agents (~75% token reduction in responses)

**v0.7.2**
- Added `brozicode:caveman` skill for explicit caveman mode toggle

**v0.7.1**
- Fixed cost estimate always showing $0.00 in status line

**v0.7.0**
- **Stale-read detection** — re-reads of unchanged files (same mtime) return a compact in-context notice; no repeated token spend on unmodified sources
- **Auto-skeleton gate** — JS/TS files >300 lines without a `#N-M` range are automatically skeletonized; prevents the 50k+ token spiral from large raw file dumps
- **TOON output encoding** — `file_paths_only` and `file_paths_with_match_count` modes now emit compact `relpath:count` lines (~70% smaller than padded absolute paths)
- **Compressed tool schemas** — all Zod `.describe()` strings tightened; saves ~250 tokens per API call across 3 tools
- **Effective tokens metric** — savings display now estimates output token impact (input+output combined); dollar estimate uses $3/M input + 15% output multiplier
- **Better match errors** — `brozi_batch_edit` match failures now include the actual file content window as a copy-pasteable corrected `oldContent`
- **Skipped-edit reporting** — when `stopOnFirstError` halts a batch, remaining edits are explicitly listed as "NOT attempted — resubmit ENTIRE batch"

**v0.6.1**
- Fixed `brozi_batch_edit` silently dropping edits: match errors now include the nearest file content as corrected `oldContent`
- Fixed 57k token spiral: added `MAX_FILE_LINES_RAW = 300` gate + lowered response cap to 150KB

**v0.6.0**
- Added `brozi_run` tool for compressed shell command output
- PostToolUse response rewriter (Bash + Read)
- In-process file cache (zero disk I/O on repeated reads)
- PreToolUse hard block on native Read/Grep/Glob
- PreCompact snapshot + PostCompact re-anchor hooks
- SessionStart PageRank repo map

## License

MIT
