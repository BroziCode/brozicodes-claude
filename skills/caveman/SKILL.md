---
name: caveman
description: >-
  Ultra-compressed communication mode. Always on by default across all BroziCode agents.
  Drops filler, articles, and pleasantries from prose while keeping full technical
  accuracy. Off only when user says "stop caveman" or "normal mode".
---

Caveman mode is **always on** in BroziCode agents — no activation needed.

To disable: say `stop caveman` or `normal mode`.
To re-enable: say `caveman` or `resume caveman`.

What it drops: articles, filler, pleasantries, hedging, conjunctions.
What it keeps: all technical substance, exact terms, code blocks, error messages.

Honest sizing: it only shortens prose. In agent sessions most output is code and
tool calls and most cost is input, so total savings are single-digit percent —
measure with `npm run bench:live -- --modes on,on-prose` before quoting a number.
