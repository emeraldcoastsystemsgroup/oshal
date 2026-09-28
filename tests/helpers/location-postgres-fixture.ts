/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2: the shared disposable-PostgreSQL shape for the location specs. It applies the shipped migrations the location store depends on (060 tenancy, 100 CLI tokens, 174 membership fence, 175 location tables; 080 when a spec needs the data-lifecycle audit), creates the NOSUPERUSER NOBYPASSRLS runtime role oshal_app, and then converges ownership the way docs/governance/app-role-provisioning.sql does on a real deployment: every public table is OWNED by oshal_app while the SECURITY DEFINER helpers stay with the bootstrap superuser. That makes the enforcing role the table owner, so a policy only holds because FORCE ROW LEVEL SECURITY is on, which is the posture production runs in. Synthetic identities only.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: the location store now also needs 115 (the durable remote-client owner binding that migration 176's device identity fence reads for a node) and 176 itself (place "since" columns, the group-only kinds CHECK, the identity fence).
 */

import type { Pool, PoolClient } from 'pg';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { DisposablePostgres } from './disposable-postgres';

/** The runtime role the app connects as on a provisioned deployment. */
export const LOCATION_APP_ROLE = 'oshal_app';

/** A neutral fixture issuer: every synthetic person in the location specs signs in here. */
export const FIXTURE_ISSUER = 'https://login.oshal.example.com';

/** The migrations the location store needs, in order. */
export const LOCATION_MIGRATIONS: readonly string[] = [
  '060-platform-rls-tenancy.sql',
  '100-cli-token-base-schema.sql',
  '115-durable-remote-task-journal.sql',
  '174-tenant-admin-membership-fence.sql',
  '175-location-storage.sql',
  '176-location-places-and-devices.sql',
];

/**
 * @description A private server with the location schema, the runtime role and production-shaped ownership.
 * @param purpose - Names the container.
 * @param extraMigrations - Migrations applied before the location ones (e.g. 080 for the audit table).
 * @returns The (not yet started) fixture.
 */
export function locationDatabase(purpose: string, extraMigrations: readonly string[] = []): DisposablePostgres {
  return new DisposablePostgres({
    purpose,
    roles: [{ name: LOCATION_APP_ROLE, max: 8 }],
    migrations: [...extraMigrations, ...LOCATION_MIGRATIONS],
  });
}

/**
 * @description Hand every public table to oshal_app and grant it the functions, as the provisioner
 * does. The superuser keeps the SECURITY DEFINER helpers (they must read past the policies).
 * @param db - A started fixture.
 * @returns The GUC-wrapped runtime pool: every query stamps the ambient request identity.
 */
export async function convergeAppRole(db: DisposablePostgres): Promise<Pool> {
  await db.pool.query(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO ${LOCATION_APP_ROLE}', r.relname);
    END LOOP; END $$`);
  await db.pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${LOCATION_APP_ROLE}`);
  return wrapPoolWithGuc(db.rolePool(LOCATION_APP_ROLE));
}

/** One synthetic session. */
export interface FixtureSession {
  sub: string;
  issuer?: string | null;
  operator?: boolean;
}

/**
 * @description Run `fn` under a request identity, exactly as the server's identity middleware stamps it.
 * @param who - The session: subject, issuer (default the fixture issuer) and the operator flag.
 * @param fn - The work.
 * @returns What `fn` returns.
 */
export function asSession<T>(who: FixtureSession, fn: () => Promise<T>): Promise<T> {
  const principalIssuer = who.issuer === undefined ? FIXTURE_ISSUER : who.issuer;
  return runWithRequestIdentity({ sub: who.sub, principalIssuer, isOperator: who.operator === true }, fn);
}

/**
 * @description Run `fn` under the frozen SYSTEM sentinel (blank subject, operator-stamped).
 * @param fn - The work.
 * @returns What `fn` returns.
 */
export function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithSystemIdentity(fn);
}

/**
 * @description Run several statements on one runtime-role client in one transaction under a
 * session, rolling back afterwards so a refusal test never leaves a half-written row.
 * @param app - The GUC-wrapped runtime pool.
 * @param who - The session.
 * @param fn - The statements.
 * @returns What `fn` returns.
 */
export async function inRolledBackTransaction<T>(app: Pool, who: FixtureSession, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return asSession(who, async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
}

/**
 * @description The Postgres error code a promise rejected with, or 'resolved' when it did not.
 * @param work - The statement.
 * @returns The SQLSTATE, e.g. 42501 for a row-level-security refusal.
 */
export async function sqlState(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'resolved';
  } catch (error) {
    return String((error as { code?: unknown }).code ?? 'no-code');
  }
}
