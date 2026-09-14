/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Scanner and known set for lazy-DDL guards that key a trigger or function on its NAME alone (IF NOT EXISTS over pg_trigger / pg_proc / information_schema.triggers / information_schema.routines, and to_regproc IS NULL). Such a guard keeps the object's FIRST definition forever - the consent-ledger trigger drift fixed in 8a88d33e. Shared by the static spec, which pins the source definition, and the real-Postgres parity gate, which pins the live catalog rendering, so the two cannot drift apart.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/** Object kinds a by-name guard can protect. */
export type ByNameGuardKind = 'trigger' | 'function';

/** One guard the scanner found in the source tree. */
export interface ByNameGuard {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** 1-based line of the guard predicate. */
  line: number;
  kind: ByNameGuardKind;
  /** The tgname / proname the guard keys on ("?" when the name is not a string literal). */
  object: string;
  /** Live-object properties the enclosing block converges on (drops or replaces when they drift); empty when create-once. */
  convergesOn: string[];
  /** The CREATE statement the guard protects, whitespace-normalized ("" when none is found in the block). */
  createStatement: string;
}

/** A guard the project has reviewed: its source and live definitions are pinned. */
export interface KnownByNameGuard extends ByNameGuard {
  /** What pg_get_triggerdef (trigger) or prosrc (function) renders on a real Postgres after the DDL ran, whitespace-normalized. */
  liveDefinition: string;
  /** Why the guard is allowed to stay by-name. */
  reason: string;
}

const PERSON_MODEL_SCHEMA = 'src/features/person-model/services/person-model-schema.ts';
const CONSENT_MESSAGE = 'ambient_speaker_consents is append-only (record a new row to change a decision)';

/**
 * @description Every by-name guard under src/ that has been reviewed. A guard missing from this
 * list makes the static spec red; a guard listed here but gone from the tree makes it red too.
 * The pins are the contract: changing a CREATE statement without a convergence path leaves every
 * existing deployment on the old definition, so the spec refuses a silent edit.
 */
export const KNOWN_BY_NAME_GUARDS: readonly KnownByNameGuard[] = [
  {
    file: PERSON_MODEL_SCHEMA,
    line: 123,
    kind: 'function',
    object: 'ambient_speaker_consents_no_flip',
    convergesOn: [],
    createStatement: `CREATE FUNCTION ambient_speaker_consents_no_flip() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION '${CONSENT_MESSAGE}'; END; $fn$ LANGUAGE plpgsql`,
    liveDefinition: `BEGIN RAISE EXCEPTION '${CONSENT_MESSAGE}'; END;`,
    reason: 'Create-once on purpose: CREATE OR REPLACE and DROP FUNCTION raise 42501 for the least-privilege app role on a box where the schema owner created it (schema-lock.ts SEQ 6). The body is a single RAISE, so its definition is pinned here instead; the parity gate checks prosrc on a real Postgres.',
  },
  {
    file: PERSON_MODEL_SCHEMA,
    line: 139,
    kind: 'trigger',
    object: 'ambient_speaker_consents_no_mutate',
    convergesOn: ['tgtype'],
    createStatement: 'CREATE TRIGGER ambient_speaker_consents_no_mutate BEFORE UPDATE ON ambient_speaker_consents FOR EACH ROW EXECUTE FUNCTION ambient_speaker_consents_no_flip()',
    liveDefinition: 'CREATE TRIGGER ambient_speaker_consents_no_mutate BEFORE UPDATE ON public.ambient_speaker_consents FOR EACH ROW EXECUTE FUNCTION ambient_speaker_consents_no_flip()',
    reason: 'Converges on the tgtype DELETE bit (8a88d33e): a DELETE-blocking variant is dropped before the UPDATE-only trigger is recreated. Any other change to the shape must extend that predicate - the pin makes the decision explicit.',
  },
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.sql']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.codex-harness-runs']);
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]s$/;

const CATALOG_GUARD = /IF\s+NOT\s+EXISTS\s*\(\s*SELECT\b[^()]*?\bFROM\s+(pg_trigger|pg_proc|information_schema\.triggers|information_schema\.routines)\b([^()]*)\)/gi;
const REGPROC_GUARD = /IF\s+to_regproc(?:edure)?\s*\(\s*'([^']*)'\s*\)\s+IS\s+NULL/gi;
const OBJECT_NAME = /\b(?:tgname|proname|trigger_name|routine_name)\s*=\s*'([^']+)'/i;
const DO_BLOCK = /DO\s+\$\$[\s\S]*?END\s*\$\$/g;
const FALLBACK_WINDOW = 1500;
const TRIGGER_PROPERTIES = ['tgtype', 'tgfoid', 'tgenabled', 'tgargs', 'pg_get_triggerdef'];
const FUNCTION_PROPERTIES = ['prosrc', 'probin', 'prorettype', 'proargtypes', 'pg_get_functiondef'];

