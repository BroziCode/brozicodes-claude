#!/usr/bin/env node
// BroziCode Session Tracker
// Reads tool usage from STDIN (Claude Code passes hook context as JSON)
// Writes cumulative session stats to a temp file
// Displays the savings bar on Stop

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATS_FILE = path.join(os.tmpdir(), 'brozicode-session.json');
const command = process.argv[2]; // 'track' or 'display'

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch {
    return { toolCalls: 0, batchCalls: 0, tokensEstimated: 0, savedRoundtrips: 0, sessionStart: Date.now() };
  }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
}

function formatDuration(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return min > 0 ? `${min}min` : `${sec}s`;
}

if (command === 'track') {
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(input);
      const stats = loadStats();
      stats.toolCalls += 1;

      const toolName = event?.tool_name || '';
      if (toolName.includes('brozi_batch_edit')) {
        stats.savedRoundtrips += 5;
        stats.batchCalls += 1;
      }
      if (toolName.includes('brozi_smart_search')) {
        stats.tokensEstimated += 1800;
        stats.savedRoundtrips += 1;
      }
      if (toolName.includes('brozi_map_dependencies')) {
        stats.savedRoundtrips += 2;
        stats.tokensEstimated += 500;
      }

      saveStats(stats);
    } catch { /* ignore parse errors */ }
  });
}

if (command === 'display') {
  const stats = loadStats();
  const elapsed = Date.now() - stats.sessionStart;

  const tokensSaved = stats.tokensEstimated + (stats.savedRoundtrips * 1200);
  const dollarsSaved = ((tokensSaved / 1_000_000) * 3).toFixed(2);
  const tokenDisplay = tokensSaved > 1000
    ? `${(tokensSaved / 1000).toFixed(1)}k tokens`
    : `${tokensSaved} tokens`;

  if (stats.savedRoundtrips > 0) {
    console.log(
      `\n ─────────────────────────────────────── brozicodes-claude ──\n` +
      ` ❯\n` +
      ` ─────────────────────────────────────────────────────────────\n` +
      `   💸 session savings: $${dollarsSaved} · ${tokenDisplay} · ${formatDuration(elapsed)} · ${stats.savedRoundtrips} roundtrips saved\n`
    );
  }

  try { fs.unlinkSync(STATS_FILE); } catch {}
}
