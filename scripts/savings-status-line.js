#!/usr/bin/env node
// BroziCode Savings Status Line
// Receives Claude Code session JSON via stdin (event-driven, non-blocking)
// Reads BroziCode savings from temp file
// Prints one line to stdout → appears in Claude Code status bar

import fs from 'fs';
import os from 'os';
import path from 'path';

let stdinData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdinData += chunk; });
process.stdin.on('end', () => {
  if (!stdinData.trim()) process.exit(0);

  let session;
  try {
    session = JSON.parse(stdinData);
  } catch {
    process.exit(0);
  }

  const sessionId    = session.session_id || 'default';
  const SAVINGS_FILE = path.join(os.tmpdir(), `brozicode-session-${sessionId}.json`);

  // Load BroziCode savings for this session
  let savings = {
    savedRoundtrips: 0,
    tokensEstimated: 0,
    batchEditCalls:  0,
    smartSearchCalls: 0,
    sessionStart:    Date.now(),
  };

  try {
    const raw = fs.readFileSync(SAVINGS_FILE, 'utf8');
    savings = { ...savings, ...JSON.parse(raw) };
  } catch {
    // No savings file yet — session just started or no BroziCode tools called
  }

  // Only show the bar if BroziCode has actually done something
  if (savings.savedRoundtrips === 0 && savings.tokensEstimated === 0) {
    process.stdout.write(' brozicode · waiting for first macro-tool call...\n');
    process.exit(0);
  }

  // Dollar savings: derived from actual session cost-per-turn × roundtrips saved
  const sessionCost   = session.cost_usd || 0;
  const sessionTurns  = session.turns || 1;
  const costPerTurn   = sessionTurns > 0 ? sessionCost / sessionTurns : 0;
  const dollarsSaved  = (costPerTurn * savings.savedRoundtrips).toFixed(2);

  function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
    return `${n}`;
  }

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min      = Math.floor(totalSec / 60);
    if (min > 0) return `${min}min`;
    return `${totalSec % 60}s`;
  }

  const elapsed         = Date.now() - savings.sessionStart;
  const tokenDisplay    = formatTokens(savings.tokensEstimated);
  const durationDisplay = formatDuration(elapsed);

  const parts = [
    `💸 est. savings: $${dollarsSaved}`,
    `${tokenDisplay} tokens`,
    durationDisplay,
    `${savings.savedRoundtrips} roundtrips saved`,
  ];

  const toolParts = [];
  if (savings.batchEditCalls  > 0) toolParts.push(`${savings.batchEditCalls}× batch-edit`);
  if (savings.smartSearchCalls > 0) toolParts.push(`${savings.smartSearchCalls}× smart-search`);

  let line = ` brozicode · ${parts.join(' · ')}`;
  if (toolParts.length > 0) line += `  [${toolParts.join(', ')}]`;

  process.stdout.write(line + '\n');
  process.exit(0);
});
