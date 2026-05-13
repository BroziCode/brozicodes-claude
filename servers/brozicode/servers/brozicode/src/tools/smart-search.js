import { z } from 'zod';
import { parse as babelParse } from '@babel/parser';
import { promises as fs } from 'fs';
import path from 'path';
import fg from 'fast-glob';

// ─── AST skeleton (for summary mode) ─────────────────────────────────────────

function parseFile(code, filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const plugins = [
    'decorators-legacy', 'classProperties', 'classPrivateProperties',
    'classPrivateMethods', 'exportDefaultFrom', 'dynamicImport',
    'optionalChaining', 'nullishCoalescingOperator',
  ];
  if (['ts', 'tsx'].includes(ext)) plugins.push('typescript');
  if (['jsx', 'tsx'].includes(ext)) plugins.push('jsx');
  try {
    return babelParse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins });
  } catch {
    return babelParse(code, {
      sourceType: 'script', errorRecovery: true,
      plugins: plugins.filter(p => p !== 'typescript'),
    });
  }
}

function walk(node, visitors) {
  if (!node || typeof node !== 'object') return;
  const visit = visitors[node.type];
  if (visit) visit(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => { if (c && c.type) walk(c, visitors); });
    else if (child && typeof child === 'object' && child.type) walk(child, visitors);
  }
}

function lineOf(node, code) { return code.slice(0, node.start).split('\n').length; }

function getSignature(node, code) {
  const body = node.body ?? node.value?.body;
  if (!body || body.type !== 'BlockStatement') return code.slice(node.start, node.end).split('\n')[0].trimEnd();
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

function extractSkeleton(code, filePath, options) {
  const { includeImports, includeTypes, includePrivate } = options;
  const ast = parseFile(code, filePath);
  const totalLines = code.split('\n').length;
  const skeletonLines = [];
  const imports = [];
  const exports = [];
  const classRanges = [];

  const addLine = (lineNum, text, indent = '') => skeletonLines.push({ lineNum, text: indent + text });
  const insideClass = (node) => classRanges.some(([s, e]) => node.start >= s && node.end <= e);

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
          addLine(memberLn, propText.replace(/\s*=\s*.+$/, ';').trimEnd(), '  ');
        }
      }
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
      if (!node.declaration) addLine(lineOf(node, code), code.slice(node.start, node.end).trimEnd());
      extractExportMeta(node).forEach(m => m?.name && exports.push(m));
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

function buildSkeletonText(filePath, result) {
  const { sorted, totalLines, imports, exports } = result;
  const fileName = path.basename(filePath);
  let out = `📄 ${fileName} — ${totalLines} lines → ${sorted.length} lines extracted\n`;
  out += '━'.repeat(50) + '\n\n';
  for (const { lineNum, text } of sorted) out += `L${String(lineNum).padEnd(4)} ${text}\n`;
  if (exports.length > 0) {
    out += '\n── Exports ' + '─'.repeat(38) + '\n';
    [...new Map(exports.map(e => [e.name, e])).values()].forEach(e => { out += `${e.name} (${e.kind})\n`; });
  }
  if (imports.length > 0) {
    out += '\n── Imports ' + '─'.repeat(38) + '\n';
    imports.forEach(({ source, specifiers }) => {
      out += `${source.padEnd(30)} →  ${specifiers.join(', ')}\n`;
    });
  }
  return out.trim();
}

// ─── Glob resolution ──────────────────────────────────────────────────────────

