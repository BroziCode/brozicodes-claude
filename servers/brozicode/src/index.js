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

const server = new McpServer({
  name: 'brozicode',
  version: '0.10.2',
});

registerBatchEdit(server);
registerSmartSearch(server);
registerRun(server);

const transport = new StdioServerTransport();
await server.connect(transport);
