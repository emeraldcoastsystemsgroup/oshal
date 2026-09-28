/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation (ADR-169 L1): the static log guard over src/features/location and the location routes. Pino redaction reaches top-level keys and one `*.` level only, so a fix nested as telemetry.position.lat, or a coordinate inside an error message or URL, cannot be caught at runtime; this AST scan is the control ADR-169 D3 names. Scope is DERIVED, not listed: every source file under the location slice, every src/app file with a path segment named location*, every src/app/routes file that declares a /api/location route (string, const or template path), and the router module behind every `.use('/api/location…')` mount, followed through imports, local consts and barrel re-exports. A /api/location handler declared outside src/app/routes and a mount whose router cannot be found are violations (fail closed). In scope, a logger call may pass only an inline object literal of allowlisted id, count and literal-label fields plus a literal or scalar-only message; an error goes through locationSafeError from '@/shared/logger'.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes. (a) A log method (or child) destructured off a logger - `const { info } = log`, a parameter defaulting to or typed as a logger, a nested `{ log: { error } }` pattern, or `({ info } = log)` - is now 'indirect-logger'; before, the later bare info(...) call escaped every rule. (b) Element access is held to the same rules as dot access: `log[level](...)` has its arguments checked as a log call, and `log['warn']` / `log[level]` used as a value is 'indirect-logger'. (c) A route path held in an IMPORTED const (named or namespace import, through barrels and renaming re-exports, composed from further consts) or in a function-local const now resolves, and every src/app file is parsed rather than only files containing the word location, so `app.use(GEO_BASE, …)` with GEO_BASE imported from a paths module is followed. (d) JSDoc on every exported constant.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** @description One place a location-scoped file could put location data into a log line, or escape the guard. */
export interface LocationLogViolation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

/** @description The guard's result over a tree: the files it scanned and every violation it found. */
export interface LocationLogGuardResult {
  files: string[];
  violations: LocationLogViolation[];
}

/** @description The location feature slice: every source file under it is in the guard's scope. */
export const LOCATION_SLICE_DIR = 'src/features/location';
/**
 * @description The app layer the guard searches for location code: files with a location* path
 * segment, and every file that declares or mounts a /api/location route.
 */
export const LOCATION_APP_DIR = 'src/app';
/**
 * @description The only directory a /api/location handler may be declared in, and a home for the
 * router a /api/location mount leads to.
 */
export const LOCATION_ROUTES_DIR = 'src/app/routes';
/** @description The one error projection the guard admits as an `err` field. */
export const SANCTIONED_ERROR_HELPER = 'locationSafeError';
/**
 * @description The barrel the sanctioned error helper (and createChildLogger) must be imported
 * from; a local function of the same name is not the helper.
 */
export const SANCTIONED_LOGGER_MODULE = '@/shared/logger';

/** @description Id fields: opaque references whose rows sit behind RLS. No subject, user or owner id (ADR-169 D4). */
export const LOCATION_LOG_ID_KEYS: readonly string[] = [
  'requestId', 'ruleId', 'fireId', 'deviceId', 'placeId', 'shareId', 'anchorId', 'tenantId',
  'transitionId', 'credentialId', 'inviteId', 'restrictionId', 'observationId', 'mapRef',
];
/** @description Count fields: numbers about work done, never about where. */
export const LOCATION_LOG_COUNT_KEYS: readonly string[] = [
  'count', 'total', 'rowCount', 'attempt', 'durationMs', 'placeCount', 'ruleCount', 'deviceCount',
  'shareCount', 'observationCount', 'fireCount', 'purgedCount', 'claimedCount', 'dispatchedCount',
  'skippedCount', 'memberCount',
];
/** @description Label fields: accepted only with a literal value (or a conditional between literals). */
export const LOCATION_LOG_LABEL_KEYS: readonly string[] = ['module', 'component', 'op', 'outcome', 'reason', 'status'];

const ID_OR_COUNT = new Set([...LOCATION_LOG_ID_KEYS, ...LOCATION_LOG_COUNT_KEYS]);
const LABEL_KEYS = new Set(LOCATION_LOG_LABEL_KEYS);
/** The final name a reference may end in to count as an id or a count. */
const SCALAR_TERMINALS = new Set([...ID_OR_COUNT, 'id', 'length', 'size']);
const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const ROUTE_DECLARE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'head', 'options', 'route']);
const NUMERIC_WRAPPERS = new Set(['Math.round', 'Math.floor', 'Math.ceil', 'Math.trunc', 'Number', 'String']);
const CLOCKS = new Set(['Date.now', 'performance.now']);
const LOGGER_RECEIVER = /(?:^|\.)(?:\w*logger|log|console)$/i;
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const LOCATION_SEGMENT = /^location(?:[-._]|$)/i;
const LOCATION_API_PATH = /^\/api\/location(?:[/?]|$)/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const MAX_REEXPORT_HOPS = 6;

