---
description: Show BroziCode plugin version, tool registration status, and configuration.
---

To show BroziCode plugin status, collect and display the following. Use Bash for all reads.

1. **Version** — read from `${CLAUDE_PLUGIN_ROOT}/servers/brozicode/package.json`
2. **Tools registered** — always `brozi_batch_edit`, `brozi_smart_search`
3. **Bundle path** — `${CLAUDE_PLUGIN_ROOT}/servers/brozicode/bundle.js`
4. **Hooks active** — parse `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` dynamically:

```bash
node --input-type=module -e "
import { readFileSync } from 'fs';
const h = JSON.parse(readFileSync(process.env.CLAUDE_PLUGIN_ROOT + '/hooks/hooks.json'));
for (const [event, entries] of Object.entries(h.hooks)) {
  for (const entry of entries) {
    const matcher = entry.matcher ? \`(\${entry.matcher})\` : '';
    const scripts = entry.hooks.map(h => h.command.split('/').pop().replace(/\"/g, '').split(' ')[0]).join(', ');
    console.log(\`  \${event}\${matcher} → \${scripts}\`);
  }
}
"
```

5. **Agent** — name, model, maxTurns from `${CLAUDE_PLUGIN_ROOT}/agents/brozicode.md` frontmatter
6. **Explore sub-agent** — confirm `${CLAUDE_PLUGIN_ROOT}/agents/explore.md` exists
7. **Skills** — list directory names under `${CLAUDE_PLUGIN_ROOT}/skills/`
8. **Settings** — contents of `${CLAUDE_PLUGIN_ROOT}/settings.json`

Format as a concise status block matching this shape (hook list is dynamic — do not hardcode it):

```
brozicode-server v0.2.0
    tools:    brozi_batch_edit, brozi_smart_search
    bundle:   .../servers/brozicode/bundle.js
    hooks:    SessionStart → session-tracker.js init
              UserPromptSubmit → session-tracker.js track
              PreToolUse(^(Read|Grep|Glob)$) → echo
              PostToolUse(^(Edit|Write|MultiEdit)$) → edit-batching-nudge.js
              PostToolUse(.*) → session-tracker.js track
              SubagentStop → session-tracker.js track
              Stop → session-tracker.js stop
              StopFailure → session-tracker.js init
              PreCompact → session-tracker.js track
              PostCompact → session-tracker.js track
    agent:    brozicode:brozicode (sonnet, maxTurns: 30)
    explore:  brozicode:explore sub-agent
    skills:   batch-edit, smart-search, savings, info, update
    settings: { "agent": "brozicode:brozicode" }
```
