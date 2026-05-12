import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerBatchEdit } from './tools/batch-edit';
import { registerSmartSearch } from './tools/smart-search';
import { registerMapDependencies } from './tools/map-dependencies';

const server = new McpServer({
  name: 'brozicodes-claude',
  version: '0.1.0',
});

registerBatchEdit(server);
registerSmartSearch(server);
registerMapDependencies(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('BroziCode MCP server running');
}

main().catch(console.error);
