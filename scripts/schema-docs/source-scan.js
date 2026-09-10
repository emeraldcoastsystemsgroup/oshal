/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Source scan for the schema-docs generator: finds every `CREATE TABLE … (` and `CREATE VIEW` statement in the core tree (migrations + lazily-bootstrapped stores) and in each store/private package (any dir holding an oshal-app.yaml), resolves `${CONST}` table names, and tags each site with its repo, package, engine (postgres vs sqlite, by the file's driver import) and statement text. Ownership of a live table is decided from these sites, never from its name.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scan git-TRACKED files only when the root is a git checkout (directory walk only for a non-git export). A live checkout carries untracked build output (the store's routes-build/ copies of every route) that made a working-tree run list files git has never seen, so regenerating from a checkout disagreed with regenerating from `git archive` of the same commit.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const SOURCE_EXT = /\.(sql|ts|js|mjs|cjs|py)$/;
const SKIP_DIR = /^(node_modules|\.git|tests?|__tests__|output|dist|coverage|site|fixtures?)$/;
const CREATE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*|\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\})"?\s*\(/gi;
const VIEW_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*|\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\})"?/gi;
const SQLITE_RE = /better-sqlite3|require\(\s*['"]sqlite3['"]\s*\)|from\s+['"]sqlite3['"]|node:sqlite|^\s*import\s+sqlite3\b|sqlite3\.connect\(|\.executescript\(/m;
const PY_PG_IMPORT_RE = /^(?:import|from)\s+(?:psycopg2?|asyncpg)\b/m;

/**
 * Core directories that hold schema-bearing source. Everything else (docs, site, tests) is
 * prose or fixtures - a `CREATE TABLE` there documents or exercises a table, it does not own one.
 */
const CORE_DIRS = ['scripts', 'src', 'any-bot', 'docker'];

/**
 * Core files that issue CREATE TABLE against a scratch database rather than the platform one:
 * counting them as definers would attribute platform tables to a benchmark or a negative guard.
 */
const CORE_IGNORED_FILES = new Set([
  'scripts/measure-global-search-latency.js',          // builds a throwaway benchmark DB
  'scripts/governance/verify-runtime-schema-validate-only.ts', // proves DDL is REFUSED
]);

/**
 * @description Whether a repo-relative path is schema-bearing source: a source extension, not a
 * spec/test file, and no path segment in SKIP_DIR.
 * @param {string} rel - forward-slash relative path
 * @returns {boolean} true when the file should be scanned
 */
function isSourcePath(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  return SOURCE_EXT.test(name) && !/\.(spec|test)\./.test(name) && !parts.slice(0, -1).some((p) => SKIP_DIR.test(p));
}

/**
 * @description List schema-bearing source files under a root, as forward-slash paths relative to
 * it. In a git checkout only TRACKED files count - untracked build output is not source; a
 * non-git tree (a `git archive` export) is walked instead.
 * @param {string} root - absolute directory
 * @returns {string[]} relative paths
 */
function listSourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  const git = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const tracked = git.status === 0 ? git.stdout.split('\0').filter(Boolean) : null;
  return (tracked || walk(root, '')).filter(isSourcePath).sort();
}

/**
 * @description Recursive directory walk (non-git fallback), skipping SKIP_DIR directories.
 * @param {string} root - absolute root
 * @param {string} rel - current relative directory ('' at the root)
 * @returns {string[]} relative file paths
 */
function walk(root, rel) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (!SKIP_DIR.test(entry.name)) out.push(...walk(root, child)); }
    else out.push(child);
  }
  return out;
}

/**
 * @description Resolve a `${CONST}` table-name interpolation from a same-file constant.
 * @param {string} raw - captured name, possibly `${NAME}`
 * @param {string} text - the file's source
 * @returns {string|null} lower-cased table name, or null when it cannot be resolved statically
 */
function resolveTableName(raw, text) {
  if (!raw.startsWith('${')) return raw.toLowerCase();
  const constant = raw.slice(2, -1).trim();
  const m = text.match(new RegExp(`\\b${constant}\\s*(?::\\s*string\\s*)?=\\s*['"\`]([A-Za-z0-9_]+)['"\`]`));
  return m ? m[1].toLowerCase() : null;
}

