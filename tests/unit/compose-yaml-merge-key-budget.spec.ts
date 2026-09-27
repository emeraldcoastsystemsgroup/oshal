/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the repository compose loader. #869 added four keys to the x-bot-env anchor, which 40 services merge, and docker-compose.oshal-local.yml went from inside js-yaml 4.3.2's default merge-key limit (10000) to 10040: `RUN node scripts/gen-dist-compose.js` failed and main could not be built, while the runtime dynamic-compose service and a dozen specs parsed the same file the same way. Three pins. (a) The REAL file parses through both loader twins identically with every `<<: *bot-env` merge resolved, and gen-dist-compose.js runs to completion on it from exactly the files the image build has at that step (Dockerfile order and .dockerignore checked). (b) No file under scripts/, src/, tests/ or any-bot/ hands a compose file to js-yaml except through the shared loader - found through the TypeScript AST, following the argument back through variables (per function scope), loop sources, this-properties and - in a file named for compose, the gen-dist-compose.js shape - process.argv, with planted violations proving the scan is not blind. (c) The file's measured merge-key total stays under 80% of the bound, so the next anchor growth reddens review instead of a deploy.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { COMPOSE_MAX_TOTAL_MERGE_KEYS, loadComposeYaml } from '@/shared/config';

const ROOT = process.cwd();
const STACK_COMPOSE = 'docker-compose.oshal-local.yml';
const TS_LOADER = 'src/shared/config/compose-yaml.ts';
const CJS_LOADER = 'scripts/lib/compose-yaml.js';
const BUDGET_SHARE = 0.8;

const requireModule = createRequire(import.meta.url);
const cjsLoader = requireModule(path.join(ROOT, CJS_LOADER)) as {
  COMPOSE_MAX_TOTAL_MERGE_KEYS: number;
  loadComposeYaml: (text: string) => unknown;
  measureComposeMergeKeys: (text: string) => number;
};

type ComposeDoc = { services?: Record<string, { environment?: Record<string, unknown> }>; 'x-bot-env'?: Record<string, unknown> };

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── (b) the scan: which js-yaml parse calls receive a compose file ─────────────────────────────

/** A compose file named in source: the tracked docker-compose*.yml family and the dist output. */
const COMPOSE_LITERAL = /docker-compose[\w.-]*\.ya?ml|compose\.dist[\w.-]*\.ya?ml/i;
/** An identifier or property whose name says it holds a compose file (composeText, STACK_COMPOSE). */
const COMPOSE_NAME = /compose/i;
const JS_YAML_PARSERS = new Set(['load', 'loadAll', 'safeLoad', 'safeLoadAll']);
const SCAN_ROOTS = ['scripts', 'src', 'tests', 'any-bot'];
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
/** The two loader twins are the one sanctioned place a compose file meets js-yaml directly. */
const LOADER_FILES = new Set([TS_LOADER, CJS_LOADER]);
/** Reads every JS/TS source under four roots: about 4 s warm, several times that on a cold, contended box. */
const SCAN_TIMEOUT_MS = 120_000;

interface YamlBindings { namespaces: Set<string>; parsers: Set<string> }
/** Values a name can hold, per function scope (the file itself is the outermost; properties live there as `.name`). */
type Declarations = Map<ts.Node, Map<string, ts.Node[]>>;

/**
 * @description The function (or the file) whose scope a node's declarations belong to.
 * @param node any AST node
 * @returns the nearest enclosing function-like node, or the source file
 */
function scopeOf(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current ?? node.getSourceFile();
}

/**
 * @description The module a `require('m')`, `import('m')` or `await import('m')` expression loads.
 * @param node initializer expression
 * @returns module specifier, or undefined when the expression is not a module load
 */
function loadedModule(node: ts.Node | undefined): string | undefined {
  const call = node && ts.isAwaitExpression(node) ? node.expression : node;
  if (!call || !ts.isCallExpression(call) || call.arguments.length === 0) return undefined;
  const isLoad = call.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(call.expression) && call.expression.text === 'require');
  const first = call.arguments[0];
  return isLoad && ts.isStringLiteralLike(first) ? first.text : undefined;
}

/**
 * @description Record the local names bound to js-yaml by one import declaration or one variable
 * declaration (default/namespace imports and whole-module requires become namespaces; destructured
 * or named load/loadAll become parser functions).
 * @param node an ImportDeclaration or VariableDeclaration
 * @param out bindings being collected
 * @returns nothing; mutates out
 */
