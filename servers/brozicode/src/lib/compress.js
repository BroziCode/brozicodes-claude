// Shared output compression. Used by brozi_run (MCP server) and by the native
// Bash PostToolUse hook (via the hooklib.js bundle), so both paths shrink output
// the same way.

// Full CSI (incl. private-mode params like \x1B[?25l), OSC (window titles),
// and single-char escapes.
const ANSI_RE = /[\x1B\x9B](?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;
export const stripAnsi = s => s.replace(ANSI_RE, '');

const ERROR_RE = /error\s*TS\d+|^\s*(Error|TypeError|SyntaxError|ReferenceError|Warning):|FAIL\s|✗|✕|\bfailed\b|\bERROR\b|npm ERR!|Traceback \(most recent|panicked at/i;
export const isErrorLine = l => ERROR_RE.test(l);

// Per-command noise: lines that carry no signal for that kind of command.
// Error lines are never dropped, whatever a pattern says.
const NOISE = [
  { // package managers
    cmd:  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update)\b|\bpip3?\s+install\b/,
    drop: /^npm (WARN|notice)|\bdeprecated\b|^(Collecting|Downloading|Using cached|Requirement already satisfied|Installing collected)|^Progress:|^Packages:|^\s*[+]{3,}\s*$/,
  },
  { // test runners: passing lines (failures + summaries are what matter)
    cmd:  /\b(test|jest|vitest|mocha|pytest|go test|cargo test|node --test)\b/,
    drop: /^\s*(✓|✔|√|PASS\b|ok \d+ |--- PASS|=== RUN)|\bPASSED\b|^test .* \.\.\. ok$/,
  },
  { // git network progress
    cmd:  /\bgit\s+(push|pull|fetch|clone)\b/,
    drop: /^(remote: )?(Enumerating|Counting|Compressing|Writing|Receiving|Resolving|Total|Delta compression)\b/,
  },
  { // build download/compile chatter
    cmd:  /\b(docker\s+build|cargo\s+build|gradle|mvn)\b/,
    drop: /^\s*(Compiling |Downloaded |Downloading |\[INFO\] Download)/,
  },
];

/** ANSI-free text → noise-filtered lines. Keeps only the final frame of
 *  \r-redrawn progress lines and collapses runs of identical lines. */
export function filterOutput(command, text) {
  const drops = NOISE.filter(n => n.cmd.test(command || '')).map(n => n.drop);
  const out = [];
  let prev = null, rep = 0;
  const flush = () => { if (rep > 1 && prev.trim()) out[out.length - 1] += `  (×${rep})`; };
  for (let l of text.split('\n')) {
    const cr = l.replace(/\r$/, '').lastIndexOf('\r');
    if (cr >= 0) l = l.slice(cr + 1);
    l = l.replace(/\r$/, '');
    if (drops.length && drops.some(d => d.test(l)) && !isErrorLine(l)) continue;
    if (l === prev) { rep++; continue; }
    flush();
    prev = l; rep = 1;
    out.push(l);
  }
  flush();
  return out;
}

/** Keywords → case-insensitive alternation regex (null when empty). */
export function focusRegex(focus, flags = 'i') {
  const words = String(focus || '').split(/[\s,|]+/).filter(w => w.length > 1)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return words.length ? new RegExp(words.join('|'), flags) : null;
}

/**
 * One ordered view of a long output: head, tail, every error line (±1) and
 * every focus match (±2), with gaps marked. Agents almost never page back for
 * more of a truncated result, so the FIRST response has to carry the answer —
 * failures and the tail (where summaries and exit lines live), not just the head.
 */
export function digest(lines, { focus, errors = true, head = 8, tail = 25 } = {}) {
  const n = lines.length, keep = new Set();
  const add = (i, ctx) => { for (let j = Math.max(0, i - ctx); j <= Math.min(n - 1, i + ctx); j++) keep.add(j); };
  for (let i = 0; i < Math.min(head, n); i++) keep.add(i);
  for (let i = Math.max(0, n - tail); i < n; i++) keep.add(i);
  let errs = 0, hits = 0;
  if (errors) for (let i = 0; i < n && errs < 25; i++) if (isErrorLine(lines[i])) { add(i, 1); errs++; }
  const fre = focusRegex(focus);
  if (fre) for (let i = 0; i < n && hits < 20; i++) if (fre.test(lines[i])) { add(i, 2); hits++; }

  const idx = [...keep].sort((a, b) => a - b);
  const w = String(n).length, out = [];
  let last = -1;
  for (const i of idx) {
    if (i > last + 1) out.push(`  … [${i - last - 1} lines]`);
    const l = lines[i];
    out.push(`${String(i + 1).padStart(w)}: ${l.length > 400 ? l.slice(0, 400) + '…' : l}`);
    last = i;
  }
  return { text: out.join('\n'), shown: idx.length, errors: errs, focusHits: hits };
}

/** Keep MCP results under Claude Code's 50K-char inline limit — past it the
 *  result is spilled to a file the model must then go and read. */
export const MAX_RESULT_CHARS = 45_000;
export const capChars = s => s.length > MAX_RESULT_CHARS
  ? s.slice(0, MAX_RESULT_CHARS) + `\n  … [truncated at ${MAX_RESULT_CHARS} chars]`
  : s;
