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
const SESSION_BUDGET = Number(process.env.BROZICODE_TOKEN_BUDGET) || 150_000; // tokens

const THRESHOLDS = [
  { pct: 0.90, icon: '🚨', msg: '~90% context used. Run /compact NOW to preserve work.' },
  { pct: 0.70, icon: '🔴', msg: '~70% context used. Recommend /compact before continuing.' },
  { pct: 0.50, icon: '⚠️ ', msg: '~50% context used. Consider /compact if current task is done.' },
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
      const usedK   = Math.round(consumed / 1000);
      const budgetK = Math.round(SESSION_BUDGET / 1000);
      process.stdout.write(`\n${icon} BROZICODE: ${usedK}k/${budgetK}k tokens — ${msg}\n`);
      break; // Only show highest threshold
    }
  }

  process.exit(0);
});
