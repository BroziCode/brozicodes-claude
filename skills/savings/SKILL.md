---
description: Show BroziCode savings for the current session — roundtrips saved, tokens saved, dollar estimate, and tool call breakdown.
---

To show the current session's BroziCode savings, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/savings-status-line.js"
```

Pass the current session context as stdin if available. The script reads the savings
file written by the PostToolUse hook and prints a one-line summary:

```
 brozicode · 💸 est. savings: $2.40 · 1.8k tokens · 12min · 18 roundtrips saved  [3× batch-edit, 2× smart-search]
```

Savings are estimated based on:
- `brozi_batch_edit`: ~5 avoided round-trips and ~10k tokens per call
- `brozi_smart_search`: ~1 avoided round-trip and ~1.8k tokens per call

The dollar estimate is derived from actual session cost-per-turn × roundtrips saved.