// ───────────────────────── files and parsing ─────────────────────────

/**
 * @description Every non-test source file under a repo-relative directory, recursively.
 * @param root - The repository (or scratch tree) root.
 * @param relDir - A directory relative to root.
 * @returns Sorted repo-relative paths with forward slashes; empty when the directory is absent.
 */
function sourcesUnder(root: string, relDir: string): string[] {
  const abs = path.join(root, relDir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name)); continue; }
      if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) {
        out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(abs);
  return out.sort();
}

/** Parses once per guard run. */
class SourceCache {
  private readonly parsed = new Map<string, ts.SourceFile>();

  constructor(private readonly root: string) {}

  /**
   * @description Parse a repo-relative file (with parent pointers), memoised.
   * @param rel - Repo-relative path.
   * @returns The source file AST.
   */
  get(rel: string): ts.SourceFile {
    let sf = this.parsed.get(rel);
    if (!sf) {
      sf = this.peek(rel);
      this.parsed.set(rel, sf);
    }
    return sf;
  }

  /**
   * @description Parse a file without keeping it: the route sweep reads every src/app file once,
   * and holding all of their trees would cost far more memory than re-parsing the few it follows.
   * @param rel - Repo-relative path.
   * @returns The memoised tree when there is one, otherwise a fresh one that is not stored.
   */
  peek(rel: string): ts.SourceFile {
    const cached = this.parsed.get(rel);
    if (cached) return cached;
    const text = fs.readFileSync(path.join(this.root, rel), 'utf8');
    return ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, scriptKind(rel));
  }

  /**
   * @description Whether a repo-relative path is an existing file.
   * @param rel - Repo-relative path.
   * @returns true for a regular file.
   */
  isFile(rel: string): boolean {
    try { return fs.statSync(path.join(this.root, rel)).isFile(); } catch { return false; }
  }
}

/**
 * @description The TypeScript script kind for a file name.
 * @param rel - The file name.
 * @returns JS for plain JavaScript files, TS otherwise.
 */
function scriptKind(rel: string): ts.ScriptKind {
  return /\.[cm]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/**
 * @description The 1-based line of a node.
 * @param node - Any node of a parsed file.
 * @returns Its starting line.
 */
function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * @description Strip parentheses, type assertions and non-null assertions from an expression.
 * @param expr - Any expression.
 * @returns The expression that actually produces the value.
 */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

// ───────────────────────── static path text ─────────────────────────

/** A file being read for static path text: the cache (to follow imports), its path and its tree. */
interface TextScope { cache: SourceCache; rel: string; sf: ts.SourceFile }

/**
 * @description The initializer of a top-level variable of this name in a file.
 * @param sf - The file.
 * @param name - The variable name.
 * @returns Its initializer, or null.
 */
function topLevelInitializer(sf: ts.SourceFile, name: string): ts.Expression | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const decl = stmt.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
    if (decl) return decl.initializer ?? null;
  }
  return null;
}

/**
 * @description The static text of a name used in a file: its own top-level const, else a const
 * declared anywhere in the file (a route path held in a function-local const), else the imported
 * const it is bound to, followed to the declaring file.
 * @param scope - The file the name is used in.
 * @param name - The name.
 * @param seen - `file#name` pairs on the current resolution path (cycle guard).
 * @returns Its static text, or null.
 */
function constText(scope: TextScope, name: string, seen: Set<string>): string | null {
  const key = `${scope.rel}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const init = topLevelInitializer(scope.sf, name) ?? localInitializer(scope.sf, name);
  const text = init ? staticText(init, scope, seen) : importedConstText(scope, name, undefined, seen);
  seen.delete(key);
  return text;
}

/**
 * @description The static text of an imported const: `import { X }` (renamed or not), or
 * `ns.X` through `import * as ns`, followed through barrels and renaming re-exports to the file
 * that declares it.
 * @param scope - The importing file.
 * @param local - The local binding (the namespace alias when member is given).
 * @param member - For `ns.member`, the member name.
 * @param seen - `file#name` pairs on the current resolution path (cycle guard).
 * @returns Its static text, or null for a package, a default import or anything unresolvable.
 */
function importedConstText(scope: TextScope, local: string, member: string | undefined, seen: Set<string>): string | null {
  const imp = importOf(scope.sf, local);
  if (!imp || imp.imported === 'default') return null;
  // `ns.X` needs a namespace import; a bare name needs a named one.
  if ((imp.imported === '*') !== (member !== undefined)) return null;
  const moduleFile = resolveModule(scope.cache, scope.rel, imp.spec);
  const found = moduleFile ? declaringExport(scope.cache, moduleFile, member ?? imp.imported) : null;
  if (!found) return null;
  return constText({ cache: scope.cache, rel: found.file, sf: scope.cache.get(found.file) }, found.name, seen);
}

/**
 * @description The static string an expression evaluates to: literals, templates, `+`
 * concatenation, and consts (local, function-local or imported). An unknown part becomes '*'.
 * @param expr - The expression.
 * @param scope - Its file, for const lookup and import following.
 * @param seen - `file#name` pairs already being resolved (cycle guard).
 * @returns The text, or null when nothing about it is static.
 */
function staticText(expr: ts.Expression, scope: TextScope, seen: Set<string> = new Set()): string | null {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) {
    return e.head.text + e.templateSpans.map((s) => (staticText(s.expression, scope, seen) ?? '*') + s.literal.text).join('');
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(e.left, scope, seen);
    return left === null ? null : left + (staticText(e.right, scope, seen) ?? '*');
  }
  if (ts.isIdentifier(e)) return constText(scope, e.text, seen);
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    return importedConstText(scope, e.expression.text, e.name.text, seen);
  }
  return null;
}

