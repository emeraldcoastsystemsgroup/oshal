/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Finds Playwright specs that build the server origin themselves instead of taking it from tests/helpers/test-origins.ts. Thirteen specs did, each with its own fallback (localhost, the generic PORT, a fixed 3456 or 4458, any non-empty MOCK_OIDC including 'false'), so under a run whose port differed from the config's they aimed at a server that was not there. Reads the TypeScript syntax tree, so comments and change logs that mention a port are not findings, and a loopback URL inside a regex or a product constant is judged on what it is.
 */

import ts from 'typescript';

/** One place a spec builds an origin itself. */
export interface OriginFinding {
  line: number;
  rule: 'env-port' | 'literal-port' | 'template-port';
  /** The offending text: the env access, or the URL text with `${…}` for substitutions. */
  text: string;
}

/** A loopback URL that names a port (literal digits or a substitution). */
const LOOPBACK_WITH_PORT = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+|\$\{…\})/;

/** Environment variables that carry the server port - the helper owns reading them. */
const PORT_ENV_NAMES = new Set(['PLAYWRIGHT_PORT', 'PORT']);

/**
 * @description Renders a string or template literal as text, with `${…}` for each substitution.
 * @param node A string, no-substitution template or template expression.
 * @returns The literal's text.
 */
function literalText(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression): string {
  if (!ts.isTemplateExpression(node)) return node.text;
  return node.head.text + node.templateSpans.map((span) => `\${…}${span.literal.text}`).join('');
}

/**
 * @description Reads `process.env.NAME` or `process.env['NAME']` and returns NAME.
 * @param node Any node.
 * @returns The env name, or '' when the node is not an env read.
 */
function envReadName(node: ts.Node): string {
  const isProcessEnv = (expr: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'process' && expr.name.text === 'env';
  if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) return node.name.text;
  if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  return '';
}

/**
 * @description Audits one spec's source for self-built server origins:
 * - env-port: it reads PLAYWRIGHT_PORT or PORT itself (the helper resolves those, with the
 *   config's MOCK_OIDC default);
 * - literal-port: a loopback URL with a fixed port;
 * - template-port: a loopback URL whose port is substituted, in a file that never starts an
 *   ephemeral server of its own (no `.address()` call) - i.e. a port the spec made up.
 * @param fileName The spec's path (selects the JS or TS parser).
 * @param source The spec's source text.
 * @returns Every finding, in source order.
 */
export function auditSpecOrigins(fileName: string, source: string): OriginFinding[] {
  const kind = /\.[cm]?jsx?$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, kind);
  const ephemeralServer = /\.address\(\)/.test(source);
  const findings: OriginFinding[] = [];
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    const envName = envReadName(node);
    if (PORT_ENV_NAMES.has(envName)) findings.push({ line: lineOf(node), rule: 'env-port', text: `process.env.${envName}` });
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = literalText(node);
      const m = LOOPBACK_WITH_PORT.exec(text);
      if (m && m[1] !== '${…}') findings.push({ line: lineOf(node), rule: 'literal-port', text });
      if (m && m[1] === '${…}' && !ephemeralServer) findings.push({ line: lineOf(node), rule: 'template-port', text });
      if (ts.isTemplateExpression(node)) {
        node.templateSpans.forEach((span) => visit(span.expression));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
