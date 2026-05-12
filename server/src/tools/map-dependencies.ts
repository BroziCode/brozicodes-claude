import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerMapDependencies(server: McpServer) {
  server.tool(
    'brozi_map_dependencies',
    'Generate import/export graph for a file. Returns upstream dependencies and downstream dependents. Use before refactoring to understand blast radius.',
    {
      filePath: z.string().describe('Path to the file to analyze'),
      depth: z.number().default(2).describe('How many levels of dependencies to traverse'),
    },
    async ({ filePath, depth }) => {
      // TODO: implement with madge or dependency-tree
      return {
        content: [
          {
            type: 'text' as const,
            text: `[BroziCode stub] Would map dependencies for ${filePath} at depth ${depth}. Implementation coming in next sprint.`,
          },
        ],
      };
    }
  );
}
