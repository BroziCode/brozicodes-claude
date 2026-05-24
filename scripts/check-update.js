#!/usr/bin/env node
// BroziCode check-update
// Fetches latest version from GitHub on SessionStart and notifies if a newer
// version is available. Checks at most once every 24 hours.

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';

const PLUGIN_ROOT  = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, '..');
const HOME         = os.homedir();
const CLAUDE_DIR   = path.join(HOME, '.claude');
const CACHE_FILE   = path.join(CLAUDE_DIR, '.brozicode-last-update-check');
const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MANIFEST_URL = 'https://raw.githubusercontent.com/BroziCode/brozicodes-claude/main/.claude-plugin/marketplace.json';

// ── 1. Read installed version ───────────────────────────────────────────────────
let installedVersion = '0.0.0';
try {
  const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  installedVersion = pj.version;
} catch { process.exit(0); }

// ── 2. Throttle: skip if checked within TTL ──────────────────────────────────────
try {
  const last = parseInt(fs.readFileSync(CACHE_FILE, 'utf8').trim(), 10);
  if (!isNaN(last) && Date.now() - last < CHECK_TTL_MS) process.exit(0);
} catch { /* no cache yet — proceed */ }

// ── 3. Fetch latest manifest from GitHub ──────────────────────────────────────
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(MANIFEST_URL, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const manifest = JSON.parse(body);
          const latest = manifest.plugins?.[0]?.version || manifest.version || null;
          resolve(latest);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── 4. Compare semver (major.minor.patch) ─────────────────────────────────────────
function isNewer(latest, installed) {
  const pa = latest.split('.').map(n => parseInt(n, 10) || 0);
  const pb = installed.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

(async () => {
  const latestVersion = await fetchLatestVersion();

  // Always write cache timestamp (even on fetch failure) to avoid hammering on errors
  try { fs.writeFileSync(CACHE_FILE, String(Date.now()), 'utf8'); } catch {}

  if (latestVersion && isNewer(latestVersion, installedVersion)) {
    process.stdout.write(
      `[brozicode] ⚡ Update available: v${installedVersion} → v${latestVersion}. Run: /plugin update brozicode\n`
    );
  }

  process.exit(0);
})();
