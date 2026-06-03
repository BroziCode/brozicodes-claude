// BroziCode batch-edit regression harness — run with `npm test`.
// Guards the two silent file-corruption bugs fixed in v0.10.1:
//   1. $-pattern interpretation in newContent (String.replace footgun)
//   2. first-of-many silent replace (must refuse ambiguous matches)

import assert from 'node:assert';
import { applyEditToContent } from '../src/tools/batch-edit.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

test('newContent with $& / $1 stays literal (no replacement-pattern corruption)', () => {
  const file = 'const re = OLD;\n';
  const out  = applyEditToContent(file, 'OLD', '/(a)$1$&$$/', 'f.js');
  assert.ok(out.success);
  assert.strictEqual(out.result, 'const re = /(a)$1$&$$/;\n',
    `corrupted: ${JSON.stringify(out.result)}`);
});

test('single exact match applies cleanly', () => {
  const out = applyEditToContent('a\nFOO\nb\n', 'FOO', 'BAR', 'f.js');
  assert.ok(out.success);
  assert.strictEqual(out.result, 'a\nBAR\nb\n');
});

test('multiple identical matches are REFUSED (no silent first-match edit)', () => {
  const file = 'x = DUP;\ny = DUP;\n';
  const out  = applyEditToContent(file, 'DUP', 'NEW', 'f.js');
  assert.strictEqual(out.success, false, 'should refuse ambiguous match');
  assert.ok(/AMBIGUOUS/.test(out.error), 'error should explain ambiguity');
});

test('whitespace-normalized (tab vs space) fallback still works', () => {
  // Tab-indented file, space-indented oldContent -> exact match fails, tier-2 matches.
  const out = applyEditToContent('\tfunction foo() {}\n', '  function foo() {}', '  function bar() {}', 'f.js');
  assert.ok(out.success, 'tier-2 whitespace match should succeed');
  assert.ok(/bar/.test(out.result));
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
