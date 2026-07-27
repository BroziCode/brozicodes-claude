#!/usr/bin/env node
// BroziCode PreToolUse Hard Blocker
// Blocks native Read/Grep/Glob and redirects the caller to brozi_smart_search.
//
// The reason goes to STDERR with exit code 2. That is the channel Claude Code
// feeds back to the model on a code-2 block; stdout JSON is only parsed on
// exit 0. Writing the reason to stdout AND exiting 2 (the previous behaviour)
// meant the model saw a bare block with no explanation and no suggested
// replacement — which is exactly what makes it try `Bash cat` next.

import path from 'path';

// brozi_smart_search reads utf8 text. It has no answer for these, so blocking
// Read here would remove the capability outright rather than redirect it.
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif',
  'pdf', 'ipynb', 'xlsx', 'xls', 'docx', 'pptx', 'zip', 'gz', 'tar',
  'mp3', 'mp4', 'wav', 'mov', 'woff', 'woff2', 'ttf', 'otf',
]);

/** Escape for embedding inside a double-quoted JS string in the suggestion. */
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch {}

  const toolName  = event.tool_name || '';
  const toolInput = event.tool_input || {};

  // ── Allow-through cases ───────────────────────────────────────────────────
  // Fail OPEN. Unparseable stdin used to fall through to the block path with an
  // empty tool name, denying a tool call for no stated reason.
  if (toolName !== 'Read' && toolName !== 'Grep' && toolName !== 'Glob') process.exit(0);

  if (toolName === 'Read') {
    const fp  = toolInput.file_path || toolInput.path || '';
    const ext = path.extname(fp).slice(1).toLowerCase();
    // Binary/rich formats: only native Read can do these.
    if (BINARY_EXTS.has(ext)) process.exit(0);
    // Claude Code's own spill files for oversized tool results.
    if (fp.includes('/.claude/projects/') || fp.includes('tool-results')) process.exit(0);
  }

  let suggestion = '';
  if (toolName === 'Read') {
    const fp = toolInput.file_path || toolInput.path || '<path>';
    suggestion = `brozi_smart_search({ file_glob_patterns: ["${esc(fp)}"] })`;
  } else if (toolName === 'Grep') {
    const pattern = toolInput.pattern || '<pattern>';
    // Claude Code's Grep param is `glob` (`include` never existed here), so this
    // used to drop the caller's filter and suggest scanning the entire repo.
    const glob = toolInput.glob || toolInput.include || (toolInput.path ? `${toolInput.path}/**/*` : '**/*');
    suggestion =
      `brozi_smart_search({ file_glob_patterns: ["${esc(glob)}"], content_regex: "${esc(pattern)}" })`;
  } else if (toolName === 'Glob') {
    const pattern = toolInput.pattern || '**/*';
    suggestion = `brozi_smart_search({ file_glob_patterns: ["${esc(pattern)}"], output_mode: "file_paths_only" })`;
  }

  const reason =
    `BROZICODE: ${toolName} is disabled — use brozi_smart_search instead.\n` +
    (suggestion
      ? `  Use this instead: ${suggestion}`
      : `  brozi_smart_search combines glob + grep + read in one call with caching.`) +
    `\n  Do NOT fall back to \`cat\`/\`grep\` via Bash — that costs more tokens than the tool you just tried.`;

  process.stderr.write(reason + '\n');
  process.exit(2);
});
