/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Review fix (registry coverage gap): the hand-written registry covered 11 stores while 40+ other user_sub/owner_sub-keyed Postgres tables (ambient transcripts, per-app profiles/conversations/messages, trading/kalshi rows, personal graph, user-model facts, channel links, ...) were silently absent from BOTH export and delete. This module closes the gap STRUCTURALLY: it discovers every public base table carrying an ownership column (user_sub/owner_sub/actor_sub) from information_schema at request time, so any table added in the future participates automatically instead of silently falling out of the inventory. Append-only/audit/security tables are export-only with an explicit retention reason; secret-shaped string columns are redacted; deletes run children-before-parents via an FK topological sort.
 */

/**
 * Dynamic (catalog-driven) exporters. The explicit exporters in default-exporters.ts stay the
 * curated, column-sanitized front line; THIS module is the guarantee behind the registry's
 * claim to be "the single inventory of the per-user data the platform holds": every remaining
 * `public` base table with an ownership column becomes an exporter automatically. Discovery
 * failures are deliberately fatal to the calling operation — proceeding with a partial
 * inventory while reporting success is exactly the bug this module exists to fix.
 *
 * @module features/data-lifecycle/services/discovered-exporters
 */

import { createChildLogger } from '@/shared/logger';
import type { DataExporter } from './exporter-registry';
import type { PgLike } from './default-exporters';

const logger = createChildLogger({ module: 'data-lifecycle:discovered' });

/**
 * @description Ownership columns that mark a table as per-user, in priority order (a table
 * carrying more than one is keyed by the first match). `actor_sub` covers the audit tables
 * (access_audit_log) which attribute rows to the acting user.
 */
export const OWNERSHIP_COLUMNS = ['user_sub', 'owner_sub', 'actor_sub'] as const;

/**
 * @description Tables that are discovered (so they EXPORT) but must never be mechanically
 * deleted, with the human-readable reason reported as the store's deleteNote / skip reason.
 * access_audit_log + connector_action_audit are append-only by trigger (migrations 061/083 —
 * a DELETE raises), data_lifecycle_audit is the retained record that the delete itself
 * happened, and tv_token_revocations is a security floor: removing a revocation row would
 * resurrect every revoked TV token minted before it.
 */
export const RETAINED_DISCOVERED_TABLES: Readonly<Record<string, string>> = {
  access_audit_log:
    'Append-only audit trail (migration 061 installs BEFORE UPDATE/DELETE triggers that reject mutation). Retained by design; export-only.',
  connector_action_audit:
    'Append-only connector-action audit trail (migration 083, same trigger model as 061). Retained by design; export-only.',
  data_lifecycle_audit:
    'The retained record that an export/delete happened and what each store reported — it must survive the deletion it documents. Export-only.',
  tv_token_revocations:
    'Security floor, not personal content: deleting the revocation row would resurrect previously revoked TV pairing tokens. Export-only.',
};

/**
 * @description Column-name shapes whose STRING values are redacted in the auto-discovered
 * export (secrets must never ride out in a JSON download): tokens/secrets/keys plus wrapped
 * data-encryption keys (oshal_user_deks.wrapped_dek). Numeric columns that merely contain
 * the word (e.g. prompt_tokens usage counters) are untouched — redaction applies to string
 * values only, and the trailing-s/underscore boundaries keep `*_tokens` counters out anyway.
 */
const SECRET_COLUMN_RE = /(secret|password|credential|private_key|api_key|apikey|(access|refresh|auth|bearer|session)_?token|(^|_)token(_|$)|(^|_)dek(_|$))/i;

/** Identifier safety net: information_schema is trusted, but never interpolate a weird name. */
const SAFE_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** One discovered per-user table: its name + which ownership column keys it. */
export interface DiscoveredTable {
  table: string;
  ownerColumn: string;
}

/** Replace secret-shaped string values so an auto-discovered export can never leak a credential. */
function redactSecretColumns(row: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    clean[k] = SECRET_COLUMN_RE.test(k) && typeof v === 'string' && v.length > 0 ? '[redacted: secret-shaped column]' : v;
  }
  return clean;
}

/**
 * @description Discover every `public` base table carrying an ownership column, excluding the
 * explicitly-covered tables (those have curated, column-sanitized exporters — running SELECT *
 * over them here would re-expose the columns the curated SQL deliberately omits).
 * @param pool - Postgres pool (PgLike).
 * @param excludeTables - Table names already covered by explicit exporters.
 * @returns One entry per discovered table, keyed by its highest-priority ownership column.
 */
