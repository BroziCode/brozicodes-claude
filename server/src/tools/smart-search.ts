import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerSmartSearch(server: McpServer) {
  server.tool(
    'brozi_smart_search',
    'Parse a file into AST and return only signatures and exports. Use instead of reading full files when you need structural overview.',
    {
      filePath: z.string().describe('Path to the file to parse'),
      includeTypes: z.boolean().default(true).describe('Include type definitions'),
    },
    async ({ filePath, includeTypes }) => {
      // TODO: implement AST parsing with @babel/parser or recast
      return {
        content: [
          {
            type: 'text' as const,
            text: `[BroziCode stub] Would parse ${filePath}. Implementation coming in next sprint.`,
          },
        ],
      };
    }
  );
}
