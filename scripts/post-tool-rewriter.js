#!/usr/bin/env node
// BroziCode PostToolUse Response Rewriter
// Intercepts tool results and compresses them before they enter Claude's context window.
//
//   Bash  → strip ANSI, truncate to 100 lines (preserve error/warning lines)
//   Read  → JS/TS files >100 lines: header + first 80 lines + skeleton suggestion
//           any file >200 lines: truncate with omission notice
//
// Writes {"type": "result", "content": "..."} to stdout to replace the result,
// or exits 0 with no output to pass the result through unchanged.

import path from 'path';

const ANSI_RE  = /\x1B\[[0-9;]*[mGKHFJK]/g;
const ERROR_RE = /error\s*TS\d+|^\s*(Error|TypeError|SyntaxError|ReferenceError|Warning):|FAIL\s|✗|✕|\bfailed\b|\bERROR\b/i;

function stripAnsi(s)   { return s.replace(ANSI_RE, ''); }
function isErrorLine(l) { return ERROR_RE.test(l); }
function passThrough()  { process.exit(0); }
function rewrite(content) {
  process.stdout.write(JSON.stringify({ type: 'result', content }) + '\n');
  process.exit(0);
}

/** Returns compressed string if lines > maxLines, or null if no change needed. */
function truncateLines(text, maxLines, keepErrors) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return null;

  const head   = lines.slice(0, maxLines);
  const tail   = lines.slice(maxLines);
  let   result = head.join('\n');
  result      += `\n  … [${tail.length} line${tail.length !== 1 ? 's' : ''} omitted]`;

  if (keepErrors) {
    const errs = tail.filter(isErrorLine);
    if (errs.length > 0) result += '\n  … [errors from omitted section:]\n' + errs.join('\n');
  }

  return result;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { passThrough(); }

  const toolName = event.tool_name || '';

  // Never rewrite brozi_* tool outputs
  if (toolName.includes('brozi_')) passThrough();

  // Extract tool response (multiple field names for compatibility)
  const raw      = event.tool_response ?? event.tool_result ?? event.output ?? event.result ?? '';
  const response = typeof raw === 'string'   ? raw
    : raw?.content ? (typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content))
    : typeof raw === 'object' ? JSON.stringify(raw)
    : '';

  if (!response) passThrough();

  if (toolName === 'Bash') {
    const cleaned   = stripAnsi(response);
    const rewritten = truncateLines(cleaned, 100, true);
    if (rewritten) rewrite(rewritten);
    else passThrough();

  } else if (toolName === 'Read') {
    const filePath = event.tool_input?.file_path || event.tool_input?.path || '';
    const ext      = path.extname(filePath).slice(1).toLowerCase();
    const isJsTs   = ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext);
    const lines    = response.split('\n');

    if (isJsTs && lines.length > 100) {
      rewrite(
        `[BroziCode: ${path.basename(filePath)} has ${lines.length} lines — showing first 80]\n` +
        `[For AST skeleton: brozi_smart_search({ file_glob_patterns: ["${filePath}"], summary: true })]\n\n` +
        lines.slice(0, 80).join('\n') +
        `\n  … [${lines.length - 80} lines omitted]`
      );
    } else {
      const rewritten = truncateLines(response, 200, false);
      if (rewritten) rewrite(rewritten + '\n  [use brozi_smart_search with #N-M ranges for targeted reads]');
      else passThrough();
    }

  } else {
    passThrough();
  }
});
