// BroziCode LIVE token A/B — `npm run bench:live -- [--model sonnet] [--runs 1] [--tasks locate,run] [--modes off,on]`
//
// bench/e2e.mjs is a deterministic MODEL of what each strategy injects. This
// drives real `claude -p` sessions against this repo and reads the billed usage
// from --output-format json. It costs real money and takes minutes — not in CI.
//
// Modes:
//   off      — no BroziCode (user-level settings/plugins excluded via --setting-sources project)
//   on       — this checkout via --plugin-dir, brozicode agent as the main thread
//   on-prose — same, with caveman style switched off: isolates what caveman buys
//
// "pass" = the final answer matches the task's expected regex. Read tokens AND
// pass rate together: a saving that costs correctness is not a saving.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const arg  = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const MODEL = arg('model', 'sonnet');
const RUNS  = Number(arg('runs', 1));

const ON = ['--plugin-dir', ROOT, '--agent', 'brozicode:brozicode'];
const MODES = {
  off:        [],
  on:         ON,
  'on-prose': [...ON, '--append-system-prompt', 'Caveman mode is OFF for this session: answer in normal, complete prose.'],
};

const TASKS = [
  { name: 'locate',  expect: /batch-edit\.js/,
    prompt: 'In this repo, which file defines the function applyEditToContent? Reply with the relative path only.' },
  { name: 'explain', expect: /\b300\b/,
    prompt: 'Above how many lines does brozi_smart_search auto-skeletonize a JS/TS file read without a line range? Reply with the number only.' },
  { name: 'hooks',   expect: /SessionStart[\s\S]*PostToolUse|PostToolUse[\s\S]*SessionStart/,
    prompt: 'List every hook event name configured in hooks/hooks.json, comma-separated.' },
  { name: 'run',     expect: /\b\d+\s+passed\b/i,
    prompt: 'Run the unit tests (npm test inside servers/brozicode) and reply with the "N passed" summary of the last suite.' },
];

const ALLOWED = ['Read', 'Grep', 'Glob', 'Bash(npm test:*)', 'Bash(cd:*)', 'Bash(ls:*)', 'mcp__plugin_brozicode_brozicode'];

function runOnce(task, flags) {
  const r = spawnSync('claude', [
    '-p', task.prompt, '--output-format', 'json', '--model', MODEL,
    '--setting-sources', 'project', ...flags, '--allowedTools', ...ALLOWED,
  ], { cwd: ROOT, encoding: 'utf8', input: '', timeout: 600_000 });
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || 'no output').slice(0, 300) }; }
  const u = j.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return {
    input, output: u.output_tokens || 0, tokens: input + (u.output_tokens || 0),
    cost: j.total_cost_usd || 0, turns: j.num_turns || 0, pass: task.expect.test(j.result || ''),
  };
}

const want  = s => (s ? s.split(',') : null);
const tasks = TASKS.filter(t => !want(arg('tasks')) || want(arg('tasks')).includes(t.name));
const modes = Object.keys(MODES).filter(m => !want(arg('modes')) || want(arg('modes')).includes(m));

const totals = Object.fromEntries(modes.map(m => [m, { tokens: 0, output: 0, cost: 0, turns: 0, pass: 0, n: 0 }]));
const pad = (s, n) => String(s).padEnd(n), rp = (s, n) => String(s).padStart(n);
console.log(`\nBroziCode LIVE A/B — model ${MODEL}, ${RUNS} run(s) per cell, cwd ${ROOT}\n`);
console.log(`  ${pad('task', 9)} ${pad('mode', 9)} ${rp('tokens', 9)} ${rp('output', 7)} ${rp('turns', 5)} ${rp('$', 7)}  pass`);
for (const task of tasks) {
  for (const mode of modes) {
    for (let i = 0; i < RUNS; i++) {
      const r = runOnce(task, MODES[mode]);
      if (r.error) { console.log(`  ${pad(task.name, 9)} ${pad(mode, 9)} ERROR ${r.error}`); continue; }
      const t = totals[mode];
      t.tokens += r.tokens; t.output += r.output; t.cost += r.cost; t.turns += r.turns; t.pass += r.pass ? 1 : 0; t.n++;
      console.log(`  ${pad(task.name, 9)} ${pad(mode, 9)} ${rp(r.tokens, 9)} ${rp(r.output, 7)} ${rp(r.turns, 5)} ${rp(r.cost.toFixed(3), 7)}  ${r.pass ? '✓' : '✗'}`);
    }
  }
}

console.log('\n  totals');
const base = totals.off?.tokens;
for (const m of modes) {
  const t = totals[m];
  const delta = base && m !== 'off' ? `  (${Math.round((t.tokens / base - 1) * 100)}% vs off)` : '';
  console.log(`  ${pad(m, 9)} ${rp(t.tokens, 9)} tok  ${rp(t.output, 7)} out  $${t.cost.toFixed(3)}  pass ${t.pass}/${t.n}${delta}`);
}
