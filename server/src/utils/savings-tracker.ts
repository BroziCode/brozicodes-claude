// Placeholder for server-side token counting logic
// Will integrate with MCP session metadata in v1
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}
