#!/usr/bin/env node
// BroziCode Session Tracker Hook
// Called by PostToolUse and SessionStart hooks
// Writes savings estimates to a temp file keyed by session ID

import fs from 'fs';
import os from 'os';
import path from 'path';

const command = process.argv[2]; // 'track' | 'init' | 'stop'

// Read hook context from stdin
let input = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { /* ignore */ }

  const sessionId = event.session_id || 'default';
  const SAVINGS_FILE = path.join(os.tmpdir(), `brozicode-session-${sessionId}.json`);

  function loadSavings() {
    try {
      return JSON.parse(fs.readFileSync(SAVINGS_FILE, 'utf8'));
    } catch {
      return {
        savedRoundtrips: 0,
        tokensEstimated: 0,
        batchEditCalls: 0,
        smartSearchCalls: 0,
        sessionStart: Date.now(),
      };
    }
  }

  function saveSavings(data) {
    try {
      const tmp = SAVINGS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, SAVINGS_FILE); // atomic on POSIX — prevents lost updates under concurrent hook fires
    } catch { /* ignore write errors */ }
  }

  // Tools that indicate the agent fell back to native ops despite brozi hooks
  const NATIVE_FALLBACK_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'NotebookEdit']);

  if (command === 'init') {
    // Bump the session epoch so the long-lived MCP server drops its cross-session
    // stale-read ledger (otherwise it reports files as "in-context" that were never
    // shown in this conversation).
    try {
      const epochFile = path.join(os.tmpdir(), 'brozicode-session-epoch');
      fs.writeFileSync(epochFile, `${sessionId}:${Date.now()}`, 'utf8');
    } catch { /* ignore */ }

    // SessionStart — initialize fresh savings file
    saveSavings({
      savedRoundtrips: 0,
      tokensEstimated: 0,
      tokensConsumed: 0,
      batchEditCalls: 0,
      smartSearchCalls: 0,
      nativeFallbacks: 0,
      recentPatterns: [],
      sessionStart: Date.now(),
    });
    process.exit(0);
  }

  if (command === 'track') {
    const toolName = event?.tool_name || event?.tool?.name || '';
    const savings = loadSavings();

    if (toolName.includes('brozi_batch_edit')) {
      // Each batch_edit replaces ~6 micro-tool calls on average
      // Estimate: 2,000 tokens saved per avoided roundtrip × 5 avoided roundtrips
      savings.savedRoundtrips  += 5;
      savings.tokensEstimated  += 10_000;
      savings.tokensConsumed    = (savings.tokensConsumed || 0) + 3_000;
      savings.batchEditCalls   += 1;
    } else if (toolName.includes('brozi_smart_search')) {
      // Replaces a full file read — estimate 1,800 tokens saved per call
      // Plus avoids 1 follow-up roundtrip
      savings.savedRoundtrips  += 1;
      savings.tokensEstimated  += 1_800;
      savings.tokensConsumed    = (savings.tokensConsumed || 0) + 2_500;
      savings.smartSearchCalls += 1;
      // Track glob patterns for pre-compact snapshot (Read is blocked, so this is our only signal)
      const patterns = event?.tool_input?.file_glob_patterns;
      if (Array.isArray(patterns)) {
        if (!savings.recentPatterns) savings.recentPatterns = [];
        savings.recentPatterns.push(...patterns.slice(0, 3));
        if (savings.recentPatterns.length > 20) savings.recentPatterns = savings.recentPatterns.slice(-20);
      }
    } else if (toolName.includes('brozi_run')) {
      // Output interception — large outputs stored, not in context. Estimate 500 tokens consumed.
      savings.savedRoundtrips  += 1;
      savings.tokensEstimated  += 800;
      savings.tokensConsumed    = (savings.tokensConsumed || 0) + 500;
      savings.runCalls          = (savings.runCalls || 0) + 1;
    } else if (NATIVE_FALLBACK_TOOLS.has(toolName)) {
      // Agent used a native tool despite brozi hooks — track compliance
      savings.nativeFallbacks   = (savings.nativeFallbacks || 0) + 1;
      savings.tokensConsumed    = (savings.tokensConsumed || 0) + 1_500; // native tools are expensive
    } else if (!toolName && event?.prompt) {
      // UserPromptSubmit — count user message overhead
      savings.tokensConsumed = (savings.tokensConsumed || 0) + 300;
    }

    // Track recently accessed files (from Read tool — kept for compatibility even though blocked)
    if (toolName === 'Read') {
      const fp = event?.tool_input?.file_path || event?.tool_input?.path;
      if (fp) {
        if (!savings.recentFiles) savings.recentFiles = [];
        savings.recentFiles.push(fp);
        if (savings.recentFiles.length > 30) savings.recentFiles = savings.recentFiles.slice(-30);
      }
    }

    saveSavings(savings);
    process.exit(0);
  }

  if (command === 'stop') {
    // Session ending — print a final savings summary to stdout so it appears in the terminal
    const savings = loadSavings();
    const calls = savings.batchEditCalls + savings.smartSearchCalls;
    if (calls > 0) {
      const tokens     = savings.tokensEstimated;
      const roundtrips = savings.savedRoundtrips;
      const dollarEst  = (tokens / 1_000_000 * 3.0).toFixed(2); // rough Sonnet rate
      const fallbacks  = savings.nativeFallbacks || 0;
      const compliance = calls + fallbacks > 0
        ? Math.round((calls / (calls + fallbacks)) * 100)
        : 100;

      const runCalls    = savings.runCalls || 0;
      const toolSummary = [
        savings.batchEditCalls  > 0 && `${savings.batchEditCalls}× batch-edit`,
        savings.smartSearchCalls > 0 && `${savings.smartSearchCalls}× smart-search`,
        runCalls                > 0 && `${runCalls}× run`,
      ].filter(Boolean).join(', ');
      const consumed   = savings.tokensConsumed || 0;
      const consumedK  = (consumed / 1000).toFixed(1);
      let line = `\n brozicode · ~${dollarEst} saved · ${(tokens / 1000).toFixed(1)}k tokens saved · ${consumedK}k consumed · ${roundtrips} roundtrips`;
      line    += `  [${toolSummary || 'no brozi tool calls'}]`;
      if (fallbacks > 0) line += `  ⚠ ${fallbacks} native fallback${fallbacks !== 1 ? 's' : ''} (${compliance}% compliance)`;
      process.stdout.write(line + '\n\n');
    }
    process.exit(0);
  }

  process.exit(0);
});
