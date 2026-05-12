---
description: Use this before editing a file to understand what other files depend on it.
---

Use the `brozi_map_dependencies` MCP tool before making changes to a file when:
- You need to know what would break if you change this file's exports
- You are about to rename or restructure something
- You want to understand the blast radius of a change

The tool generates a local import/export graph and returns a compact summary of:
- Upstream: files this file imports from
- Downstream: files that import from this file

Do NOT use for simple, isolated edits where blast radius is obviously zero.
