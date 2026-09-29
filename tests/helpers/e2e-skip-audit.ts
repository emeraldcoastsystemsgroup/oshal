/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Static audit of the skip calls in a Playwright spec, for the no-pass-by-skip rule of the green ratchet: a spec that skips under the CI e2e env passes without running, which is how tests/dynamic-agent-live-e2e.spec.ts sat in the green list proving nothing. Each test.skip / test.fixme / test.describe.skip is located with the TypeScript parser, classified by scope (test body vs describe, hook or top level), and - when its condition depends only on process.env and same-file constants - evaluated under the CI env that ci.yml and ci-local.sh actually set. Conditions that call a runtime probe (a function, a `let` assigned in a hook) are reported as runtime, not guessed at.
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import ts from 'typescript';

/** Where a skip call sits: inside one test's body, or around a whole describe/file. */
export type SkipScope = 'test' | 'describe';

/** One skip call found in a spec. */
export interface SkipSite {
  line: number;
  scope: SkipScope;
  /** unconditional: always skips; env: evaluable from the env; runtime: depends on a runtime probe. */
  kind: 'unconditional' | 'env' | 'runtime';
  /** The description argument, verbatim, when it is a string literal. */
  message: string;
  /** For kind 'env': the process.env names the condition reads. */
  envNames: string[];
  /** For kind 'env': compiled evaluator of the condition under a given env. */
  evaluate?: (env: Record<string, string>) => boolean;
}

/** Identifiers an env-only condition may use besides its own constants. */
const SAFE_GLOBALS = new Set(['process', 'undefined', 'String', 'Number', 'Boolean']);

/** Call names that declare a test and so make a skip inside them test-scoped. */
const TEST_DECLARATIONS = new Set(['test', 'test.only', 'test.slow']);

/**
 * @description Renders a call's callee as dotted text (`test.describe.skip`), or '' when the
 * callee is not a plain identifier/property chain.
 * @param expr The callee expression.
 * @returns The dotted name.
 */
function calleeName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleeName(expr.expression);
    return left ? `${left}.${expr.name.text}` : '';
  }
  return '';
}

/**
 * @description Decides whether a skip call is scoped to one test: its nearest enclosing call
 * whose argument is a function is a test declaration. Anything else - describe bodies, hooks,
 * the top level - skips more than one test.
 * @param node The skip call.
 * @returns 'test' or 'describe'.
 */
function scopeOf(node: ts.Node): SkipScope {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (!(ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))) continue;
    const call = cur.parent;
    if (call && ts.isCallExpression(call)) return TEST_DECLARATIONS.has(calleeName(call.expression)) ? 'test' : 'describe';
  }
  return 'describe';
}

/**
 * @description Collects the top-level `const` declarations of a source file by name.
 * @param sf The parsed source file.
 * @returns Name → declaration.
 */
function topLevelConsts(sf: ts.SourceFile): Map<string, ts.VariableDeclaration> {
  const out = new Map<string, ts.VariableDeclaration>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) out.set(decl.name.text, decl);
    }
  }
  return out;
}

/**
 * @description Walks an expression and records what it depends on. Plain calls (`hasGit()`) and
 * identifiers that are neither safe globals nor top-level constants make it a runtime condition.
 * @param expr The expression to inspect.
 * @param consts The file's top-level constants.
 * @param deps Accumulates the constant names it uses (transitively).
 * @param envNames Accumulates the process.env names it reads.
 * @returns False when the expression depends on something only known at runtime.
 */
