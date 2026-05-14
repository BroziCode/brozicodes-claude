import { z } from 'zod';
import { parse } from '@babel/parser';
import { promises as fs } from 'fs';
import path from 'path';
import fg from 'fast-glob';

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

// ─── Walker ──────────────────────────────────────────────────────────────────

function walk(node, visitors) {
  if (!node || typeof node !== 'object') return;
  const visit = visitors[node.type];
  if (visit) visit(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach(c => { if (c && c.type) walk(c, visitors); });
    } else if (child && typeof child === 'object' && child.type) {
      walk(child, visitors);
    }
  }
}

// ─── Extraction helpers ──────────────────────────────────────────────────────

function lineOf(node, code) {
  return code.slice(0, node.start).split('\n').length;
}

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
  const ast = parseFile(code, filePath);
  const totalLines = code.split('\n').length;

  const skeletonLines = [];
  const imports = [];
  const exports = [];

  const addLine = (lineNum, text, indent = '') => {
    skeletonLines.push({ lineNum, text: indent + text });
  };

  // Track class node ranges so the generic FunctionDeclaration/VariableDeclaration
  // visitors don't double-emit nodes that are inside a class body.
  const classRanges = [];

  function insideClass(node) {
    return classRanges.some(([start, end]) => node.start >= start && node.end <= end);
  }

  walk(ast, {
    ClassDeclaration(node) {
      classRanges.push([node.start, node.end]);
      const ln = lineOf(node, code);
      addLine(ln, getClassHeader(node, code));

      for (const member of node.body.body) {
        if (!includePrivate && isPrivate(member)) continue;
        const memberLn = lineOf(member, code);
        if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
          addLine(memberLn, getSignature(member, code), '  ');
        } else if (member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty') {
          const propText = code.slice(member.start, member.end).split('\n')[0];
          const withoutValue = propText.replace(/\s*=\s*.+$/, ';').trimEnd();
          addLine(memberLn, withoutValue, '  ');
        }
      }
      // Closing brace on the line after the last member
      const closingLine = code.slice(0, node.body.end).split('\n').length;
      addLine(closingLine, '}');
    },

    ImportDeclaration(node) {
      if (!includeImports) return;
      addLine(lineOf(node, code), code.slice(node.start, node.end).split('\n')[0].trimEnd());
      imports.push(extractImportMeta(node));
    },

    ExportAllDeclaration(node) {
      addLine(lineOf(node, code), code.slice(node.start, node.end).trimEnd());
    },

    ExportNamedDeclaration(node) {
      if (!node.declaration) {
        addLine(lineOf(node, code), code.slice(node.start, node.end).trimEnd());
      }
      const meta = extractExportMeta(node);
      meta.forEach(m => m?.name && exports.push(m));
    },

    ExportDefaultDeclaration(node) {
      const decl = node.declaration;
      const ln = lineOf(node, code);
      if (decl.type === 'ClassDeclaration' || decl.type === 'FunctionDeclaration') {
        addLine(ln, 'export default ' + getSignature(decl, code));
        exports.push({ name: decl.id?.name || 'default', kind: 'default' });
      } else {
        addLine(ln, 'export default ' + code.slice(decl.start, decl.end).split('\n')[0]);
        exports.push({ name: 'default', kind: 'default' });
      }
    },

    FunctionDeclaration(node) {
      if (insideClass(node)) return;
      addLine(lineOf(node, code), getSignature(node, code));
    },

    VariableDeclaration(node) {
      if (insideClass(node)) return;
      for (const decl of node.declarations) {
        const init = decl.init;
        if (!init) continue;
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
          addLine(lineOf(node, code), getSignature({ ...node, body: init.body }, code));
        }
      }
    },

    TSInterfaceDeclaration(node) {
      if (!includeTypes) return;
      addLine(lineOf(node, code), code.slice(node.start, node.end));
    },

    TSTypeAliasDeclaration(node) {
      if (!includeTypes) return;
      addLine(lineOf(node, code), code.slice(node.start, node.end));
    },

    TSEnumDeclaration(node) {
      if (!includeTypes) return;
      addLine(lineOf(node, code), code.slice(node.start, node.end));
    },
  });

  // Sort by line number, deduplicate
  const seen = new Set();
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

