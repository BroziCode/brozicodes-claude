// BroziCode output-compression checks — run with `npm test`.
// Guards src/lib/compress.js, shared by brozi_run and the native Bash hook.

import assert from 'node:assert';
import { filterOutput, digest, focusRegex, stripAnsi } from '../src/lib/compress.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

test('test runs: passing lines dropped, failures + summary kept', () => {
  const out = filterOutput('npm test', ['  ✓ a', '  ✓ b', '  ✗ c broke', 'FAIL src/x.test.js', 'Tests: 1 failed, 2 passed'].join('\n'));
  assert.deepStrictEqual(out, ['  ✗ c broke', 'FAIL src/x.test.js', 'Tests: 1 failed, 2 passed']);
});

test('noise rules only apply to their own command', () => {
  assert.deepStrictEqual(filterOutput('ls', '✓ ok'), ['✓ ok']);
});

test('error lines survive even when a noise rule matches them', () => {
  assert.deepStrictEqual(filterOutput('npm install', 'npm WARN deprecated x\nnpm ERR! code E404'), ['npm ERR! code E404']);
});

test('repeats collapse with a count; blank runs collapse silently', () => {
  assert.deepStrictEqual(filterOutput('x', 'a\na\na\nb\n\n\n\nc'), ['a  (×3)', 'b', '', 'c']);
});

test('\\r-redrawn progress keeps only the final frame', () => {
  assert.deepStrictEqual(filterOutput('x', 'dl 10%\rdl 50%\rdl 100%\ndone'), ['dl 100%', 'done']);
});

test('digest shows head, tail, mid-output error and focus hit — and is much shorter', () => {
  const lines = Array.from({ length: 500 }, (_, i) =>
    i === 249 ? 'Error: boom' : i === 399 ? 'the needle is here' : `log ${i}`);
  const d = digest(lines, { focus: 'needle' });
  for (const want of ['1: log 0', '250: Error: boom', '400: the needle is here', '500: log 499']) {
    assert.ok(d.text.includes(want), `missing "${want}"`);
  }
  assert.strictEqual(d.errors, 1);
  assert.strictEqual(d.focusHits, 1);
  assert.ok(d.shown < 60, `shown ${d.shown} lines`);
  assert.ok(d.text.includes('… ['), 'gaps should be marked');
});

test('focusRegex treats keywords literally', () => {
  const re = focusRegex('a.b (c)');
  assert.ok(re.test('x a.b y'));
  assert.ok(!re.test('axb'));
  assert.strictEqual(focusRegex('  '), null);
});

test('stripAnsi removes CSI/OSC sequences', () => {
  assert.strictEqual(stripAnsi('\x1B[31mred\x1B[0m \x1B]0;title\x07ok'), 'red ok');
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
