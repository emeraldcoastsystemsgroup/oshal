/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (B2): the RLS statements for a settings table that holds portal-default rows beside people's own. The owner-or-operator policy (buildOwnerRlsPolicyStatements) already lets only an operator write a row whose owner is not their own subject, and 'portal-default' is nobody's subject, so no person can insert, update or delete the portal-default row; this adds the one policy a fresh table needs on top, <table>_read_portal_default (FOR SELECT), so every identity, and the backend acting as a user, can read it. Idempotent and applied at the same lazy-DDL chokepoint, so a fresh database gets both the moment the table exists.
 */

import { buildOwnerRlsPolicyStatements } from './owner-rls-policy';
import { PORTAL_DEFAULT_OWNER } from '@/shared/portal-default';

/**
 * @description Builds the idempotent RLS statements for an owner-scoped settings table that also
 * holds portal-default rows (ADR-174 Amendment B, B2): the canonical owner-or-operator policy for
 * ALL commands, plus `<table>_read_portal_default`, a SELECT policy admitting the row owned by
 * {@link PORTAL_DEFAULT_OWNER} to every identity. Writes to that row still pass only the
 * owner-or-operator policy, whose WITH CHECK requires the owner to be the caller's own subject
 * (never 'portal-default') or the caller to be an operator. The database therefore refuses what
 * a route layer might miss. Postgres exempts superuser/BYPASSRLS roles, so these statements are
 * inert on the legacy single-role posture and enforce only under the `oshal_app` runtime role.
 *
 * Rules for a table that adopts this (ADR-174 Amendment B):
 *  - A reader filters by owner explicitly (`WHERE <owner> = $1`); RLS alone no longer scopes a
 *    SELECT to one person, because every person also sees the portal-default row.
 *  - Never a credential or secret column: "everyone reads it" includes guests, machine identities
 *    and the service rail. A key or token belongs in its own table, read through the operator.
 *  - The table's uniqueness includes the owner column, or the portal-default row collides with
 *    every person's own row on the same key.
 *  - Mirror the SELECT policy in docs/governance/rls-policies-enforce.sql, the reviewed source of
 *    truth the owner helper follows.
 * @param table - Table name (already-trusted identifier from a schema module; never user input)
 * @param ownerColumn - Column holding the owning user's sub claim, or 'portal-default'
 * @returns Ordered idempotent SQL statements safe to append to a runtime schema bootstrap
 */
export function buildPortalDefaultRlsPolicyStatements(table: string, ownerColumn: string): string[] {
  const policy = `${table}_read_portal_default`;
  return [
    ...buildOwnerRlsPolicyStatements(table, ownerColumn),
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_policy
         WHERE polname = '${policy}' AND polrelid = '${table}'::regclass
       ) THEN
         CREATE POLICY ${policy} ON ${table}
           AS PERMISSIVE FOR SELECT
           USING (${ownerColumn} = '${PORTAL_DEFAULT_OWNER}');
       END IF;
     END $$`,
  ];
}
