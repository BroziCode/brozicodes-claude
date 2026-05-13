import { z } from 'zod';
import { parse } from '@babel/parser';
import { promises as fs } from 'fs';
import path from 'path';

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

// ─── Handler ─────────────────────────────────────────────────────────────────

async function handler({ filePath, includeImports, includeTypes, includePrivate }) {
  const resolved = path.resolve(filePath);

  let code;
  try {
    code = await fs.readFile(resolved, 'utf8');
  } catch (err) {
    return {
      content: [{ type: 'text', text: `✗ Could not read file: ${resolved}\n${err.message}` }],
      isError: true,
    };
  }

  let result;
  try {
    result = extractSkeleton(code, resolved, { includeImports, includeTypes, includePrivate });
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `✗ Failed to parse ${path.basename(resolved)}: ${err.message}\n\nThis file may have syntax errors or use unsupported syntax.`,
      }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: buildResponse(resolved, result) }],
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerSmartSearch(server) {
  server.tool(
    'brozi_smart_search',
    `Parse a source file into AST and return only its structural skeleton.
Strips function bodies, returns signatures, types, exports, and imports.
Use instead of reading full files when you need structural overview.
Typical reduction: 2,000 lines → 150 lines.`,
    {
      filePath: z.string().describe('Path to the JS/TS/JSX/TSX file to parse'),
      includeImports: z.boolean().default(true).describe('Include import statements'),
      includeTypes: z.boolean().default(true).describe('Include TS type/interface definitions'),
      includePrivate: z.boolean().default(false).describe('Include private class members'),
    },
    handler
  );
}