function parsePatternSuffix(pattern) {
  const lineMatch = pattern.match(/^(.+?)#(\d+)(?:-(\d+))?$/);
  if (lineMatch) {
    return {
      glob: lineMatch[1],
      lineStart: parseInt(lineMatch[2], 10),
      lineEnd: lineMatch[3] ? parseInt(lineMatch[3], 10) : null,
    };
  }
  return { glob: pattern, lineStart: null, lineEnd: null };
}

async function resolvePatterns(rawPatterns, typeFilter, projectDir) {
  const results = [];
  const seen = new Set();

  for (const raw of rawPatterns) {
    const { glob: globPat, lineStart, lineEnd } = parsePatternSuffix(raw);
    const base = path.isAbsolute(globPat) ? globPat : path.join(projectDir, globPat);

    let candidates = [];

    // Try as exact path first
    try {
      const stat = await fs.stat(base);
      if (stat.isFile()) {
        candidates = [base];
      }
    } catch {
      // Use as glob
      try {
        candidates = await fg(base, {
          onlyFiles: true, absolute: true, dot: false,
          ignore: ['**/node_modules/**', '**/.git/**'],
        });
      } catch {
        candidates = [];
      }
    }

    for (const filePath of candidates) {
      if (seen.has(filePath)) continue;
      if (typeFilter) {
        const ext = path.extname(filePath).slice(1).toLowerCase();
        if (ext !== typeFilter.toLowerCase()) continue;
      }
      seen.add(filePath);
      results.push({ filePath, lineStart, lineEnd });
    }
  }

  return results;
}

// ─── Content search ───────────────────────────────────────────────────────────

function searchLines(lines, regex, linesBefore, linesAfter) {
  const rawRanges = [];
  lines.forEach((line, i) => {
    if (regex.test(line)) rawRanges.push({ start: Math.max(0, i - linesBefore), end: Math.min(lines.length - 1, i + linesAfter), matchLine: i });
  });

  // Merge overlapping ranges
  const merged = [];
  for (const r of rawRanges) {
    if (merged.length && r.start <= merged[merged.length - 1].end + 1) {
      const last = merged[merged.length - 1];
      last.end = Math.max(last.end, r.end);
      last.matchLines.push(r.matchLine);
    } else {
      merged.push({ start: r.start, end: r.end, matchLines: [r.matchLine] });
    }
  }
  return merged;
}

function countMatches(lines, regex) {
  return lines.filter(l => regex.test(l)).length;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function truncateLine(line, maxLen) {
  if (maxLen === 0 || line.length <= maxLen) return line;
  const cutStart = Math.floor(maxLen / 2);
  const cutEnd = line.length - (maxLen - cutStart);
  return line.slice(0, cutStart) + `[⋯${cutStart + 1}-${cutEnd}]` + line.slice(cutEnd);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDate(mtime) {
  return mtime.toISOString().replace('T', ' ').slice(0, 16);
}

function nowISO() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(params) {
  const {
    file_glob_patterns,
    content_regex,
    output_mode = 'file_paths_with_content',
    summary = false,
    type,
    file_limit,
    lines_before = 0,
    lines_after = 0,
    lines_per_file = 500,
    max_line_length = 1000,
    if_modified_since,
    ignore_case = false,
    multiline = false,
  } = params;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sinceDate = if_modified_since ? new Date(if_modified_since) : null;
  const timestamp = `Results as of ${nowISO()}. Pass this value as if_modified_since on next search to skip unchanged files.`;

  // Build regex
  let regex = null;
  if (content_regex) {
    const flags = (ignore_case ? 'i' : '') + (multiline ? 's' : '');
    try {
      regex = new RegExp(content_regex, flags);
    } catch (err) {
      return { content: [{ type: 'text', text: `✗ Invalid regex: ${err.message}` }], isError: true };
    }
  }

  // Resolve files
  let files = await resolvePatterns(file_glob_patterns, type, projectDir);
  if (file_limit && files.length > file_limit) files = files.slice(0, file_limit);

  // ── file_paths_only ────────────────────────────────────────────────────────
  if (output_mode === 'file_paths_only') {
    const lines = [timestamp];
    for (const { filePath } of files) {
      try {
        const stat = await fs.stat(filePath);
        if (regex) {
          const content = await fs.readFile(filePath, 'utf8');
          if (!regex.test(content)) continue;
        }
        const rel = path.relative(projectDir, filePath);
        lines.push(`${rel}\t(${formatSize(stat.size)}, ${formatDate(stat.mtime)})`);
      } catch {}
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ── file_paths_with_match_count ────────────────────────────────────────────
  if (output_mode === 'file_paths_with_match_count') {
    const lines = [timestamp];
    for (const { filePath } of files) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const fileLines = content.split('\n');
        const count = regex ? countMatches(fileLines, regex) : fileLines.length;
        if (regex && count === 0) continue;
        const rel = path.relative(projectDir, filePath);
        lines.push(`${rel}\t${count}`);
      } catch {}
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ── file_paths_with_content ────────────────────────────────────────────────
  const sections = [timestamp];

  for (const { filePath, lineStart, lineEnd } of files) {
    let stat;
    try { stat = await fs.stat(filePath); } catch { continue; }

    const rel = path.relative(projectDir, filePath);
    const header = `${rel}\n${formatSize(stat.size)}\n${formatDate(stat.mtime)}\n---`;

    if (sinceDate && stat.mtime <= sinceDate) {
      sections.push(`${header}\n(unchanged)`);
      continue;
    }

    let content;
    try { content = await fs.readFile(filePath, 'utf8'); } catch (err) {
      sections.push(`${header}\n(error: ${err.message})`);
      continue;
    }

    // Slice to line range if specified
    let allLines = content.split('\n');
    let lineOffset = 0;
    if (lineStart !== null) {
      const start = lineStart - 1;
      const end = lineEnd !== null ? lineEnd : allLines.length;
      allLines = allLines.slice(start, end);
      lineOffset = start;
    }

    // summary mode for JS/TS
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (summary && ['js', 'ts', 'jsx', 'tsx'].includes(ext)) {
      try {
        const skeleton = extractSkeleton(allLines.join('\n'), filePath, {
          includeImports: true, includeTypes: true, includePrivate: false,
        });
        sections.push(`${header}\n${buildSkeletonText(filePath, skeleton)}`);
        continue;
      } catch { /* fall through to raw content */ }
    }

    // Content regex search
    if (regex) {
      const ranges = searchLines(allLines, regex, lines_before, lines_after);
      if (ranges.length === 0) continue;

      let lineCount = 0;
      const contentLines = [];

      for (const { start, end } of ranges) {
        if (lines_per_file > 0 && lineCount >= lines_per_file) break;
        if (contentLines.length > 0) contentLines.push('---');
        for (let i = start; i <= end; i++) {
          if (lines_per_file > 0 && lineCount >= lines_per_file) break;
          contentLines.push(`${lineOffset + i + 1}: ${truncateLine(allLines[i], max_line_length)}`);
          lineCount++;
        }
      }

      sections.push(`${header}\n${contentLines.join('\n')}`);
    } else {
      // Full content
      let outputLines = allLines;
      if (lines_per_file > 0 && outputLines.length > lines_per_file) {
        outputLines = [...outputLines.slice(0, lines_per_file), `... (${allLines.length - lines_per_file} more lines)` ];
      }
      sections.push(`${header}\n${outputLines.map(l => truncateLine(l, max_line_length)).join('\n')}`);
    }
  }

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}

// ─── Registration ──────────────────────────────────────────────────────────────

export function registerSmartSearch(server) {
  server.tool(
    'brozi_smart_search',
    `Combined file discovery, grep, and reading tool. Matches woz:code Search behavior.
Use output_mode "file_paths_with_content" whenever file contents may be needed.
Set summary: true for JS/TS AST skeleton instead of raw content.
Supports glob patterns, content regex, line ranges (#N or #N-M suffix), caching via if_modified_since.`,
    {
      file_glob_patterns: z.array(z.string()).min(1).describe(
        'Glob patterns or exact paths. May include #N or #N-M suffix to read only those lines.'
      ),
      content_regex: z.string().optional().describe(
        'Regex to search file contents. Combine with file_glob_patterns to filter files by content.'
      ),
      output_mode: z.enum(['file_paths_with_content', 'file_paths_only', 'file_paths_with_match_count'])
        .default('file_paths_with_content')
        .describe('Controls result shape. Prefer file_paths_with_content whenever file contents may be needed.'),
      summary: z.boolean().default(false).describe(
        'For JS/TS files: return AST skeleton (signatures, exports, imports) instead of raw content.'
      ),
      type: z.string().optional().describe('Filter by file extension, e.g. "ts", "js", "sql".'),
      file_limit: z.number().int().positive().optional().describe('Max files to process.'),
      lines_before: z.number().int().min(0).default(0).describe('Context lines before each regex match.'),
      lines_after: z.number().int().min(0).default(0).describe('Context lines after each regex match.'),
      lines_per_file: z.number().int().min(0).default(500).describe('Max matching lines per file (0 = unlimited).'),
      max_line_length: z.number().int().min(0).default(1000).describe('Truncate lines longer than this (0 = unlimited).'),
      if_modified_since: z.string().optional().describe(
        'ISO timestamp from a previous Results header. Files unchanged since this time return "(unchanged)".'
      ),
      ignore_case: z.boolean().default(false).describe('Case-insensitive regex matching.'),
      multiline: z.boolean().default(false).describe('Enable multiline mode where . matches newlines.'),
    },
    handler
  );
}
