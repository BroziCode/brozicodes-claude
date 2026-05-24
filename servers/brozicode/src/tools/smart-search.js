import { z } from 'zod';
import { parse } from '@babel/parser';
import { promises as fs } from 'fs';
import path from 'path';
import fg from 'fast-glob';

// ─── In-process file cache ────────────────────────────────────────────────────
// Persists across all tool calls within the same Node.js session (shared module state).
// Each entry: { mtime: number, content: string, skeletons: Map<optKey, skeletonResult> }
const fileCache = new Map();

// P3: Tracks files already returned to Claude's context this session.
// Prevents re-injecting unchanged file content and refilling the context window.
const returnedFiles = new Map(); // fp → { mtime: number, isoTime: string }

// ─── Parser ──────────────────────────────────────────────────────────────────

function parseFile(code, filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const plugins = [
    'decorators-legacy',
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'exportDefaultFrom',
    'dynamicImport',
    'optionalChaining',
    'nullishCoalescingOperator',
  ];
  if (['ts', 'tsx'].includes(ext)) plugins.push('typescript');
  if (['jsx', 'tsx'].includes(ext)) plugins.push('jsx');

  try {
    return parse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins });
  } catch {
    return parse(code, {
      sourceType: 'script',
      errorRecovery: true,
      plugins: plugins.filter(p => p !== 'typescript'),
    });
  }
}

// ─── Line offset table (O(n) build, O(log n) lookup) ─────────────────────────

