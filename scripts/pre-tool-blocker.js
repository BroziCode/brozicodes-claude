#!/usr/bin/env node
// BroziCode PreToolUse Hard Blocker
// Blocks native Read/Grep/Glob tool calls and redirects the agent to brozi_smart_search.
// Writes {"decision": "block", "reason": "..."} to stdout and exits with code 2.

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch {}

  const toolName  = event.tool_name || '';
  const toolInput = event.tool_input || {};

  // Build a targeted brozi_smart_search suggestion based on which tool was blocked
  let suggestion = '';
  if (toolName === 'Read') {
    const fp = toolInput.file_path || toolInput.path || '<path>';
    suggestion = `brozi_smart_search({ file_glob_patterns: ["${fp}"], summary: true })`;
  } else if (toolName === 'Grep') {
    const pattern = toolInput.pattern || '<pattern>';
    const include = toolInput.include || '**/*';
    suggestion =
      `brozi_smart_search({ file_glob_patterns: ["${include}"], content_regex: "${pattern}", ` +
      `output_mode: "file_paths_with_match_count" })`;
  } else if (toolName === 'Glob') {
    const pattern = toolInput.pattern || '**/*';
    suggestion = `brozi_smart_search({ file_glob_patterns: ["${pattern}"], output_mode: "file_paths_only" })`;
  }

  const reason =
    `BROZICODE: ${toolName} is disabled — use brozi_smart_search instead.\n` +
    (suggestion
      ? `  Suggested: ${suggestion}`
      : `  brozi_smart_search combines glob + grep + read in one call with caching.`);

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
});
