// Entry point for hooklib.js — the pieces the hook scripts need, bundled with
// their dependencies (node_modules is not shipped with the plugin).
export { stripAnsi, filterOutput, digest } from './lib/compress.js';
export { renderSkeleton } from './tools/smart-search.js';
