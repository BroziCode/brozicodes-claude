import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Matching ────────────────────────────────────────────────────────────────


export function applyEditToContent(fileContent, oldContent, newContent, filePath) {
  // Tier 1: Exact match — index-spliced (NOT String.replace).
  //  - String.replace interprets dollar-sequences in newContent as special
  //    replacement patterns (matched text, capture groups, pre/post-match) -> silent
  //    corruption. Splicing by index keeps newContent byte-for-byte literal.
  //  - String.replace also silently edits only the FIRST of several matches. We refuse
  //    to guess which (mirrors native Edit's uniqueness requirement).
  const firstIdx = fileContent.indexOf(oldContent);
  if (firstIdx !== -1) {
    if (fileContent.indexOf(oldContent, firstIdx + oldContent.length) !== -1) {
      const count = fileContent.split(oldContent).length - 1;
      return { success: false, error: buildAmbiguityError(fileContent, oldContent, count) };
    }
    const result =
      fileContent.slice(0, firstIdx) + newContent + fileContent.slice(firstIdx + oldContent.length);
    return { success: true, result };
  }

  // Tier 2: indentation-insensitive line match.
  //
  // This used to be gated behind a normalizeWhitespace(file).includes(old) check
  // that almost never passed — normalizeWhitespace trims the string as a whole but
  // not each line, so any block indented differently from the caller's copy fell
  // straight through to the old fuzzy-patch tier. That tier applied hunks with
  // fuzzFactor 2 and trim-only line comparison, which is how a block that appears
  // in two classes got silently rewritten in the WRONG one, and how replacements
  // landed at the wrong indentation (a SyntaxError in Python/YAML). The scan runs
  // unconditionally now, refuses ambiguity like Tier 1 does, and re-indents.
  const fileLines = fileContent.split('\n');
  const oldLines  = oldContent.trim().split('\n').map(l => l.trim());
  const needle    = oldLines.join('\n');

  if (needle !== '') {
    const hits = [];
    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      const slice = fileLines.slice(i, i + oldLines.length).map(l => l.trim());
      if (slice.join('\n') === needle) hits.push(i);
    }

    if (hits.length > 1) {
      return {
        success: false,
        error: buildAmbiguityError(fileContent, oldContent, hits.length) +
               `\n   (matches ignoring indentation start at lines: ${hits.map(i => i + 1).join(', ')})`,
      };
    }

    if (hits.length === 1) {
      const i      = hits[0];
      const before = fileLines.slice(0, i);
      const after  = fileLines.slice(i + oldLines.length);
      return {
        success: true,
        result: [...before, ...reindent(newContent, fileLines[i], oldContent), ...after].join('\n'),
      };
    }
  }

  // No Tier 3. There used to be a `diff` fuzzy-patch fallback here; with fuzz it
  // silently misplaced edits, and without fuzz it can do nothing Tier 2 can't.
  // Failing with a precise "here is the text you should have sent" beats guessing.
  const nearestMatch = findNearestMatch(fileContent, oldContent);
  return {
    success: false,
    error: buildMatchError(fileContent, oldContent, nearestMatch),
  };
}

/**
 * Re-indent newContent to sit where the matched block sat.
 *
 * Tier 2 matches on trimmed lines, so the caller's oldContent (and therefore its
 * newContent) is frequently unindented. Splicing it in verbatim dumped the
 * replacement at column 0 — cosmetic in JS, a SyntaxError in Python or YAML.
 * Shift by the difference between the file's indentation and the caller's.
 */
function reindent(newContent, matchedFirstLine, oldContent) {
  const fileIndent = (matchedFirstLine.match(/^[ \t]*/) || [''])[0];
  const oldFirst   = oldContent.replace(/^\n+/, '').split('\n')[0] ?? '';
  const oldIndent  = (oldFirst.match(/^[ \t]*/) || [''])[0];
  const lines      = newContent.split('\n');

  if (fileIndent === oldIndent) return lines;

  return lines.map(line => {
    if (line.trim() === '') return line;
    // Caller already matched the file's indentation on this line — leave it.
    if (oldIndent && line.startsWith(oldIndent)) return fileIndent + line.slice(oldIndent.length);
    return fileIndent + line;
  });
}

