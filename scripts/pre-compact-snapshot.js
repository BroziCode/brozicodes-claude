#!/usr/bin/env node
// BroziCode PreCompact Snapshot Generator
// Before context compaction, writes a snapshot of recently-read file paths + git diff stat
// to .brozicode/snapshot-{session_id}.md so the agent can re-anchor after compaction.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch {}

  const sessionId  = event.session_id || 'default';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const snapDir    = path.join(projectDir, '.brozicode');
  const snapPath   = path.join(snapDir, `snapshot-${sessionId}.md`);
  const sessFile   = path.join(os.tmpdir(), `brozicode-session-${sessionId}.json`);

  try {
    fs.mkdirSync(snapDir, { recursive: true });

    let sessData = {};
    try { sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch {}

    const recentFiles = (sessData.recentFiles || []).slice(-20);

    let snap  = `# BroziCode Compaction Snapshot\n`;
    snap     += `Session: ${sessionId}  •  ${new Date().toISOString()}\n\n`;

    // Git diff summary
    try {
      const diff = execSync('git diff --stat HEAD', {
        cwd: projectDir, encoding: 'utf8', timeout: 5_000,
      });
      if (diff.trim()) {
        snap += `## Pending changes (git diff --stat HEAD)\n\`\`\`\n${diff.trim()}\n\`\`\`\n\n`;
      }
    } catch {}

    // Recently accessed files with brozi_smart_search restore command
    if (recentFiles.length > 0) {
      snap += `## Recently accessed files\n`;
      recentFiles.forEach(f => { snap += `- ${f}\n`; });
      snap += `\n`;

      const recent5 = recentFiles.slice(-5).map(f => `"${f}"`).join(', ');
      snap += `### Restore context\n`;
      snap += `\`\`\`js\nbrozi_smart_search({ file_glob_patterns: [${recent5}], summary: true })\n\`\`\`\n`;
    }

    // Write atomically
    const tmp = snapPath + '.tmp';
    fs.writeFileSync(tmp, snap, 'utf8');
    fs.renameSync(tmp, snapPath);

    process.stdout.write(`BroziCode snapshot saved: ${snapPath}\n`);
  } catch (err) {
    // Non-fatal — don't disrupt compaction
    process.stderr.write(`[brozicode] pre-compact-snapshot: ${err.message}\n`);
  }

  process.exit(0);
});