/**
 * @description Collapses whitespace so a definition compares the same from a template literal,
 * a psql dump, or pg_get_triggerdef.
 * @param sql - Raw SQL text.
 * @returns Single-spaced, trimmed text.
 */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * @description Lists the source files the scanner reads: .ts/.js/.mjs/.cjs/.sql under root,
 * skipping dependency/build folders and colocated test files (a test cannot run boot DDL).
 * @param root - Directory to walk.
 * @returns Absolute file paths.
 */
export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(full);
      } else if (SOURCE_EXTENSIONS.has(extname(entry)) && !TEST_FILE.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * @description Finds every guard in one source text that keys a trigger or function on its name
 * alone, and reports whether the enclosing DO block converges on a property of the live object.
 * @param source - File contents.
 * @param file - Repo-relative path recorded on each hit.
 * @returns Guards in source order.
 */
export function findByNameGuards(source: string, file: string): ByNameGuard[] {
  const hits: ByNameGuard[] = [];
  for (const match of source.matchAll(CATALOG_GUARD)) {
    const kind: ByNameGuardKind = /trigger/i.test(match[1]) ? 'trigger' : 'function';
    const object = OBJECT_NAME.exec(match[2])?.[1] ?? '?';
    hits.push(describeGuard(source, file, match.index ?? 0, kind, object));
  }
  for (const match of source.matchAll(REGPROC_GUARD)) {
    hits.push(describeGuard(source, file, match.index ?? 0, 'function', match[1] || '?'));
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * @description Scans a tree for by-name guards.
 * @param root - Absolute directory (normally the repo's src/).
 * @param repoRoot - Directory the reported file paths are relative to (defaults to root's parent).
 * @returns Every guard found, ordered by file then line.
 */
export function scanByNameGuards(root: string, repoRoot: string = join(root, '..')): ByNameGuard[] {
  const guards: ByNameGuard[] = [];
  for (const file of listSourceFiles(root)) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    guards.push(...findByNameGuards(readFileSync(file, 'utf8'), rel));
  }
  return guards.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Builds the record for one hit from the block that encloses it. */
function describeGuard(source: string, file: string, at: number, kind: ByNameGuardKind, object: string): ByNameGuard {
  const block = enclosingBlock(source, at);
  const line = source.slice(0, at).split('\n').length;
  return { file, line, kind, object, convergesOn: convergence(block, kind, object), createStatement: createStatement(block, kind, object) };
}

/** The DO $$ ... END $$ block containing the offset, or a fixed window around it when there is none. */
function enclosingBlock(source: string, at: number): string {
  for (const match of source.matchAll(DO_BLOCK)) {
    const start = match.index ?? 0;
    if (start <= at && at < start + match[0].length) return match[0];
  }
  return source.slice(Math.max(0, at - FALLBACK_WINDOW), at + FALLBACK_WINDOW);
}

/** Live-object properties the block converges on: a property predicate plus a DROP/REPLACE of the same object. */
function convergence(block: string, kind: ByNameGuardKind, object: string): string[] {
  const name = escapeRegExp(object);
  const replaces = kind === 'trigger'
    ? new RegExp(`\\b(?:DROP\\s+TRIGGER(?:\\s+IF\\s+EXISTS)?|CREATE\\s+OR\\s+REPLACE\\s+TRIGGER)\\s+${name}\\b`, 'i')
    : new RegExp(`\\b(?:DROP\\s+FUNCTION(?:\\s+IF\\s+EXISTS)?|CREATE\\s+OR\\s+REPLACE\\s+FUNCTION)\\s+${name}\\b`, 'i');
  if (!replaces.test(block)) return [];
  const properties = kind === 'trigger' ? TRIGGER_PROPERTIES : FUNCTION_PROPERTIES;
  return properties.filter((property) => new RegExp(`\\b${property}\\b`, 'i').test(block));
}

/** The normalized CREATE statement for the object inside the block ("" when absent). */
function createStatement(block: string, kind: ByNameGuardKind, object: string): string {
  const name = escapeRegExp(object);
  const re = kind === 'trigger'
    ? new RegExp(`CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+${name}\\b[\\s\\S]*?(?=;)`, 'i')
    : new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name}\\s*\\([\\s\\S]*?LANGUAGE\\s+\\w+`, 'i');
  const match = re.exec(block);
  return match ? normalizeSql(match[0]) : '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
