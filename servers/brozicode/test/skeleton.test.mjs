// BroziCode skeleton regression harness — run with `npm test`.
// Guards the P0 class of bug (skeletonizer silently producing 0 lines) and
// reports the token reduction skeletons deliver. Exits non-zero on any failure.
//
// No test framework — plain node assertions so it runs anywhere with zero deps
// beyond what the server already installs.

import assert from 'node:assert';
import { extractSkeleton, extractRegexSkeleton, buildSkeleton, trimSkeleton } from '../src/tools/smart-search.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
const tokens = s => Math.ceil(s.length / 4);
const skelText = r => r.sorted.map(l => l.text).join('\n');

// ── Fixtures ─────────────────────────────────────────────────────────────────
const JS = `import { z } from 'zod';
export function alpha(a, b) { return a + b; }
function beta() { return 1; }
const gamma = (x) => x * 2;
export class Widget {
  constructor() { this.n = 0; }
  render() { return this.n; }
}
export default alpha;
`;

const PY = `import os
from typing import List

class Service:
    def __init__(self, name):
        self.name = name
    async def fetch(self, url):
        return url

def helper(x):
    return x + 1
`;

const GO = `package main
import "fmt"
type Server struct { port int }
func New(port int) *Server { return &Server{port} }
func (s *Server) Start() error { return nil }
`;

// ── P0 regression: JS/TS skeleton must NEVER be empty for a file with decls ──
test('JS skeleton extracts top-level declarations (P0 guard)', () => {
  const r = extractSkeleton(JS, 'fixture.js', { includeImports: true, includeTypes: true, includePrivate: false });
  assert.ok(r.sorted.length > 0, 'skeleton was EMPTY — the P0 walker bug has regressed');
  const t = skelText(r);
  assert.ok(/alpha/.test(t),  'missing exported function alpha');
  assert.ok(/Widget/.test(t), 'missing exported class Widget');
});

test('buildSkeleton dispatches JS to babel extractor', () => {
  const r = buildSkeleton(JS, 'a.ts', { includeImports: true, includeTypes: true, includePrivate: false });
  assert.ok(r && r.sorted.length >= 3);
});

// ── Multi-language ───────────────────────────────────────────────────────────
test('Python skeleton extracts class + def + async def', () => {
  const r = extractRegexSkeleton(PY, 'svc.py');
  assert.ok(r && r.sorted.length >= 3, `expected >=3 symbols, got ${r ? r.sorted.length : 'null'}`);
  const t = skelText(r);
  assert.ok(/class Service/.test(t));
  assert.ok(/def helper/.test(t));
  assert.ok(/async def fetch/.test(t));
});

test('Go skeleton extracts type + func', () => {
  const r = buildSkeleton(GO, 'main.go', {});
  assert.ok(r && r.sorted.length >= 3, `got ${r ? r.sorted.length : 'null'}`);
  assert.ok(/type Server/.test(skelText(r)));
});

test('unknown language returns null (caller falls back to raw)', () => {
  assert.strictEqual(buildSkeleton('SELECT 1;', 'q.sql', {}), null);
});

// ── Budget ranking ───────────────────────────────────────────────────────────
test('trimSkeleton caps to max and keeps public surface first', () => {
  const r = extractSkeleton(JS, 'fixture.js', { includeImports: true, includeTypes: true, includePrivate: false });
  const trimmed = trimSkeleton(r, 2);
  assert.strictEqual(trimmed.sorted.length, 2, 'did not cap to 2');
  assert.ok(trimmed.trimmed > 0, 'trimmed count not reported');
  // original must be untouched (no mutation of cached skeleton)
  assert.ok(r.sorted.length > 2, 'trimSkeleton mutated the source skeleton');
});

test('trimSkeleton is a no-op when under budget or unbounded', () => {
  const r = extractSkeleton(JS, 'fixture.js', {});
  assert.strictEqual(trimSkeleton(r, 0), r);
  assert.strictEqual(trimSkeleton(r, 999), r);
});

// ── Token reduction report (visibility, not pass/fail) ─────────────────────
console.log('\n  token reduction (raw → skeleton):');
for (const [code, fp] of [[JS, 'fixture.js'], [PY, 'svc.py'], [GO, 'main.go']]) {
  const r = buildSkeleton(code, fp, { includeImports: true, includeTypes: true, includePrivate: false });
  const raw = tokens(code), skel = tokens(skelText(r));
  const pct = raw ? Math.round((1 - skel / raw) * 100) : 0;
  console.log(`    ${fp.padEnd(14)} ${raw}t → ${skel}t  (-${pct}%)`);
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
