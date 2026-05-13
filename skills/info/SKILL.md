---
description: Show BroziCode plugin version, tool registration status, and configuration.
---

To show BroziCode plugin status, report the following:

1. **Version**: read from `${CLAUDE_PLUGIN_ROOT}/servers/brozicode/package.json` (the `version` field)
2. **Tools registered**: `brozi_batch_edit`, `brozi_smart_search`
3. **Bundle path**: `${CLAUDE_PLUGIN_ROOT}/servers/brozicode/bundle.js`
4. **Hooks active**: SessionStart (tracker init), PreToolUse on Read/Grep/Glob (guidance), PostToolUse (savings tracking)
5. **Settings**: read from `${CLAUDE_PLUGIN_ROOT}/settings.json`

Format the output as a concise status block. Example:

```
brozicodes-claude v0.2.0
  tools:   brozi_batch_edit, brozi_smart_search
  hooks:   SessionStart · PreToolUse(Read|Grep|Glob) · PostToolUse
  agent:   brozicode (sonnet, maxTurns: 30)
  skills:  batch-edit, smart-search, savings, info, update
```
