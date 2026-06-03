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

    // Measure what ACTUALLY entered context: the byte size of the tool response.
    // (~4 bytes/token heuristic.) This replaces the previous hardcoded fictional
    // numbers so the budget guard and savings report reflect real consumption.
    const rawResp   = event?.tool_response ?? event?.tool_result ?? event?.output ?? event?.result;
    const respBytes = rawResp == null ? 0
      : (typeof rawResp === 'string' ? rawResp.length : JSON.stringify(rawResp).length);
    const respTokens = Math.ceil(respBytes / 4);

    if (toolName.includes('brozi_batch_edit')) {
      savings.batchEditCalls  += 1;
      savings.savedRoundtrips += 5; // replaces ~6 Read→Edit→Verify micro-calls
      savings.tokensConsumed   = (savings.tokensConsumed || 0) + respTokens;
    } else if (toolName.includes('brozi_smart_search')) {
      savings.smartSearchCalls += 1;
      savings.savedRoundtrips  += 1;
      savings.tokensConsumed    = (savings.tokensConsumed || 0) + respTokens;
      // Track glob patterns for pre-compact snapshot (Read is blocked, so this is our only signal)
      const patterns = event?.tool_input?.file_glob_patterns;
      if (Array.isArray(patterns)) {
        if (!savings.recentPatterns) savings.recentPatterns = [];
        savings.recentPatterns.push(...patterns.slice(0, 3));
        if (savings.recentPatterns.length > 20) savings.recentPatterns = savings.recentPatterns.slice(-20);
      }
    } else if (toolName.includes('brozi_run')) {
      savings.runCalls         = (savings.runCalls || 0) + 1;
      savings.savedRoundtrips += 1;
      savings.tokensConsumed    = (savings.tokensConsumed || 0) + respTokens;
    } else if (NATIVE_FALLBACK_TOOLS.has(toolName)) {
      // Agent used a native tool despite brozi hooks — track compliance
      savings.nativeFallbacks  = (savings.nativeFallbacks || 0) + 1;
      savings.tokensConsumed    = (savings.tokensConsumed || 0) + respTokens;
    } else if (!toolName && event?.prompt) {
      // UserPromptSubmit — count user message overhead from real prompt length
      savings.tokensConsumed   = (savings.tokensConsumed || 0) + Math.ceil((event.prompt.length || 0) / 4);
    } else if (respTokens > 0) {
      // Any other tool whose output enters the context window
      savings.tokensConsumed   = (savings.tokensConsumed || 0) + respTokens;
    }

    // Savings is a clearly-labeled HEURISTIC (not measured): each avoided roundtrip
    // saves ~1,800 tokens of tool-call + redundant re-read overhead on average.
    savings.tokensEstimated = savings.savedRoundtrips * 1_800;

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
      let line = `\n brozicode · ~${dollarEst} est. saved · ~${(tokens / 1000).toFixed(1)}k tokens (est.) · ${consumedK}k consumed (measured) · ${roundtrips} roundtrips`;
      line    += `  [${toolSummary || 'no brozi tool calls'}]`;
      if (fallbacks > 0) line += `  ⚠ ${fallbacks} native fallback${fallbacks !== 1 ? 's' : ''} (${compliance}% compliance)`;
      process.stdout.write(line + '\n\n');
    }
    process.exit(0);
  }

  process.exit(0);
});
