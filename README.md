# brozicodes-claude

> Stop burning tokens on the loop.

BroziCode is a free, open-source Claude Code plugin that replaces micro-tool
agentic loops with Macro-tools — cutting API round-trips from 12 to 2 on
complex edits.

## Install

Open Claude Code and run:

```
/plugin marketplace add broziden/brozicodes-claude
/plugin install brozicodes-claude@brozicodes-claude
```

That's it. The agent calls the tools. You just code.

## What it does

| Tool | Replaces | Savings |
|---|---|---|
| `brozi_batch_edit` | Read→Edit→Verify loop | ~6 round-trips per task |
| `brozi_smart_search` | Full file reads | 2,000 lines → 150 lines |
| `brozi_map_dependencies` | Blind grepping | Instant blast radius |

## Session savings display

After each session, BroziCode prints:

```
 ─────────────────────────────────── brozicodes-claude ──
 ❯
 ─────────────────────────────────────────────────────────────
   💸 session savings: $5.58 · 2.9k tokens · 17min · 41 roundtrips saved
```

## Status

**v0.1.0 — skeleton.** Tools are stubbed. Watch this repo or sign up at
[brozi.codes](https://brozi.codes) to get notified when v1 ships.

## License

MIT
