// BroziCode boot smoke test — run with `npm test`.
//
// Exists because v0.11.0 development briefly shipped an index.js that resolved
// package.json relative to import.meta.url. That path is correct from src/ and
// wrong from bundle.js (one directory shallower), so the bundled server threw
// during module load, registered zero tools, and — because index.js installs an
// uncaughtException handler — stayed alive as a process the client could only
// experience as a server that hangs. Unit tests on the tool functions all passed.
//
// So: actually speak MCP to BOTH entry points and assert the tools come back.

import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = ['brozi_batch_edit', 'brozi_smart_search', 'brozi_run'];

function handshake(entry) {
  return new Promise(resolve => {
    const proc = spawn('node', [entry], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });

    const send = o => proc.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'boot-test', version: '1' },
    }});
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    }, 250);

    setTimeout(() => {
      proc.kill();
      const msgs = out.trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({
        init:  msgs.find(m => m.id === 1)?.result,
        tools: msgs.find(m => m.id === 2)?.result?.tools,
        err,
      });
    }, 1100);
  });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

for (const entry of ['bundle.js', 'src/index.js']) {
  await test(`${entry} completes an MCP handshake and registers all tools`, async () => {
    const { init, tools, err } = await handshake(entry);
    assert.ok(init, `no initialize response. stderr:\n${err.slice(0, 600)}`);
    assert.ok(tools, `no tools/list response. stderr:\n${err.slice(0, 600)}`);
    const names = tools.map(t => t.name).sort();
    assert.deepStrictEqual(names, [...EXPECTED].sort(), `registered: ${names.join(', ')}`);
    assert.ok(init.serverInfo?.version && init.serverInfo.version !== '0.0.0',
      `server reported version ${init.serverInfo?.version} — package.json lookup failed`);
  });
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
