// BroziCode end-to-end token A/B harness — run with `npm run bench`.
//
// Measures CONTEXT-INJECTION TOKENS (the quantity the macro-tools actually
// control) for brozi-ON vs native-OFF across a realistic task corpus run against
// this repo's own source files. It does NOT drive a live model — it deterministically
// models what each strategy injects into the context window, which is the dominant,
// tool-controlled cost. Token counts are an approximation (~4 chars/token); the
// ON/OFF *ratio* is what's meaningful and is stable under that proxy.
//
// Also acts as a regression guard: if a core feature silently breaks (e.g. the P0
// skeletonizer), overall reduction collapses and this exits non-zero.

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSkeleton } from '../src/tools/smart-search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src/tools');

// ~4 chars/token proxy. Consistent across ON/OFF so the ratio is faithful.
const tok = s => Math.ceil((s || '').length / 4);
const skelText = r => (r ? r.sorted.map(l => `L${l.lineNum} ${l.text}`).join('\n') : '');

const read = async f => fs.readFile(path.join(SRC, f), 'utf8');
const FILES = ['smart-search.js', 'run.js', 'batch-edit.js'];
const OPTS  = { includeImports: true, includeTypes: true, includePrivate: false };

const tasks = [];
function task(name, off, on) {
  tasks.push({ name, off, on, saved: off - on, pct: off ? Math.round((1 - on / off) * 100) : 0 });
}

// ── T1: understand one large file ────────────────────────────────────────────
// OFF: native Read injects the whole file. ON: smart_search summary injects a skeleton.
{
  const c = await read('smart-search.js');
  task('understand 1 large file (738 LOC)', tok(c), tok(skelText(buildSkeleton(c, 'smart-search.js', OPTS))));
}

// ── T2: understand a whole module (3 files) ──────────────────────────────────
{
  let off = 0, on = 0;
  for (const f of FILES) {
    const c = await read(f);
    off += tok(c);
    on  += tok(skelText(buildSkeleton(c, f, OPTS)));
  }
  task('understand a 3-file module', off, on);
}

// ── T3: locate a symbol across the module ────────────────────────────────────
// OFF: grep emits matching lines, then the dev opens the 2 relevant files in full.
// ON: smart_search match-count (ranked) + one #N-M slice of the winning file.
{
  const contents = await Promise.all(FILES.map(read));
  const needle = 'register';
  let grepLines = '';
  contents.forEach((c, i) => {
    c.split('\n').forEach((l, n) => { if (l.includes(needle)) grepLines += `${FILES[i]}:${n + 1}:${l}\n`; });
  });
  const off = tok(grepLines) + tok(contents[0]) + tok(contents[2]); // open 2 files fully
  const counts = FILES.map((f, i) => `${f}:${contents[i].split(needle).length - 1}`).join('\n');
  const slice = contents[0].split('\n').slice(680, 738).join('\n'); // targeted region
  task('locate symbol across module', off, tok(counts) + tok(slice));
}

// ── T4: rename across 3 files (Read→Edit→Verify vs one batch) ─────────────────
// OFF: per file native flow = Read(full) + Edit echo + re-Read to verify ≈ 2×full.
// ON: a single batch_edit returns a ~4-line confirmation.
{
  const contents = await Promise.all(FILES.map(read));
  const off = contents.reduce((s, c) => s + 2 * tok(c) + 60, 0); // 60t edit-echo overhead/file
  const on  = tok('✓ Applied 3 edit(s) across 3 file(s)\n  a.js  1 edit(s)\n  b.js  1 edit(s)\n  c.js  1 edit(s)');
  task('rename across 3 files', off, on);
}

// ── T5: run a command with large output ──────────────────────────────────────
// OFF: Bash dumps the whole 500-line output. ON: brozi_run keeps 30 lines + errors + hint.
{
  const lines = Array.from({ length: 500 }, (_, i) => i === 240 ? `  Error: thing ${i} failed` : `  log line ${i} doing work here`);
  const full = lines.join('\n');
  const errs = lines.filter(l => /error/i.test(l));
  const on = lines.slice(0, 30).join('\n') + '\n  … [470 lines stored]\n' + errs.join('\n') + '\n  query hint';
  task('run cmd w/ 500-line output', tok(full), tok(on));
}

// ── Report ───────────────────────────────────────────────────────────────────
const totOff = tasks.reduce((s, t) => s + t.off, 0);
const totOn  = tasks.reduce((s, t) => s + t.on, 0);
const totPct = Math.round((1 - totOn / totOff) * 100);

const pad  = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
console.log('\nBroziCode end-to-end token A/B (context-injection tokens, ~4 chars/token proxy)\n');
console.log(`  ${pad('task', 32)} ${rpad('native', 9)} ${rpad('brozi', 8)} ${rpad('saved', 8)}  reduction`);
console.log('  ' + '─'.repeat(72));
for (const t of tasks) {
  console.log(`  ${pad(t.name, 32)} ${rpad(t.off + 't', 9)} ${rpad(t.on + 't', 8)} ${rpad(t.saved + 't', 8)}  -${t.pct}%`);
}
console.log('  ' + '─'.repeat(72));
console.log(`  ${pad('TOTAL', 32)} ${rpad(totOff + 't', 9)} ${rpad(totOn + 't', 8)} ${rpad((totOff - totOn) + 't', 8)}  -${totPct}%\n`);

// Regression guard tied to the headline claim. If a core feature silently breaks
// (e.g. skeletons regress to raw output), reduction collapses below this floor.
const FLOOR = 50;
if (totPct < FLOOR) {
  console.error(`✗ overall reduction ${totPct}% < ${FLOOR}% floor — a token-saving feature may have regressed.`);
  process.exit(1);
}
console.log(`✓ overall reduction ${totPct}% (≥ ${FLOOR}% floor)\n`);
