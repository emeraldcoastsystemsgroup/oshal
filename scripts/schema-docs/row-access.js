/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Summarise a table's row-level security from its REAL policy expressions (pg_policies USING / WITH CHECK), so the docs state which column scopes a row - owner column, helper function, parent table, or unrestricted - instead of inferring ownership from column names.
 */

'use strict';

const OWNER_RE = /\(*"?(\w+)"?\)?(?:::[\w ]+)?\s*=\s*(?:NULLIF\()?current_setting\('oshal\.current_sub'/g;
const HELPER_RE = /\b(oshal_[a-z_]+)\((\w+)\)/g;
const PARENT_RE = /EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(\w+)/gi;
const OPERATOR_ONLY_RE = /^\(*current_setting\('oshal\.is_operator'::text, true\) = 'on'::text\)*$/;

/**
 * @description Classify one policy expression into human-readable row-scope phrases.
 * @param {{name: string, command: string, using: string|null, check: string|null}} policy - pg_policies row
 * @returns {{scopes: string[], owners: string[]}} phrases plus any owner columns found
 */
function classifyPolicy(policy) {
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
 * @description Summarise a table's RLS posture for the docs.
 * @param {{rls: boolean, forced: boolean, policies: Array<object>, source: string}} table - folded table record
 * @returns {{state: string, scopes: string[], ownerColumns: string[]}} state is forced | enabled | off | n/a
 */
function summarizeRowAccess(table) {
  if (table.source === 'parsed') return { state: 'n/a', scopes: [], ownerColumns: [] };
  const state = table.forced ? 'forced' : table.rls ? 'enabled' : 'off';
  const scopes = new Set();
  const owners = new Set();
  for (const p of table.policies) {
    const r = classifyPolicy(p);
    r.scopes.forEach((s) => scopes.add(s));
    r.owners.forEach((o) => owners.add(o));
  }
  return { state, scopes: [...scopes], ownerColumns: [...owners] };
}

module.exports = { summarizeRowAccess, classifyPolicy };
