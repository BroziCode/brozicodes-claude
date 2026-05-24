#!/usr/bin/env node
// BroziCode configure-settings
// Rewrites ~/.claude/settings.json with BroziCode defaults on install/update.
// Runs on SessionStart but only applies when the plugin version changes.

import fs from 'fs';
import path from 'path';
import os from 'os';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, '..');
const HOME        = os.homedir();
const CLAUDE_DIR  = path.join(HOME, '.claude');
const SETTINGS    = path.join(CLAUDE_DIR, 'settings.json');
const MARKER      = path.join(CLAUDE_DIR, '.brozicode-configured-version');

// ── 1. Read plugin version ───────────────────────────────────────────────────
let pluginVersion = '0.0.0';
try {
  const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  pluginVersion = pj.version;
} catch {}

// ── 2. Skip if already configured for this version ──────────────────────────
let lastConfigured = '';
try { lastConfigured = fs.readFileSync(MARKER, 'utf8').trim(); } catch {}

if (lastConfigured === pluginVersion) {
  process.exit(0);
}

// ── 3. Find newest versioned cache dir ───────────────────────────────────────
function findNewestVersionDir() {
  const cacheBase = path.join(CLAUDE_DIR, 'plugins', 'cache', 'brozicode-marketplace', 'brozicode');

  if (!fs.existsSync(cacheBase)) return PLUGIN_ROOT;

  const dirs = fs.readdirSync(cacheBase).filter(d => {
    try { return fs.statSync(path.join(cacheBase, d)).isDirectory(); } catch { return false; }
  });

  if (!dirs.length) return PLUGIN_ROOT;

  dirs.sort((a, b) => {
    const pa = a.split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const diff = (pb[i] || 0) - (pa[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

  return path.join(cacheBase, dirs[0]);
}

const newestDir     = findNewestVersionDir();
const statusLineCmd = `node "${newestDir}/scripts/savings-status-line.js"`;

// ── 4. Merge into existing settings.json ─────────────────────────────────────
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}

settings.agent      = 'brozicode:brozicode';
settings.statusLine = { type: 'command', command: statusLineCmd };
settings.spinnerVerbs = {
  mode: 'replace',
  verbs: [
    'In broziden we trust',
    'One call to rule them all',
    'Batching it, no questions asked',
    'Token bill going down',
    'Counting your savings',
    'Skipping the verify step',
    'Fuzzy-matching your mess',
    'Not re-reading that file',
    'Going full macro',
    'Brozi knows best',
    'Flattening the roundtrips',
    'Outsmarting the loop tax',
    'Reading the AST so you don\'t have to',
    'Mapping the blast radius',
    'Making Claude work smarter',
    'No micro-tools allowed',
    'Trust the batch, always',
    'Doing it in one trip',
    'Compressing your context',
    'Keeping Anthropic\'s bill in check'
  ]
};

// ── 5. Write settings atomically ─────────────────────────────────────────────
try {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const tmp = SETTINGS + '.brozicode.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS);
} catch (err) {
  process.stderr.write(`[brozicode] configure-settings: failed to write settings.json: ${err.message}\n`);
  process.exit(0);
}

// ── 6. Write version marker ───────────────────────────────────────────────────
try {
  fs.writeFileSync(MARKER, pluginVersion, 'utf8');
} catch {}

process.stdout.write(`[brozicode] settings.json configured for v${pluginVersion} (statusLine → ${newestDir})\n`);
process.exit(0);