function collectDeps(expr: ts.Node, consts: Map<string, ts.VariableDeclaration>, deps: Set<string>, envNames: Set<string>): boolean {
  let pure = true;
  const visit = (node: ts.Node): void => {
    if (!pure) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) { pure = false; return; }
    if (ts.isPropertyAccessExpression(node) && calleeName(node.expression) === 'process.env') envNames.add(node.name.text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !SAFE_GLOBALS.has(node.expression.text)) { pure = false; return; }
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      if (SAFE_GLOBALS.has(node.text)) return;
      const decl = consts.get(node.text);
      if (!decl) { pure = false; return; }
      if (!deps.has(node.text)) {
        deps.add(node.text);
        if (!collectDeps(decl.initializer!, consts, deps, envNames)) { pure = false; return; }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return pure;
}

/**
 * @description Compiles an env-only condition into a function of an env map: the constants it
 * uses are emitted in source order ahead of it, TypeScript syntax is stripped by the compiler,
 * and the result runs against a stand-in `process` that carries only that env.
 * @param sf The parsed source file.
 * @param condition The condition expression.
 * @param deps The constant names it depends on.
 * @returns The evaluator.
 */
function compileCondition(sf: ts.SourceFile, condition: ts.Expression, deps: Set<string>): (env: Record<string, string>) => boolean {
  const prelude = sf.statements
    .filter(ts.isVariableStatement)
    .flatMap((stmt) => stmt.declarationList.declarations)
    .filter((decl) => ts.isIdentifier(decl.name) && deps.has(decl.name.text))
    .map((decl) => `const ${(decl.name as ts.Identifier).text} = ${decl.initializer!.getText(sf)};`)
    .join('\n');
  const source = `function __skipCondition(process) {\n${prelude}\nreturn Boolean(${condition.getText(sf)});\n}`;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const fn = new Function(`${js}\nreturn __skipCondition;`)() as (p: { env: Record<string, string> }) => boolean;
  return (env) => fn({ env });
}

/**
 * @description Finds and classifies every skip call in a spec's source.
 * @param fileName The spec's path (used for the parser's script kind).
 * @param source The spec's source text.
 * @returns One SkipSite per test.skip / test.fixme / test.describe.skip / test.describe.fixme call.
 */
export function auditSkipSites(fileName: string, source: string): SkipSite[] {
  const kind = /\.[cm]?jsx?$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, kind);
  const consts = topLevelConsts(sf);
  const sites: SkipSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (['test.skip', 'test.fixme', 'test.describe.skip', 'test.describe.fixme'].includes(name)) {
        sites.push(classify(sf, node, name, consts));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/**
 * @description Classifies one skip call (see auditSkipSites).
 * @param sf The parsed source file.
 * @param call The skip call.
 * @param name Its dotted callee name.
 * @param consts The file's top-level constants.
 * @returns The SkipSite.
 */
function classify(sf: ts.SourceFile, call: ts.CallExpression, name: string, consts: Map<string, ts.VariableDeclaration>): SkipSite {
  const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
  const [first, second] = call.arguments;
  const literal = (node?: ts.Expression): string => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : '');
  const base = { line, scope: scopeOf(call), message: literal(second), envNames: [] as string[] };
  // describe.skip, a bare test.skip(), and test.skip('title', body) never run their tests.
  if (name.startsWith('test.describe.')) return { ...base, scope: 'describe', kind: 'unconditional', message: literal(first) };
  if (!first) return { ...base, kind: 'unconditional' };
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) || ts.isTemplateExpression(first)) {
    return { ...base, scope: 'test', kind: 'unconditional', message: literal(first) };
  }
  const deps = new Set<string>();
  const envNames = new Set<string>();
  if (!collectDeps(first, consts, deps, envNames)) return { ...base, kind: 'runtime' };
  return { ...base, kind: 'env', envNames: [...envNames].sort(), evaluate: compileCondition(sf, first, deps) };
}

/** A green-listed spec's path and source. */
export interface SpecSource {
  file: string;
  source: string;
}

/** A single test recorded as skipping under CI by design: the file and the skip's own message. */
export interface RegisteredSkip {
  file: string;
  skipMessage: string;
}

