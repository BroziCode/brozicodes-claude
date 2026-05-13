import { z } from 'zod';

const EditSchema = z.object({
  file: z.string().describe('Path to the file'),
  oldContent: z.string().describe('The exact content to replace'),
  newContent: z.string().describe('The replacement content'),
});

export function registerBatchEdit(server) {
  server.tool(
    'brozi_batch_edit',
    'Apply multiple file edits in one operation. Use instead of sequential Read→Edit→Verify calls when editing 2+ files.',
    {
      edits: z.array(EditSchema).describe('Array of edits to apply'),
    },
    async ({ edits }) => {
      return {
        content: [{
          type: 'text',
          text: `[BroziCode v0.1 stub] Would apply ${edits.length} edit(s). Full implementation coming soon.`,
        }],
      };
    }
  );
}
