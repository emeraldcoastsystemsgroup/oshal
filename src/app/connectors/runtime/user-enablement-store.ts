/**
 * Connector per-user enablement store — the OVERRIDE layer on top of the deployment-global
 * marketplace state (output/connector-marketplace-state.json) and the per-user credential
 * layer (resolveBotCreds / oshal_connections).
 *
 * Semantics (NON-BREAKING, see BACKLOG.md:2718 + migration 091):
 *   usable-for-user(provider) := deployment-enabled(provider) AND NOT user-disabled(provider)
 * Absence of a row = ALLOWED. This is what keeps every existing user who pasted a credential but
 * never toggled per-user from regressing. An `enabled=false` row blocks the connector for THAT
 * user only; an `enabled=true` row is an explicit opt-in / surface marker.
 *
 * Reads are FAIL-OPEN by contract: a query error (including the table not existing yet on a fresh
 * DB before migration 091 runs) returns an empty override set, i.e. default-allow — never a throw,
 * so a per-user consult can never break the broker dispatch path. Writes ensure the schema first
 * and throw on real failure so the route can 500 honestly.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial per-user connector enablement store: lazy-ensure of oshal_connector_user_enablement with owner-or-operator RLS (mirrors scripts/migrations/091), upsert of a per-user enable/disable override, and a fail-open read of a caller's overrides used by both the marketplace service per-user methods and the token broker's per-user disable consult.
 *
 * @module user-enablement-store
 */

import type { Pool } from 'pg';
import { buildOwnerRlsPolicyStatements } from '@/shared/services/database';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'connector-user-enablement-store' });

/** Table name — also the RLS owner-scoped relation (see migration 091). */
export const CONNECTOR_USER_ENABLEMENT_TABLE = 'oshal_connector_user_enablement';

/** Pools whose schema has already been ensured this process — avoids re-running idempotent DDL on the hot path. */
const ensuredPools = new WeakSet<object>();

/**
 * @description The ordered idempotent DDL that creates the per-user enablement table + its
 * owner-scoped RLS. Mirrors scripts/migrations/091-connector-user-enablement.sql exactly so a
 * fresh database is never left with the table present but policy-less between creation and a
 * migration re-run. Exported for direct unit coverage of the RLS shape.
 * @returns ordered CREATE / index / ENABLE-FORCE-RLS / policy statements
 */
export function connectorUserEnablementSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${CONNECTOR_USER_ENABLEMENT_TABLE} (
       user_sub   TEXT        NOT NULL,
       provider   TEXT        NOT NULL,
       enabled    BOOLEAN     NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (user_sub, provider)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_connector_user_enablement_user ON ${CONNECTOR_USER_ENABLEMENT_TABLE} (user_sub)`,
    ...buildOwnerRlsPolicyStatements(CONNECTOR_USER_ENABLEMENT_TABLE, 'user_sub'),
  ];
}

/**
 * @description Ensure the per-user enablement table + RLS exist (idempotent, cached per pool).
 * Called before every write; reads deliberately do NOT ensure (they fail-open on a missing table).
 * @param pool - Postgres pool
 * @returns resolves once the schema is present
 */
export async function ensureConnectorUserEnablementSchema(pool: Pool): Promise<void> {
  if (ensuredPools.has(pool as unknown as object)) return;
  for (const statement of connectorUserEnablementSchemaStatements()) {
    await pool.query(statement);
  }
  ensuredPools.add(pool as unknown as object);
}

/**
 * @description Upsert one caller's per-user override for a connector. `enabled=false` blocks the
 * connector for this user only; `enabled=true` records an explicit opt-in. Ensures the schema first.
 * @param pool - Postgres pool
 * @param userSub - the authenticated caller's OIDC sub (owner)
 * @param provider - connector provider slug
 * @param enabled - false to block for this user, true to opt in
 * @returns resolves when the row is persisted
 */
export async function setConnectorUserEnablement(
  pool: Pool,
  userSub: string,
  provider: string,
  enabled: boolean,
): Promise<void> {
  await ensureConnectorUserEnablementSchema(pool);
  await pool.query(
    `INSERT INTO ${CONNECTOR_USER_ENABLEMENT_TABLE} (user_sub, provider, enabled, updated_at)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (user_sub, provider)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [userSub, provider, enabled],
  );
  logger.info({ userSub, provider, enabled }, 'persisted per-user connector enablement override');
}

/**
 * @description Read every per-user override row for one caller as a provider→enabled map.
 * FAIL-OPEN: any query error (including the table not existing yet) is logged and returns an
 * empty map (= default-allow), so a per-user consult never breaks the caller.
 * @param pool - Postgres pool
 * @param userSub - the caller's OIDC sub
 * @returns provider → explicit enabled flag (only providers the user has toggled appear)
 */
export async function readConnectorUserEnablement(
  pool: Pool,
  userSub: string,
): Promise<Map<string, boolean>> {
  if (!userSub) return new Map();
  try {
    const result = await pool.query<{ provider: string; enabled: boolean }>(
      `SELECT provider, enabled FROM ${CONNECTOR_USER_ENABLEMENT_TABLE} WHERE user_sub = $1`,
      [userSub],
    );
    return new Map(result.rows.map((row) => [String(row.provider), Boolean(row.enabled)]));
  } catch (error) {
    // Fail-open: absence of the store (fresh DB) or a transient read error must not block a caller.
    logger.warn({ err: error, userSub }, 'per-user connector enablement read failed — defaulting to allow-all');
    return new Map();
  }
}

/**
 * @description The set of providers this caller has EXPLICITLY disabled (enabled=false rows only).
 * Used by the token broker to skip brokering a user-disabled connector. Fail-open (empty set).
 * @param pool - Postgres pool
 * @param userSub - the caller's OIDC sub
 * @returns providers the user has switched off for themselves
 */
export async function readConnectorUserDisabledProviders(
  pool: Pool,
  userSub: string,
): Promise<Set<string>> {
  const overrides = await readConnectorUserEnablement(pool, userSub);
  const disabled = new Set<string>();
  for (const [provider, enabled] of overrides) {
    if (enabled === false) disabled.add(provider);
  }
  return disabled;
}
