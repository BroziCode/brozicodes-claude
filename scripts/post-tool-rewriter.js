#!/usr/bin/env node
// BroziCode PostToolUse compressor (native Bash / Read)
//
// PostToolUse `hookSpecificOutput.updatedToolOutput` replaces a built-in tool's
// result before the model sees it. The value must match the tool's output
// schema; a mismatch is ignored and the original passes through, so a wrong
// shape here is harmless rather than destructive.
//
// This replaces the old PreToolUse hard block on Read/Grep/Glob. Blocking cost
// a denied call + error + (often) a ToolSearch + the real call — 2–3 extra model
// steps each time — and fought the tools the model is trained on. Compressing
// in place keeps the native tools and still cuts what reaches the context.
//
// Shapes verified against Claude Code 2.1.312 with a dump hook:
//   Bash → { stdout, stderr, interrupted, isImage, noOutputExpected }  (stderr merged into stdout)
//   Read → { type: 'text', file: { filePath, content, numLines, startLine, totalLines } }

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const BASH_FILTER_MIN   = 40;   // lines before per-command noise filtering is worth a rewrite
const BASH_DIGEST_MIN   = 150;  // lines before we digest and spill the full output to disk
const READ_SKELETON_MIN = 400;  // lines in a whole-file Read before it becomes a skeleton
// ponytail: spill files live in the OS temp dir and are never pruned; the OS
// cleans it. Add an age-based sweep if anyone runs week-long sessions.
const SPILL_DIR = path.join(os.tmpdir(), 'brozicode-out');

const lineCount = s => { let n = 1; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; };
const lib = () => import('../servers/brozicode/hooklib.js'); // ~2MB bundle — load only when needed

function emit(updatedToolOutput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput },
  }) + '\n');
}

async function bash(event) {
  const r = event.tool_response;
  if (!r || typeof r.stdout !== 'string' || r.isImage) return;
  const n = lineCount(r.stdout);
  if (n < BASH_FILTER_MIN) return;

  const { stripAnsi, filterOutput, digest } = await lib();
  const cmd   = event.tool_input?.command || '';
  const lines = filterOutput(cmd, stripAnsi(r.stdout).trimEnd());

  let stdout;
  if (lines.length < BASH_DIGEST_MIN) {
    stdout = lines.join('\n');
    if (stdout.length > r.stdout.length * 0.9) return; // not worth a rewrite
  } else {
    // Keep the full output reachable: agents rarely page back, but when they do
    // they need somewhere to go.
    fs.mkdirSync(SPILL_DIR, { recursive: true });
    const spill = path.join(SPILL_DIR, crypto.createHash('sha1').update(cmd + Date.now()).digest('hex').slice(0, 12) + '.log');
    fs.writeFileSync(spill, r.stdout);
    const d = digest(lines);
    stdout = `[BroziCode: ${n} lines → ${d.errors} error line(s), head and tail shown. ` +
             `Full output: ${spill} — grep it or Read with offset/limit]\n${d.text}`;
  }
  emit({ ...r, stdout });
}

async function read(event) {
  const r = event.tool_response, input = event.tool_input || {};
  if (r?.type !== 'text' || typeof r.file?.content !== 'string') return;
  // An explicit slice means the caller wants exact text (usually to edit it).
  if (input.offset != null || input.limit != null) return;
  const fp = r.file.filePath || input.file_path || '';
  if (fp.includes(`${path.sep}.claude${path.sep}`) || fp.startsWith(SPILL_DIR)) return;
  if ((r.file.numLines || lineCount(r.file.content)) < READ_SKELETON_MIN) return;

  const { renderSkeleton } = await lib();
  const sk = renderSkeleton(r.file.content, fp);
  if (!sk) return; // no extractor for this language — leave it alone
  const content =
    `[BroziCode: ${r.file.totalLines ?? r.file.numLines}-line file shown as a skeleton; "L<n>" is the real line number. ` +
    `Read with offset/limit for exact text before editing.]\n${sk}`;
  emit({ ...r, file: { ...r.file, content, numLines: lineCount(content) } });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(input);
    if (event.tool_name === 'Bash') await bash(event);
    else if (event.tool_name === 'Read') await read(event);
  } catch (err) {
    // Fail open: never break the tool call over a compression problem.
    process.stderr.write(`[brozicode] post-tool compress: ${err?.message}\n`);
  }
  process.exit(0);
});
