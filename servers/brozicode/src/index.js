import { readFileSync } from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerBatchEdit } from './tools/batch-edit.js';
import { registerSmartSearch } from './tools/smart-search.js';
import { registerRun } from './tools/run.js';

// ─── Global error handlers ────────────────────────────────────────────────────
// Catch unhandled errors so the MCP server stays alive instead of crashing
// and dropping the stdio socket (which causes "socket closed unexpectedly").

process.on('uncaughtException', (err) => {
  process.stderr.write(`[brozicode] uncaughtException: ${err?.message}\n${err?.stack ?? ''}\n`);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  process.stderr.write(`[brozicode] unhandledRejection: ${msg}\n`);
});

// ─── Server ───────────────────────────────────────────────────────────────────

// Read from package.json so this can't drift from the published version again
// (it was pinned at 0.10.2 while plugin.json said 0.10.3 and the marketplace
// manifest still advertised 0.9.0 — which also meant check-update.js, comparing
// plugin.json against the marketplace, could never detect a newer release).
//
// Candidate paths, because this file runs from two different depths: src/index.js
// during `npm run dev`, and bundle.js one level up in production. And it NEVER
// throws — a version lookup must not be able to stop the server from booting.
function readVersion() {
  for (const rel of ['../package.json', './package.json']) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')).version;
    } catch { /* try the next candidate */ }
  }
  return '0.0.0';
}

const server = new McpServer({
  name: 'brozicode',
  version: readVersion(),
});

registerBatchEdit(server);
registerSmartSearch(server);
registerRun(server);

// If startup itself fails, exit loudly. The uncaughtException handler above keeps
// the process alive on a bad TOOL CALL, which is what we want — but applied to a
// boot failure it left a live process with no transport and no registered tools,
// which the client can only experience as a server that hangs.
try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  process.stderr.write(`[brozicode] failed to start: ${err?.stack || err}\n`);
  process.exit(1);
}
