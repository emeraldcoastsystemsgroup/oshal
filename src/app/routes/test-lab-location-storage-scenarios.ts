/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for ADR-169 slice L2 (location storage with no operator bypass). Two steps against the database the running build uses. The posture step reads only the catalog: every location table present with ENABLE and FORCE and at least one policy, no oshal.is_operator in a location policy or any helper it reaches (operator decision Q2), the membership and creator fences and the tenant-admin helper installed, and a connecting role that row-level security applies to. The probe step writes synthetic, uniquely tagged rows inside ONE transaction that it always rolls back: a synthetic owner writes a fix, a synthetic stranger, the same stranger operator-stamped, and the SYSTEM stamp each read none of it, the owner reads it and purges it, and an operator-stamped session cannot add itself to a synthetic group. Nothing persists; no real person's row is read.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { LOCATION_TABLES, inspectLocationRlsPosture, type LocationRlsPosture } from '@/features/location';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-location-storage' });
const APP = 'location';
const POSTURE_LABEL = 'Location tables have no operator bypass on this database (ADR-169 L2)';
const PROBE_LABEL = 'Two-identity probe, rolled back (ADR-169 L2)';
const PROBE_ISSUER = 'urn:oshal:test-lab';
const NOT_LIVE = 'It reads no real person\'s rows, and the probe\'s synthetic rows are rolled back.';

type Result = (state: StepResult['state'], detail: string, output?: unknown) => StepResult;
const resultFor = (label: string): Result => (state, detail, output) =>
  ({ app: APP, label, state, detail, ...(output === undefined ? {} : { output }) });

/**
 * @description Grade a posture read. A role that bypasses row-level security is a gap, not a
 * failure of the store: the policies may be right while this connection is exempt from them.
 * @param posture - The catalog read.
 * @returns The Lab step result.
 */
export function gradeLocationPosture(posture: LocationRlsPosture): StepResult {
  const result = resultFor(POSTURE_LABEL);
  const missing = posture.tables.filter((t) => !t.present).map((t) => t.table);
  if (missing.length) return result('fail', `Location tables missing on this database: ${missing.join(', ')}.`, { missing });
  const unforced = posture.tables.filter((t) => !t.enabled || !t.forced || t.policies === 0).map((t) => t.table);
  if (unforced.length) return result('fail', `Not ENABLE+FORCE with a policy: ${unforced.join(', ')}.`, { unforced });
  if (posture.bypasses.length) return result('fail', `oshal.is_operator found in: ${posture.bypasses.join(', ')}.`, { bypasses: posture.bypasses });
  if (!posture.membershipFence || !posture.creatorFence || !posture.tenantAdminHelper) {
    return result('fail', 'The membership fence, the creator fence or oshal_is_tenant_admin is not installed.',
      { membershipFence: posture.membershipFence, creatorFence: posture.creatorFence, tenantAdminHelper: posture.tenantAdminHelper });
  }
  if (posture.role.superuser || posture.role.bypassRls) {
    return result('gap', 'The policies are right, but this build connects as a role that bypasses row-level security, so they do not bind it.', posture.role);
  }
  return result('pass', `${LOCATION_TABLES.length} location tables are ENABLE+FORCE with policies; ${posture.functionsChecked.length} helpers checked; no operator bypass; both membership fences installed. ${NOT_LIVE}`);
}

/** Stamp the transaction-local identity the location policies read. */
async function stamp(client: PoolClient, sub: string, operator: boolean): Promise<void> {
  await client.query("SELECT set_config('oshal.current_sub', $1, true), set_config('oshal.current_issuer', $2, true), "
    + "set_config('oshal.is_operator', $3, true)", [sub, sub ? PROBE_ISSUER : '', operator ? 'on' : 'off']);
}

/** Count the synthetic owner's observations as the currently stamped identity. */
async function visible(client: PoolClient, owner: string): Promise<number> {
  return Number((await client.query('SELECT count(*)::int AS n FROM location_observations WHERE owner_sub = $1', [owner])).rows[0].n);
}

/**
 * Whether a statement is refused with insufficient_privilege (42501), inside a savepoint so the
 * transaction survives the refusal. Any other error is not the refusal under test and is rethrown.
 */
async function refused(client: PoolClient, sql: string, params: unknown[]): Promise<boolean> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT probe');
    return false;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    if ((error as { code?: string }).code === '42501') return true;
    throw error;
  }
}

/**
 * @description The two-identity probe inside an open transaction. Every write is synthetic.
 * @param client - A client with an open transaction.
 * @returns Named checks and whether each held.
 */