// ───────────────────────── import resolution ─────────────────────────

/**
 * @description Resolve a relative or `@/` module specifier to a repo-relative source file.
 * @param cache - The source cache (for existence checks).
 * @param fromRel - The importing file.
 * @param spec - The module specifier.
 * @returns The file, or null for a package or an unresolvable specifier.
 */
function resolveModule(cache: SourceCache, fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(fromRel), spec);
  else if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else return null;
  const stem = base.replace(/\.[cm]?js$/, '');
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}/index.ts`, `${stem}/index.js`];
  return candidates.find((c) => cache.isFile(c)) ?? null;
}

/**
 * @description Whether a file declares an exported binding of this name itself.
 * @param sf - The file.
 * @param name - The exported name.
 * @returns true for `export function|class|const NAME`.
 */
function declaresExport(sf: ts.SourceFile, name: string): boolean {
  return sf.statements.some((stmt) => {
    const exported = ts.canHaveModifiers(stmt)
      && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return false;
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === name) return true;
    return ts.isVariableStatement(stmt)
      && stmt.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name);
  });
}

/** Where an exported name is declared: the file, and the name it has there (re-exports can rename). */
interface DeclaredExport { file: string; name: string }

/**
 * @description Follow `export { x as y } from`, `export * from` and local `export { x as y }` lists
 * to the file that declares a name, keeping track of renames.
 * @param cache - The source cache.
 * @param rel - The file to start from (a module or a barrel).
 * @param name - The exported name.
 * @param hops - Re-export hops already taken.
 * @returns The declaring file and the declared name, or null.
 */
function declaringExport(cache: SourceCache, rel: string, name: string, hops = 0): DeclaredExport | null {
  if (hops > MAX_REEXPORT_HOPS) return null;
  const sf = cache.get(rel);
  if (declaresExport(sf, name)) return { file: rel, name };
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    const found = followExportDeclaration(cache, rel, stmt, name, hops);
    if (found) return found;
  }
  return null;
}

/**
 * @description Follow one export declaration of a file for a name.
 * @param cache - The source cache.
 * @param rel - The file holding the declaration.
 * @param stmt - The `export … from` or local `export { … }` declaration.
 * @param name - The exported name being looked for.
 * @param hops - Re-export hops already taken.
 * @returns The declaring file and name, or null when this declaration does not export it.
 */
function followExportDeclaration(
  cache: SourceCache, rel: string, stmt: ts.ExportDeclaration, name: string, hops: number,
): DeclaredExport | null {
  const clause = stmt.exportClause;
  const el = clause && ts.isNamedExports(clause) ? clause.elements.find((e) => e.name.text === name) : undefined;
  const origin = el?.propertyName?.text ?? name;
  if (!stmt.moduleSpecifier) return el ? { file: rel, name: origin } : null;
  if (!ts.isStringLiteral(stmt.moduleSpecifier) || (clause && !el)) return null;
  const target = resolveModule(cache, rel, stmt.moduleSpecifier.text);
  return target ? declaringExport(cache, target, origin, hops + 1) : null;
}

/**
 * @description Where a local name in a file was imported from.
 * @param sf - The importing file.
 * @param local - The local binding name.
 * @returns The specifier and the imported name ('default' / '*' for default and namespace), or null.
 */
function importOf(sf: ts.SourceFile, local: string): { spec: string; imported: string } | null {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !stmt.importClause) continue;
    const spec = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (clause.name?.text === local) return { spec, imported: 'default' };
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === local) return { spec, imported: '*' };
    if (bindings && ts.isNamedImports(bindings)) {
      const el = bindings.elements.find((e) => e.name.text === local);
      if (el) return { spec, imported: el.propertyName?.text ?? local };
    }
  }
  return null;
}

/**
 * @description The file that declares an imported binding used in a file.
 * @param cache - The source cache.
 * @param rel - The file using the binding.
 * @param local - The local name (or the namespace alias).
 * @param member - For `ns.member`, the member name.
 * @returns The declaring file, or null when it is a package or cannot be followed.
 */
function resolveBinding(cache: SourceCache, rel: string, local: string, member?: string): string | null {
  const imp = importOf(cache.get(rel), local);
  if (!imp) return null;
  const moduleFile = resolveModule(cache, rel, imp.spec);
  if (!moduleFile) return null;
  if (imp.imported === 'default') return moduleFile;
  const name = imp.imported === '*' ? member : imp.imported;
  return name ? declaringExport(cache, moduleFile, name)?.file ?? null : null;
}

/**
 * @description The initializer of the first variable declared with this name anywhere in a file.
 * @param sf - The file.
 * @param name - The variable name.
 * @returns Its initializer expression, or null.
 */
function localInitializer(sf: ts.SourceFile, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// ───────────────────────── scope discovery ─────────────────────────

/** A route call found in an app file: a handler declaration or a router mount on a /api/location path. */
interface LocationRouteCall { call: ts.CallExpression; kind: 'declare' | 'mount' }

/**
 * @description Every `.get/.post/…/.route/.use` call in a file whose static path is under
 * /api/location, however the path is spelled (literal, template, local or imported const).
 * @param scope - The file.
 * @returns The calls with their kind.
 */
function locationRouteCalls(scope: TextScope): LocationRouteCall[] {
  const out: LocationRouteCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length) {
      const method = node.expression.name.text;
      const isRoute = ROUTE_DECLARE_METHODS.has(method) || method === 'use';
      const text = isRoute ? staticText(node.arguments[0], scope) : null;
      if (text !== null && LOCATION_API_PATH.test(text)) out.push({ call: node, kind: method === 'use' ? 'mount' : 'declare' });
    }
    ts.forEachChild(node, visit);
  };
  visit(scope.sf);
  return out;
}

/**
 * @description Whether a file may hold a location router: the slice, the routes directory, or a
 * location-named path under src/app. A mount resolving anywhere else (shared middleware) is ignored.
 * @param rel - Repo-relative path.
 * @returns true when a mount target there counts as the location router.
 */
function isRouterHome(rel: string): boolean {
  return rel.startsWith(`${LOCATION_SLICE_DIR}/`) || rel.startsWith(`${LOCATION_ROUTES_DIR}/`) || isLocationNamed(rel);
}

/**
 * @description Whether a src/app path has a segment named location* (location-routes.ts, location/…).
 * @param rel - Repo-relative path.
 * @returns true when it does.
 */
function isLocationNamed(rel: string): boolean {
  if (!rel.startsWith(`${LOCATION_APP_DIR}/`)) return false;
  return rel.slice(LOCATION_APP_DIR.length + 1).split('/').some((seg) => LOCATION_SEGMENT.test(seg));
}

/**
 * @description The router files a single mount argument leads to: a called or passed factory,
 * directly imported, reached through a namespace, or held in a local const.
 * @param cache - The source cache.
 * @param rel - The mounting file.
 * @param arg - One argument after the path.
 * @returns Declaring files (possibly outside the router homes; the caller filters).
 */
function mountArgumentTargets(cache: SourceCache, rel: string, arg: ts.Expression): string[] {
  const e = unwrap(arg);
  const callee = ts.isCallExpression(e) ? unwrap(e.expression) : e;
  if (ts.isIdentifier(callee)) {
    const direct = resolveBinding(cache, rel, callee.text);
    if (direct) return [direct];
    const init = ts.isIdentifier(e) ? localInitializer(cache.get(rel), callee.text) : null;
    return init && ts.isCallExpression(unwrap(init)) ? mountArgumentTargets(cache, rel, init) : [];
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const viaNamespace = resolveBinding(cache, rel, callee.expression.text, callee.name.text);
    return viaNamespace ? [viaNamespace] : [];
  }
  return [];
}

/**
 * @description Decide what one /api/location route call adds to the scope, or which violation it is.
 * @param cache - The source cache.
 * @param rel - The file holding the call.
 * @param route - The call and its kind.
 * @returns Files to scan and discovery violations.
 */
function scopeFromRouteCall(cache: SourceCache, rel: string, route: LocationRouteCall): LocationLogGuardResult {
  const inRoutes = rel.startsWith(`${LOCATION_ROUTES_DIR}/`);
  const line = lineOf(route.call);
  const args = route.call.arguments.slice(1);
  const inline = args.some((a) => ts.isArrowFunction(unwrap(a)) || ts.isFunctionExpression(unwrap(a)));
  if (route.kind === 'declare' || inline) {
    if (inRoutes || isLocationNamed(rel)) return { files: [rel], violations: [] };
    return { files: [], violations: [{ file: rel, line, rule: 'route-outside-routes',
      detail: 'a /api/location handler is declared outside src/app/routes; move it into a location route file there' }] };
  }
  const targets = args.flatMap((a) => mountArgumentTargets(cache, rel, a)).filter(isRouterHome);
  if (targets.length) return { files: targets, violations: [] };
  if (inRoutes) return { files: [rel], violations: [] };
  return { files: [], violations: [{ file: rel, line, rule: 'mount-unresolved',
    detail: 'the router mounted at /api/location could not be followed to a file under src/app/routes or src/features/location' }] };
}

/**
 * @description Derive the files the log guard covers, plus discovery violations. Every src/app
 * file is parsed: a route path can come from an imported const, so a file need not contain the
 * word "location" to declare or mount a /api/location route.
 * @param root - Repository (or scratch tree) root.
 * @returns The sorted file set and any route placement or mount violations.
 */
export function discoverLocationLogScope(root: string): LocationLogGuardResult {
  const cache = new SourceCache(root);
  const files = new Set<string>(sourcesUnder(root, LOCATION_SLICE_DIR));
  const violations: LocationLogViolation[] = [];
  for (const rel of sourcesUnder(root, LOCATION_APP_DIR)) {
    if (isLocationNamed(rel)) files.add(rel);
    for (const route of locationRouteCalls({ cache, rel, sf: cache.peek(rel) })) {
      const found = scopeFromRouteCall(cache, rel, route);
      found.files.forEach((f) => files.add(f));
      violations.push(...found.violations);
    }
  }
  return { files: [...files].sort(), violations };
}

// ───────────────────────── the logger-call rules ─────────────────────────

/**
 * @description The dotted text of a callee such as `Date.now` or `Math.round`.
 * @param expr - A call's callee.
 * @returns The dotted name, or null for anything else.
 */
function dottedName(expr: ts.Expression): string | null {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const left = dottedName(e.expression);
    return left ? `${left}.${e.name.text}` : null;
  }
  return null;
}

/**
 * @description Whether a value is an id or a count: a literal, a reference ending in an id/count
 * name (or id, length, size), clock arithmetic, or a conditional/logical/arithmetic mix of those.
 * @param expr - The field value.
 * @returns true when nothing but an id or a number can come out of it.
 */
function isScalarRef(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(e)) return e.text === 'undefined' || SCALAR_TERMINALS.has(e.text);
  if (ts.isPropertyAccessExpression(e)) return SCALAR_TERMINALS.has(e.name.text);
  if (ts.isElementAccessExpression(e)) {
    const key = unwrap(e.argumentExpression);
    return ts.isStringLiteral(key) && SCALAR_TERMINALS.has(key.text);
  }
  if (ts.isConditionalExpression(e)) return isScalarRef(e.whenTrue) && isScalarRef(e.whenFalse);
  if (ts.isPrefixUnaryExpression(e)) return e.operator === ts.SyntaxKind.ExclamationToken || isScalarRef(e.operand);
  if (ts.isTypeOfExpression(e)) return true;
  if (ts.isCallExpression(e)) return isScalarCall(e);
  if (ts.isBinaryExpression(e)) return isScalarBinary(e);
  return false;
}

/**
 * @description A call that yields an id or a number: a clock read, or a numeric/string wrapper of a scalar.
 * @param call - The call.
 * @returns true when admitted.
 */
function isScalarCall(call: ts.CallExpression): boolean {
  const name = dottedName(call.expression);
  if (name && CLOCKS.has(name)) return call.arguments.length === 0;
  return !!name && NUMERIC_WRAPPERS.has(name) && call.arguments.length === 1 && isScalarRef(call.arguments[0]);
}

/**
 * @description A binary expression that yields an id or a number. Comparisons yield booleans;
 * `Date.now() - started` is the duration idiom; anything else needs scalar operands.
 * @param bin - The binary expression.
 * @returns true when admitted.
 */
function isScalarBinary(bin: ts.BinaryExpression): boolean {
  const op = bin.operatorToken.kind;
  const comparisons = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken];
  if (comparisons.includes(op)) return true;
  const left = unwrap(bin.left);
  const right = unwrap(bin.right);
  const clockLeft = ts.isCallExpression(left) && CLOCKS.has(dottedName(left.expression) ?? '') && left.arguments.length === 0;
  if (op === ts.SyntaxKind.MinusToken && clockLeft && (ts.isIdentifier(right) || ts.isPropertyAccessExpression(right))) return true;
  return isScalarRef(left) && isScalarRef(right);
}

/**
 * @description Whether a label value is a literal (or a conditional choosing between literals).
 * @param expr - The field value.
 * @returns true when it is.
 */
function isLiteralLabel(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return true;
  return ts.isConditionalExpression(e) && isLiteralLabel(e.whenTrue) && isLiteralLabel(e.whenFalse);
}

/**
 * @description Whether a message argument is safe: a literal, a template whose every substitution
 * is a scalar, or a `+` chain of those.
 * @param expr - The message argument.
 * @returns true when admitted.
 */
function isSafeMessage(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => isScalarRef(s.expression));
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isSafeMessage(e.left) && isSafeMessage(e.right);
  }
  return isScalarRef(e);
}

/** Per-file facts the call checks need: local names bound to the shared logger exports. */
interface FileContext {
  file: string;
  loggerBindings: Map<string, string>;
  violations: LocationLogViolation[];
}

/**
 * @description Local names imported from '@/shared/logger', keyed by local name, valued by the imported name.
 * @param sf - The file.
 * @returns The binding map.
 */
function sharedLoggerBindings(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text !== SANCTIONED_LOGGER_MODULE) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) map.set(el.name.text, el.propertyName?.text ?? el.name.text);
    }
  }
  return map;
}

/**
 * @description Record one violation.
 * @param ctx - The file context.
 * @param node - Where it is.
 * @param rule - The rule id.
 * @param detail - What to do instead.
 * @returns Nothing.
 */
function report(ctx: FileContext, node: ts.Node, rule: string, detail: string): void {
  ctx.violations.push({ file: ctx.file, line: lineOf(node), rule, detail });
}

/**
 * @description Whether an `err` value is exactly `locationSafeError(x)` imported from the logger barrel.
 * @param ctx - The file context.
 * @param value - The field value.
 * @returns true when sanctioned.
 */
function isSanctionedError(ctx: FileContext, value: ts.Expression): boolean {
  const e = unwrap(value);
  if (!ts.isCallExpression(e) || e.arguments.length !== 1 || !ts.isIdentifier(e.expression)) return false;
  return ctx.loggerBindings.get(e.expression.text) === SANCTIONED_ERROR_HELPER;
}

/**
 * @description Check one property of a merge object or bindings object against the allowlist.
 * @param ctx - The file context.
 * @param prop - The property.
 * @param allowErr - Whether an `err` field is admissible here (log calls yes, child bindings no).
 * @returns Nothing; violations are recorded on ctx.
 */
function checkProperty(ctx: FileContext, prop: ts.ObjectLiteralElementLike, allowErr: boolean): void {
  if (ts.isSpreadAssignment(prop)) { report(ctx, prop, 'spread', 'list each allowlisted field explicitly; a spread can carry a fix'); return; }
  if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
    report(ctx, prop, 'accessor', 'use plain id or count fields'); return;
  }
  if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) { report(ctx, prop, 'computed-key', 'use a literal allowlisted key'); return; }
  const key = prop.name.text;
  const value = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
  if (key === 'err' && allowErr) {
    if (!isSanctionedError(ctx, value)) report(ctx, prop, 'error-object', `log errors as err: ${SANCTIONED_ERROR_HELPER}(error), imported from '${SANCTIONED_LOGGER_MODULE}'`);
  } else if (ID_OR_COUNT.has(key)) {
    if (!isScalarRef(value)) report(ctx, prop, 'value-not-scalar', `'${key}' must hold an id or a count, not '${value.getText()}'`);
  } else if (LABEL_KEYS.has(key)) {
    if (!isLiteralLabel(value)) report(ctx, prop, 'label-not-literal', `'${key}' takes a literal value only`);
  } else {
    report(ctx, prop, 'key-not-allowlisted', `'${key}' is not an allowlisted id, count or label field`);
  }
}

/**
 * @description Check the arguments of a trace/debug/info/warn/error/fatal call.
 * @param ctx - The file context.
 * @param call - The logger call.
 * @returns Nothing; violations are recorded on ctx.
 */
function checkLogCall(ctx: FileContext, call: ts.CallExpression): void {
  const [first, ...rest] = call.arguments;
  if (!first) return;
  const head = unwrap(first);
  if (ts.isObjectLiteralExpression(head)) {
    head.properties.forEach((p) => checkProperty(ctx, p, true));
    if (rest[0] && !isSafeMessage(rest[0])) report(ctx, rest[0], 'unsafe-message', 'the message must be a literal or interpolate ids and counts only');
    if (rest.length > 1) report(ctx, rest[1], 'interpolation-args', 'pass values as allowlisted fields, not printf arguments');
    return;
  }
  if (!isSafeMessage(head)) {
    const messageShaped = ts.isTemplateExpression(head)
      || (ts.isBinaryExpression(head) && head.operatorToken.kind === ts.SyntaxKind.PlusToken);
    if (messageShaped) report(ctx, first, 'unsafe-message', 'the message must be a literal or interpolate ids and counts only');
    else report(ctx, first, 'merge-object-not-inline', `log an inline object of allowlisted fields, not '${first.getText()}'`);
    return;
  }
  if (rest.length) report(ctx, rest[0], 'interpolation-args', 'pass values as allowlisted fields, not printf arguments');
}

/**
 * @description Check a child-logger binding call (`.child(...)` or createChildLogger(...)).
 * @param ctx - The file context.
 * @param call - The call.
 * @returns Nothing; violations are recorded on ctx.
 */
function checkChildCall(ctx: FileContext, call: ts.CallExpression): void {
  const [bindings, ...rest] = call.arguments;
  if (bindings) {
    const head = unwrap(bindings);
    if (ts.isObjectLiteralExpression(head)) head.properties.forEach((p) => checkProperty(ctx, p, false));
    else report(ctx, bindings, 'merge-object-not-inline', 'child bindings must be an inline object of allowlisted fields');
  }
  if (rest.length) report(ctx, rest[0], 'child-options', 'child-logger options can replace redaction; pass bindings only');
}

/**
 * @description Classify one call expression and apply the matching rule.
 * @param ctx - The file context.
 * @param call - Any call in a scoped file.
 * @returns Nothing; violations are recorded on ctx.
 */
function checkCall(ctx: FileContext, call: ts.CallExpression): void {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    if (ctx.loggerBindings.get(callee.text) === 'createChildLogger') checkChildCall(ctx, call);
    return;
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return;
  const method = memberKey(callee);
  const receiver = callee.expression;
  if (dottedName(receiver) === 'console') { report(ctx, call, 'console', 'use the Pino logger; console output bypasses redaction'); return; }
  if (method === null) {
    // log[level](...): any method could be behind the key, so hold its arguments to the log-call rules.
    if (isLoggerShaped(ctx, receiver)) checkLogCall(ctx, call);
    return;
  }
  if (LOG_METHODS.has(method)) { checkLogCall(ctx, call); return; }
  if (method === 'child') { checkChildCall(ctx, call); return; }
  if (['call', 'apply', 'bind'].includes(method) && isLoggerMethodRef(ctx, receiver)) {
    report(ctx, call, 'indirect-logger', 'call the logger method directly so its arguments can be checked');
  }
}

/**
 * @description The static member name of `a.b` or `a['b']`.
 * @param access - The member access.
 * @returns The name, or null for a computed key that is not a literal.
 */
function memberKey(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const key = unwrap(access.argumentExpression);
  return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : null;
}

/**
 * @description Whether an expression reads as a logger: a name like log / logger / this.log, or a
 * createChildLogger(...) / .child(...) call.
 * @param ctx - The file context (for the createChildLogger import).
 * @param expr - The expression.
 * @returns true when it does.
 */
function isLoggerShaped(ctx: FileContext, expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (!ts.isCallExpression(e)) return LOGGER_RECEIVER.test(e.getText());
  const callee = unwrap(e.expression);
  if (ts.isIdentifier(callee)) return callee.text === 'createChildLogger' || ctx.loggerBindings.get(callee.text) === 'createChildLogger';
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'child';
}

/**
 * @description Whether an expression names a logger method: `x.info`, or `log['info']` / `log[level]`
 * on a logger-shaped receiver.
 * @param ctx - The file context.
 * @param expr - The expression.
 * @returns true when it does.
 */
function isLoggerMethodRef(ctx: FileContext, expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isPropertyAccessExpression(e)) return LOG_METHODS.has(e.name.text);
  if (!ts.isElementAccessExpression(e) || !isLoggerShaped(ctx, e.expression)) return false;
  const key = memberKey(e);
  return key === null || LOG_METHODS.has(key);
}

/**
 * @description Flag a logger method used as a value (passed as a callback or assigned), where its
 * arguments can no longer be checked: `log.warn`, `log['warn']` or `log[level]` not being called.
 * @param ctx - The file context.
 * @param access - A member access.
 * @returns Nothing; violations are recorded on ctx.
 */
function checkDetachedMethod(ctx: FileContext, access: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
  const key = memberKey(access);
  if (key !== null && !LOG_METHODS.has(key)) return;
  const parent = access.parent;
  if (ts.isCallExpression(parent) && parent.expression === access) return;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === access) return;
  if (!isLoggerShaped(ctx, access.expression)) return;
  report(ctx, access, 'indirect-logger', `do not pass '${access.getText()}' around; call it with checked arguments`);
}

/**
 * @description The static name of a destructured or assigned property: `info`, `info: i`, `['info']: i`.
 * @param name - The property name node.
 * @returns The name, or null when it is computed from something other than a literal.
 */
function propertyKey(name: ts.Node): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return null;
  const inner = unwrap(name.expression);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : null;
}

/**
 * @description Report a property taken off a logger when it is a log method, `child`, or a key that
 * cannot be read statically (it could be either).
 * @param ctx - The file context.
 * @param node - The binding element or property.
 * @param key - Its static name, or null.
 * @returns Nothing; violations are recorded on ctx.
 */
function reportLoggerMember(ctx: FileContext, node: ts.Node, key: string | null): void {
  if (key !== null && !LOG_METHODS.has(key) && key !== 'child') return;
  report(ctx, node, 'indirect-logger', `do not destructure '${key ?? node.getText()}' off a logger; call it on the logger with checked arguments`);
}

/** What a destructuring pattern reads from: dotted source text, and the source expression when there is one. */
interface PatternSource { text: string; expr?: ts.Expression }

/**
 * @description What an object binding pattern destructures: the initializer of its declaration or
 * parameter (else a parameter's declared type), or for a nested pattern the outer source plus the
 * property it sits under (`{ log: { info } } = deps` reads `deps.log`).
 * @param pattern - The pattern.
 * @returns Its source, or null when the pattern sits somewhere else (array patterns, catch clauses).
 */
function patternSource(pattern: ts.ObjectBindingPattern): PatternSource | null {
  const parent = pattern.parent;
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
    if (parent.initializer) return { text: unwrap(parent.initializer).getText(), expr: parent.initializer };
    return { text: parent.type ? parent.type.getText() : '' };
  }
  if (!ts.isBindingElement(parent) || !ts.isObjectBindingPattern(parent.parent)) return null;
  const outer = patternSource(parent.parent);
  const key = propertyKey(parent.propertyName ?? parent.name);
  return outer && key !== null ? { text: `${outer.text}.${key}` } : null;
}

/**
 * @description Flag log methods destructured off a logger (`const { info } = log`, a parameter
 * `({ error } = log)` or `({ info }: Logger)`), where later calls to them escape every other rule.
 * @param ctx - The file context.
 * @param pattern - An object binding pattern.
 * @returns Nothing; violations are recorded on ctx.
 */
function checkLoggerPattern(ctx: FileContext, pattern: ts.ObjectBindingPattern): void {
  const src = patternSource(pattern);
  if (!src) return;
  if (!LOGGER_RECEIVER.test(src.text) && !(src.expr && isLoggerShaped(ctx, src.expr))) return;
  for (const el of pattern.elements) {
    if (!el.dotDotDotToken) reportLoggerMember(ctx, el, propertyKey(el.propertyName ?? el.name));
  }
}

/**
 * @description Flag log methods taken off a logger by destructuring assignment (`({ info } = log)`).
 * @param ctx - The file context.
 * @param bin - A binary expression.
 * @returns Nothing; violations are recorded on ctx.
 */
function checkLoggerAssignment(ctx: FileContext, bin: ts.BinaryExpression): void {
  if (bin.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const left = unwrap(bin.left);
  if (!ts.isObjectLiteralExpression(left) || !isLoggerShaped(ctx, bin.right)) return;
  for (const prop of left.properties) {
    if (ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop)) reportLoggerMember(ctx, prop, propertyKey(prop.name));
  }
}

/**
 * @description Apply every logger-call rule to one source text.
 * @param file - Its repo-relative name (used for the script kind and in violations).
 * @param text - The source.
 * @returns Every violation in it.
 */
export function scanLocationLogSource(file: string, text: string): LocationLogViolation[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, scriptKind(file));
  const ctx: FileContext = { file, loggerBindings: sharedLoggerBindings(sf), violations: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) checkCall(ctx, node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) checkDetachedMethod(ctx, node);
    if (ts.isObjectBindingPattern(node)) checkLoggerPattern(ctx, node);
    if (ts.isBinaryExpression(node)) checkLoggerAssignment(ctx, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ctx.violations;
}

/**
 * @description Run the whole guard over a tree: derive the scope, then scan every file in it.
 * @param root - Repository (or scratch tree) root.
 * @returns The scanned files and every discovery and logger-call violation.
 */
export function checkLocationLogSafety(root: string): LocationLogGuardResult {
  const scope = discoverLocationLogScope(root);
  const violations = [...scope.violations];
  for (const rel of scope.files) {
    violations.push(...scanLocationLogSource(rel, fs.readFileSync(path.join(root, rel), 'utf8')));
  }
  return { files: scope.files, violations };
}