function findNearestMatch(fileContent, oldContent) {
  const targetLine   = oldContent.trim().split('\n')[0].trim();
  const cappedTarget = targetLine.slice(0, 200);
  const allLines     = fileContent.split('\n');

  // Sample at most 500 candidate lines spread across the full file
  const step = Math.max(1, Math.floor(allLines.length / 500));

  let bestScore   = Infinity;
  let bestLine    = null;
  let bestLineNum = 0;

  for (let i = 0; i < allLines.length; i += step) {
    const score = levenshteinDistance(allLines[i].trim().slice(0, 200), cappedTarget);
    if (score < bestScore) {
      bestScore   = score;
      bestLine    = allLines[i];
      bestLineNum = i + 1;
    }
  }

  return bestScore < 50 ? { line: bestLine, lineNum: bestLineNum } : null;
}

/** Space-optimised Levenshtein using two rolling rows instead of a full (m+1)×(n+1) matrix. */
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function buildAmbiguityError(fileContent, oldContent, count) {
  const lines     = fileContent.split('\n');
  const firstLine = oldContent.split('\n')[0].trim();
  const hits      = [];
  lines.forEach((l, i) => { if (firstLine && l.includes(firstLine)) hits.push(i + 1); });

  let msg = `❌ AMBIGUOUS — oldContent matches ${count} locations; refusing to guess which one.\n`;
  msg    += `   First line "${firstLine.slice(0, 90)}" appears near lines: ${hits.slice(0, 10).join(', ')}${hits.length > 10 ? '…' : ''}\n`;
  msg    += `   → Add surrounding context to oldContent so it matches exactly ONE location, then resubmit.`;
  return msg;
}