function buildLineOffsets(code) {
  const offsets = [0];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** O(log n) char-offset → 1-based line number via binary search. */
function lineOf(charOffset, lineOffsets) {
  let lo = 0, hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= charOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ─── Walker ──────────────────────────────────────────────────────────────────

// Curated child-bearing AST key list — avoids Object.keys() enumeration on every node.
const CHILD_KEYS = [
  'body', 'declarations', 'declaration', 'specifiers', 'params', 'arguments',
  'consequent', 'alternate', 'init', 'test', 'update', 'left', 'right',
  'object', 'property', 'callee', 'expression', 'id', 'superClass', 'value',
  'key', 'elements', 'properties', 'block', 'handler', 'finalizer',
  'cases', 'discriminant', 'tag', 'quasi', 'expressions', 'quasis',
];

/**
 * Generic AST walker. Visitors may return 'skip' to prevent recursing
 * into that node's children (used by ClassDeclaration to avoid double-visiting members).
 */
function walk(node, visitors) {
  if (!node || typeof node !== 'object') return;
  const visit = visitors[node.type];
  if (visit) {
    const result = visit(node);
    if (result === 'skip') return;
  }
  for (const key of CHILD_KEYS) {
    const child = node[key];
    if (!child) continue;
    if (Array.isArray(child)) {
      for (const c of child) { if (c && c.type) walk(c, visitors); }
    } else if (child.type) {
      walk(child, visitors);
    }
  }
}

// ─── Extraction helpers ──────────────────────────────────────────────────────

function getSignature(node, code) {
  const body = node.body ?? node.value?.body;
  if (!body || body.type !== 'BlockStatement') {
    return code.slice(node.start, node.end).split('\n')[0].trimEnd();
  }
  return code.slice(node.start, body.start).trimEnd() + ' { ... }';
}

function getClassHeader(node, code) {
  return code.slice(node.start, node.body.start).trimEnd() + ' {';
}

function isPrivate(node) {
  const name = node.key?.name || node.key?.value || '';
  if (node.accessibility === 'private') return true;
  if (node.key?.type === 'PrivateName') return true;
  if (typeof name === 'string' && name.startsWith('_')) return true;
  return false;
}

function extractImportMeta(node) {
  const source = node.source.value;
  const specifiers = node.specifiers.map(s => {
    if (s.type === 'ImportDefaultSpecifier') return s.local.name;
    if (s.type === 'ImportNamespaceSpecifier') return `* as ${s.local.name}`;
    const imported = s.imported?.name || s.local.name;
    const isType = node.importKind === 'type' || s.importKind === 'type';
    return isType ? `${imported} (type)` : imported;
  });
  return { source, specifiers };
}

function extractExportMeta(node) {
  if (node.declaration) {
    const decl = node.declaration;
    if (decl.id) return [{ name: decl.id.name, kind: decl.type.replace('Declaration', '').toLowerCase() }];
    if (decl.declarations) return decl.declarations.map(d => ({ name: d.id?.name, kind: 'const' }));
  }
  if (node.specifiers) return node.specifiers.map(s => ({ name: s.exported.name, kind: 'specifier' }));
  return [];
}

// ─── Main extractor ──────────────────────────────────────────────────────────

function extractSkeleton(code, filePath, options) {
  const { includeImports, includeTypes, includePrivate } = options;
  const ast         = parseFile(code, filePath);
  const lineOffsets = buildLineOffsets(code); // built once — O(n)
  const totalLines  = lineOffsets.length;

  const skeletonLines = [];
  const imports = [];
  const exports = [];

  // addLine now takes a char offset and resolves line via O(log n) binary search
  const addLine = (charOffset, text, indent = '') => {
    skeletonLines.push({ lineNum: lineOf(charOffset, lineOffsets), text: indent + text });
  };

  walk(ast, {
    ClassDeclaration(node) {
      addLine(node.start, getClassHeader(node, code));

      for (const member of node.body.body) {
        if (!includePrivate && isPrivate(member)) continue;
        if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
          addLine(member.start, getSignature(member, code), '  ');
        } else if (member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty') {
          const propText     = code.slice(member.start, member.end).split('\n')[0];
          const withoutValue = propText.replace(/\s*=\s*.+$/, ';').trimEnd();
          addLine(member.start, withoutValue, '  ');
        }
      }

      // Closing brace — last char of the class body block is at node.body.end - 1
      skeletonLines.push({ lineNum: lineOf(node.body.end - 1, lineOffsets), text: '}' });

      return 'skip'; // members already handled above — prevent walker from re-entering body
    },

    ImportDeclaration(node) {
      if (!includeImports) return;
      addLine(node.start, code.slice(node.start, node.end).split('\n')[0].trimEnd());
      imports.push(extractImportMeta(node));
    },

    ExportAllDeclaration(node) {
      addLine(node.start, code.slice(node.start, node.end).trimEnd());
    },

    ExportNamedDeclaration(node) {
      if (!node.declaration) {
        addLine(node.start, code.slice(node.start, node.end).trimEnd());
      }
      const meta = extractExportMeta(node);
      meta.forEach(m => m?.name && exports.push(m));
    },

    ExportDefaultDeclaration(node) {
      const decl = node.declaration;
      if (decl.type === 'ClassDeclaration' || decl.type === 'FunctionDeclaration') {
        addLine(node.start, 'export default ' + getSignature(decl, code));
        exports.push({ name: decl.id?.name || 'default', kind: 'default' });
      } else {
        addLine(node.start, 'export default ' + code.slice(decl.start, decl.end).split('\n')[0]);
        exports.push({ name: 'default', kind: 'default' });
      }
    },

    FunctionDeclaration(node) {
      addLine(node.start, getSignature(node, code));
    },

    VariableDeclaration(node) {
      for (const decl of node.declarations) {
        const init = decl.init;
        if (!init) continue;
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
          addLine(node.start, getSignature({ ...node, body: init.body }, code));
        }
      }
    },

    TSInterfaceDeclaration(node) {
      if (!includeTypes) return;
      addLine(node.start, code.slice(node.start, node.end));
    },

    TSTypeAliasDeclaration(node) {
      if (!includeTypes) return;
      addLine(node.start, code.slice(node.start, node.end));
    },

    TSEnumDeclaration(node) {
      if (!includeTypes) return;
      addLine(node.start, code.slice(node.start, node.end));
    },
  });

  // Sort by line number, deduplicate
  const seen   = new Set();
  const sorted = skeletonLines
    .sort((a, b) => a.lineNum - b.lineNum)
    .filter(({ lineNum }) => {
      if (seen.has(lineNum)) return false;
      seen.add(lineNum);
      return true;
    });

  return { sorted, totalLines, imports, exports };
}

