import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const EditSchema = z.object({
  file: z.string().describe('Absolute or relative path to the file'),
  oldContent: z.string().describe('The exact content to replace'),
  newContent: z.string().describe('The replacement content'),
});

export function registerBatchEdit(server: McpServer) {
  server.tool(
    'brozi_batch_edit',
    'Apply multiple file edits in a single operation with local validation. Use instead of sequential Read→Edit→Verify calls.',
    {
      edits: z.array(EditSchema).describe('Array of edits to apply'),
      validate: z.boolean().default(true).describe('Run tsc/eslint after applying edits'),
    },
    async ({ edits, validate }) => {
      // TODO: implement fuzzy patch application and local validation
      return {
        content: [
          {
            type: 'text' as const,
            text: `[BroziCode stub] Would apply ${edits.length} edit(s). Implementation coming in next sprint.`,
          },
        ],
      };
    }
  );
}
