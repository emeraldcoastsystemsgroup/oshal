/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Declaration scanner for the data-model explorer: walks core source (migrations, src, any-bot, docker/postgres) and each installed package's directory for CREATE TABLE / CREATE VIEW, resolves `${CONST}` names, and tags each site with its owner and engine (a `.sql` file is always Postgres; JS/TS is SQLite only when it loads a SQLite driver; Python is SQLite unless it imports a Postgres driver). Async and bounded (file size, file count) so a scan never stalls the API event loop.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { DeclarationEngine, DeclarationSite } from '../types';

const logger = createChildLogger({ module: 'data-model-scanner' });

const SOURCE_EXT = /\.(sql|ts|js|mjs|cjs|py)$/;
const SKIP_DIR = /^(node_modules|\.git|tests?|__tests__|output|dist|coverage|fixtures?|routes-build|build)$/;
const TEST_FILE = /\.(spec|test)\./;
const CREATE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*|\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\})"?\s*\(/gi;
const VIEW_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*|\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\})"?/gi;
const SQLITE_RE = /better-sqlite3|require\(\s*['"]sqlite3['"]\s*\)|from\s+['"]sqlite3['"]|node:sqlite|^\s*import\s+sqlite3\b|sqlite3\.connect\(|\.executescript\(/m;
const PY_PG_IMPORT_RE = /^(?:import|from)\s+(?:psycopg2?|asyncpg)\b/m;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 25_000;
const DDL_WINDOW = 12_000;

/** Core directories that hold schema-bearing source, relative to the repository/image root. */
export const CORE_SOURCE_DIRS = ['scripts/migrations', 'src', 'any-bot/server', 'docker/postgres'];

/** One directory to scan, the owner its declarations belong to, and what paths are shown relative to. */
export interface ScanRoot {
  owner: string;
  dir: string;
  relativeTo: string;
}

/**
 * @description Resolve a `${CONST}` table-name interpolation from a same-file constant.
 * @param raw - captured name, possibly `${NAME}`
 * @param text - the file's source
 * @returns lower-cased name, or null when it cannot be resolved statically
 */
export function resolveDeclaredName(raw: string, text: string): string | null {
  if (!raw.startsWith('${')) return raw.toLowerCase();
  const constant = raw.slice(2, -1).trim();
  const m = text.match(new RegExp(`\\b${constant}\\s*(?::\\s*string\\s*)?=\\s*['"\`]([A-Za-z0-9_]+)['"\`]`));
  return m ? m[1].toLowerCase() : null;
}

/**
 * @description Decide which engine a file's DDL targets.
 * @param file - path (only its extension is read)
 * @param text - file source
 * @returns 'sqlite' or 'postgres'
 */
export function detectEngine(file: string, text: string): DeclarationEngine {
  if (file.endsWith('.sql')) return 'postgres';
  if (SQLITE_RE.test(text)) return 'sqlite';
  if (file.endsWith('.py') && !PY_PG_IMPORT_RE.test(text)) return 'sqlite';
  return 'postgres';
}

/**
 * @description Find every CREATE TABLE / CREATE VIEW in one file's text.
 * @param text - file source
 * @param file - path shown in the explorer (forward slashes, relative to its root)
 * @param owner - owner id
 * @returns declaration sites, possibly empty
 */
export function scanText(text: string, file: string, owner: string): DeclarationSite[] {
  if (!/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW)/i.test(text)) return [];
  const engine = detectEngine(file, text);
  const sites: DeclarationSite[] = [];
  for (const m of text.matchAll(CREATE_RE)) {
    const name = resolveDeclaredName(m[1], text);
    if (name) sites.push({ name, kind: 'table', owner, file, engine, ddl: text.slice(m.index ?? 0, (m.index ?? 0) + DDL_WINDOW) });
  }
  for (const m of text.matchAll(VIEW_RE)) {
    const name = resolveDeclaredName(m[1], text);
    if (name) sites.push({ name, kind: 'view', owner, file, engine, ddl: '' });
  }
  return sites;
}

/**
 * @description Run a filesystem read, logging a failure instead of hiding it; the scan skips
 * the unreadable entry and carries on (one bad file must not blank the whole explorer).
 * @param what - short label for the log line
 * @param target - the path being read
 * @param op - the read to perform
 * @param fallback - value returned after a logged failure
 * @returns the read's result, or the fallback
 */
async function readOrLog<T>(what: string, target: string, op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (err) {
    logger.error({ err, target }, `data-model scan: ${what} failed`);
    return fallback;
  }
}

/**
 * @description List schema-bearing files under a directory (async, skipping SKIP_DIR, tests
 * and oversized files), stopping at the shared file budget.
 * @param dir - absolute directory
 * @param budget - remaining file budget, shared across roots
 * @returns absolute file paths
 */
async function listFiles(dir: string, budget: { left: number }): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length && budget.left > 0) {
    const current = stack.pop() as string;
    const entries = await readOrLog('readdir', current, () => fs.readdir(current, { withFileTypes: true }), []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIR.test(entry.name)) stack.push(full); continue; }
      if (!entry.isFile() || !SOURCE_EXT.test(entry.name) || TEST_FILE.test(entry.name)) continue;
      out.push(full);
      budget.left -= 1;
      if (budget.left <= 0) break;
    }
  }
  return out;
}

/**
 * @description Scan every root and return all declaration sites. Files over MAX_FILE_BYTES are
 * skipped (generated bundles, not schema source).
 * @param roots - directories with their owners
 * @returns sites plus how many files were read
 */
export async function scanDeclarations(roots: ScanRoot[]): Promise<{ sites: DeclarationSite[]; filesRead: number }> {
  const budget = { left: MAX_FILES };
  const sites: DeclarationSite[] = [];
  let filesRead = 0;
  for (const root of roots) {
    const files = await listFiles(root.dir, budget);
    for (const file of files) {
      const stat = await readOrLog('stat', file, () => fs.stat(file), null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const text = await readOrLog('read', file, () => fs.readFile(file, 'utf8'), '');
      filesRead += 1;
      const rel = path.relative(root.relativeTo, file).split(path.sep).join('/');
      sites.push(...scanText(text, rel, root.owner));
    }
  }
  return { sites, filesRead };
}