export async function discoverSubKeyedTables(pool: PgLike, excludeTables: ReadonlySet<string>): Promise<DiscoveredTable[]> {
  const r = await pool.query(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.column_name = ANY($1::text[])
      ORDER BY c.table_name`,
    [[...OWNERSHIP_COLUMNS]],
  );
  const byTable = new Map<string, string>();
  for (const row of r.rows) {
    const table = String(row.table_name);
    const column = String(row.column_name);
    if (excludeTables.has(table)) continue;
    if (!SAFE_IDENT_RE.test(table) || !SAFE_IDENT_RE.test(column)) {
      logger.error({ table, column }, 'discovered table/column name failed the identifier safety net — skipped from discovery');
      continue;
    }
    const existing = byTable.get(table);
    if (!existing || OWNERSHIP_COLUMNS.indexOf(column as (typeof OWNERSHIP_COLUMNS)[number]) < OWNERSHIP_COLUMNS.indexOf(existing as (typeof OWNERSHIP_COLUMNS)[number])) {
      byTable.set(table, column);
    }
  }
  return [...byTable.entries()].map(([table, ownerColumn]) => ({ table, ownerColumn }));
}

/** Load the FK graph (child references parent) among public tables for delete ordering. */
async function loadFkEdges(pool: PgLike): Promise<Array<{ child: string; parent: string }>> {
  const r = await pool.query(
    `SELECT DISTINCT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
  );
  return r.rows.map((row) => ({ child: String(row.child), parent: String(row.parent) }));
}

/**
 * @description Order the discovered tables children-before-parents (Kahn topological sort over
 * the FK edges restricted to the discovered set), so a non-cascading FK never makes a parent
 * delete fail merely because its child rows had not been removed yet. Cycles (or self-refs)
 * fall back to name order and are honestly reported as failed outcomes if a delete then breaks.
 * @param tables - The discovered tables.
 * @param edges - FK edges (child -> parent) among public tables.
 * @returns The tables, delete-safe ordered.
 */
export function orderChildrenFirst(tables: DiscoveredTable[], edges: Array<{ child: string; parent: string }>): DiscoveredTable[] {
  const inSet = new Map(tables.map((t) => [t.table, t]));
  const pendingChildren = new Map<string, number>(); // parent -> children not yet emitted
  const parentsOf = new Map<string, string[]>(); // child -> parents to unblock on emit
  for (const t of tables) pendingChildren.set(t.table, 0);
  for (const { child, parent } of edges) {
    if (child === parent || !inSet.has(child) || !inSet.has(parent)) continue;
    pendingChildren.set(parent, (pendingChildren.get(parent) ?? 0) + 1);
    parentsOf.set(child, [...(parentsOf.get(child) ?? []), parent]);
  }
  const ready = tables.filter((t) => (pendingChildren.get(t.table) ?? 0) === 0).map((t) => t.table).sort();
  const out: DiscoveredTable[] = [];
  const emitted = new Set<string>();
  while (ready.length > 0) {
    const name = ready.shift() as string;
    if (emitted.has(name)) continue;
    emitted.add(name);
    out.push(inSet.get(name) as DiscoveredTable);
    for (const parent of parentsOf.get(name) ?? []) {
      const left = (pendingChildren.get(parent) ?? 1) - 1;
      pendingChildren.set(parent, left);
      if (left === 0) ready.push(parent);
    }
  }
  // FK cycles: emit the remainder in name order rather than dropping them from the inventory.
  for (const t of [...tables].sort((a, b) => a.table.localeCompare(b.table))) {
    if (!emitted.has(t.table)) out.push(t);
  }
  return out;
}

/** Build the DataExporter for one discovered table (export-only when on the retain list). */
function discoveredExporter(pool: PgLike, t: DiscoveredTable): DataExporter {
  const retained = RETAINED_DISCOVERED_TABLES[t.table];
  return {
    store: t.table,
    describe: `Auto-discovered per-user store: every ${t.table} row keyed by your ${t.ownerColumn}. Secret-shaped string columns are redacted in the export.`,
    deletable: !retained,
    ...(retained ? { deleteNote: retained } : {}),
    async exportRows(userSub: string): Promise<unknown[]> {
      const r = await pool.query(`SELECT * FROM "${t.table}" WHERE "${t.ownerColumn}"=$1`, [userSub]);
      return r.rows.map(redactSecretColumns);
    },
    ...(!retained
      ? {
          async deleteRows(userSub: string): Promise<number> {
            const r = await pool.query(`DELETE FROM "${t.table}" WHERE "${t.ownerColumn}"=$1`, [userSub]);
            return r.rowCount ?? 0;
          },
        }
      : {}),
  };
}

/**
 * @description Discover and build exporters for EVERY remaining sub-keyed public table, in
 * delete-safe (children-first) order. Called per request by buildAllExporters — two cheap
 * information_schema reads — so a table created after boot still shows up. Throws (rather than
 * degrading to a partial inventory) when discovery itself fails: a "successful" export/delete
 * built from an incomplete table list is the exact dishonesty this module fixes.
 * @param pool - Postgres pool (PgLike; the app passes its GUC-wrapped pool).
 * @param excludeTables - Table names already covered by the explicit, column-sanitized exporters.
 * @returns One DataExporter per discovered table, children-before-parents.
 */
export async function discoverSubKeyedExporters(pool: PgLike, excludeTables: ReadonlySet<string>): Promise<DataExporter[]> {
  const [tables, edges] = await Promise.all([discoverSubKeyedTables(pool, excludeTables), loadFkEdges(pool)]);
  const ordered = orderChildrenFirst(tables, edges);
  logger.info({ discovered: ordered.length, retained: ordered.filter((t) => RETAINED_DISCOVERED_TABLES[t.table]).length }, 'sub-keyed table discovery complete');
  return ordered.map((t) => discoveredExporter(pool, t));
}
