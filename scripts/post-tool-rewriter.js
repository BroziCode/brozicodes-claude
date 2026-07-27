#!/usr/bin/env node
// BroziCode PostToolUse nudge (Bash / Read)
//
// HISTORY / WHY THIS IS SMALL NOW:
// This script used to claim it rewrote verbose tool output — strip ANSI, truncate
// Bash to 100 lines, Read to 200 — by printing {"type":"result","content":…}.
// That field is not part of the PostToolUse hook contract and Claude Code ignored
// it: a tool result is already produced and delivered by the time PostToolUse
// fires, so a PostToolUse hook cannot replace it. Verified against a 300-line
// Bash command — every line still entered the context untouched. The compression
// never happened; the script was dead weight running on every Bash and Read call.
//
// Truncation has to happen where the output is produced, which is brozi_run
// (it intercepts >100 lines into a queryable store). So all this hook can
// honestly do is point the caller at brozi_run the first time they take the
// expensive path — once per session, via the supported additionalContext field.

import fs from 'fs';
import os from 'os';
import path from 'path';

const BIG_OUTPUT_LINES = 150;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { process.exit(0); }

  const toolName = event.tool_name || '';
  if (toolName !== 'Bash' && toolName !== 'Read') process.exit(0);

  const raw = event.tool_response ?? event.tool_result ?? event.output ?? event.result ?? '';
  const text = typeof raw === 'string' ? raw
    : typeof raw?.content === 'string' ? raw.content
    : raw ? JSON.stringify(raw) : '';

  let lineCount = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineCount++;
  if (lineCount < BIG_OUTPUT_LINES) process.exit(0);

  // Once per session — a nudge repeated after every large output costs more
  // tokens than it saves.
  const sessionId = event.session_id || 'default';
  const flagFile  = path.join(os.tmpdir(), `brozicode-nudge-${sessionId}-${toolName}`);
  try {
    fs.writeFileSync(flagFile, '1', { flag: 'wx' });   // fails if it already exists
  } catch {
    process.exit(0);
  }

  const advice = toolName === 'Bash'
    ? 'brozi_run intercepts outputs over 100 lines into a queryable store instead of ' +
      'putting them in context: brozi_run({ command }) then brozi_run({ command, query: "pattern" }).'
    : 'brozi_smart_search returns AST skeletons (summary: true) or line ranges ("path#40-90") ' +
      'instead of whole files.';

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `⚡ BROZICODE: that ${toolName} call put ~${lineCount} lines into the context window. ${advice}`,
    },
  }) + '\n');
  process.exit(0);
});
