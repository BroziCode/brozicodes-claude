#!/usr/bin/env node
// BroziCode SessionStart Repo Map Generator
// Builds an Aider-style repo map: parses JS/TS import graphs, runs simplified PageRank,
// generates lightweight skeletons for the top-30 most-imported files, and writes the map
// to .brozicode/repo-map.md so the agent gets codebase context at session start.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  run().catch(err => {
    process.stderr.write(`[brozicode] session-start-repo-map: ${err.message}\n`);
    process.exit(0);
  });
});

async function run() {
  let event = {};
  try { event = JSON.parse(input); } catch {}

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const outputDir  = path.join(projectDir, '.brozicode');
  const mapPath    = path.join(outputDir, 'repo-map.md');

  fs.mkdirSync(outputDir, { recursive: true });

  // Keep .brozicode/ out of the user's git status without touching their
  // .gitignore (which is a tracked file we have no business editing).
  try {
    const exclude = path.join(projectDir, '.git', 'info', 'exclude');
    if (fs.existsSync(path.dirname(exclude))) {
      const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!cur.includes('.brozicode/')) {
        fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}.brozicode/\n`, 'utf8');
      }
    }
  } catch { /* best effort */ }

  // ── 0. Skip if map is fresh (< 30 min) ──────────────────────────────────
  try {
    const stat  = fs.statSync(mapPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 30 * 60 * 1000) {
      const ageMin = Math.round(ageMs / 60_000);
      process.stdout.write(`BroziCode repo map cached (${ageMin}m old): ${mapPath}\n`);
      process.exit(0);
    }
  } catch { /* map doesn't exist yet — proceed */ }

  // ── 1. Find all JS/TS source files ──────────────────────────────────────────
  let files = [];
  try {
    // Build output has no import edges, so every artifact ties at baseline
    // PageRank and floods the top-30 by tie-break. Excluding only
    // node_modules/.git/dist/build left .next chunks as ~2/3 of the map.
    const PRUNE = [
      'node_modules', '.git', 'dist', 'build', '.brozicode', '.next', 'out',
      'target', 'vendor', 'coverage', '.venv', 'venv', '__pycache__',
      '.turbo', '.cache', '.svelte-kit', '.nuxt', '.output',
    ];
    const pruneExpr = PRUNE.map(d => `-name "${d}"`).join(' -o ');
    const found = execSync(
      `find . \\( ${pruneExpr} \\) -prune -o` +
      ` -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" \\)` +
      ` ! -name "bundle.js" ! -name "*.min.js" -print`,
      { cwd: projectDir, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }
    );
    files = found.trim().split('\n').filter(Boolean)
      .map(f => path.resolve(projectDir, f));
  } catch {}

  if (files.length === 0) { process.exit(0); }

  // ── 2. Parse relative imports via regex (no babel dep needed) ───────────────
  const IMPORT_RE  = /(?:^|\s)(?:import|from)\s+['"](\.[\/\w.\-]+)['"]\s*/gm;
  const REQUIRE_RE = /require\s*\(\s*['"](\.[\/\w.\-]+)['"]\s*\)/g;
  const EXTS       = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', ''];

  const allFiles   = new Set(files);
  const adjacency  = new Map(); // src → Set<imported>
  const reverseAdj = new Map(); // imported → [src]

  for (const fp of files) {
    adjacency.set(fp, new Set());
    reverseAdj.set(fp, []);
  }

  for (const fp of files) {
    let code = '';
    try { code = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    const dir = path.dirname(fp);

    for (const re of [IMPORT_RE, REQUIRE_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code)) !== null) {
        const spec = m[1];
        outer:
        for (const ext of EXTS) {
          for (const candidate of [
            path.resolve(dir, spec + ext),
            path.resolve(dir, spec, 'index' + ext),
          ]) {
            if (allFiles.has(candidate)) {
              adjacency.get(fp).add(candidate);
              reverseAdj.get(candidate).push(fp);
              break outer;
            }
          }
        }
      }
    }
  }

  // ── 3. Simplified PageRank (d = 0.85, 5 iterations) ──────────────────────────
  const N = files.length;
  let rank = new Map();
  for (const fp of files) rank.set(fp, 1 / N);

  for (let iter = 0; iter < 5; iter++) {
    const next = new Map();
    for (const fp of files) {
      const inbound = reverseAdj.get(fp) || [];
      let sum = 0;
      for (const src of inbound) {
        const out = adjacency.get(src)?.size || 1;
        sum += rank.get(src) / out;
      }
      next.set(fp, (1 - 0.85) / N + 0.85 * sum);
    }
    rank = next;
  }

  // ── 4. Take top 30 by PageRank ───────────────────────────────────────────────
  const top30 = [...rank.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([fp]) => fp);

  // ── 5. Lightweight skeleton (regex-based, no babel dep) ───────────────────────
  function getSkeletonLines(fp) {
    let code = '';
    try { code = fs.readFileSync(fp, 'utf8'); } catch { return ['  (unreadable)']; }

    const out  = [];
    const seen = new Set();

    // for-loop, not forEach: `return` inside a forEach callback only ends that
    // iteration, so the 20-symbol cap below never actually capped anything.
    const srcLines = code.split('\n');
    for (let i = 0; i < srcLines.length; i++) {
      if (out.length >= 20) break;
      const t = srcLines[i].trim();
      if (t.length === 0 || t.length > 120) continue;
      if (
        t.startsWith('export ')         ||
        t.startsWith('function ')       ||
        t.startsWith('async function ') ||
        t.startsWith('class ')          ||
        (t.startsWith('const ') && t.includes('=>'))
      ) {
        const sig = t.replace(/\s*\{?\s*$/, '').slice(0, 90);
        if (!seen.has(sig)) {
          seen.add(sig);
          out.push(`  ${i + 1}: ${sig}`);
        }
      }
    }

    return out.length ? out : ['  (no exports found)'];
  }

  // ── 6. Build markdown ────────────────────────────────────────────────────────
  let md  = `# BroziCode Repo Map\n`;
  md     += `Generated: ${new Date().toISOString()}\n`;
  md     += `Top ${top30.length} files by import centrality (PageRank over ${files.length} source files).\n\n`;

  for (const fp of top30) {
    const rel = path.relative(projectDir, fp);
    const pr  = rank.get(fp).toFixed(4);
    md += `## ${rel}  (rank ${pr})\n${getSkeletonLines(fp).join('\n')}\n\n`;
  }

  // ── 7. Write atomically ──────────────────────────────────────────────────────
  const tmp = mapPath + '.tmp';
  fs.writeFileSync(tmp, md, 'utf8');
  fs.renameSync(tmp, mapPath);

  process.stdout.write(`BroziCode repo map ready: ${mapPath} (${top30.length} files)\n`);
  process.exit(0);
}