function collectYamlBinding(node: ts.Node, out: YamlBindings): void {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'js-yaml') {
    const clause = node.importClause;
    if (clause?.name) out.namespaces.add(clause.name.text);
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) out.namespaces.add(named.name.text);
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) if (JS_YAML_PARSERS.has((el.propertyName ?? el.name).text)) out.parsers.add(el.name.text);
    }
    return;
  }
  if (!ts.isVariableDeclaration(node) || loadedModule(node.initializer) !== 'js-yaml') return;
  if (ts.isIdentifier(node.name)) out.namespaces.add(node.name.text);
  else if (ts.isObjectBindingPattern(node.name)) {
    for (const el of node.name.elements) {
      const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : (el.name as ts.Identifier).text;
      if (JS_YAML_PARSERS.has(imported) && ts.isIdentifier(el.name)) out.parsers.add(el.name.text);
    }
  }
}

/**
 * @description Record what a name can hold: a variable's initializer (or its for-of/for-in
 * source), a parameter default, an assignment, or a class/object property value. Names are kept
 * per function scope, so two methods that each read a different file into `content` stay apart;
 * inside one function every same-named binding counts, so the scan over-reports rather than
 * misses. Properties are file-wide.
 * @param node any AST node
 * @param decls scope -> name -> value expressions (properties keyed as `.name` on the file)
 * @returns nothing; mutates decls
 */
function collectDeclaration(node: ts.Node, decls: Declarations): void {
  const add = (scope: ts.Node, key: string, value: ts.Node | undefined): void => {
    if (!value) return;
    const names = decls.get(scope) ?? new Map<string, ts.Node[]>();
    names.set(key, [...(names.get(key) ?? []), value]);
    decls.set(scope, names);
  };
  const file = node.getSourceFile();
  if (ts.isVariableDeclaration(node)) {
    const loop = node.parent?.parent;
    const source = loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) ? loop.expression : node.initializer;
    const bind = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) add(scopeOf(node), name.text, source);
      else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
    };
    bind(node.name);
  } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) add(scopeOf(node), node.name.text, node.initializer);
  else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (ts.isIdentifier(node.left)) add(scopeOf(node), node.left.text, node.right);
    else if (ts.isPropertyAccessExpression(node.left)) add(file, `.${node.left.name.text}`, node.right);
  } else if ((ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && ts.isIdentifier(node.name)) {
    add(file, `.${node.name.text}`, node.initializer);
  }
}

/**
 * @description The values an identifier or property can hold at a use site: the nearest enclosing
 * scope that binds the name wins; properties resolve file-wide.
 * @param use the identifier or property-access node being resolved
 * @param key the name (`.name` for a property)
 * @param decls recorded values
 * @returns the candidate value expressions (empty when the name is unbound in the file)
 */
function valuesOf(use: ts.Node, key: string, decls: Declarations): ts.Node[] {
  if (key.startsWith('.')) return decls.get(use.getSourceFile())?.get(key) ?? [];
  for (let scope = scopeOf(use); ; scope = scopeOf(scope)) {
    const found = decls.get(scope)?.get(key);
    if (found) return found;
    if (ts.isSourceFile(scope)) return [];
  }
}

/** What one argument trace needs: the file's recorded values, a cycle guard and the argv rule. */
interface Trace { decls: Declarations; seen: Set<ts.Node>; argvIsCompose: boolean }

/**
 * @description Whether an expression can carry a compose file: a compose file name in a string,
 * a compose-named identifier or property, a variable/property whose recorded value does, or - in
 * a file named for compose, such as gen-dist-compose.js - the process arguments (a compose CLI's
 * input path arrives there, with no file name in the source). Call targets are judged by name only
 * and function bodies are never entered, so `read(X)` is judged by X, not by whatever `read` does.
 * @param node expression to judge
 * @param trace recorded values, cycle guard and argv rule for the file
 * @returns true when the expression reaches a compose file
 */