/**
 * @description The no-pass-by-skip rule for the green ratchet. A skip that never lets its tests
 * run (describe.skip, a bare test.skip) is refused. An env-driven skip is evaluated under each
 * CI env: firing around a describe, a hook or the file is refused outright (the spec passes
 * without running and belongs in the disposition registry, not the green list); firing inside one
 * test is allowed only when that test is recorded in the registry's skippedTests. A recorded skip
 * that no longer fires is stale and refused too. Skips decided by a runtime probe are out of
 * scope here - they cannot be evaluated without running the spec.
 * @param specs The green-listed specs with their sources.
 * @param envs Each CI env the green gate runs under, by name.
 * @param registered The registry's skippedTests rows.
 * @returns One line per violation; empty when no green spec passes by skipping.
 */
export function greenSkipViolations(specs: SpecSource[], envs: Record<string, Record<string, string>>, registered: RegisteredSkip[]): string[] {
  const out: string[] = [];
  const firing = new Set<string>();
  const isRegistered = (file: string, message: string): boolean => registered.some((r) => r.file === file && r.skipMessage === message);
  for (const { file, source } of specs) {
    for (const site of auditSkipSites(file, source)) {
      if (site.kind === 'unconditional') {
        out.push(`${file}:${site.line} skips unconditionally`);
        continue;
      }
      if (site.kind !== 'env') continue;
      const firesUnder = Object.entries(envs).filter(([, env]) => site.evaluate!(env)).map(([name]) => name);
      if (firesUnder.length === 0) continue;
      const why = `under the ${firesUnder.join(' and ')} CI env (reads ${site.envNames.join(', ') || 'no env'})`;
      if (site.scope === 'describe') out.push(`${file}:${site.line} skips more than one test ${why}`);
      else if (!isRegistered(file, site.message)) out.push(`${file}:${site.line} skips a test ${why} and is not recorded in skippedTests`);
      else firing.add(`${file}\u0000${site.message}`);
    }
  }
  for (const r of registered) {
    if (!firing.has(`${r.file}\u0000${r.skipMessage}`)) out.push(`${r.file}: skippedTests row "${r.skipMessage}" matches no test-scoped skip that fires under CI`);
  }
  return out;
}

/**
 * @description The env the hosted CI e2e step sets: the `env:` block of the step that runs the
 * green ratchet in .github/workflows/ci.yml.
 * @param ciYmlPath Path to ci.yml.
 * @returns The step's env, values as strings.
 */
export function hostedCiE2eEnv(ciYmlPath: string): Record<string, string> {
  const doc = yaml.load(readFileSync(ciYmlPath, 'utf8')) as { jobs: Record<string, { steps?: Array<{ run?: string; env?: Record<string, unknown> }> }> };
  const step = Object.values(doc.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((s) => typeof s.run === 'string' && s.run.includes('test:e2e:green'));
  if (!step?.env) throw new Error(`${ciYmlPath}: no step running test:e2e:green with an env block`);
  return Object.fromEntries(Object.entries(step.env).map(([k, v]) => [k, String(v)]));
}

/**
 * @description The env the local CI gate sets for the green ratchet: every NAME=value
 * assignment in scripts/ci-local.sh's gate_e2e function (empty assignments included, because an
 * empty value is still "set").
 * @param ciLocalPath Path to scripts/ci-local.sh.
 * @returns The gate's env, values as the literal text after '='.
 */
export function localCiE2eEnv(ciLocalPath: string): Record<string, string> {
  const text = readFileSync(ciLocalPath, 'utf8');
  const start = text.indexOf('gate_e2e() {');
  if (start < 0) throw new Error(`${ciLocalPath}: gate_e2e() not found`);
  const end = text.indexOf('\n}\n', start);
  const body = text.slice(start, end);
  if (!body.includes('test:e2e:green')) throw new Error(`${ciLocalPath}: gate_e2e does not run test:e2e:green`);
  const env: Record<string, string> = {};
  for (const m of body.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=(\S*)/g)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  return env;
}
