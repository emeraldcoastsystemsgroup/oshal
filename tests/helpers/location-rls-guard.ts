/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 D3/L2: the "no operator bypass" guard for the location tables (operator decision Q2), in two halves over the same rule. The static half reads every migration in scripts/migrations: a CREATE or ALTER POLICY on a location_* table, every function such a policy calls (followed transitively through function bodies, last definition wins), the membership-fence seed functions, and any dynamic statement that builds a policy for a location table, must not mention oshal.is_operator; SQL comments and COMMENT ON strings are not code and are stripped first. The catalog half is the slice's own inspectLocationRlsPosture (src/features/location), which asks a live database the same question through pg_policies and pg_proc and is what the Test Lab card runs; both halves share one reachability walk.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  LOCATION_FENCE_FUNCTIONS,
  LOCATION_OPERATOR_BYPASS_TOKEN as OPERATOR_BYPASS_TOKEN,
  reachableLocationFunctions,
} from '@/features/location';

/** @description Functions checked even though no location policy names them (the fences and the admin helper). */
export const LOCATION_HELPER_SEEDS: readonly string[] = LOCATION_FENCE_FUNCTIONS;

const LOCATION_TABLE = /^location_[a-z0-9_]+$/;

/** @description What the static scan found. */
export interface StaticBypassReport {
  /** `table.policy` for every location policy read. */
  policies: string[];
  /** Every function whose body was checked. */
  functionsChecked: string[];
  /** Each bypass as `policy <table>.<name>`, `function <name>` or `dynamic <file>`. */
  bypasses: string[];
}

/**
 * @description Remove SQL comments and COMMENT ON statements: prose about the rule is not the rule.
 * @param sql - A migration's text.
 * @returns The text with `--` comments, block comments and COMMENT ON statements removed.
 */
export function stripSqlProse(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/COMMENT\s+ON\s+[\s\S]*?'(?:[^']|'')*'\s*;/gi, ' ');
}

/** One policy statement found in a migration. */
interface PolicyStatement { table: string; name: string; text: string }

/**
 * @description Literal CREATE/ALTER POLICY statements and their text up to the terminating semicolon.
 * @param sql - Prose-stripped migration text.
 * @returns The statements.
 */
function policyStatements(sql: string): PolicyStatement[] {
  const out: PolicyStatement[] = [];
  const re = /(?:CREATE|ALTER)\s+POLICY\s+("?)([a-z_][a-z0-9_]*)\1\s+ON\s+(?:public\.)?("?)([a-z_][a-z0-9_]*)\3([\s\S]*?);/gi;
  for (const m of sql.matchAll(re)) out.push({ name: m[2].toLowerCase(), table: m[4].toLowerCase(), text: m[0] });
  return out;
}

/**
 * @description CREATE FUNCTION bodies by name (dollar-quoted bodies of any tag).
 * @param sql - Prose-stripped migration text.
 * @returns name -> body text.
 */
function functionBodies(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\$([a-z_]*)\$([\s\S]*?)\$\3\$/gi;
  for (const m of sql.matchAll(re)) out.set(m[1].toLowerCase(), `${m[2]} ${m[4]}`);
  return out;
}

/**
 * @description Statements that build policies dynamically (EXECUTE format(...) in a DO block) and
 * name a location table: a bypass there cannot be read from a literal CREATE POLICY.
 * @param sql - Prose-stripped migration text.
 * @returns true when such a statement also mentions the bypass token.
 */
function dynamicLocationBypass(sql: string): boolean {
  for (const m of sql.matchAll(/DO\s+\$([a-z_]*)\$([\s\S]*?)\$\1\$/gi)) {
    const body = m[2];
    if (/CREATE\s+POLICY/i.test(body) && /\blocation_[a-z0-9_]+/i.test(body) && body.includes(OPERATOR_BYPASS_TOKEN)) return true;
  }
  return false;
}

/**
 * @description The static guard over a set of migration texts, in file order.
 * @param files - [file name, SQL text] pairs, in the order migrations apply.
 * @param seeds - Functions checked regardless of whether a policy calls them.
 * @returns What was read and every bypass found.
 */
export function scanForOperatorBypass(files: ReadonlyArray<readonly [string, string]>, seeds = LOCATION_HELPER_SEEDS): StaticBypassReport {
  const policies = new Map<string, PolicyStatement>();
  const bodies = new Map<string, string>();
  const bypasses: string[] = [];
  for (const [file, raw] of files) {
    const sql = stripSqlProse(raw);
    for (const p of policyStatements(sql)) if (LOCATION_TABLE.test(p.table)) policies.set(`${p.table}.${p.name}`, p);
    for (const [name, body] of functionBodies(sql)) bodies.set(name, body);
    if (dynamicLocationBypass(sql)) bypasses.push(`dynamic ${file}`);
  }
  for (const [key, p] of policies) if (p.text.includes(OPERATOR_BYPASS_TOKEN)) bypasses.push(`policy ${key}`);
  const functionsChecked = reachableLocationFunctions([...policies.values()].map((p) => p.text), seeds, bodies);
  for (const name of functionsChecked) if ((bodies.get(name) ?? '').includes(OPERATOR_BYPASS_TOKEN)) bypasses.push(`function ${name}`);
  return { policies: [...policies.keys()].sort(), functionsChecked, bypasses: bypasses.sort() };
}

/**
 * @description Read every migration in a directory, in apply order, and run the static guard.
 * @param dir - The migrations directory.
 * @returns The report.
 */
export function scanMigrationsDir(dir: string): StaticBypassReport {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')] as const);
  return scanForOperatorBypass(files);
}
