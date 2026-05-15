#!/usr/bin/env node
// BroziCode PostCompact Re-anchor
// After context compaction, reminds the agent of its tool constraints
// and points it to the pre-compaction snapshot for context restoration.

import fs from 'fs';
import path from 'path';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch {}

  const sessionId  = event.session_id || 'default';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const snapPath   = path.join(projectDir, '.brozicode', `snapshot-${sessionId}.md`);

  let msg  = `\n⚡ BROZICODE RE-ANCHOR (context was compacted)\n`;
  msg     += `  Tools: brozi_smart_search, brozi_batch_edit, brozi_run\n`;
  msg     += `  Rules: NEVER use Read/Grep/Glob/Edit/Write — always use brozi_* tools\n`;

  if (fs.existsSync(snapPath)) {
    msg += `  Context snapshot — run to restore:\n`;
    msg += `  brozi_smart_search({ file_glob_patterns: ["${snapPath}"] })\n`;
  }

  process.stdout.write(msg);
  process.exit(0);
});
