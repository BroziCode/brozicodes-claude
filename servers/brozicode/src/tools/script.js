import { z } from 'zod';
import vm from 'node:vm';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fg from 'fast-glob';
import { capChars } from '../lib/compress.js';

const execAsync = promisify(exec);

// Code mode (Anthropic, "Code execution with MCP"): the model writes ONE async
// snippet that chains search / read / shell / edit calls and filters in code.
// Intermediate data never enters the context — only the returned value does.
//
// ponytail: node:vm is NOT a security sandbox. The snippet can reach the host
// the same way brozi_run already can, which is fine for a local dev tool the
// user already trusts with a shell. Swap for isolated-vm / a container if this
// ever runs untrusted code. The timeout also can't kill a runaway async loop —
// it just stops waiting for it.

const fmt = v => (typeof v === 'string' ? v : JSON.stringify(v, null, 1) ?? String(v));

const DESC = `Code mode: run an async JS snippet that chains file/shell ops and returns only the final result —
intermediate data never enters context. Use when a task needs 3+ chained lookups (search → filter → read
slices → edit). In scope (paths relative to project root):
  read(path) → string            glob(pattern) → string[]       sh(cmd) → {stdout, stderr, code}
  search(smart_search args) → text   edit([{file, oldContent, newContent}]) → text   run(cmd) → text
  console.log(...)
"return" what you need. Example:
  const hits = []; for (const f of await glob("src/**/*.ts")) if ((await read(f)).includes("useAuth")) hits.push(f); return hits;`;

/** @param tools map of tool name → RegisteredTool ({ inputSchema, handler }) */
export function registerScript(server, tools) {
  // Go through each tool's own zod schema so defaults apply exactly as for a
  // direct MCP call.
  const call = async (name, args) => {
    const t   = tools[name];
    const res = await t.handler(t.inputSchema.parse(args ?? {}), {});
    return res.content.map(c => c.text ?? '').join('\n');
  };

  return server.tool('brozi_script', DESC, {
    code:       z.string().describe('Body of an async function. Use await; return the result.'),
    timeout_ms: z.number().int().min(1000).max(600_000).default(120_000).describe('Stop waiting after this many ms.'),
  }, async ({ code, timeout_ms }) => {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const abs  = p => path.resolve(root, p);
    const logs = [];
    const api  = {
      read:   p => fs.readFile(abs(p), 'utf8'),
      glob:   (pattern, opts = {}) => fg(pattern, { cwd: root, dot: true, ignore: ['**/node_modules/**', '**/.git/**'], ...opts }),
      sh:     async (cmd, opts = {}) => {
        try {
          const { stdout, stderr } = await execAsync(cmd, { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout ?? timeout_ms });
          return { stdout, stderr, code: 0 };
        } catch (e) {
          return { stdout: e.stdout ?? '', stderr: e.stderr || e.message, code: e.code ?? 1 };
        }
      },
      search: args => call('brozi_smart_search', args),
      edit:   args => call('brozi_batch_edit', Array.isArray(args) ? { edits: args } : args),
      run:    args => call('brozi_run', typeof args === 'string' ? { command: args } : args),
      console: { log: (...a) => logs.push(a.map(fmt).join(' ')) },
    };

    let timer;
    try {
      const ctx     = vm.createContext(api);
      const pending = vm.runInContext(`(async () => {\n${code}\n})()`, ctx, { timeout: 5_000 });
      const value   = await Promise.race([
        pending,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeout_ms}ms`)), timeout_ms); }),
      ]);
      const out = [logs.join('\n'), value === undefined ? '' : fmt(value)].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: capChars(out || '(no return value)') }] };
    } catch (e) {
      const msg = `Error: ${e?.message ?? e}` + (logs.length ? `\n── console ──\n${logs.join('\n')}` : '');
      return { content: [{ type: 'text', text: capChars(msg) }], isError: true };
    } finally {
      clearTimeout(timer);
    }
  });
}