function buildResponse(filePath, result) {
  const { sorted, totalLines, imports, exports } = result;
  const fileName = path.basename(filePath);

  let out = `📄 ${fileName} — ${totalLines} lines → ${sorted.length} lines extracted\n`;
  out += '━'.repeat(50) + '\n\n';

  for (const { lineNum, text } of sorted) {
    out += `L${String(lineNum).padEnd(4)} ${text}\n`;
  }

  if (exports.length > 0) {
    out += '\n── Exports ' + '─'.repeat(38) + '\n';
    const unique = [...new Map(exports.map(e => [e.name, e])).values()];
    unique.forEach(e => { out += `${e.name} (${e.kind})\n`; });
  }

  if (imports.length > 0) {
    out += '\n── Imports ' + '─'.repeat(38) + '\n';
    imports.forEach(({ source, specifiers }) => {
      out += `${source.padEnd(30)} →  ${specifiers.join(', ')}\n`;
    });
  }

  return out.trim();
}

// ─── Glob / line-range helpers ────────────────────────────────────────────────

/** Parse "src/**\/*.ts#10-40" → { pattern: "src/**\/*.ts", lineStart: 10, lineEnd: 40 } */
function parseGlobPattern(raw) {
  const hashIdx = raw.lastIndexOf('#');
  if (hashIdx === -1) return { pattern: raw, lineStart: null, lineEnd: null };

  const rangePart = raw.slice(hashIdx + 1);
  const match = rangePart.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return { pattern: raw, lineStart: null, lineEnd: null };

  return {
    pattern:   raw.slice(0, hashIdx),
    lineStart: parseInt(match[1], 10),
    lineEnd:   match[2] ? parseInt(match[2], 10) : parseInt(match[1], 10),
  };
}

function sliceLines(content, lineStart, lineEnd) {
  if (lineStart === null) return content;
  const lines = content.split('\n');
  const start = Math.max(0, lineStart - 1);
  const end   = Math.min(lines.length, lineEnd);
  return lines.slice(start, end).join('\n');
}

function truncateLine(line, maxLen) {
  if (maxLen <= 0 || line.length <= maxLen) return line;
  return line.slice(0, maxLen) + '…';
}

