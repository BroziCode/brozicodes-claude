---
description: Rebuild the BroziCode bundle after source changes, or update dependencies.
---

To rebuild the BroziCode plugin after source changes:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/servers/brozicode" && npm run build
```

To update dependencies and rebuild:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/servers/brozicode" && npm update && npm run build
```

After rebuilding, the updated `bundle.js` is used on the next Claude Code session start.
No restart is required for skill or agent definition changes (`.md` files) — those are
read on each invocation.

## What triggers a rebuild

- Changes to `servers/brozicode/src/**` (tool implementations)
  - `src/tools/batch-edit.js` — brozi_batch_edit
  - `src/tools/smart-search.js` — brozi_smart_search
  - `src/tools/run.js` — brozi_run
  - `src/index.js` — server registration
- Adding new npm dependencies (`npm install <pkg>`)
- Updating dependencies (`npm update`)

## What does NOT need a rebuild

- `agents/brozicode.md` — read on each agent spawn
- `agents/explore.md` — read on each agent spawn
- `skills/**/*.md` — read on each skill invocation
- `hooks/hooks.json` — read by the Claude Code harness on each session
- `scripts/*.js` — hook scripts run directly by Node.js, not bundled