export async function runLocationProbe(client: PoolClient): Promise<Array<[string, boolean]>> {
  const tag = randomUUID().slice(0, 8);
  const owner = `test-lab-location-owner-${tag}`;
  const stranger = `test-lab-location-stranger-${tag}`;
  await stamp(client, owner, false);
  await client.query(`INSERT INTO location_observations (owner_sub, principal_issuer, subject_ref, source, precision_class, lat, lon, observed_at)
    VALUES ($1, $2, $1, 'manual', 'city', -12.35, -31.99, NOW())`, [owner, PROBE_ISSUER]);
  const checks: Array<[string, boolean]> = [['the owner reads their fix', await visible(client, owner) === 1]];
  await stamp(client, stranger, false);
  checks.push(['a stranger reads none of it', await visible(client, owner) === 0]);
  await stamp(client, stranger, true);
  checks.push(['an operator-stamped stranger reads none of it', await visible(client, owner) === 0]);
  await stamp(client, '', true);
  checks.push(['the SYSTEM stamp reads none of it', await visible(client, owner) === 0]);
  await stamp(client, owner, false);
  const tenant = (await client.query("INSERT INTO oshal_tenants (name, created_by_sub) VALUES ('Test Lab probe', $1) RETURNING tenant_id", [owner])).rows[0].tenant_id;
  await client.query("INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'admin')", [tenant, owner]);
  await stamp(client, stranger, true);
  checks.push(['an operator-stamped session cannot add itself to a group',
    await refused(client, "INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'admin')", [tenant, stranger])]);
  await stamp(client, owner, false);
  checks.push(['the owner\'s purge removes the fix', (await client.query('DELETE FROM location_observations WHERE owner_sub = $1', [owner])).rowCount === 1]);
  return checks;
}

/**
 * @description Run the probe in a transaction that is always rolled back, and grade it.
 * @param runtime - The Lab's server-derived context (its pool).
 * @returns The Lab step result.
 */
export async function locationProbeStep(runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(PROBE_LABEL);
  if (!runtime?.ctx?.pool) return result('gap', 'Needs the running server\'s database pool; run it from the Test Lab.');
  const role = await inspectLocationRlsPosture(runtime.ctx.pool);
  if (role.role.superuser || role.role.bypassRls) return result('gap', 'This build connects as a role that bypasses row-level security, so a probe would prove nothing.');
  const client = await runtime.ctx.pool.connect();
  let checks: Array<[string, boolean]>;
  try {
    await client.query('BEGIN');
    checks = await runLocationProbe(client);
  } catch (error) {
    logger.error({ op: 'location-probe', err: locationSafeError(error) }, 'Test Lab location probe could not run');
    return result('fail', `The probe could not run: ${(error as { code?: string }).code ?? (error as Error).name}.`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Probe failed: ${failed.join('; ')}.`, { failed });
  return result('pass', `${checks.length} checks hold on this database: ${checks.map(([name]) => name).join('; ')}. ${NOT_LIVE}`);
}

/** The ADR-169 L2 Test Lab card. */
export const LOCATION_STORAGE_SCENARIOS: Scenario[] = [{
  id: 'location-storage-rls',
  title: 'Location — storage has no operator bypass (ADR-169 L2)',
  group: 'tool',
  description: 'Checks the database this build runs on carries ADR-169 slice L2: every location table ENABLE+FORCE with policies and no oshal.is_operator in any policy or helper it reaches (operator decision Q2), the membership and creator fences installed, and a connecting role that row-level security binds. Then a two-identity probe inside a transaction that is always rolled back: a synthetic owner writes a fix that a stranger, an operator-stamped stranger and the SYSTEM stamp cannot read, an operator-stamped session cannot add itself to a group, and the owner purges the fix. Nothing persists and no real person\'s row is read.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/location-storage-rls-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/location-erasure-routes-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-rls-no-operator-guard.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-location-storage-registration.spec.ts' },
  ],
  steps: [
    { id: 'rls-posture', app: APP, label: POSTURE_LABEL, run: async (_cookie, _prior, runtime) => {
      if (!runtime?.ctx?.pool) return resultFor(POSTURE_LABEL)('gap', 'Needs the running server\'s database pool; run it from the Test Lab.');
      return gradeLocationPosture(await inspectLocationRlsPosture(runtime.ctx.pool));
    } },
    { id: 'two-identity-probe', app: APP, label: PROBE_LABEL, run: async (_cookie, _prior, runtime) => locationProbeStep(runtime) },
  ],
}];