function reachesCompose(node: ts.Node, trace: Trace): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false;
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return COMPOSE_LITERAL.test(node.text);
  }
  const follow = (key: string): boolean => valuesOf(node, key, trace.decls).some((value) => {
    if (trace.seen.has(value)) return false;
    trace.seen.add(value);
    return reachesCompose(value, trace);
  });
  if (ts.isIdentifier(node)) return COMPOSE_NAME.test(node.text) || follow(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    if (trace.argvIsCompose && node.name.text === 'argv' && ts.isIdentifier(node.expression) && node.expression.text === 'process') return true;
    return COMPOSE_NAME.test(node.name.text) || follow(`.${node.name.text}`) || reachesCompose(node.expression, trace);
  }
  if (ts.isCallExpression(node)) {
    const target = node.expression;
    const targetName = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : '';
    return COMPOSE_NAME.test(targetName) || node.arguments.some((arg) => reachesCompose(arg, trace));
  }
  let found = false;
  ts.forEachChild(node, (child) => { found = found || reachesCompose(child, trace); });
  return found;
}

/**
 * @description Every js-yaml parse call in one source text whose argument reaches a compose file.
 * @param fileName path used for the parser's language choice, the argv rule and the report
 * @param text source text
 * @returns `file:line` entries, one per offending call
 */
function composeParsesOutsideLoader(fileName: string, text: string): string[] {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const bindings: YamlBindings = { namespaces: new Set(), parsers: new Set() };
  const decls: Declarations = new Map();
  const calls: ts.CallExpression[] = [];
  const walk = (node: ts.Node): void => {
    collectYamlBinding(node, bindings);
    collectDeclaration(node, decls);
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
  const isYamlParse = (call: ts.CallExpression): boolean => {
    const target = call.expression;
    if (ts.isIdentifier(target)) return bindings.parsers.has(target.text);
    return ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)
      && bindings.namespaces.has(target.expression.text) && JS_YAML_PARSERS.has(target.name.text);
  };
  const argvIsCompose = COMPOSE_NAME.test(path.basename(fileName));
  return calls
    .filter((call) => isYamlParse(call) && call.arguments.some((arg) => reachesCompose(arg, { decls, seen: new Set(), argvIsCompose })))
    .map((call) => `${fileName}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1}`);
}

/**
 * @description Repository-relative paths of every JS/TS source under a scan root.
 * @param dir repository-relative directory
 * @returns source file paths (forward slashes)
 */
function sourcesUnder(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourcesUnder(rel);
    return entry.isFile() && SCAN_EXT.test(entry.name) ? [rel] : [];
  });
}

// ── (a) the build step, run the way the image runs it ──────────────────────────────────────────

/**
 * @description Run gen-dist-compose.js on the real stack compose from a scratch tree holding only
 * what Dockerfile.oshal has copied when its `RUN node scripts/gen-dist-compose.js` executes: the
 * script, scripts/lib/*.js and the compose file (js-yaml resolves from the install via NODE_PATH).
 * @returns the run's exit status, combined output and the generated document
 */
