// BroziCode batch-edit regression harness — run with `npm test`.
// Guards the silent file-corruption bugs fixed in v0.10.1:
//   1. $-pattern interpretation in newContent (String.replace footgun)
//   2. first-of-many silent replace (must refuse ambiguous matches)
// …and the ones fixed in v0.11.0:
//   3. ambiguity refusal only ever covered Tier 1; blocks that differed by
//      indentation reached the fuzzy patcher and were rewritten in the wrong place
//   4. replacements were spliced in at the caller's indentation, not the file's

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

// ── v0.11.0 regressions ───────────────────────────────────────────────────

test('duplicate blocks differing ONLY by indentation are REFUSED', () => {
  // Pre-fix: Tier 2's gate didn't fire, the fuzzy patcher took over and rewrote
  // class A while the caller meant B — reported as success.
  const file = ['class A {', '  run() {', '    return 1;', '  }', '}', '',
                'class B {', '  run() {', '    return 1;', '  }', '}'].join('\n');
  const out  = applyEditToContent(file, 'run() {\n  return 1;\n}', 'run() { return 99; }', 'f.js');
  assert.strictEqual(out.success, false, 'must not silently pick one of two matches');
  assert.ok(/AMBIGUOUS/.test(out.error));
});

test('replacement is re-indented to the matched block, not the caller', () => {
  const file = ['class A {', '  run() {', '    return 1;', '  }', '}'].join('\n');
  const out  = applyEditToContent(file, 'run() {\n  return 1;\n}', 'run() {\n  return 99;\n}', 'f.js');
  assert.ok(out.success);
  assert.strictEqual(out.result,
    ['class A {', '  run() {', '    return 99;', '  }', '}'].join('\n'),
    `wrong indentation: ${JSON.stringify(out.result)}`);
});

test('indentation-sensitive languages survive a tier-2 edit', () => {
  // Pre-fix this produced `    return 99` at the class body's indent level —
  // valid-looking text, different program.
  const file = ['class S:', '    def go(self):', '        return 1'].join('\n');
  const out  = applyEditToContent(file, 'def go(self):\n    return 1', 'def go(self):\n    return 99', 's.py');
  assert.ok(out.success);
  assert.strictEqual(out.result,
    ['class S:', '    def go(self):', '        return 99'].join('\n'),
    `python indentation broken: ${JSON.stringify(out.result)}`);
});

test('unmatched oldContent fails loudly instead of being fuzzed into place', () => {
  const out = applyEditToContent('alpha\nbeta\ngamma\n', 'not in the file at all', 'x', 'f.js');
  assert.strictEqual(out.success, false);
  assert.ok(/MATCH FAILED/.test(out.error));
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
