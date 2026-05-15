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

  // ── 1. Find all JS/TS source files ──────────────────────────────────────────
  let files = [];
  try {
    const found = execSync(
      `find . -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" \\)` +
      ` ! -path "*/node_modules/*" ! -path "*/.git/*" ! -name "bundle.js"` +
      ` ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/.brozicode/*"`,
      { cwd: projectDir, encoding: 'utf8', timeout: 8_000 }
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

    code.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.length === 0 || t.length > 120) return;
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
      if (out.length >= 20) return;
    });

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
