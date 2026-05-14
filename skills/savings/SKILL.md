---
description: Show BroziCode savings for the current session — roundtrips saved, tokens saved, dollar estimate, compliance rate, and tool call breakdown.
---

To show the current session's BroziCode savings report, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/savings-report.js"
```

Relay the full output to the user. Do not summarize or modify it.

The report includes:
- Session duration
- `brozi_batch_edit` and `brozi_smart_search` call counts with per-tool estimates
- Total roundtrips saved, tokens saved, and estimated dollar savings
- Native tool compliance rate (macro calls vs native fallbacks)
