import { z } from 'zod';

export function registerSmartSearch(server) {
  server.tool(
    'brozi_smart_search',
    'Parse a file into AST and return only signatures and exports. Use instead of reading full files for structural overview.',
    {
      filePath: z.string().describe('Path to the file to parse'),
    },
    async ({ filePath }) => {
      return {
        content: [{
          type: 'text',
          text: `[BroziCode v0.1 stub] Would parse ${filePath}. Full implementation coming soon.`,
        }],
      };
    }
  );
}
