/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Lock every source-derived refusal token to one reviewed Stage 3 disposition and fail for both new unclassified emitters and stale inventory entries.
 * 2   | maintainer@emeraldcoastsystemsgroup.com   | Cover every tracked executable production JS/TS-family source and inline HTML script, including JSX/template literals while excluding in-tree test files and inventory self-seeding.
 * 3   | maintainer@emeraldcoastsystemsgroup.com   | Inventory literal RefusalError constructor codes independently of the suffix heuristic so a new typed refusal cannot evade disposition review by naming shape.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  REFUSAL_CODE_CLASSIFICATION,
  REFUSAL_CODES_BY_DISPOSITION,
  type RefusalDisposition,
} from '@/shared/refusal-events';

const ROOT = process.cwd();
const EXCLUDED_INVENTORY_SOURCES = new Set([
  'src/shared/refusal-events/classification.ts',
  'src/shared/refusal-events/remedies.ts',
]);
const REFUSAL_CODE_PATTERN = /(?<![a-z_])([a-z_]+_(?:required|denied|refused|forbidden|unavailable|not_allowed|blocked))(?![a-z_])/g;

/** Inspect only executable string/template literal text, never comments or identifiers. */
function sourceRefusalCodeCensus(): {
  codes: Set<string>;
  inlineHtmlCodes: Set<string>;
  typedRefusalCodes: Set<string>;
  parseDiagnostics: string[];
} {
  const tracked = execFileSync('git', ['ls-files', 'src/**'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(Boolean)
    .filter(file => /\.(?:[cm]?[jt]sx?|html)$/.test(file))
    .filter(file => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
    .filter(file => !EXCLUDED_INVENTORY_SOURCES.has(file));
  const codes = new Set<string>();
  const inlineHtmlCodes = new Set<string>();
  const typedRefusalCodes = new Set<string>();
  const parseDiagnostics: string[] = [];
  const inspectText = (text: string, localCodes?: Set<string>): void => {
    for (const match of text.matchAll(REFUSAL_CODE_PATTERN)) {
      codes.add(match[1]);
      localCodes?.add(match[1]);
    }
  };
  const inspectSource = (file: string, text: string, localCodes?: Set<string>): void => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const diagnostic of source.parseDiagnostics) {
      parseDiagnostics.push(`${file}:${diagnostic.start ?? 0}:${diagnostic.messageText}`);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'RefusalError') {
        const code = node.arguments?.[0];
        if (code && (ts.isStringLiteral(code) || ts.isNoSubstitutionTemplateLiteral(code))) {
          typedRefusalCodes.add(code.text);
          codes.add(code.text);
          localCodes?.add(code.text);
        }
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) inspectText(node.text, localCodes);
      else if (ts.isTemplateExpression(node)) {
        inspectText(node.head.text, localCodes);
        for (const span of node.templateSpans) inspectText(span.literal.text, localCodes);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };

  for (const file of tracked) {
    const text = readFileSync(resolve(ROOT, file), 'utf8');
    if (!file.endsWith('.html')) {
      inspectSource(file, text);
      continue;
    }
    let index = 0;
    for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const attributes = match[1];
      if (/\bsrc\s*=/i.test(attributes)) continue;
      const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
      if (type && type !== 'module' && !/(?:java|ecma)script/i.test(type)) continue;
      inspectSource(`${file}#inline-${index++}.js`, match[2], inlineHtmlCodes);
    }
  }
  return { codes, inlineHtmlCodes, typedRefusalCodes, parseDiagnostics };
}

const dispositions = Object.keys(REFUSAL_CODES_BY_DISPOSITION).sort() as RefusalDisposition[];
const classifiedCodes = Object.values(REFUSAL_CODES_BY_DISPOSITION).flat();
const classified = new Set<string>(classifiedCodes);
const { codes: census, inlineHtmlCodes, typedRefusalCodes, parseDiagnostics } = sourceRefusalCodeCensus();

describe('source-derived refusal disposition inventory', () => {
  it('holds exactly the six reviewed groups and all 151 unique tokens', () => {
    expect(dispositions).toEqual([
      'hard-security',
      'infrastructure-undetermined',
      'non-refusal',
      'operator-remediable',
      'validation-or-user-action',
      'workflow-or-domain',
    ]);
    expect(Object.fromEntries(dispositions.map(disposition => [
      disposition, REFUSAL_CODES_BY_DISPOSITION[disposition].length,
    ]))).toEqual({
      'hard-security': 53,
      'infrastructure-undetermined': 48,
      'non-refusal': 4,
      'operator-remediable': 8,
      'validation-or-user-action': 20,
      'workflow-or-domain': 18,
    });
    expect(classifiedCodes).toHaveLength(151);
    expect(classified.size, 'a code may have only one disposition').toBe(151);
    expect(Object.keys(REFUSAL_CODE_CLASSIFICATION)).toHaveLength(151);
  });

  it('finds the complete AST-derived executable production census, including inline scripts and template prefixes', () => {
    expect(parseDiagnostics).toEqual([]);
    expect(census.size).toBe(151);
    expect([...census]).toEqual(expect.arrayContaining([
      'authorization_recorded_delegation_required',
      'book_delete_refused',
      'op_not_allowed',
      'sweep_refused',
    ]));
    expect(inlineHtmlCodes).toContain('sweep_refused');
    expect(REFUSAL_CODE_CLASSIFICATION.sweep_refused).toBe('non-refusal');
  });

  it('fails when a production code has not been classified', () => {
    const unclassified = [...census].filter(code => !classified.has(code)).sort();
    expect(unclassified, 'classify every new source refusal token').toEqual([]);
  });

  it('classifies every literal typed refusal even when its name would evade the suffix heuristic', () => {
    expect([...typedRefusalCodes]).toEqual(expect.arrayContaining([
      'authorization_recorded_delegation_required',
      'authorization_remote_dispatch_required',
      'authorization_result_persistence_required',
      'protected_result_owner_issuer_required',
    ]));
    expect([...typedRefusalCodes].filter(code => !classified.has(code)).sort(),
      'classify every RefusalError constructor code').toEqual([]);
  });

  it('fails when the inventory retains a code no longer present in production source', () => {
    const stale = [...classified].filter(code => !census.has(code)).sort();
    expect(stale, 'remove or reclassify every stale refusal token').toEqual([]);
  });
});
