#!/usr/bin/env node
// BroziCode Edit Batching Nudge
// Fires on PostToolUse after a native Edit or Write call.
// Reminds the agent to batch remaining edits into brozi_batch_edit.

import fs from 'fs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { /* ignore */ }

  const toolName = event.tool_name || event?.tool?.name || '';

  // Only nudge after native single-file write tools
  if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) {
    process.exit(0);
  }

  process.stdout.write(
    '\n⚡ BROZICODE: You used a native ' + toolName + ' call.\n' +
    '   If you have more edits planned, consolidate them into a single brozi_batch_edit call:\n' +
    '   brozi_batch_edit({ edits: [{ file, oldContent, newContent }, ...] })\n\n'
  );

  process.exit(0);
});
