#!/usr/bin/env node
// BroziCode Edit Batching Nudge
// Fires on PostToolUse after a native Edit / Write / MultiEdit call.
//
// Rate-limited to ONCE PER SESSION. It used to fire unconditionally after every
// single native write, injecting ~40 tokens of advice each time with no idea
// whether more edits were even coming — a token-saving plugin spending tokens to
// say "save tokens".

import fs from 'fs';
import os from 'os';
import path from 'path';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { process.exit(0); }

  const toolName = event.tool_name || event?.tool?.name || '';
  if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) process.exit(0);

  const sessionId = event.session_id || 'default';
  const flagFile  = path.join(os.tmpdir(), `brozicode-editnudge-${sessionId}`);
  try {
    fs.writeFileSync(flagFile, '1', { flag: 'wx' });   // fails if it already exists
  } catch {
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `⚡ BROZICODE: you used native ${toolName}. If more edits are coming, put them in one call: ` +
        `brozi_batch_edit({ edits: [{ file, oldContent, newContent }, …] }). ` +
        `(Shown once per session.)`,
    },
  }) + '\n');
  process.exit(0);
});
