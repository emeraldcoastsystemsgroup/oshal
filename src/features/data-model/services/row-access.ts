/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | RLS row-scope classification for the data-model explorer, read from each table's REAL policy expressions (pg_policies USING / WITH CHECK): owner column, helper function, parent table, unrestricted, or operator-only. Same rules as the schema-docs generator (scripts/schema-docs/row-access.js); tests/unit/data-model-catalog.spec.ts holds the two to identical answers.
 */

import type { PolicyInfo, RelationInfo, RowAccessSummary } from '../types';

const OWNER_RE = /\(*"?(\w+)"?\)?(?:::[\w ]+)?\s*=\s*(?:NULLIF\()?current_setting\('oshal\.current_sub'/g;
const HELPER_RE = /\b(oshal_[a-z_]+)\((\w+)\)/g;
const PARENT_RE = /EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(\w+)/gi;
const OPERATOR_ONLY_RE = /^\(*current_setting\('oshal\.is_operator'::text, true\) = 'on'::text\)*$/;

/**
 * @description Classify one policy expression into human-readable row-scope phrases.
 * @param policy - a pg_policies row
 * @returns the phrases plus any owner columns found
 */
export function classifyPolicy(policy: PolicyInfo): { scopes: string[]; owners: string[] } {
  const expr = (policy.using || policy.check || '').replace(/\s+/g, ' ').trim();
  const command = policy.command === 'ALL' ? 'all commands' : policy.command;
  if (expr === 'true') return { scopes: [`${command}: unrestricted`], owners: [] };
  if (OPERATOR_ONLY_RE.test(expr)) return { scopes: [`${command}: operator only`], owners: [] };
  const owners = [...expr.matchAll(OWNER_RE)].map((m) => m[1]);
  const scopes = owners.map((c) => `owner \`${c}\``);
  for (const m of expr.matchAll(HELPER_RE)) scopes.push(`\`${m[1]}(${m[2]})\``);
  for (const m of expr.matchAll(PARENT_RE)) scopes.push(`via parent \`${m[1]}\``);
  if (!scopes.length) scopes.push(`custom policy \`${policy.name}\``);
  return { scopes, owners };
}

/**
 * @description Summarise a relation's RLS posture: the FORCE/ENABLE flags plus the union of what
 * its policies scope rows by. A parsed (non-catalog) relation has no posture to report.
 * @param rel - a relation record
 * @returns state, scope phrases and owner columns
 */
export function summarizeRowAccess(rel: Pick<RelationInfo, 'rls' | 'forced' | 'policies' | 'source'>): RowAccessSummary {
  if (rel.source === 'parsed') return { state: 'n/a', scopes: [], ownerColumns: [] };
  const state = rel.forced ? 'forced' : rel.rls ? 'enabled' : 'off';
  const scopes = new Set<string>();
  const owners = new Set<string>();
  for (const p of rel.policies) {
    const r = classifyPolicy(p);
    r.scopes.forEach((s) => scopes.add(s));
    r.owners.forEach((o) => owners.add(o));
  }
  return { state, scopes: [...scopes], ownerColumns: [...owners] };
}
