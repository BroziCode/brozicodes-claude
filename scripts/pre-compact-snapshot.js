#!/usr/bin/env node
// BroziCode PreCompact Snapshot — tiered priority, 2K hard cap
//
// T1 (never drop): timestamp + git status --short + session stats
// T2 (drop if needed): recent 5 files with line counts
// T3 (drop first): restore brozi_smart_search command
//
// Hard cap: 2000 chars total. Truncate T3 first, then T2, T1 last.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const HARD_CAP = 2000;

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

    // ── Tier 1: Always keep ─────────────────────────────────────────────────
    let t1 = `# BroziCode Snapshot  ${new Date().toISOString().slice(0, 16)}Z\n`;

    // Git status (pending changes — most critical context)
    try {
      const status = execSync('git status --short', {
        cwd: projectDir, encoding: 'utf8', timeout: 5_000,
      }).trim();
      if (status) {
        const lines = status.split('\n').slice(0, 10);
        t1 += `## Pending changes\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`;
      }
    } catch {}

    // Session stats
    const toolCalls = (sessData.batchEditCalls || 0) +
                      (sessData.smartSearchCalls || 0) +
                      (sessData.runCalls || 0);
    if (toolCalls > 0) {
      const consumed = sessData.tokensConsumed || 0;
      t1 += `Session: ${toolCalls} tool calls`;
      if (consumed > 0) t1 += `, ~${Math.round(consumed / 1000)}k tokens consumed`;
      t1 += '\n';
    }

    // ── Tier 2: Recent files ────────────────────────────────────────────────
    // Tracks files from brozi_smart_search patterns (not Read calls, which are blocked)
    const recentFiles    = (sessData.recentFiles    || []).slice(-5);
    const recentPatterns = (sessData.recentPatterns || []).slice(-5);

    let t2 = '';
    if (recentFiles.length > 0) {
      t2 += `## Recent files\n`;
      for (const f of recentFiles) {
        try {
          const lineCount = fs.readFileSync(f, 'utf8').split('\n').length;
          t2 += `- ${path.relative(projectDir, f)} (${lineCount} lines)\n`;
        } catch {
          t2 += `- ${path.relative(projectDir, f)}\n`;
        }
      }
    } else if (recentPatterns.length > 0) {
      t2 += `## Recent search patterns\n`;
      recentPatterns.forEach(p => { t2 += `- ${p}\n`; });
    }

    // ── Tier 3: Restore command ─────────────────────────────────────────────
    let t3 = '';
    const restoreTargets = recentFiles.length > 0
      ? recentFiles.slice(-3).map(f => `"${f}"`).join(', ')
      : recentPatterns.length > 0
        ? recentPatterns.slice(-3).map(p => `"${p}"`).join(', ')
        : null;

    if (restoreTargets) {
      t3 += `## Restore\n\`\`\`js\nbrozi_smart_search({ file_glob_patterns: [${restoreTargets}], summary: true })\n\`\`\`\n`;
    }

    // ── Assemble with hard cap ──────────────────────────────────────────────
    let snap;
    if ((t1 + t2 + t3).length <= HARD_CAP) {
      snap = t1 + t2 + t3;
    } else if ((t1 + t2).length <= HARD_CAP) {
      snap = t1 + t2; // T3 dropped
    } else if (t1.length <= HARD_CAP) {
      snap = t1;      // T2+T3 dropped
    } else {
      snap = t1.slice(0, HARD_CAP); // T1 truncated (extreme case)
    }

    const tmp = snapPath + '.tmp';
    fs.writeFileSync(tmp, snap, 'utf8');
    fs.renameSync(tmp, snapPath);

    process.stdout.write(`BroziCode snapshot saved: ${snapPath} (${snap.length}/${HARD_CAP} chars)\n`);
  } catch (err) {
    process.stderr.write(`[brozicode] pre-compact-snapshot: ${err.message}\n`);
  }

  process.exit(0);
});
