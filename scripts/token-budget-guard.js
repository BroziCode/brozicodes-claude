#!/usr/bin/env node
// BroziCode Token Budget Guard
// Called by UserPromptSubmit hook — estimates context consumption and warns at thresholds.
// Thresholds: 50% warn, 70% recommend compact, 90% urgent compact.

import fs from 'fs';
import os from 'os';
import path from 'path';

// Configurable via BROZICODE_TOKEN_BUDGET env var; defaults to 150k (a reasonable
// warn threshold under a 200k context window). tokensConsumed is now measured from
// real tool-response sizes, so these thresholds reflect actual context fill.
// NOTE: this is a heuristic against a FIXED budget, not a real context-window
// reading — the hook payload doesn't carry one. On a large-context model the
// default fires while most of the window is still free, and nagging someone into
// /compact costs them context for nothing. Hence: conservative default, wording
// that admits it's an estimate, and each threshold announced at most once.
const SESSION_BUDGET = Number(process.env.BROZICODE_TOKEN_BUDGET) || 150_000; // tokens

const THRESHOLDS = [
  { pct: 0.90, icon: '🚨', msg: '/compact soon to avoid losing working context.' },
  { pct: 0.70, icon: '🔴', msg: 'consider /compact before starting anything large.' },
  { pct: 0.50, icon: '⚠️ ', msg: 'consider /compact if the current task is done.' },
];

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch {}

  const sessionId = event.session_id || 'default';
  const sessFile  = path.join(os.tmpdir(), `brozicode-session-${sessionId}.json`);

  let sessData = {};
  try {
    sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  } catch {
    process.exit(0); // No session file yet — first prompt, skip
  }

  const consumed = sessData.tokensConsumed || 0;
  if (consumed === 0) { process.exit(0); }

  const ratio = consumed / SESSION_BUDGET;

  for (const { pct, icon, msg } of THRESHOLDS) {
    if (ratio >= pct) {
      // Announce each threshold once. Re-warning on every prompt trains the user
      // to ignore it, and costs tokens to do so.
      if ((sessData.warnedThreshold || 0) >= pct) break;
      try {
        sessData.warnedThreshold = pct;
        const tmp = sessFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(sessData), 'utf8');
        fs.renameSync(tmp, sessFile);
      } catch { /* best effort */ }

      const usedK   = Math.round(consumed / 1000);
      const budgetK = Math.round(SESSION_BUDGET / 1000);
      process.stdout.write(
        `\n${icon} BROZICODE: ~${usedK}k tokens of tool output this session ` +
        `(heuristic budget ${budgetK}k, set BROZICODE_TOKEN_BUDGET to change) — ${msg}\n`
      );
      break; // Only show highest threshold
    }
  }

  process.exit(0);
});
