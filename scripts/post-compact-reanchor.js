#!/usr/bin/env node
// BroziCode post-compaction re-anchor — runs as SessionStart (matcher "compact").
// It used to run on PostCompact, whose stdout Claude Code does NOT add to the
// context (only SessionStart / UserPromptSubmit stdout is injected), so the
// model never saw it. SessionStart fires with source "compact" right after.
// Points the agent at its tools and at the pre-compaction snapshot.

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

  // Keep this list truthful. It used to say "NEVER use Read/Grep/Glob/Edit/Write",
  // but only Read/Grep/Glob are actually blocked — and Read is deliberately allowed
  // for images/PDFs/notebooks, which brozi_smart_search cannot open at all.
  // Native tools are not blocked (their big outputs are compressed by the
  // PostToolUse hook); the macro-tools are just cheaper.
  let msg  = `\n⚡ BROZICODE RE-ANCHOR (context was compacted)\n`;
  msg     += `  Prefer: brozi_smart_search (read/grep/glob/skeletons), brozi_batch_edit (multi-file writes),\n`;
  msg     += `  brozi_run (shell), brozi_script (multi-step chains).\n`;
  msg     += `  Files read before compaction are NOT in context any more; re-read what you still need.\n`;

  if (fs.existsSync(snapPath)) {
    msg += `  Context snapshot — run to restore:\n`;
    msg += `  brozi_smart_search({ file_glob_patterns: ["${snapPath}"] })\n`;
  }

  process.stdout.write(msg);
  process.exit(0);
});
