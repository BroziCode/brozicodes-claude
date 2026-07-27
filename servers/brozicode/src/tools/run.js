import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── ANSI stripping ───────────────────────────────────────────────────────────

// Full CSI (incl. private-mode params like \x1B[?25l), OSC (window titles),
// and single-char escapes. The old pattern only handled a handful of CSI final
// bytes, so progress bars and spinners still came through as garbage.
const ANSI_RE = /[\x1B\x9B](?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

// ─── Error/warning line detection ─────────────────────────────────────────────

const ERROR_RE = /error\s*TS\d+|^\s*(Error|TypeError|SyntaxError|ReferenceError|Warning):|FAIL\s|✗|✕|\bfailed\b|\bERROR\b/i;

function isErrorLine(line) {
  return ERROR_RE.test(line);
}

// ─── Process-level output store ───────────────────────────────────────────────
// Outputs >100 lines are intercepted here — never bloat context.
// Model queries stored output with: brozi_run({ command, query: "pattern" })

const outputStore = new Map(); // cmdKey → { command, lines, storedAt }
const OUTPUT_STORE_MAX       = 50;
const STORE_THRESHOLD        = 100;               // lines
const STORE_MAX_LINES        = 50_000;            // per command
const STORE_MAX_TOTAL_BYTES  = 32 * 1024 * 1024;  // across the whole store
let   storeBytes             = 0;

function cmdKey(cmd) {
  let h = 0;
  for (let i = 0; i < cmd.length; i++) h = ((h << 5) - h + cmd.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function sizeOf(lines) {
  let n = 0;
  for (const l of lines) n += l.length + 1;
  return n;
}

function storeOutput(key, command, lines) {
  // A single maxBuffer-sized run can be millions of lines; 50 of those pinned
  // in a long-lived process is hundreds of MB. Cap per-entry and in aggregate.
  let kept = lines;
  if (lines.length > STORE_MAX_LINES) {
    const head = lines.slice(0, STORE_MAX_LINES - 1000);
    const tail = lines.slice(-1000);
    kept = [...head, `  … [${lines.length - STORE_MAX_LINES} lines dropped from the middle of the stored output]`, ...tail];
  }

  const prev = outputStore.get(key);
  if (prev) { storeBytes -= sizeOf(prev.lines); outputStore.delete(key); }

  outputStore.set(key, { command, lines: kept, storedAt: Date.now() });
  storeBytes += sizeOf(kept);

  // Insertion order == recency, because every set() is preceded by a delete().
  while (outputStore.size > OUTPUT_STORE_MAX || storeBytes > STORE_MAX_TOTAL_BYTES) {
    const oldest = outputStore.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    storeBytes -= sizeOf(outputStore.get(oldest).lines);
    outputStore.delete(oldest);
  }
}

// ─── Output compressor (for small outputs) ────────────────────────────────────

function compressOutput(text, maxLines, keepErrors) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;

  const head   = lines.slice(0, maxLines);
  const tail   = lines.slice(maxLines);
  let   result = head.join('\n');
  result      += `\n  … [${tail.length} line${tail.length !== 1 ? 's' : ''} omitted]`;

  if (keepErrors) {
    const errs = tail.filter(isErrorLine);
    if (errs.length > 0) {
      result += '\n  … [errors from omitted section:]\n' + errs.join('\n');
    }
  }

  return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler({ command, keep_errors, max_lines, strip_ansi, query, timeout_ms }) {
  const startMs = Date.now();
  const key     = cmdKey(command);

  // ── Query mode: search previously stored output ───────────────────────────
  if (query !== undefined && query !== '') {
    const stored = outputStore.get(key);
    if (!stored) {
      return {
        content: [{
          type: 'text',
          text: `No stored output for: ${command}\nRun brozi_run({ command: "..." }) first to capture output, then query it.`,
        }],
      };
    }

    let re;
    try { re = new RegExp(query, 'gi'); } catch {
      return { content: [{ type: 'text', text: `Invalid regex: ${query}` }] };
    }

    const { lines } = stored;
    const matchIdxs = lines.reduce((acc, line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) acc.push(i);
      return acc;
    }, []);

    if (matchIdxs.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No matches for "${query}" in stored output (${lines.length} lines from: ${command}).`,
        }],
      };
    }

    // Emit matches with ±2 context lines
    const shown = new Set();
    const out   = [];
    for (const i of matchIdxs) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
        if (!shown.has(j)) {
          shown.add(j);
          out.push(`${String(j + 1).padStart(4)}: ${lines[j]}`);
        }
      }
      out.push('  ───');
    }
    if (out[out.length - 1] === '  ───') out.pop();

    return {
      content: [{
        type: 'text',
        text: `$ ${command}  [stored, ${matchIdxs.length} match${matchIdxs.length !== 1 ? 'es' : ''} for "${query}"]\n` +
              out.join('\n'),
      }],
    };
  }

  // ── Execute command ───────────────────────────────────────────────────────
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd:       process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      shell:     true,
      maxBuffer: 10 * 1024 * 1024,
      // Was a hard 60s. Real test/build suites run longer, and every timeout
      // looked like a failure — which taught the caller to prefer native Bash.
      timeout:   timeout_ms,
    });

    let combined = '';
    if (stdout) combined += stdout;
    if (stderr) combined += (combined ? '\n' : '') + stderr;
    if (strip_ansi) combined = stripAnsi(combined);

    const allLines = combined.trimEnd().split('\n');
    const elapsed  = Date.now() - startMs;

    if (allLines.length > STORE_THRESHOLD) {
      // Intercept: full output stored in memory, not injected into context
      storeOutput(key, command, allLines);
      const errorLines = allLines.filter(isErrorLine).slice(0, 20);

      let summary  = `$ ${command}  [${elapsed}ms — ${allLines.length} lines intercepted, not in context]\n`;
      summary     += allLines.slice(0, 30).join('\n');
      if (allLines.length > 30) {
        summary += `\n  … [${allLines.length - 30} lines stored — query with brozi_run({ command, query: "pattern" })]`;
      }
      if (errorLines.length > 0) {
        summary += `\n\n  ── Errors/warnings (${errorLines.length}) ──\n` + errorLines.join('\n');
      }
      summary += `\n\n  ── Query stored output ──`;
      summary += `\n  brozi_run({ command: "${command.slice(0, 60)}", query: "your pattern" })`;

      return { content: [{ type: 'text', text: summary }] };
    }

    const text    = compressOutput(combined.trimEnd(), max_lines, keep_errors);
    return {
      content: [{ type: 'text', text: `$ ${command}  [${elapsed}ms]\n${text || '(no output)'}` }],
    };

  } catch (err) {
    let out = (err.stdout || '') + (err.stdout && err.stderr ? '\n' : '') + (err.stderr || err.message || String(err));
    if (strip_ansi) out = stripAnsi(out);

    const allLines = out.trimEnd().split('\n');
    if (allLines.length > STORE_THRESHOLD) storeOutput(key, command, allLines);

    const text    = compressOutput(out.trimEnd(), max_lines, keep_errors);
    const elapsed = Date.now() - startMs;
    // A timeout kill reports no exit code; calling it "exit 1" hid the real cause.
    const status  = err.killed || err.signal
      ? `timed out after ${timeout_ms}ms (killed${err.signal ? ` — ${err.signal}` : ''}) — raise timeout_ms if the command legitimately runs longer`
      : `exit ${err.code ?? 1}`;
    return {
      content: [{ type: 'text', text: `$ ${command}  [${elapsed}ms, ${status}]\n${text || '(no output)'}` }],
    };
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerRun(server) {
  server.tool(
    'brozi_run',
    `Run a shell command. Outputs >100 lines are intercepted into a process-level store
(never injected into context). Returns first 30 lines + all error lines + a query hint.
Query the stored output with the query param to fetch only relevant sections.

Params:
  command      – shell command (runs in CLAUDE_PROJECT_DIR)
  query        – regex to search stored output for this command (run without query first)
  keep_errors  – preserve error/warning lines when truncating small outputs (default: true)
  max_lines    – max lines to return for small outputs <100 lines (default: 50)
  strip_ansi   – remove ANSI escape codes (default: true)
  timeout_ms   – kill after N ms (default 120000, max 600000) — raise for long builds

Two-step pattern for large outputs:
  1. brozi_run({ command: "npm test" })                     ← captures, returns summary
  2. brozi_run({ command: "npm test", query: "FAIL|Error" }) ← searches captured output`,
    {
      command:     z.string().describe('Shell command to execute.'),
      query:       z.string().optional().describe('Regex to search stored output for this command. Run without query first to capture.'),
      keep_errors: z.boolean().default(true).describe('Keep error/warning lines when truncating small outputs.'),
      max_lines:   z.number().int().min(1).default(50).describe('Max output lines for outputs under threshold.'),
      strip_ansi:  z.boolean().default(true).describe('Strip ANSI escape codes from output.'),
      timeout_ms:  z.number().int().min(1000).max(600_000).default(120_000)
        .describe('Kill the command after this many ms (default 120000, max 600000). Raise it for long builds/test suites.'),
    },
    handler,
  );
}
