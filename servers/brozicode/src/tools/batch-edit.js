import { z } from 'zod';
import { createPatch, applyPatch } from 'diff';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Matching ────────────────────────────────────────────────────────────────

function normalizeWhitespace(str) {
  return str
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function applyEditToContent(fileContent, oldContent, newContent, filePath) {
  // Tier 1: Exact match
  if (fileContent.includes(oldContent)) {
    return { success: true, result: fileContent.replace(oldContent, newContent) };
  }

  // Tier 2: Whitespace-normalized match
  const normalizedFile = normalizeWhitespace(fileContent);
  const normalizedOld  = normalizeWhitespace(oldContent);

  if (normalizedFile.includes(normalizedOld)) {
    const fileLines = fileContent.split('\n');
    const oldLines  = oldContent.trim().split('\n').map(l => l.trim());

    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      const slice = fileLines.slice(i, i + oldLines.length).map(l => l.trim());
      if (slice.join('\n') === oldLines.join('\n')) {
        const before = fileLines.slice(0, i);
        const after  = fileLines.slice(i + oldLines.length);
        return {
          success: true,
          result: [...before, ...newContent.split('\n'), ...after].join('\n'),
        };
      }
    }
  }

  // Tier 3: diff library fuzzy patch
  try {
    const patch  = createPatch(path.basename(filePath), oldContent, newContent);
    const result = applyPatch(fileContent, patch, {
      fuzzFactor: 2,
      compareLine: (_lineNum, line, _op, patchContent) =>
        line.trim() === patchContent.trim(),
    });
    if (result !== false) {
      return { success: true, result };
    }
  } catch (_) {
    // fall through to failure
  }

  const nearestMatch = findNearestMatch(fileContent, oldContent);
  return {
    success: false,
    error: buildMatchError(oldContent, nearestMatch),
  };
}

function findNearestMatch(fileContent, oldContent) {
  const targetLine = oldContent.trim().split('\n')[0].trim();
  const fileLines  = fileContent.split('\n');
  let bestScore    = Infinity;
  let bestLine     = null;
  let bestLineNum  = 0;

  fileLines.forEach((line, i) => {
    const score = levenshteinDistance(line.trim(), targetLine);
    if (score < bestScore) {
      bestScore   = score;
      bestLine    = line;
      bestLineNum = i + 1;
    }
  });

  return bestScore < 50 ? { line: bestLine, lineNum: bestLineNum } : null;
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function buildMatchError(oldContent, nearestMatch) {
  const firstLine = oldContent.split('\n')[0].slice(0, 100);
  const ellipsis  = oldContent.split('\n').length > 1 ? '...' : '';
  let msg = `Could not find:\n  "${firstLine}${ellipsis}"`;
  if (nearestMatch) {
    msg += `\nNearest match at line ${nearestMatch.lineNum}:\n  "${nearestMatch.line.trim()}"`;
    msg += `\nSuggestion: update oldContent to match the actual file content.`;
  }
  return msg;
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function findProjectRoot(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.dirname(dir);
  while (dir !== root) {
    for (const marker of ['tsconfig.json', 'package.json']) {
      try {
        await fs.access(path.join(dir, marker));
        return dir;
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return path.dirname(path.resolve(filePath));
}

async function runValidation(validate, editedFiles) {
  if (validate === 'none') return null;
  const projectRoot = await findProjectRoot(editedFiles[0]);
  const escaped     = editedFiles.map(f => `"${f}"`).join(' ');

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

function buildResponse(results, validationResult, totalEdits) {
  const succeeded   = results.filter(r => r.success);
  const failed      = results.filter(r => !r.success);
  const filesEdited = [...new Set(succeeded.map(r => r.file))];

  let text = '';

  if (failed.length === 0) {
    text += `✓ Applied ${succeeded.length} edit(s) across ${filesEdited.length} file(s)\n\n`;
    const byFile = {};
    succeeded.forEach(r => { byFile[r.file] = (byFile[r.file] || 0) + 1; });
    Object.entries(byFile).forEach(([file, count]) => {
      text += `  ${file}  ${count} edit(s) applied\n`;
    });
  } else if (succeeded.length > 0) {
    text += `⚠ Applied ${succeeded.length} of ${totalEdits} edit(s). ${failed.length} failed.\n\n`;
    const byFile = {};
    succeeded.forEach(r => { byFile[r.file] = (byFile[r.file] || 0) + 1; });
    Object.entries(byFile).forEach(([file, count]) => {
      text += `  ${file}  ${count} edit(s) applied\n`;
    });
    text += `\nFailed edits:\n`;
    failed.forEach(r => { text += `  ${r.file} — ${r.error}\n`; });
  } else {
    text += `✗ No edits applied. ${failed.length} error(s).\n\n`;
    failed.forEach(r => { text += `  ${r.file} — ${r.error}\n`; });
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
  // 1. Group edits by file
  const fileEdits = new Map();
  for (const edit of edits) {
    const resolved = path.resolve(edit.file);
    if (!fileEdits.has(resolved)) fileEdits.set(resolved, []);
    fileEdits.get(resolved).push({ ...edit, resolvedPath: resolved });
  }

  // 2. Load all files into memory
  const fileContents = new Map();
  for (const filePath of fileEdits.keys()) {
    try {
      fileContents.set(filePath, await fs.readFile(filePath, 'utf8'));
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `✗ Could not read file: ${filePath}\n${err.message}`,
        }],
        isError: true,
      };
    }
  }

  // 3. Apply all edits to in-memory copies
  const results  = [];
  const modified = new Map(fileContents);
  let aborted    = false;

  for (const [filePath, editsForFile] of fileEdits.entries()) {
    if (aborted) break;
    for (const edit of editsForFile) {
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

  // 4. Write files only if no failures (when stopOnFirstError=true)
  const failures = results.filter(r => !r.success);
  if (failures.length === 0 || !stopOnFirstError) {
    const filesToWrite = stopOnFirstError
      ? [...modified.keys()]
      : [...new Set(results.filter(r => r.success).map(r => path.resolve(r.file)))];

    for (const filePath of filesToWrite) {
      if (modified.get(filePath) !== fileContents.get(filePath)) {
        await fs.writeFile(filePath, modified.get(filePath), 'utf8');
      }
    }
  }

  // 5. Run validation if all edits succeeded
  let validationResult = null;
  if (validate !== 'none' && failures.length === 0) {
    const editedFiles = [...new Set(results.filter(r => r.success).map(r => r.file))];
    validationResult = await runValidation(validate, editedFiles);
  }

  // 6. Build and return response
  const responseText = buildResponse(results, validationResult, edits.length);

  return {
    content: [{ type: 'text', text: responseText }],
    isError: failures.length > 0,
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function registerBatchEdit(server) {
  server.tool(
    'brozi_batch_edit',
    `Apply multiple file edits in one operation with optional local validation.
Use instead of sequential Read→Edit→Verify calls when editing 2+ files.
Whitespace differences in oldContent are tolerated automatically.`,
    {
      edits: z.array(z.object({
        file:       z.string().describe('Absolute or relative path to the file'),
        oldContent: z.string().describe('The exact block of text to find and replace'),
        newContent: z.string().describe('The replacement text'),
      })).min(1).describe('Array of edits to apply'),

      validate: z.enum(['none', 'tsc', 'eslint', 'both'])
        .default('none')
        .describe('Run local validation after edits'),

      stopOnFirstError: z.boolean()
        .default(true)
        .describe('Abort all edits if one fails'),
    },
    handler
  );
}
