#!/usr/bin/env node
// BroziCode Savings Report
// Finds the most recent session savings file and prints a full report.
// Called by the brozicode:savings skill.

import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = os.tmpdir();

// Find all brozicode session files
const sessionFiles = fs.readdirSync(tmpDir)
  .filter(f => f.startsWith('brozicode-session-') && f.endsWith('.json'))
  .map(f => {
    const fp = path.join(tmpDir, f);
    try {
      const stat = fs.statSync(fp);
      return { fp, mtime: stat.mtimeMs };
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => b.mtime - a.mtime); // most recent first

if (sessionFiles.length === 0) {
  process.stdout.write('No BroziCode session data found. Start a session and use brozi_batch_edit or brozi_smart_search first.\n');
  process.exit(0);
}

const { fp, mtime } = sessionFiles[0];

let savings;
try {
  savings = JSON.parse(fs.readFileSync(fp, 'utf8'));
} catch {
  process.stdout.write('Could not read session savings file.\n');
  process.exit(1);
}

const {
  batchEditCalls   = 0,
  smartSearchCalls = 0,
  savedRoundtrips  = 0,
  tokensEstimated  = 0,
  nativeFallbacks  = 0,
  sessionStart     = mtime,
} = savings;

const totalMacroCalls = batchEditCalls + smartSearchCalls;
const elapsed         = mtime - sessionStart;
const elapsedMin      = Math.floor(elapsed / 60_000);
const elapsedSec      = Math.floor((elapsed % 60_000) / 1000);
const dollarEst       = (tokensEstimated / 1_000_000 * 3.0).toFixed(2);
const compliancePct   = totalMacroCalls + nativeFallbacks > 0
  ? Math.round((totalMacroCalls / (totalMacroCalls + nativeFallbacks)) * 100)
  : 100;

function bar(value, max, width = 20) {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const divider = '─'.repeat(52);

let out = '';
out += `\n brozicode · session savings report\n`;
out += ` ${divider}\n`;
out += `  Duration       ${elapsedMin}m ${elapsedSec}s\n`;
out += ` ${divider}\n`;
out += `  Macro calls\n`;
out += `    batch-edit   ${batchEditCalls}×   (~${(batchEditCalls * 5)} roundtrips saved, ~${(batchEditCalls * 10).toFixed(0)}k tokens)\n`;
out += `    smart-search ${smartSearchCalls}×   (~${smartSearchCalls} roundtrips saved, ~${(smartSearchCalls * 1.8).toFixed(1)}k tokens)\n`;
out += ` ${divider}\n`;
out += `  Saved\n`;
out += `    Roundtrips   ${savedRoundtrips}   ${bar(savedRoundtrips, savedRoundtrips + nativeFallbacks)}\n`;
out += `    Tokens       ~${tokensEstimated >= 1000 ? (tokensEstimated / 1000).toFixed(1) + 'k' : tokensEstimated}\n`;
out += `    Est. cost    ~$${dollarEst}\n`;
out += ` ${divider}\n`;
out += `  Compliance\n`;
out += `    Macro tools  ${totalMacroCalls} call${totalMacroCalls !== 1 ? 's' : ''}\n`;
out += `    Native falls ${nativeFallbacks} (${compliancePct}% macro compliance)  ${bar(totalMacroCalls, totalMacroCalls + nativeFallbacks)}\n`;
out += ` ${divider}\n`;

process.stdout.write(out);