function addLineNumbers(content, startLine = 1) {
  const lines = content.split('\n');
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
}) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sinceMs    = if_modified_since ? new Date(if_modified_since).getTime() : null;

  // Build regex flags
  let reFlags = 'g';
  if (ignore_case) reFlags += 'i';
  if (multiline)   reFlags += 'm';
  const contentRe = content_regex ? new RegExp(content_regex, reFlags) : null;

  const useContext = contentRe && (lines_before > 0 || lines_after > 0);

  // 1. Expand all glob patterns, collecting per-file line ranges
  const fileLineRanges = new Map(); // filePath → { lineStart, lineEnd }

  for (const raw of file_glob_patterns) {
    const { pattern, lineStart, lineEnd } = parseGlobPattern(raw);
    const isAbsolute = path.isAbsolute(pattern);

    const matches = await fg(pattern, {
      cwd:      isAbsolute ? '/' : projectDir,
      absolute: true,
      dot:      true,
      ignore:   ['**/node_modules/**', '**/.git/**'],
    });

    for (const absPath of matches) {
      // Extension filter
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

  // 2. Apply if_modified_since filter
  let filePaths = [...fileLineRanges.keys()];
  if (sinceMs !== null) {
    const filtered = [];
    for (const fp of filePaths) {
      try {
        const stat = await fs.stat(fp);
        if (stat.mtimeMs > sinceMs) filtered.push(fp);
      } catch { /* skip unreadable */ }
    }
    filePaths = filtered;
  }

  // 3. Apply file_limit
  if (file_limit > 0 && filePaths.length > file_limit) {
    filePaths = filePaths.slice(0, file_limit);
  }

  // 4. For path-only mode we can skip reading
  if (output_mode === 'file_paths_only') {
    const text = filePaths.sort().join('\n');
    return { content: [{ type: 'text', text: text || 'No files matched.' }] };
  }

  // 5. Read files, apply content_regex filter, build output
  const sections     = [];
  const matchCounts  = [];
  const MAX_RESPONSE_BYTES = 400_000;
  let responseSize   = 0;
  const skippedFiles = [];

  for (const fp of filePaths.sort()) {
    let content;
    try {
      content = await fs.readFile(fp, 'utf8');
    } catch {
      continue;
    }

    // Content regex filter / match counting
    let matchCount = 0;
    if (contentRe) {
      contentRe.lastIndex = 0;
      const allMatches = [...content.matchAll(contentRe)];
      if (allMatches.length === 0) continue;
      matchCount = allMatches.length;
    }

    matchCounts.push({ fp, matchCount });
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
          const skeleton = extractSkeleton(content, fp, { includeImports, includeTypes, includePrivate });
          section = `### ${fp}${rangeLabel}\n${buildResponse(fp, skeleton)}`;
        } catch {
          const sliced = sliceLines(content, lineStart, lineEnd);
          section = `### ${fp}${rangeLabel}\n${addLineNumbers(sliced, lineStart ?? 1)}`;
        }
      } else {
        const sliced = sliceLines(content, lineStart, lineEnd);
        section = `### ${fp}${rangeLabel}\n${sliced}`;
      }

    } else if (useContext) {
      const lines = content.split('\n');
      const ctx = extractMatchContext(
        lines,
        new RegExp(content_regex, reFlags),
        lines_before,
        lines_after,
        lines_per_file,
        max_line_length,
      );
      if (!ctx) continue; // regex had no matches in this file
      section = `### ${fp}  (${ctx.matchCount} match${ctx.matchCount !== 1 ? 'es' : ''})\n${ctx.text}`;

    } else {
      // Plain content mode — apply limits then add line numbers
      let sliced = sliceLines(content, lineStart, lineEnd);
      if (max_line_length > 0 || lines_per_file > 0) {
        let fileLines = sliced.split('\n');
        if (max_line_length > 0) fileLines = fileLines.map(l => truncateLine(l, max_line_length));
        if (lines_per_file > 0 && fileLines.length > lines_per_file) {
          fileLines = fileLines.slice(0, lines_per_file);
          fileLines.push(`  … (truncated at ${lines_per_file} lines)`);
        }
        sliced = fileLines.join('\n');
      }
      const lineInfo = lineStart !== null ? ` (lines ${lineStart}–${lineEnd})` : '';
      section = `### ${fp}${lineInfo}\n${addLineNumbers(sliced, lineStart ?? 1)}`;
    }

    // ── Per-file response size guard ──────────────────────────────────────
    // Before pushing, check if this section would overflow the 400KB cap.
    // For JS/TS files in plain mode, try auto-summary first — gives the agent
    // useful structure instead of a hard skip.
    if (responseSize + section.length > MAX_RESPONSE_BYTES) {
      if (isJsTs && !summary) {
        try {
          const skeleton  = extractSkeleton(content, fp, { includeImports, includeTypes, includePrivate });
          const autoSummary = `### ${fp} ⚡auto-summary\n${buildResponse(fp, skeleton)}`;
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
    const text = matchCounts
      .sort((a, b) => b.matchCount - a.matchCount)
      .map(({ fp, matchCount }) => `${String(matchCount).padStart(5)}  ${fp}`)
      .join('\n');
    return { content: [{ type: 'text', text: text }] };
  }

  if (skippedFiles.length > 0) {
    sections.push(
      `⚠ ${skippedFiles.length} file(s) omitted — response exceeded 400KB limit: ${skippedFiles.join(', ')}\n` +
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
    `Multi-file search, read, and AST-summary tool. Replaces grep + cat + glob.

Params:
  file_glob_patterns  – array of glob strings. Append #N-M to read only those lines.
                        e.g. ["src/**/*.ts", "src/utils.ts#10-40"]
  content_regex       – only return files whose content matches this regex (grep-style)
  output_mode         – "file_paths_with_content" (default) | "file_paths_only" | "file_paths_with_match_count"
  summary             – true → return JS/TS AST skeleton instead of raw content
  if_modified_since   – ISO timestamp; skip files not modified after this date
  type                – extension filter: "ts", "js", "sql", etc.
  file_limit          – max number of files to process (0 = unlimited)
  lines_before        – context lines before each regex match (like grep -B)
  lines_after         – context lines after each regex match (like grep -A)
  lines_per_file      – max matching lines shown per file (0 = unlimited)
  max_line_length     – truncate lines longer than this (0 = unlimited)
  ignore_case         – case-insensitive regex matching
  multiline           – multiline regex flag (^ and $ match line boundaries)

Typical savings: read 20 files in one call instead of 20 sequential Reads.`,
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
    },
    handler
  );
}