function runDistStepLikeTheImage(): { status: number | null; output: string; dist: ComposeDoc | undefined } {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-dist-compose-'));
  try {
    fs.mkdirSync(path.join(tree, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts/gen-dist-compose.js'), path.join(tree, 'scripts/gen-dist-compose.js'));
    for (const lib of fs.readdirSync(path.join(ROOT, 'scripts/lib')).filter((f) => f.endsWith('.js'))) {
      fs.copyFileSync(path.join(ROOT, 'scripts/lib', lib), path.join(tree, 'scripts/lib', lib));
    }
    fs.copyFileSync(path.join(ROOT, STACK_COMPOSE), path.join(tree, STACK_COMPOSE));
    const run = spawnSync(process.execPath, ['scripts/gen-dist-compose.js', STACK_COMPOSE, 'compose.dist.yml'], {
      cwd: tree, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
    });
    const out = path.join(tree, 'compose.dist.yml');
    const dist = fs.existsSync(out) ? (loadComposeYaml(fs.readFileSync(out, 'utf8')) as ComposeDoc) : undefined;
    return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}`, dist };
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

describe('(a) the real stack compose parses and the image build step completes', () => {
  const text = read(STACK_COMPOSE);

  it('both loader twins carry the same finite bound and resolve every <<: *bot-env merge identically', () => {
    expect(cjsLoader.COMPOSE_MAX_TOTAL_MERGE_KEYS, `${CJS_LOADER} and ${TS_LOADER} must declare the same bound`).toBe(COMPOSE_MAX_TOTAL_MERGE_KEYS);
    expect(Number.isFinite(COMPOSE_MAX_TOTAL_MERGE_KEYS) && COMPOSE_MAX_TOTAL_MERGE_KEYS > 0, 'the bound must stay finite - -1 disables the runaway-anchor guard').toBe(true);
    const doc = loadComposeYaml(text) as ComposeDoc;
    expect(cjsLoader.loadComposeYaml(text), 'the twins parse the file differently').toEqual(doc);
    const anchorKeys = Object.keys(doc['x-bot-env'] ?? {});
    expect(anchorKeys.length, 'x-bot-env has no keys - the file shape changed').toBeGreaterThan(0);
    const carriers = Object.values(doc.services ?? {}).filter((svc) => anchorKeys.every((key) => key in (svc?.environment ?? {})));
    const merges = text.match(/<<:\s*\*bot-env\b/g) ?? [];
    expect(merges.length, 'no <<: *bot-env merges found - this guard would pass vacuously').toBeGreaterThan(0);
    expect(carriers.length, 'a service that merges x-bot-env did not receive every anchor key').toBe(merges.length);
  });

  it('gen-dist-compose.js completes on the real file from the files the image has at that step', () => {
    const run = runDistStepLikeTheImage();
    expect(run.status, `gen-dist-compose.js failed:\n${run.output}`).toBe(0);
    const source = loadComposeYaml(text) as ComposeDoc;
    expect(Object.keys(run.dist?.services ?? {}).sort(), 'the dist compose lost or gained services').toEqual(Object.keys(source.services ?? {}).sort());
  });

  it('Dockerfile.oshal copies scripts/lib/*.js into the build before it runs gen-dist-compose.js', () => {
    const lines = read('Dockerfile.oshal').split(/\r?\n/);
    const copyLib = lines.findIndex((l) => /^COPY scripts\/lib\/\*\.js \.\/scripts\/lib\/$/.test(l));
    const runDist = lines.findIndex((l) => /^RUN node scripts\/gen-dist-compose\.js /.test(l));
    expect(runDist, 'Dockerfile.oshal no longer runs gen-dist-compose.js - retire (a) with it').toBeGreaterThan(-1);
    expect(copyLib, 'scripts/lib/*.js must be copied BEFORE gen-dist-compose.js runs - it requires ./lib/compose-yaml').toBeGreaterThan(-1);
    expect(copyLib).toBeLessThan(runDist);
    expect(read('.dockerignore'), '.dockerignore must allowlist scripts/lib/*.js').toMatch(/^!scripts\/lib\/\*\.js$/m);
  });
});

describe('(b) every compose parse goes through the shared loader', () => {
  const planted: Array<[string, string]> = [
    ['direct literal', "import yaml from 'js-yaml';\nconst c = yaml.load(fs.readFileSync('docker-compose.oshal-local.yml', 'utf8'));"],
    ['named import through two variables', "import { load as yamlLoad } from 'js-yaml';\nconst FILE = join(ROOT, 'docker-compose.yml');\nconst raw = read(FILE);\nyamlLoad(raw);"],
    ['compose-named parameter', "const yaml = require('js-yaml');\nfunction derive(composeText) { return yaml.load(composeText); }"],
    ['this-property set in a constructor', "import * as yaml from 'js-yaml';\nclass S { constructor() { this.target = path.resolve(root, 'compose.dist.yml'); }\n read() { const t = readFileSync(this.target, 'utf8'); return yaml.load(t); } }"],
    ['for-of over compose files', "const { load } = require('js-yaml');\nfor (const file of ['docker-compose.swarm-local.yml', 'x.yml']) load(fs.readFileSync(file, 'utf8'));"],
  ];
  // The shape that broke the build: a compose CLI whose input path arrives through process.argv.
  const argvCli = "const yaml = require('js-yaml');\nconst [, , inFile] = process.argv;\nconst doc = yaml.load(fs.readFileSync(inFile, 'utf8'));";

  for (const [shape, source] of planted) {
    it(`the scan catches a planted violation: ${shape}`, () => {
      expect(composeParsesOutsideLoader('planted.ts', source), `the scan is blind to: ${shape}`).toHaveLength(1);
    });
  }

  it('the scan catches a compose-named CLI parsing its argv input, and only a compose-named one', () => {
    expect(composeParsesOutsideLoader('scripts/gen-planted-compose.js', argvCli), 'blind to the gen-dist-compose.js shape').toHaveLength(1);
    expect(composeParsesOutsideLoader('scripts/render-values.js', argvCli)).toEqual([]);
  });

  it('the scan leaves non-compose YAML and loader calls alone', () => {
    const clean = [
      "import yaml from 'js-yaml';\nconst cfg = yaml.load(read('ops/monitoring/prometheus.yml'));",
      "import yaml from 'js-yaml';\nconst values = yaml.load(fs.readFileSync(path.join(CHART_DIR, 'values.yaml'), 'utf8'));",
      "import { loadComposeYaml } from '@/shared/config';\nconst doc = loadComposeYaml(read('docker-compose.oshal-local.yml'));",
      "import yaml from 'js-yaml';\nconst body = yaml.dump(loadComposeYaml(read('docker-compose.oshal-local.yml')));",
      // Same local name in two methods: only the one holding a compose file would count.
      "const yaml2 = require('js-yaml');\nclass G { list() { const content = readFileSync(this.composePath, 'utf8'); return content.split('\\n'); }\n persona(p) { const content = readFileSync(p, 'utf8'); return yaml2.load(content); } }",
    ].join('\n');
    expect(composeParsesOutsideLoader('clean.ts', clean)).toEqual([]);
  });

  it('no file under scripts/, src/, tests/ or any-bot/ parses a compose file with js-yaml directly', () => {
    const files = SCAN_ROOTS.flatMap(sourcesUnder).filter((rel) => !LOADER_FILES.has(rel));
    const candidates = files.filter((rel) => read(rel).includes('js-yaml'));
    expect(candidates.length, 'no js-yaml importers found - the scan roots are wrong and this would pass vacuously').toBeGreaterThan(10);
    const offenders = candidates.flatMap((rel) => composeParsesOutsideLoader(rel, read(rel)));
    expect(offenders, `parse compose files with loadComposeYaml (${TS_LOADER}, or ${CJS_LOADER} from plain Node) so the explicit merge-key budget applies`).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});

describe('(c) the stack compose stays well inside the merge-key budget', () => {
  it('the measurement is the library\'s own count (known document)', () => {
    const known = 'base: &base {alpha: 1, beta: 2}\nfirst: {<<: *base}\nsecond: {<<: *base, gamma: 3}\n';
    // Each merge charges one for the source mapping and one per key copied: 2 x (1 + 2).
    expect(cjsLoader.measureComposeMergeKeys(known)).toBe(6);
  });

  it('a runaway anchor past the bound is still refused by the loader', () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `k${i}: ${i}`).join(', ');
    const fanout = Math.ceil(COMPOSE_MAX_TOTAL_MERGE_KEYS / 1000) + 1;
    const runaway = `x: &a {${keys}}\n${Array.from({ length: fanout }, (_, i) => `s${i}: {<<: *a}`).join('\n')}\n`;
    expect(() => loadComposeYaml(runaway)).toThrow(/maxTotalMergeKeys/);
    expect(() => cjsLoader.loadComposeYaml(runaway)).toThrow(/maxTotalMergeKeys/);
  });

  it(`${STACK_COMPOSE} uses at most ${BUDGET_SHARE * 100}% of COMPOSE_MAX_TOTAL_MERGE_KEYS`, () => {
    const text = read(STACK_COMPOSE);
    const total = cjsLoader.measureComposeMergeKeys(text);
    const mergeSites = (text.match(/<<:\s*\*/g) ?? []).length;
    const ceiling = Math.floor(COMPOSE_MAX_TOTAL_MERGE_KEYS * BUDGET_SHARE);
    console.info(`[compose-yaml-merge-key-budget] ${STACK_COMPOSE}: ${total} merge-key units of ${COMPOSE_MAX_TOTAL_MERGE_KEYS} (review ceiling ${ceiling})`);
    expect(total, 'no merge work measured - the anchors are gone and this guard is vacuous').toBeGreaterThan(0);
    expect(total, `${STACK_COMPOSE} charges ${total} js-yaml merge-key units, over ${BUDGET_SHARE * 100}% of the ${COMPOSE_MAX_TOTAL_MERGE_KEYS} budget. `
      + `Every key on a merged anchor is paid once per merge site (${mergeSites} here): move service-specific keys onto the service, `
      + `or raise COMPOSE_MAX_TOTAL_MERGE_KEYS in BOTH ${TS_LOADER} and ${CJS_LOADER} as a reviewed change.`).toBeLessThanOrEqual(ceiling);
  });
});
