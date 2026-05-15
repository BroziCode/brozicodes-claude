import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── ANSI stripping ───────────────────────────────────────────────────────────

const ANSI_RE = /\x1B\[[0-9;]*[mGKHFJK]/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

// ─── Error/warning line detection ─────────────────────────────────────────────

const ERROR_RE = /error\s*TS\d+|^\s*(Error|TypeError|SyntaxError|ReferenceError|Warning):|FAIL\s|✗|✕|\bfailed\b|\bERROR\b/i;

function isErrorLine(line) {
  return ERROR_RE.test(line);
}

// ─── Output compressor ────────────────────────────────────────────────────────

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

async function handler({ command, keep_errors, max_lines, strip_ansi }) {
  const startMs = Date.now();

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd:       process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      shell:     true,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      timeout:   60_000,
    });

    let combined = '';
    if (stdout) combined += stdout;
    if (stderr) combined += (combined ? '\n' : '') + stderr;

    if (strip_ansi) combined = stripAnsi(combined);
    combined = compressOutput(combined.trimEnd(), max_lines, keep_errors);

    const elapsed = Date.now() - startMs;
    return {
      content: [{ type: 'text', text: `$ ${command}  [${elapsed}ms]\n${combined || '(no output)'}` }],
    };
  } catch (err) {
    let out = (err.stdout || '') + (err.stdout && err.stderr ? '\n' : '') + (err.stderr || err.message || String(err));
    if (strip_ansi) out = stripAnsi(out);
    out = compressOutput(out.trimEnd(), max_lines, keep_errors);

    const elapsed = Date.now() - startMs;
    return {
      content: [{ type: 'text', text: `$ ${command}  [${elapsed}ms, exit ${err.code ?? 1}]\n${out || '(no output)'}` }],
    };
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerRun(server) {
  server.tool(
    'brozi_run',
    `Run a shell command and return compressed, ANSI-stripped output. Replaces Bash
when you only need a clean summary — not full verbose output.

Params:
  command      – shell command to run (runs in CLAUDE_PROJECT_DIR)
  keep_errors  – preserve error/warning lines even when truncating (default: true)
  max_lines    – maximum output lines to return (default: 50)
  strip_ansi   – remove ANSI color escape codes (default: true)

Typical savings: npm test output 800 lines → 50 lines with all failures preserved.`,
    {
      command:     z.string().describe('Shell command to execute.'),
      keep_errors: z.boolean().default(true).describe('Keep error/warning lines when truncating.'),
      max_lines:   z.number().int().min(1).default(50).describe('Max output lines to return.'),
      strip_ansi:  z.boolean().default(true).describe('Strip ANSI escape codes from output.'),
    },
    handler,
  );
}
