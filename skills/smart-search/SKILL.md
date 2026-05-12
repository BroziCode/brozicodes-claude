---
description: Use this instead of grep or reading full files when you need to understand the structure of a codebase file.
---

Use the `brozi_smart_search` MCP tool instead of reading full files or grepping when:
- You need to understand what functions/classes/exports a file contains
- You would otherwise read a 500+ line file just to find one function signature
- You need a structural overview before deciding what to edit

The tool parses files into an AST and returns only signatures and exports —
stripping function bodies. Typical reduction: 2,000 lines → 150 lines.

Do NOT use when you actually need to read the implementation details inside a function.
