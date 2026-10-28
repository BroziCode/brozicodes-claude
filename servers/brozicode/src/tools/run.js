import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { stripAnsi, filterOutput, digest, capChars } from '../lib/compress.js';

const execAsync = promisify(exec);

// ─── Process-level output store ───────────────────────────────────────────────
// Outputs over max_lines are digested; the full (noise-filtered) lines are kept
// here so the model can query them: brozi_run({ command, query: "pattern" })

const outputStore = new Map(); // cmdKey → { command, lines, storedAt }
const OUTPUT_STORE_MAX       = 50;
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

// ─── Handler ──────────────────────────────────────────────────────────────────

const textResult = text => ({ content: [{ type: 'text', text: capChars(text) }] });

async function handler({ command, focus, keep_errors, max_lines, strip_ansi, query, timeout_ms }) {
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

    return textResult(
      `$ ${command}  [stored, ${matchIdxs.length} match${matchIdxs.length !== 1 ? 'es' : ''} for "${query}"]\n` +
      out.join('\n'),
    );
  }

  // ── Execute command ───────────────────────────────────────────────────────
  let raw, status = '';
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd:       process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      shell:     true,
      maxBuffer: 10 * 1024 * 1024,
      // Was a hard 60s. Real test/build suites run longer, and every timeout
      // looked like a failure — which taught the caller to prefer native Bash.
      timeout:   timeout_ms,
    });
    raw = (stdout || '') + (stdout && stderr ? '\n' : '') + (stderr || '');
  } catch (err) {
    raw = (err.stdout || '') + (err.stdout && err.stderr ? '\n' : '') + (err.stderr || err.message || String(err));
    // A timeout kill reports no exit code; calling it "exit 1" hid the real cause.
    status = err.killed || err.signal
      ? `timed out after ${timeout_ms}ms (killed${err.signal ? ` — ${err.signal}` : ''}) — raise timeout_ms if the command legitimately runs longer`
      : `exit ${err.code ?? 1}`;
  }

  if (strip_ansi) raw = stripAnsi(raw);
  const elapsed = Date.now() - startMs;
  const tag     = status ? `${elapsed}ms, ${status}` : `${elapsed}ms`;
  const lines   = filterOutput(command, raw.trimEnd());

  if (lines.length <= max_lines) {
    return textResult(`$ ${command}  [${tag}]\n${lines.join('\n') || '(no output)'}`);
  }

  // ponytail: stores the noise-filtered lines, so a query can't find dropped
  // passing-test/progress lines; store the raw text too if anyone needs that.
  storeOutput(key, command, lines);
  const d = digest(lines, { focus, errors: keep_errors });
  return textResult(
    `$ ${command}  [${tag} — ${lines.length} lines; showing ${d.errors} error(s)` +
    `${focus ? `, ${d.focusHits} focus hit(s)` : ''}, head + tail; rest stored]\n` +
    `${d.text}\n  ── more: brozi_run({ command: <same>, query: "regex" })`,
  );
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerRun(server) {
  return server.tool(
    'brozi_run',
    `Run a shell command (cwd = project root). Output is ANSI-stripped and noise-filtered per command
(passing tests, install/progress spam, repeated lines). Up to max_lines it is returned whole; beyond
that you get every error line, every focus match, head and tail in one ordered view, and the full
output is stored — fetch more with brozi_run({ command: <same>, query: "regex" }) (does not re-run).
Pass focus: "keywords" to guarantee the lines you care about are shown.`,
    {
      command:     z.string().describe('Shell command to execute.'),
      focus:       z.string().optional().describe('Keywords (space-separated) whose lines must be shown when output is digested.'),
      query:       z.string().optional().describe('Regex to search stored output for this command. Run without query first to capture.'),
      keep_errors: z.boolean().default(true).describe('Show error/warning lines when output is digested.'),
      max_lines:   z.number().int().min(1).default(50).describe('Return output whole up to this many lines; digest beyond it.'),
      strip_ansi:  z.boolean().default(true).describe('Strip ANSI escape codes from output.'),
      timeout_ms:  z.number().int().min(1000).max(600_000).default(120_000)
        .describe('Kill the command after this many ms (default 120000, max 600000). Raise it for long builds/test suites.'),
    },
    handler,
  );
}