/**
 * @description Find every CREATE TABLE site in one file.
 * @param {string} file - absolute path
 * @param {string} relPath - repo-relative path (forward slashes) recorded on each site
 * @param {{repo: string, pkg: string|null}} owner - who this file belongs to
 * @returns {Array<object>} sites: {table, kind, file, repo, pkg, engine, ddl}
 */
function scanFile(file, relPath, owner) {
  const text = fs.readFileSync(file, 'utf8');
  const engine = detectEngine(file, text);
  const sites = [];
  for (const m of text.matchAll(CREATE_RE)) {
    const table = resolveTableName(m[1], text);
    if (!table) continue;
    sites.push({ table, kind: 'table', file: relPath, repo: owner.repo, pkg: owner.pkg, engine, ddl: text.slice(m.index, m.index + 20000) });
  }
  for (const m of text.matchAll(VIEW_RE)) {
    const view = resolveTableName(m[1], text);
    if (view) sites.push({ table: view, kind: 'view', file: relPath, repo: owner.repo, pkg: owner.pkg, engine, ddl: '' });
  }
  return sites;
}

/**
 * @description Decide which engine a file's DDL targets. `.sql` files are migrations, always
 * Postgres (a comment naming a SQLite API must not flip them). JS/TS: SQLite only when it loads a
 * SQLite driver. Python: SQLite unless it imports a Postgres driver at module level - the
 * dual-mode career engine keeps its SQLite DDL behind a `config.POSTGRES` guard and serves the
 * same names as Postgres views, so its CREATE TABLEs are SQLite-mode schema.
 * @param {string} file - absolute path
 * @param {string} text - file source
 * @returns {'sqlite'|'postgres'} engine
 */
function detectEngine(file, text) {
  if (file.endsWith('.sql')) return 'postgres';
  if (SQLITE_RE.test(text)) return 'sqlite';
  if (file.endsWith('.py') && !PY_PG_IMPORT_RE.test(text)) return 'sqlite';
  return 'postgres';
}

/**
 * @description Scan the core tree.
 * @param {string} root - core repo root
 * @returns {Array<object>} CREATE TABLE sites owned by core
 */
function scanCore(root) {
  const sites = [];
  for (const rel of listSourceFiles(root)) {
    if (!CORE_DIRS.includes(rel.split('/')[0]) || CORE_IGNORED_FILES.has(rel)) continue;
    sites.push(...scanFile(path.join(root, rel), rel, { repo: 'core', pkg: null }));
  }
  return sites;
}

/**
 * @description Read the fields of a package manifest the docs need.
 * @param {string} pkgDir - package directory holding oshal-app.yaml
 * @returns {{name: string, displayName: string|null, migrations: string[]}} manifest summary
 */
function readManifest(pkgDir) {
  const doc = yaml.load(fs.readFileSync(path.join(pkgDir, 'oshal-app.yaml'), 'utf8')) || {};
  return {
    name: String(doc.name || path.basename(pkgDir)),
    displayName: doc.displayName || doc.label || null,
    migrations: Array.isArray(doc.migrations) ? doc.migrations.map(String) : [],
  };
}

/**
 * @description Scan a package repo (store or private): one package per top-level dir that
 * holds an oshal-app.yaml. Files outside a package are repo tooling and own nothing.
 * @param {string} root - package repo root
 * @param {string} repo - 'store' | 'private'
 * @returns {{sites: Array<object>, packages: Map<string, object>}} sites + manifest summaries keyed by dir
 */
function scanPackageRepo(root, repo) {
  const sites = [];
  const packages = new Map();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const pkgDir = path.join(root, entry.name);
    if (!entry.isDirectory() || SKIP_DIR.test(entry.name) || !fs.existsSync(path.join(pkgDir, 'oshal-app.yaml'))) continue;
    packages.set(entry.name, { dir: entry.name, ...readManifest(pkgDir) });
  }
  for (const rel of listSourceFiles(root)) {
    const [pkg, ...rest] = rel.split('/');
    if (!rest.length || !packages.has(pkg)) continue;
    sites.push(...scanFile(path.join(root, rel), rest.join('/'), { repo, pkg }));
  }
  return { sites, packages };
}

module.exports = { scanCore, scanPackageRepo, resolveTableName, scanFile, detectEngine, CORE_IGNORED_FILES };
