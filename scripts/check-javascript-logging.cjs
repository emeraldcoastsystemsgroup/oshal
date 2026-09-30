/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard ADR-171 cross-runtime structured logging and its actual module boundary.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

/**
 * @description Detect console references and legacy logger imports in executable syntax.
 * @param source - File contents, not runtime input.
 * @param file - Diagnostic filename.
 * @returns Violations with source locations; comments and string examples are ignored.
 */
function inspectSource(source, file = 'input.js') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations = tree.parseDiagnostics.map((d) => ({
    file, line: tree.getLineAndCharacterOfPosition(d.start || 0).line + 1,
    rule: 'unparseable-source',
  }));
  function visit(node) {
    let rule;
    if (ts.isIdentifier(node) && node.text === 'console') rule = 'console-reference';
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        && node.argumentExpression.text === 'console') rule = 'console-reference';
    if (ts.isStringLiteralLike(node) && /^(?:winston(?:\/|$)|(?:node:)?console$)/.test(node.text)) {
      const parent = node.parent;
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
          || ts.isExternalModuleReference(parent)
          || (ts.isCallExpression(parent) && parent.arguments[0] === node
            && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
              || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require')
              || (ts.isPropertyAccessExpression(parent.expression)
                && parent.expression.name.text === 'require')))) rule = 'logger-import';
    }
    if (rule) violations.push({
      file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, rule,
    });
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return violations;
}

/**
 * @description Scan the complete JavaScript server tree, refusing missing/empty inputs.
 * @param root - Repository root whose source the gate judges.
 * @returns All violations, without changing source or starting services.
 */
function checkTree(root) {
  const server = path.join(root, 'any-bot/server');
  let count = 0;
  const violations = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in logging guard: ' + file);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) {
        count += 1;
        violations.push(...inspectSource(fs.readFileSync(file, 'utf8'), path.relative(root, file)));
      }
    }
  }
  walk(server);
  if (!count) throw new Error('No server sources found for logging guard');
  return violations;
}

/**
 * @description Fail the local gate for any console/legacy logger violation.
 * @param root - Repository root.
 * @param output - Diagnostic sink.
 * @returns Process exit code (zero only for a complete clean scan).
 */
function main(root = path.resolve(__dirname, '..'), output = process.stderr) {
  try {
    const violations = checkTree(root);
    for (const v of violations) output.write(`${v.file}:${v.line}: ${v.rule}\n`);
    return violations.length ? 1 : 0;
  } catch (err) {
    output.write('JavaScript logging guard failed: ' + err.message + '\n');
    return 1;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { inspectSource, checkTree, main };