// ─── Response builder ────────────────────────────────────────────────────────

function buildResponse(filePath, result, projectDir) {
  const { sorted, totalLines, imports, exports } = result;
  const rel     = projectDir ? path.relative(projectDir, filePath) : path.basename(filePath);
  const display = rel.startsWith('..') ? path.basename(filePath) : rel;

  let out = `# ${display} (${totalLines}→${sorted.length} lines)\n`;

  for (const { lineNum, text } of sorted) {
    out += `L${String(lineNum).padEnd(4)} ${text}\n`;
  }

  if (exports.length > 0) {
    const unique = [...new Map(exports.map(e => [e.name, e])).values()];
    out += `\nexports: ${unique.map(e => `${e.name} (${e.kind})`).join(', ')}\n`;
  }

  if (imports.length > 0) {
    const importStr = imports
      .map(({ source, specifiers }) => `${source} → ${specifiers.join(', ')}`)
      .join(' | ');
    out += `imports: ${importStr}\n`;
  }

  return out.trim();
}

// ─── Glob / line-range helpers ────────────────────────────────────────────────

/** Parse "src/**\/*.ts#10-40" → { pattern: "src/**\/*.ts", lineStart: 10, lineEnd: 40 } */
function parseGlobPattern(raw) {
  const hashIdx = raw.lastIndexOf('#');
  if (hashIdx === -1) return { pattern: raw, lineStart: null, lineEnd: null };

  const rangePart = raw.slice(hashIdx + 1);
  const match     = rangePart.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return { pattern: raw, lineStart: null, lineEnd: null };

  return {
    pattern:   raw.slice(0, hashIdx),
    lineStart: parseInt(match[1], 10),
    lineEnd:   match[2] ? parseInt(match[2], 10) : parseInt(match[1], 10),
  };
}

/**
 * Slice a pre-split lines array — avoids re-splitting the content string.
 * lineStart / lineEnd are 1-based, inclusive. Returns all lines when lineStart is null.
 */
function sliceLines(lines, lineStart, lineEnd) {
  if (lineStart === null) return lines;
  const start = Math.max(0, lineStart - 1);
  const end   = Math.min(lines.length, lineEnd);
  return lines.slice(start, end);
}

function truncateLine(line, maxLen) {
  if (maxLen <= 0 || line.length <= maxLen) return line;
  return line.slice(0, maxLen) + '…';
}

