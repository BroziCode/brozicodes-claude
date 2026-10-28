// BroziCode hook checks — run with `npm run test:boot` (needs the built hooklib.js).
// Feeds real-shaped hook payloads (captured from Claude Code 2.1.312) to the
// scripts and asserts on what they hand back.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts');
const hook = (script, event) => {
  const r = spawnSync('node', [path.join(SCRIPTS, script)], { input: JSON.stringify(event), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
};
const updated = out => JSON.parse(out).hookSpecificOutput.updatedToolOutput;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const bashEvent = (command, stdout) => ({
  tool_name: 'Bash', tool_input: { command },
  tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
});

test('Bash: big output is digested, error kept, full output spilled, shape preserved', () => {
  const lines = Array.from({ length: 500 }, (_, i) => (i === 300 ? 'Error: boom' : `line ${i}`));
  const out = updated(hook('post-tool-rewriter.js', bashEvent('make', lines.join('\n'))));
  assert.ok(out.stdout.includes('Error: boom'));
  assert.ok(out.stdout.length < lines.join('\n').length / 3, `only shrank to ${out.stdout.length}`);
  const spill = out.stdout.match(/Full output: (\S+)/)?.[1];
  assert.ok(spill && fs.readFileSync(spill, 'utf8').includes('line 499'), 'spill file missing');
  assert.deepStrictEqual(Object.keys(out).sort(), ['interrupted', 'isImage', 'noOutputExpected', 'stderr', 'stdout']);
});

test('Bash: small output is left alone', () => {
  assert.strictEqual(hook('post-tool-rewriter.js', bashEvent('ls', 'a\nb\nc')), '');
});

test('Bash: mid-size test output loses passing lines', () => {
  const lines = [...Array.from({ length: 80 }, (_, i) => `  ✓ test ${i}`), '  ✗ broken', 'Tests: 1 failed, 80 passed'];
  const out = updated(hook('post-tool-rewriter.js', bashEvent('npm test', lines.join('\n'))));
  assert.strictEqual(out.stdout, '  ✗ broken\nTests: 1 failed, 80 passed');
});

const bigJs = Array.from({ length: 100 }, (_, i) =>
  `export function f${i}(x) {\n  const y = x * ${i};\n  if (y > 10) {\n    return y - 1;\n  }\n  return y + ${i};\n}`).join('\n');
const readEvent = (input, content) => ({
  tool_name: 'Read', tool_input: input,
  tool_response: { type: 'text', file: { filePath: '/repo/big.js', content, numLines: 600, startLine: 1, totalLines: 600 } },
});

test('Read: whole-file read of a big JS file becomes a skeleton', () => {
  const out = updated(hook('post-tool-rewriter.js', readEvent({ file_path: '/repo/big.js' }, bigJs)));
  assert.strictEqual(out.type, 'text');
  assert.ok(out.file.content.includes('skeleton') && out.file.content.includes('f99'));
  assert.ok(out.file.content.length < bigJs.length / 2);
  assert.strictEqual(out.file.totalLines, 600);
});

test('Read: explicit offset/limit is never touched', () => {
  assert.strictEqual(hook('post-tool-rewriter.js', readEvent({ file_path: '/repo/big.js', offset: 10, limit: 50 }, bigJs)), '');
});

test('budget guard reads real usage from the transcript, ignores subagents, warns once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brozi-test-'));
  const tp = path.join(dir, 't.jsonl');
  const usage = (n, side) => JSON.stringify({ type: 'assistant', isSidechain: side, message: { usage: { input_tokens: 10, cache_read_input_tokens: n, cache_creation_input_tokens: 0 } } });
  fs.writeFileSync(tp, [usage(119_990, false), usage(5_000, true)].join('\n') + '\n');
  const ev = { session_id: `test-${process.pid}-${Date.now()}`, transcript_path: tp };
  const first = hook('token-budget-guard.js', ev);
  assert.ok(first.includes('~120k'), first);
  assert.strictEqual(hook('token-budget-guard.js', ev), '', 'second prompt should not re-warn');
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
