import { z } from 'zod';
import { createPatch, applyPatch } from 'diff';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Path parsing ─────────────────────────────────────────────────────────────

function parseFilePath(raw) {
  // #cell=<target> for notebooks
  const cellMatch = raw.match(/^(.+\.ipynb)#cell=(.+)$/i);
  if (cellMatch) return { filePath: cellMatch[1], lineStart: null, lineEnd: null, cellTarget: cellMatch[2] };

  // #N or #N-M line range
  const lineMatch = raw.match(/^(.+?)#(\d+)(?:-(\d+))?$/);
  if (lineMatch) {
    return {
      filePath: lineMatch[1],
      lineStart: parseInt(lineMatch[2], 10),
      lineEnd: lineMatch[3] ? parseInt(lineMatch[3], 10) : null,
      cellTarget: null,
    };
  }

  return { filePath: raw, lineStart: null, lineEnd: null, cellTarget: null };
}

// ─── Unicode normalization ────────────────────────────────────────────────────

function normalizeTypography(str) {
  return str
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...');
}

// ─── Matching ────────────────────────────────────────────────────────────────

function normalizeWhitespace(str) {
  return str
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function applyEditToContent(fileContent, oldContent, newContent, filePath, lineStart, lineEnd) {
  // Constrain search to line range if specified
  let searchContent = fileContent;
  let prefixLines = [];
  let suffixLines = [];

  if (lineStart !== null) {
    const lines = fileContent.split('\n');
    const start = lineStart - 1;
    const end = lineEnd !== null ? lineEnd : lines.length;
    prefixLines = lines.slice(0, start);
    suffixLines = lines.slice(end);
    searchContent = lines.slice(start, end).join('\n');
  }

  const tryMatch = (content) => {
    // Tier 1: Exact match
    if (content.includes(oldContent)) {
      return { success: true, result: content.replace(oldContent, newContent) };
    }

    // Tier 1b: Unicode-normalized exact match
    const normOld = normalizeTypography(oldContent);
    const normContent = normalizeTypography(content);
    if (normContent.includes(normOld)) {
      const idx = normContent.indexOf(normOld);
      return { success: true, result: content.slice(0, idx) + newContent + content.slice(idx + oldContent.length) };
    }

    // Tier 2: Whitespace-normalized match
    const normalizedFile = normalizeWhitespace(content);
    const normalizedOld  = normalizeWhitespace(oldContent);

    if (normalizedFile.includes(normalizedOld)) {
      const fileLines = content.split('\n');
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

    // Tier 3: diff fuzzy patch
    try {
      const patch  = createPatch(path.basename(filePath), oldContent, newContent);
      const result = applyPatch(content, patch, {
        fuzzFactor: 2,
        compareLine: (_lineNum, line, _op, patchContent) =>
          line.trim() === patchContent.trim(),
      });
      if (result !== false) return { success: true, result };
    } catch (_) {}

    return null;
  };

  const matched = tryMatch(searchContent);

  if (matched) {
    if (lineStart !== null) {
      const fullResult = [...prefixLines, ...matched.result.split('\n'), ...suffixLines].join('\n');
      return { success: true, result: fullResult };
    }
    return matched;
  }

  const nearestMatch = findNearestMatch(searchContent, oldContent);
  return {
    success: false,
    error: buildMatchError(oldContent, nearestMatch),
  };
}

function findNearestMatch(fileContent, oldContent) {
  const targetLine = oldContent.trim().split('\n')[0].trim();
  const fileLines  = fileContent.split('\n').slice(0, 200);
  let bestScore    = Infinity;
  let bestLine     = null;
  let bestLineNum  = 0;
  const cappedTarget = targetLine.slice(0, 200);

  fileLines.forEach((line, i) => {
    const score = levenshteinDistance(line.trim().slice(0, 200), cappedTarget);
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
    msg += `\nSuggestion: update old_string to match the actual file content.`;
  }
  return msg;
}

// ─── Notebook support ─────────────────────────────────────────────────────────

function resolveCellTarget(cells, target) {
  if (target === 'first') return 0;
  if (target === 'last') return cells.length - 1;
  const asInt = parseInt(target, 10);
  if (!isNaN(asInt)) return Math.max(0, Math.min(cells.length - 1, asInt));
  // Match by cell id
  const idx = cells.findIndex(c => c.id === target);
  return idx >= 0 ? idx : 0;
}

function cellSourceToString(source) {
  return Array.isArray(source) ? source.join('') : (source || '');
}

function stringToCellSource(str) {
  const lines = str.split('\n');
  return lines.map((l, i) => i < lines.length - 1 ? l + '\n' : l);
}

function makeCell(cellType, source) {
  const base = {
    cell_type: cellType || 'code',
    id: Math.random().toString(36).slice(2, 10),
    metadata: {},
    source: stringToCellSource(source || ''),
  };
  if (base.cell_type === 'code') {
    base.execution_count = null;
    base.outputs = [];
  }
  return base;
}

async function applyNotebookEdit(filePath, edit) {
  let nb;
  try {
    nb = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    return { success: false, error: `Cannot read notebook: ${err.message}` };
  }

  const cells = nb.cells || (nb.cells = []);
  const targetIdx = edit.cellTarget ? resolveCellTarget(cells, edit.cellTarget) : 0;

  switch (edit.cell_action) {
    case 'delete': {
      cells.splice(targetIdx, 1);
      break;
    }
    case 'insert_after': {
      const newCell = makeCell(edit.cell_type, edit.new_string);
      cells.splice(targetIdx + 1, 0, newCell);
      break;
    }
    case 'insert_before': {
      const newCell = makeCell(edit.cell_type, edit.new_string);
      cells.splice(targetIdx, 0, newCell);
      break;
    }
    case 'move_after':
    case 'move_before': {
      const [cell] = cells.splice(targetIdx, 1);
      const destIdx = resolveCellTarget(cells, String(edit.cell_move_target ?? 0));
      const insertAt = edit.cell_action === 'move_after' ? destIdx + 1 : destIdx;
      cells.splice(insertAt, 0, cell);
      break;
    }
    default: {
      // Edit cell source
      if (!edit.cellTarget && cells.length === 0) {
        return { success: false, error: 'Notebook has no cells' };
      }
      const cell = cells[targetIdx];
      if (edit.cell_type) cell.cell_type = edit.cell_type;

      if (edit.overwrite || edit.old_string === undefined) {
        cell.source = stringToCellSource(edit.new_string);
      } else {
        const cellContent = cellSourceToString(cell.source);
        const { success, result, error } = applyEditToContent(
          cellContent, edit.old_string, edit.new_string, filePath, null, null
        );
        if (!success) return { success: false, error };
        cell.source = stringToCellSource(result);
      }
    }
  }

  try {
    await fs.writeFile(filePath, JSON.stringify(nb, null, 1), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: `Cannot write notebook: ${err.message}` };
  }
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
    if (parent === dir) break;
    dir = parent;
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
    const { stdout } = await execAsync(cmds[validate], { cwd: projectRoot, timeout: 30_000 });
    return { passed: true, output: stdout.trim().slice(0, 2000) };
  } catch (err) {
    return { passed: false, output: (err.stderr || err.stdout || err.message || '').trim().slice(0, 2000) };
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
    if (validationResult.output) text += `\n${validationResult.output}`;
  }

  return text.trim();
}

// ─── Main Handler ────────────────────────────────────────────────────────────

async function handler({ edits, validate, stopOnFirstError }) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Group edits by resolved file path, parsing #line-range / #cell= suffixes
  const fileEdits = new Map();
  for (const edit of edits) {
    const { filePath, lineStart, lineEnd, cellTarget } = parseFilePath(edit.file_path);
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectDir, filePath);
    if (!fileEdits.has(resolved)) fileEdits.set(resolved, []);
    fileEdits.get(resolved).push({ ...edit, resolvedPath: resolved, lineStart, lineEnd, cellTarget });
  }

  const results  = [];
  const modified = new Map();
  let aborted    = false;

  for (const [filePath, editsForFile] of fileEdits.entries()) {
    if (aborted) break;
    const isNotebook = filePath.endsWith('.ipynb');

    for (const edit of editsForFile) {
      // ── Notebook edits ────────────────────────────────────────────────────
      if (isNotebook) {
        const result = await applyNotebookEdit(filePath, edit);
        results.push({ success: result.success, file: edit.file_path, error: result.error });
        if (!result.success && stopOnFirstError) { aborted = true; break; }
        continue;
      }

      // ── Overwrite (full file replace) ─────────────────────────────────────
      if (edit.overwrite && edit.old_string === undefined) {
        modified.set(filePath, edit.new_string);
        results.push({ success: true, file: edit.file_path });
        continue;
      }

      // ── File creation (no old_string, no overwrite) ───────────────────────
      if (edit.old_string === undefined) {
        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, edit.new_string, 'utf8');
          results.push({ success: true, file: edit.file_path });
        } catch (err) {
          results.push({ success: false, file: edit.file_path, error: err.message });
          if (stopOnFirstError) { aborted = true; break; }
        }
        continue;
      }

      // ── Regular edit ──────────────────────────────────────────────────────
      if (!modified.has(filePath)) {
        try {
          modified.set(filePath, await fs.readFile(filePath, 'utf8'));
        } catch (err) {
          results.push({ success: false, file: edit.file_path, error: `Cannot read: ${err.message}` });
          if (stopOnFirstError) { aborted = true; break; }
          continue;
        }
      }

      const current = modified.get(filePath);
      const { success, result, error } = applyEditToContent(
        current, edit.old_string, edit.new_string, filePath, edit.lineStart, edit.lineEnd
      );

      if (success) {
        modified.set(filePath, result);
        results.push({ success: true, file: edit.file_path });
      } else {
        results.push({ success: false, file: edit.file_path, error });
        if (stopOnFirstError) { aborted = true; break; }
      }
    }
  }

  // Write in-memory changes to disk
  const failures = results.filter(r => !r.success);
  if (failures.length === 0 || !stopOnFirstError) {
    for (const [filePath, content] of modified.entries()) {
      try {
        await fs.writeFile(filePath, content, 'utf8');
      } catch (err) {
        // Mark as failed if write fails
        results.push({ success: false, file: filePath, error: `Write failed: ${err.message}` });
      }
    }
  }

  // Validate
  let validationResult = null;
  const finalFailures = results.filter(r => !r.success);
  if (validate !== 'none' && finalFailures.length === 0) {
    const editedFiles = [...new Set(results.filter(r => r.success).map(r => r.file))];
    validationResult = await runValidation(validate, editedFiles);
  }

  return {
    content: [{ type: 'text', text: buildResponse(results, validationResult, edits.length) }],
    isError: finalFailures.length > 0,
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function registerBatchEdit(server) {
  server.tool(
    'brozi_batch_edit',
    `Apply multiple file edits in one operation. Matches woz:code Edit behavior.
Supports: fuzzy old_string matching, overwrite mode, file creation, #line-range
constraints, Unicode typography normalization, and Jupyter notebook cell operations.
Always use absolute paths or paths relative to the project root.`,
    {
      edits: z.array(z.object({
        file_path: z.string().describe(
          'Path to the file. May include #N or #N-M to constrain matching to those lines. '
          + 'For .ipynb notebooks, use #cell=<N|id|first|last> to target a cell.'
        ),
        old_string: z.string().optional().describe(
          'Text to find and replace. Omit to create a new file (or combine with overwrite: true to replace entire file).'
        ),
        new_string: z.string().describe('Replacement text (or full file content when creating/overwriting).'),
        overwrite: z.boolean().optional().describe(
          'When true with no old_string: replace entire file content.'
        ),
        cell_action: z.enum(['insert_after', 'insert_before', 'delete', 'move_after', 'move_before'])
          .optional()
          .describe('Notebook-only: structural cell operation.'),
        cell_move_target: z.union([z.string(), z.number()]).optional()
          .describe('Notebook-only: destination cell for move_after / move_before.'),
        cell_type: z.enum(['code', 'markdown']).optional()
          .describe('Notebook-only: cell type for inserts or type change on overwrite.'),
      })).min(1),

      validate: z.enum(['none', 'tsc', 'eslint', 'both'])
        .default('none')
        .describe('Run local validation after edits.'),

      stopOnFirstError: z.boolean()
        .default(true)
        .describe('Abort all edits if one fails.'),
    },
    handler
  );
}
