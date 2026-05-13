import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerBatchEdit } from './tools/batch-edit.js';
import { registerSmartSearch } from './tools/smart-search.js';

const server = new McpServer({
  name: 'brozicode',
  version: '0.1.0',
});

registerBatchEdit(server);
registerSmartSearch(server);

const transport = new StdioServerTransport();
await server.connect(transport);
