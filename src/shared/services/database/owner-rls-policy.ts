/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A1.2 fresh-boot RLS: idempotent owner-or-operator policy statements applied at the lazy-DDL chokepoint, so a table created by runtime schema bootstrap is never policy-less. Shapes mirror docs/governance/rls-policies-enforce.sql exactly.
 */

/**
 * @description Builds idempotent RLS statements that ENABLE + FORCE row-level
 * security on an owner-scoped table and create the canonical
 * `<table>_owner_or_operator` policy if it is absent. Uses create-if-absent
 * (not drop/recreate) so re-running at every boot never opens a window with
 * RLS enabled but no policy (which would deny the app its own rows mid-boot).
 * The policy shape MUST stay identical to docs/governance/rls-policies-enforce.sql —
 * that file remains the reviewed source of truth; this helper exists so a FRESH
 * database gets the same policies the moment the runtime schema bootstrap creates
 * the table, instead of waiting for an operator to run the governance script.
 * Postgres exempts superuser/BYPASSRLS roles, so these statements are inert on
 * the legacy single-role posture and only enforce under the `oshal_app` runtime
 * role (ADR-076).
 * @param table - Table name (already-trusted identifier from a schema module; never user input)
 * @param ownerColumn - Column holding the owning user's sub claim
 * @returns Ordered idempotent SQL statements safe to append to a runtime schema bootstrap
 */
export function buildOwnerRlsPolicyStatements(table: string, ownerColumn: string): string[] {
  const policy = `${table}_owner_or_operator`;
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_policy
         WHERE polname = '${policy}' AND polrelid = '${table}'::regclass
       ) THEN
         CREATE POLICY ${policy} ON ${table}
           AS PERMISSIVE FOR ALL
           USING (
             ${ownerColumn} = current_setting('oshal.current_sub', true)
             OR current_setting('oshal.is_operator', true) = 'on'
           )
           WITH CHECK (
             ${ownerColumn} = current_setting('oshal.current_sub', true)
             OR current_setting('oshal.is_operator', true) = 'on'
           );
       END IF;
     END $$`,
  ];
}