function buildMatchError(fileContent, oldContent, nearestMatch) {
  const oldLines  = oldContent.split('\n');
  const firstLine = oldLines[0].slice(0, 120);
  const suffix    = oldLines.length > 1 ? ` … (+${oldLines.length - 1} lines)` : '';

  let msg = `❌ MATCH FAILED — oldContent not found in file.\n`;
  msg    += `   Looking for: "${firstLine}"${suffix}\n`;

  if (nearestMatch) {
    const allLines = fileContent.split('\n');
    // Extract a window of lines around the nearest match to give the model
    // the exact text it should use as oldContent.
    const winStart = Math.max(0, nearestMatch.lineNum - 3);
    const winEnd   = Math.min(allLines.length, nearestMatch.lineNum - 1 + oldLines.length + 3);
    const snippet  = allLines.slice(winStart, winEnd).join('\n');

    msg += `\n   Nearest match at line ${nearestMatch.lineNum}: "${nearestMatch.line.trim()}"\n`;
    msg += `\n   ✏ Correct oldContent to use (file lines ${winStart + 1}–${winEnd}):\n`;
    msg += `   \`\`\`\n${snippet}\n   \`\`\`\n`;
    msg += `\n   → Copy the relevant portion above as your oldContent and retry.`;
  } else {
    msg += `\n   No similar line found in file. Verify the text exists verbatim, or use overwrite:true.`;
  }

  return msg;
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function findProjectRoot(filePath) {
  let dir = path.dirname(path.resolve(filePath));

  while (true) {
    for (const marker of ['tsconfig.json', 'package.json']) {
      try {
        await fs.access(path.join(dir, marker));
        return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return path.dirname(path.resolve(filePath)); // fallback
}

/** POSIX single-quote escaping — the only safe way to put a path in a shell string. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function runValidation(validate, editedFiles) {
  if (validate === 'none' || editedFiles.length === 0) return null;
  const projectRoot = await findProjectRoot(editedFiles[0]);
  // Was `"${f}"` — a path containing a double quote, backtick or $( ) escaped the
  // string and ran as a command. Filenames are caller-supplied.
  const escaped     = editedFiles.map(shellQuote).join(' ');

  const cmds = {
    tsc:    'npx --no-install tsc --noEmit 2>&1',
    eslint: `npx --no-install eslint ${escaped} 2>&1`,
    both:   `npx --no-install tsc --noEmit 2>&1 && npx --no-install eslint ${escaped} 2>&1`,
  };

  try {
    const { stdout } = await execAsync(cmds[validate], {
      cwd: projectRoot,
      timeout: 30_000,
    });
    return { passed: true, output: stdout.trim().slice(0, 2000) };
  } catch (err) {
    return {
      passed: false,
      output: (err.stderr || err.stdout || err.message || '').trim().slice(0, 2000),
    };
  }
}

// ─── Response Builder ────────────────────────────────────────────────────────

function buildResponse(results, validationResult, totalEdits, wrote = true) {
  const succeeded   = results.filter(r => r.success);
  const failed      = results.filter(r => !r.success);
  // Edits never attempted because stopOnFirstError aborted the batch early
  const skipped     = totalEdits - results.length;
  const filesEdited = [...new Set(succeeded.map(r => r.file))];

  let text = '';

  if (failed.length === 0 && skipped === 0) {
    text += `✓ Applied ${succeeded.length} edit(s) across ${filesEdited.length} file(s)\n\n`;
    const byFile  = {};
    succeeded.forEach(r => { byFile[r.file] = (byFile[r.file] || 0) + 1; });
    const entries = Object.entries(byFile);
    // TOON-style tabular encoding once the list is large enough that declaring the
    // "edit(s) applied" suffix once (instead of per row) actually saves tokens.
    if (entries.length > 5) {
      text += `files[${entries.length}]{path,edits}:\n`;
      entries.forEach(([file, count]) => { text += `  ${file},${count}\n`; });
    } else {
      entries.forEach(([file, count]) => { text += `  ${file}  ${count} edit(s) applied\n`; });
    }
  } else if (succeeded.length > 0) {
    const skippedNote = skipped > 0 ? `, ${skipped} not attempted` : '';
    // When stopOnFirstError aborts with a failure, NO files are written (atomic batch).
    // Don't print a check-mark for edits that were rolled back — that was misleading.
    const mark = wrote ? '✓' : '○';
    if (!wrote) {
      text += `↩ NOTHING WRITTEN — ${failed.length} edit(s) failed and stopOnFirstError aborted the batch (atomic rollback). ${succeeded.length} edit(s) would have applied${skippedNote}.\n\n`;
    } else {
      text += `⚠ Applied ${succeeded.length} of ${totalEdits} edit(s) — ${failed.length} failed${skippedNote}.\n\n`;
    }
    const byFile = {};
    succeeded.forEach(r => { byFile[r.file] = (byFile[r.file] || 0) + 1; });
    Object.entries(byFile).forEach(([file, count]) => {
      text += `  ${mark} ${file}  ${count} edit(s)${wrote ? '' : ' (not written)'}\n`;
    });
    text += `\nFailed edits:\n`;
    failed.forEach(r => { text += `\n  ✗ ${r.file}\n  ${r.error.split('\n').join('\n  ')}\n`; });
    if (skipped > 0) {
      text += `\n⚠ ${skipped} edit(s) were NOT attempted because stopOnFirstError aborted the batch.\n`;
      text += `  → Fix the failed edit(s) above, then resubmit the ENTIRE batch (all ${totalEdits} edits).\n`;
    }
  } else {
    const skippedNote = skipped > 0 ? ` (${skipped} not attempted)` : '';
    text += `✗ 0 of ${totalEdits} edits applied — all ${failed.length} failed${skippedNote}.\n\n`;
    failed.forEach(r => { text += `\n  ✗ ${r.file}\n  ${r.error.split('\n').join('\n  ')}\n`; });
    if (skipped > 0) {
      text += `\n⚠ ${skipped} edit(s) were NOT attempted.\n`;
      text += `  → Fix the error(s) above, then resubmit the ENTIRE batch (all ${totalEdits} edits).\n`;
    }
  }

  if (validationResult) {
    text += `\nValidation: ${validationResult.passed ? 'passed ✓' : 'FAILED ✗'}`;
    if (validationResult.output) {
      text += `\n${validationResult.output}`;
    }
  }

  return text.trim();
}

// ─── Main Handler ────────────────────────────────────────────────────────────

async function handler({ edits, validate, stopOnFirstError }) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // 1. Group edits by file, resolving paths
  const fileEdits = new Map();
  for (const edit of edits) {
    const resolved = path.isAbsolute(edit.file)
      ? edit.file
      : path.resolve(projectDir, edit.file);
    if (!fileEdits.has(resolved)) fileEdits.set(resolved, []);
    fileEdits.get(resolved).push({ ...edit, resolvedPath: resolved });
  }

  // 2. Load all files in parallel
  const fileContents = new Map();
  const isNewFile    = new Set();

  const readResults = await Promise.all(
    [...fileEdits.entries()].map(async ([filePath, editsForFile]) => {
      const isCreateOrOverwrite = editsForFile.every(
        e => (e.oldContent === undefined || e.oldContent === '') && e.overwrite !== false
      );
      try {
        const content = await fs.readFile(filePath, 'utf8');
        return { filePath, content, isNew: false };
      } catch {
        if (isCreateOrOverwrite) {
          return { filePath, content: '', isNew: true };
        }
        return { filePath, content: null, isNew: false, readError: true };
      }
    })
  );

  for (const { filePath, content, isNew, readError } of readResults) {
    if (readError) {
      return {
        content: [{
          type: 'text',
          text: `✗ Could not read file: ${filePath}\nIf you're creating a new file, omit oldContent entirely.`,
        }],
        isError: true,
      };
    }
    fileContents.set(filePath, content);
    if (isNew) isNewFile.add(filePath);
  }

  // 3. Apply all edits to in-memory copies
  const results         = [];
  const modified        = new Map(fileContents);
  const wholeFileWrites = new Set();
  let aborted           = false;

  for (const [filePath, editsForFile] of fileEdits.entries()) {
    if (aborted) break;

    for (const edit of editsForFile) {
      const isCreate    = edit.oldContent === undefined || edit.oldContent === '';
      const isOverwrite = isCreate && (edit.overwrite === true || isNewFile.has(filePath));

      if (isCreate) {
        if (isOverwrite || isNewFile.has(filePath)) {
          // Two whole-file writes to the same path in one batch: the second
          // silently discarded the first while both were reported as applied.
          if (wholeFileWrites.has(filePath)) {
            results.push({
              success: false,
              file: edit.file,
              error: `Two whole-file writes target this path in one batch — the first would be ` +
                     `silently discarded.\n   → Combine them into ONE edit with the full final content.`,
            });
            if (stopOnFirstError) { aborted = true; break; }
            continue;
          }
          wholeFileWrites.add(filePath);
          modified.set(filePath, edit.newContent);
          results.push({ success: true, file: edit.file, created: isNewFile.has(filePath), resolved: filePath });
        } else {
          results.push({
            success: false,
            file: edit.file,
            error: `File already exists. Pass overwrite: true to replace its entire content.`,
          });
          if (stopOnFirstError) { aborted = true; break; }
        }
        continue;
      }

      const current = modified.get(filePath);
      const { success, result, error } = applyEditToContent(
        current, edit.oldContent, edit.newContent, filePath
      );

      if (success) {
        modified.set(filePath, result);
        results.push({ success: true, file: edit.file });
      } else {
        results.push({ success: false, file: edit.file, error });
        if (stopOnFirstError) { aborted = true; break; }
      }
    }
  }

  // 4. Write changed files in parallel
  const failures    = results.filter(r => !r.success);
  const writeErrors = [];
  let   writtenOk   = [];
  if (failures.length === 0 || !stopOnFirstError) {
    const filesToWrite = stopOnFirstError
      ? [...modified.keys()]
      : [...new Set(results.filter(r => r.success).map(r =>
          path.isAbsolute(r.file) ? r.file : path.resolve(projectDir, r.file)
        ))];

    const targets = filesToWrite
      .filter(fp => modified.get(fp) !== fileContents.get(fp) || isNewFile.has(fp));

    // allSettled, not all: a single EACCES used to reject the whole handler, so
    // the caller got a bare errno and no idea which files had ALREADY been written.
    const settled = await Promise.allSettled(
      targets.map(async fp => {
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(fp, modified.get(fp), 'utf8');
        return fp;
      })
    );

    settled.forEach((res, i) => {
      if (res.status === 'fulfilled') writtenOk.push(targets[i]);
      else writeErrors.push({ file: targets[i], message: res.reason?.message || String(res.reason) });
    });

    // An edit whose file could not be written did NOT succeed — demote it before
    // the summary is built, so the header can't report "✓ Applied 2 edits" above a
    // warning that one of them never reached disk.
    if (writeErrors.length > 0) {
      const failedPaths = new Set(writeErrors.map(e => e.file));
      for (const r of results) {
        if (!r.success) continue;
        const abs = path.isAbsolute(r.file) ? r.file : path.resolve(projectDir, r.file);
        if (failedPaths.has(abs)) {
          r.success = false;
          r.error   = `Edit applied in memory but the file could not be written:\n   ` +
                      writeErrors.find(e => e.file === abs).message;
        }
      }
    }
  }

  // 5. Run validation if all edits succeeded
  const failedNow = results.filter(r => !r.success);
  let validationResult = null;
  if (validate !== 'none' && failedNow.length === 0 && writeErrors.length === 0) {
    // Resolved absolute paths — passing the caller's raw (possibly relative)
    // strings made findProjectRoot resolve against the server's cwd, not the project.
    validationResult = await runValidation(validate, writtenOk);
  }

  // 6. Build and return response
  const wrote        = failures.length === 0 || !stopOnFirstError;
  let   responseText = buildResponse(results, validationResult, edits.length, wrote);

  if (writeErrors.length > 0) {
    responseText +=
      `\n⚠ The batch is PARTIALLY applied — ${writtenOk.length} file(s) reached disk, ` +
      `${writeErrors.length} did not.` +
      (writtenOk.length
        ? `\n  Already written (do NOT re-apply these):\n` +
          writtenOk.map(f => `  ✓ ${f}`).join('\n')
        : '') +
      `\n  → Fix the permission/path problem, then resubmit ONLY the failed file(s).`;
  }

  // Surface where relative paths actually landed — CLAUDE_PROJECT_DIR is often a
  // monorepo root, so a relative path can silently create a file in the wrong tree.
  // Only for files that genuinely got written.
  const created = results.filter(r => r.created && r.resolved && writtenOk.includes(r.resolved));
  if (created.length > 0) {
    responseText += `\n\nCreated new file(s):\n` +
      created.map(r => `  + ${r.resolved}`).join('\n');
  }

  return {
    content: [{ type: 'text', text: responseText }],
    isError: results.some(r => !r.success) || writeErrors.length > 0,
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function registerBatchEdit(server) {
  server.tool(
    'brozi_batch_edit',
    `Apply multiple file edits in one operation with optional local validation.
Use instead of sequential Read→Edit→Verify calls when editing 2+ files.
Whitespace differences in oldContent are tolerated automatically.
Always use absolute paths or paths relative to the project root.`,
    {
      edits: z.array(z.object({
        file:       z.string().describe('Absolute path to the file. Use CLAUDE_PROJECT_DIR as base for relative paths.'),
        oldContent: z.string().optional().describe('The exact block of text to find and replace. Omit entirely to create a new file.'),
        newContent: z.string().describe('The replacement text (or full content for new/overwritten files).'),
        overwrite:  z.boolean().optional().describe('When true and oldContent is absent, replaces the entire file content.'),
      })).min(1).describe('Array of edits to apply'),

      validate: z.enum(['none', 'tsc', 'eslint', 'both'])
        .default('none')
        .describe('Run local validation after edits. Default none — only use when explicitly needed.'),

      stopOnFirstError: z.boolean()
        .default(true)
        .describe('Abort all edits if one fails'),
    },
    handler
  );
}