/** Add 1-based line numbers to an array of line strings. Returns a joined string. */
function addLineNumbers(lines, startLine = 1) {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)}: ${line}`)
    .join('\n');
}

// ─── Regex match context extraction (grep -A/-B style) ───────────────────────

function extractMatchContext(lines, regex, linesBefore, linesAfter, linesPerFile, maxLineLength) {
  const matchedLineIdxs = [];
  let matchCount = 0;

  for (let i = 0; i < lines.length; i++) {
    regex.lastIndex = 0;
    if (regex.test(lines[i])) {
      matchedLineIdxs.push(i);
      matchCount++;
      if (linesPerFile > 0 && matchCount >= linesPerFile) break;
    }
  }

  if (matchedLineIdxs.length === 0) return null;

  // Build ranges [start, end] (0-indexed, inclusive)
  const ranges = matchedLineIdxs.map(idx => ({
    start: Math.max(0, idx - linesBefore),
    end:   Math.min(lines.length - 1, idx + linesAfter),
  }));

  // Merge overlapping/adjacent ranges
  const merged = [];
  for (const r of ranges) {
    if (merged.length && r.start <= merged[merged.length - 1].end + 1) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  const parts = [];
  for (const { start, end } of merged) {
    const chunk = lines.slice(start, end + 1).map((line, i) => {
      const lineNo = String(start + i + 1).padStart(5);
      return `${lineNo}: ${truncateLine(line, maxLineLength)}`;
    });
    parts.push(chunk.join('\n'));
  }

  return { text: parts.join('\n  ···\n'), matchCount };
}

// ─── Path relativizer ─────────────────────────────────────────────────────────

function relativize(absPath, projectDir) {
  const rel = path.relative(projectDir, absPath);
  return rel.startsWith('..') ? absPath : rel;
}

// ─── Multi-file handler ───────────────────────────────────────────────────────

async function handler({
  file_glob_patterns,
  content_regex,
  output_mode,
  summary,
  if_modified_since,
  type,
  file_limit,
  lines_before,
  lines_after,
  lines_per_file,
  max_line_length,
  ignore_case,
  multiline,
  includeImports,
  includeTypes,
  includePrivate,
  relevance_threshold,
}) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sinceMs    = if_modified_since ? new Date(if_modified_since).getTime() : null;

  // Build regex flags
  let reFlags = 'g';
  if (ignore_case) reFlags += 'i';
  if (multiline)   reFlags += 'm';
  const contentRe = content_regex ? new RegExp(content_regex, reFlags) : null;

  const useContext = contentRe && (lines_before > 0 || lines_after > 0);

  // 1. Expand all glob patterns in parallel
  const patternResults = await Promise.all(
    file_glob_patterns.map(async raw => {
      const { pattern, lineStart, lineEnd } = parseGlobPattern(raw);
      const isAbsolutePattern = path.isAbsolute(pattern);
      const matches = await fg(pattern, {
        cwd:      isAbsolutePattern ? '/' : projectDir,
        absolute: true,
        dot:      true,
        ignore:   ['**/node_modules/**', '**/.git/**'],
      });
      return { matches, lineStart, lineEnd };
    })
  );

  const fileLineRanges = new Map(); // filePath → { lineStart, lineEnd }
  for (const { matches, lineStart, lineEnd } of patternResults) {
    for (const absPath of matches) {
      if (type) {
        const ext = path.extname(absPath).slice(1).toLowerCase();
        if (ext !== type.toLowerCase()) continue;
      }
      if (!fileLineRanges.has(absPath) || lineStart !== null) {
        fileLineRanges.set(absPath, { lineStart, lineEnd });
      }
    }
  }

  if (fileLineRanges.size === 0) {
    return { content: [{ type: 'text', text: 'No files matched the provided glob patterns.' }] };
  }

  // 2. Stat + cache-aware read — combines if_modified_since filter, cache hit detection,
  //    and disk reads into a single parallel pass.
  const filePaths = [...fileLineRanges.keys()];

  const statReadResults = await Promise.all(
    filePaths.map(async fp => {
      try {
        const stat  = await fs.stat(fp);
        const mtime = stat.mtimeMs;

        // if_modified_since filter
        if (sinceMs !== null && mtime <= sinceMs) return null;

        // path-only mode: no content needed
        if (output_mode === 'file_paths_only') return { fp, content: '', mtime };

        // Cache hit — serve without re-reading disk
        const cached = fileCache.get(fp);
        if (cached && cached.mtime === mtime) {
          return { fp, content: cached.content, mtime };
        }

        // Cache miss — read from disk and populate cache
        const content = await fs.readFile(fp, 'utf8');
        fileCache.set(fp, { mtime, content, skeletons: new Map() });
        return { fp, content, mtime };
      } catch {
        return null;
      }
    })
  );

  // 3. Filter nulls and handle path-only output
  const validEntries = statReadResults.filter(Boolean);

  if (output_mode === 'file_paths_only') {
    let paths = validEntries.map(e => e.fp).sort();
    if (file_limit > 0 && paths.length > file_limit) paths = paths.slice(0, file_limit);
    // P2: TOON — relative paths, no padding
    const text = paths.map(p => relativize(p, projectDir)).join('\n');
    return { content: [{ type: 'text', text: text || 'No files matched.' }] };
  }

  // 4. Apply file_limit and sort for stable output
  let readResults = validEntries;
  if (file_limit > 0 && readResults.length > file_limit) {
    readResults = readResults.slice(0, file_limit);
  }
  readResults = readResults.sort((a, b) => (a.fp < b.fp ? -1 : 1));

  // 6. Process files, apply content_regex filter, build output
  const sections     = [];
  const matchCounts  = [];
  // Claude Code's internal MCP result token limit is well below 400KB;
  // 150KB keeps individual responses safely under that threshold.
  const MAX_RESPONSE_BYTES  = 150_000;
  // JS/TS files larger than this get auto-skeletonized in plain-content mode
  // to prevent the chunk-read spiral that occurs when a raw 2500-line file
  // overflows Claude Code's MCP response buffer.
  const MAX_FILE_LINES_RAW  = 300;
  let responseSize   = 0;
  const skippedFiles = [];

  for (const entry of readResults) {
    if (!entry) continue;
    const { fp, content, mtime } = entry;

    // Split lines once per file — reused across all processing paths below
    const contentLines = content.split('\n');

    // Content regex filter / match counting
    let matchCount = 0;
    if (contentRe) {
      contentRe.lastIndex = 0;
      const allMatches = [...content.matchAll(contentRe)];
      if (allMatches.length === 0) continue;
      matchCount = allMatches.length;
    }

    matchCounts.push({ fp, matchCount });

    // Relevance threshold — skip files below match density (matches / total lines)
    if (relevance_threshold > 0 && contentRe && matchCount > 0) {
      const density = matchCount / Math.max(1, contentLines.length);
      if (density < relevance_threshold) continue;
    }

    if (output_mode === 'file_paths_with_match_count') continue;

    // Apply line range
    const { lineStart, lineEnd } = fileLineRanges.get(fp);
    const rangeLabel = lineStart !== null ? `#${lineStart}-${lineEnd}` : '';
    const ext        = path.extname(fp).slice(1).toLowerCase();
    const isJsTs     = ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext);

    // ── Build the section string ──────────────────────────────────────────
    let section;

    if (summary) {
      if (isJsTs) {
        try {
          // Use cached skeleton when available (same options key)
          const optKey = `${includeImports}-${includeTypes}-${includePrivate}`;
          const cEntry = fileCache.get(fp);
          let skeleton;
          if (cEntry?.skeletons?.has(optKey)) {
            skeleton = cEntry.skeletons.get(optKey);
          } else {
            skeleton = extractSkeleton(content, fp, { includeImports, includeTypes, includePrivate });
            cEntry?.skeletons?.set(optKey, skeleton);
          }
          section = `### ${relativize(fp, projectDir)}${rangeLabel}\n${buildResponse(fp, skeleton, projectDir)}`;
          // Record full-file skeleton returns for stale detection
          if (lineStart === null) returnedFiles.set(fp, { mtime, isoTime: new Date(mtime).toISOString() });
        } catch {
          const sliced = sliceLines(contentLines, lineStart, lineEnd);
          section = `### ${relativize(fp, projectDir)}${rangeLabel}\n${addLineNumbers(sliced, lineStart ?? 1)}`;
        }
      } else {
        const sliced = sliceLines(contentLines, lineStart, lineEnd);
        section = `### ${relativize(fp, projectDir)}${rangeLabel}\n${sliced.join('\n')}`;
      }

    } else if (useContext) {
      // Reuse the already-compiled contentRe — extractMatchContext resets lastIndex per line
      contentRe.lastIndex = 0;
      const ctx = extractMatchContext(
        contentLines,
        contentRe,
        lines_before,
        lines_after,
        lines_per_file,
        max_line_length,
      );
      if (!ctx) continue;
      section = `### ${relativize(fp, projectDir)}  (${ctx.matchCount} match${ctx.matchCount !== 1 ? 'es' : ''})\n${ctx.text}`;

    } else {
      // P3: Stale-read detection — if this file was already returned this session and
      // hasn't changed on disk, substitute a compact reference instead of re-injecting
      // the full content. Saves the entire file's token cost on repeated reads.
      if (lineStart === null && !useContext && returnedFiles.has(fp)) {
        const prev = returnedFiles.get(fp);
        if (prev.mtime === mtime) {
          section =
            `### ${relativize(fp, projectDir)}\n` +
            `[in-context — unchanged since ${prev.isoTime}. ` +
            `Skip: if_modified_since:"${prev.isoTime}" | Slice: #N-M | Skeleton: summary:true]`;
        }
      }

      // Plain content mode — but auto-skeleton large JS/TS files with no explicit range.
      // Without this gate a 2500-line file returns ~90KB raw, exceeds Claude Code's
      // internal MCP token buffer, gets saved to disk, and triggers an expensive
      // chunk-read subagent spiral (observed cost: ~57k tokens on a single file).
      if (!section && isJsTs && lineStart === null && contentLines.length > MAX_FILE_LINES_RAW) {
        try {
          const optKey = `${includeImports}-${includeTypes}-${includePrivate}`;
          const cEntry = fileCache.get(fp);
          let   skeleton;
          if (cEntry?.skeletons?.has(optKey)) {
            skeleton = cEntry.skeletons.get(optKey);
          } else {
            skeleton = extractSkeleton(content, fp, { includeImports, includeTypes, includePrivate });
            cEntry?.skeletons?.set(optKey, skeleton);
          }
          const note = `⚡auto-skeleton (${contentLines.length} lines — add summary:true or a #N-M range to silence this)`;
          section = `### ${relativize(fp, projectDir)} ${note}\n${buildResponse(fp, skeleton, projectDir)}`;
          // Record this auto-skeleton return for stale detection
          returnedFiles.set(fp, { mtime, isoTime: new Date(mtime).toISOString() });
        } catch {
          // skeleton failed — fall through to plain truncated output
        }
      }

      if (!section) {
        // Standard plain-content path: slice, apply limits, add line numbers
        let fileLines = sliceLines(contentLines, lineStart, lineEnd);
        if (max_line_length > 0) fileLines = fileLines.map(l => truncateLine(l, max_line_length));
        if (lines_per_file > 0 && fileLines.length > lines_per_file) {
          fileLines = fileLines.slice(0, lines_per_file);
          fileLines.push(`  … (truncated at ${lines_per_file} lines)`);
        }
        const lineInfo = lineStart !== null ? ` (lines ${lineStart}–${lineEnd})` : '';
        section = `### ${relativize(fp, projectDir)}${lineInfo}\n${addLineNumbers(fileLines, lineStart ?? 1)}`;
        // Record full-file plain returns for stale detection
        if (lineStart === null && !useContext) {
          returnedFiles.set(fp, { mtime, isoTime: new Date(mtime).toISOString() });
        }
      }
    }

    // ── Per-file response size guard ──────────────────────────────────────
    if (responseSize + section.length > MAX_RESPONSE_BYTES) {
      if (isJsTs && !summary) {
        try {
          const skeleton    = extractSkeleton(content, fp, { includeImports, includeTypes, includePrivate });
          const autoSummary = `### ${relativize(fp, projectDir)} ⚡auto-summary\n${buildResponse(fp, skeleton, projectDir)}`;
          if (responseSize + autoSummary.length <= MAX_RESPONSE_BYTES) {
            sections.push(autoSummary);
            responseSize += autoSummary.length + 2;
            continue;
          }
        } catch {}
      }
      skippedFiles.push(path.basename(fp));
      continue;
    }

    sections.push(section);
    responseSize += section.length + 2;
  }

  // ── match_count mode ─────────────────────────────────────────────────────
  if (output_mode === 'file_paths_with_match_count') {
    if (matchCounts.length === 0) {
      return { content: [{ type: 'text', text: 'No files matched.' }] };
    }
    // P2: TOON format — relpath:count, no padding, relative paths
    const text = matchCounts
      .sort((a, b) => b.matchCount - a.matchCount)
      .map(({ fp, matchCount }) => `${relativize(fp, projectDir)}:${matchCount}`)
      .join('\n');
    return { content: [{ type: 'text', text: text }] };
  }

  if (skippedFiles.length > 0) {
    sections.push(
      `⚠ ${skippedFiles.length} file(s) omitted — response exceeded 150KB limit: ${skippedFiles.join(', ')}\n` +
      `  Use file_limit, tighter glob patterns, or #N-M line ranges to narrow the query.`
    );
  }

  if (sections.length === 0) {
    return { content: [{ type: 'text', text: 'No files matched (after content_regex filtering).' }] };
  }

  return { content: [{ type: 'text', text: sections.join('\n\n') }] };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerSmartSearch(server) {
  server.tool(
    'brozi_smart_search',
    'glob+grep+read+AST in one call. Replaces Read/Grep/Glob. Append #N-M to globs for line ranges. Large JS/TS files auto-skeletonized. Repeated full-file reads return compact in-context notice.',
    {
      file_glob_patterns: z.array(z.string()).min(1)
        .describe('Glob patterns to match files. Append #N-M to limit to a line range.'),

      content_regex: z.string().optional()
        .describe('Filter: only include files whose content matches this regex.'),

      output_mode: z.enum(['file_paths_with_content', 'file_paths_only', 'file_paths_with_match_count'])
        .default('file_paths_with_content')
        .describe('Controls output verbosity.'),

      summary: z.boolean().default(false)
        .describe('For JS/TS files: return AST skeleton (signatures, exports) instead of raw source.'),

      if_modified_since: z.string().optional()
        .describe('ISO 8601 timestamp. Skip files not modified after this date.'),

      type: z.string().optional()
        .describe('Extension filter (without dot): "ts", "js", "sql", etc.'),

      file_limit: z.number().int().min(0).default(0)
        .describe('Max files to process. 0 = unlimited.'),

      lines_before: z.number().int().min(0).default(0)
        .describe('Context lines before each regex match (like grep -B).'),

      lines_after: z.number().int().min(0).default(0)
        .describe('Context lines after each regex match (like grep -A).'),

      lines_per_file: z.number().int().min(0).default(0)
        .describe('Max matching lines shown per file. 0 = unlimited.'),

      max_line_length: z.number().int().min(0).default(0)
        .describe('Truncate lines longer than this. 0 = unlimited.'),

      ignore_case: z.boolean().default(false)
        .describe('Case-insensitive regex matching.'),

      multiline: z.boolean().default(false)
        .describe('Multiline flag — ^ and $ match line boundaries.'),

      includeImports: z.boolean().default(true)
        .describe('(summary mode) Include import statements in skeleton.'),
      includeTypes: z.boolean().default(true)
        .describe('(summary mode) Include TS type/interface definitions in skeleton.'),
      includePrivate: z.boolean().default(false)
        .describe('(summary mode) Include private class members in skeleton.'),

      relevance_threshold: z.number().min(0).max(1).default(0)
        .describe('Min match density (matches ÷ total lines) to include a file. 0 = disabled. E.g. 0.02 = skip files where <2% of lines match content_regex.'),
    },
    handler
  );
}
