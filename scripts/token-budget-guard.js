#!/usr/bin/env node
// BroziCode Token Budget Guard (UserPromptSubmit)
//
// Reads the REAL context size from the transcript: the last main-thread
// assistant message's usage (input + cache read + cache write) is exactly the
// prompt size of that request. The old estimate summed tool-output sizes across
// the session, counted subagent output that never entered this context, and
// reported ~85k in a session whose context was a fraction of that.
//
// Budget is configurable via BROZICODE_TOKEN_BUDGET (default 150k) because the
// hook payload doesn't carry the model's window size. Each threshold is
// announced once, and the warnings re-arm after the context shrinks (/compact).

import fs from 'fs';
import os from 'os';
import path from 'path';

const BUDGET = Number(process.env.BROZICODE_TOKEN_BUDGET) || 150_000;
const THRESHOLDS = [
  { pct: 0.90, icon: '🚨', msg: '/compact soon to avoid losing working context.' },
  { pct: 0.70, icon: '🔴', msg: 'consider /compact before starting anything large.' },
  { pct: 0.50, icon: '⚠️ ', msg: 'consider /compact if the current task is done.' },
];
const TAIL_BYTES = 512 * 1024;

export function contextTokens(transcriptPath) {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len  = Math.min(size, TAIL_BYTES);
    const buf  = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; } // also skips a cut first line
      const u = e?.message?.usage;
      if (e?.type !== 'assistant' || e.isSidechain || !u) continue;
      return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
  } finally {
    fs.closeSync(fd);
  }
  return 0;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { process.exit(0); }

  let used = 0;
  try { used = contextTokens(event.transcript_path); } catch { process.exit(0); }
  if (!used) process.exit(0);

  const stateFile = path.join(os.tmpdir(), `brozicode-budget-${event.session_id || 'default'}.json`);
  let warned = 0;
  try { warned = JSON.parse(fs.readFileSync(stateFile, 'utf8')).warned || 0; } catch {}

  const ratio = used / BUDGET;
  const hit   = THRESHOLDS.find(t => ratio >= t.pct);
  const next  = hit ? hit.pct : 0;
  if (next !== warned && (next > warned || ratio < warned - 0.2)) {
    try { fs.writeFileSync(stateFile, JSON.stringify({ warned: next })); } catch {}
  }
  if (!hit || hit.pct <= warned) process.exit(0);

  process.stdout.write(
    `\n${hit.icon} BROZICODE: context is ~${Math.round(used / 1000)}k tokens ` +
    `(${Math.round(ratio * 100)}% of the ${Math.round(BUDGET / 1000)}k budget; set BROZICODE_TOKEN_BUDGET to change) — ${hit.msg}\n`,
  );
  process.exit(0);
});
