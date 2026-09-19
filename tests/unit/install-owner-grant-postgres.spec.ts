/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary companion for the install-owner admin grant. tests/unit/install-owner-stamp.spec.ts doubles the Pool and its decisive assertion reads the SQL text for "ON CONFLICT ... DO NOTHING" - a statement that is never executed - so nothing proved the INSERT lands under oshal_app_access FORCE RLS as a non-superuser, nothing proved DO NOTHING preserves a tier someone set on purpose (an explicit deny is the case that matters), and the pre-145 fallback was never reached because the double never raises 42703. CLAUDE.md's integration-boundary corollary asks for a real store against the enforcing role and schema; this is it. Nothing on the boundary is doubled: a disposable postgres:16-alpine, migrations 022/121/145/146 as shipped, a NOSUPERUSER NOBYPASSRLS role behind the production GUC wrapper, and the real AppAccessService. Self-validated - the role's own powers and a non-operator refusal are asserted BEFORE anything else, so the fixture is enforcing rather than agreeing with itself. Docker is REQUIRED; a missing engine fails loudly and never skips.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';
import { AppAccessService } from '../../src/features/swarm-apps/services/app-access-service';

const RUNTIME_ROLE = 'oshal_app_fixture';
const RUNTIME_PASS = 'fixture_only_never_a_deployment';
const APP = 'trading';
const OWNER = 'auth0|install-owner';
const ISSUER = 'https://tenant-a.example/';
const OTHER = 'auth0|somebody-else';

const fixture = new DisposablePostgres({
  purpose: 'install-owner-grant',
  migrations: [
    '022-swarm-applications.sql',
    '121-app-access-tiers.sql',
    '145-app-access-principal-issuer.sql',
    '146-app-access-legacy-issuerless-rows.sql',
  ],
});

let owner: Pool;
let runtime: Pool;
let access: AppAccessService;

/** The identity boot auto-load runs under: runWithSystemIdentity stamps is_operator on. */
const asOperator = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithRequestIdentity({ sub: OWNER, isOperator: true }, fn);

const asUser = <T>(sub: string, fn: () => Promise<T>): Promise<T> =>
  runWithRequestIdentity({ sub, isOperator: false }, fn);

beforeAll(async () => {
  owner = await fixture.start();
  await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASS}' NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE}`);
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`);
  // oshal_app_access.app_name REFERENCES swarm_applications(name), so the app has to exist.
  await owner.query(
    `INSERT INTO swarm_applications (app_id, name, display_name, manifest_path, manifest)
     VALUES (gen_random_uuid(), $1, $1, '/dev/null', '{}'::jsonb) ON CONFLICT (name) DO NOTHING`,
    [APP],
  );
  const { host, port, database } = fixture.connection;
  runtime = wrapPoolWithGuc(new Pool({ host, port, database, user: RUNTIME_ROLE, password: RUNTIME_PASS, max: 4 }));
  access = new AppAccessService(runtime);
}, 180_000);

afterAll(async () => {
  if (runtime) await runtime.end();
  await fixture.stop();
}, 60_000);

/** Read the stored tier straight off the table, bypassing the service entirely. */
async function storedTier(sub: string): Promise<string | null> {
  const result = await owner.query(
    'SELECT tier FROM oshal_app_access WHERE user_sub = $1 AND app_name = $2',
    [sub, APP],
  );
  return result.rows[0]?.tier ?? null;
}

describe('the install-owner admin grant, against the enforcing role and schema', () => {
  it('the fixture enforces: the runtime role is neither superuser nor RLS-bypassing', async () => {
    const who = await runtime.query(
      'SELECT current_user AS u,'
      + ' (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s,'
      + ' (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS b',
    );
    expect(who.rows[0].u).toBe(RUNTIME_ROLE);
    expect(who.rows[0].s, 'a superuser would pass every case below for the wrong reason').toBe(false);
    expect(who.rows[0].b, 'BYPASSRLS would make the policy assertions meaningless').toBe(false);
  });

  it('a NON-operator cannot write a tier — the write policy is real', async () => {
    // Asserted before the grants so those mean something. If this passed silently, every case
    // after it would prove nothing about the policy at all.
    await expect(asUser(OTHER, () => access.grantIfAbsent({
      userSub: OTHER,
      userIssuer: null,
      appName: APP,
      tier: 'admin',
      assignedBySub: OTHER,
      reason: 'should be refused by oshal_app_access_operator_write',
    }))).rejects.toMatchObject({ code: '42501' });
    expect(await storedTier(OTHER)).toBeNull();
  });

  it('grants admin to the install owner when the principal has no tier', async () => {
    const granted = await asOperator(() => access.grantIfAbsent({
      userSub: OWNER,
      userIssuer: ISSUER,
      appName: APP,
      tier: 'admin',
      assignedBySub: OWNER,
      reason: 'Install owner: administrator of every application this installation staged',
    }));
    expect(granted).toBe(true);
    expect(await storedTier(OWNER)).toBe('admin');
  });

  it('a second grant writes nothing and reports nothing — adoption runs on every boot', async () => {
    const again = await asOperator(() => access.grantIfAbsent({
      userSub: OWNER,
      userIssuer: ISSUER,
      appName: APP,
      tier: 'admin',
      assignedBySub: OWNER,
      reason: 'Install owner: administrator of every application this installation staged',
    }));
    expect(again, 'a repeat grant reported a write — the boot pass is not idempotent').toBe(false);
    expect(await storedTier(OWNER)).toBe('admin');
  });

  it('DO NOTHING preserves an explicit deny — the case that actually matters', async () => {
    // A tier someone set ON PURPOSE must survive adoption. Were the statement DO UPDATE, the
    // install owner would silently restore themselves to admin on an app they had been denied.
    const denied = 'auth0|denied-on-purpose';
    await asOperator(() => access.assign({
      userSub: denied,
      userIssuer: ISSUER,
      appName: APP,
      tier: 'deny',
      assignedBySub: OWNER,
      reason: 'operator set this deliberately',
    }));
    expect(await storedTier(denied)).toBe('deny');

    const granted = await asOperator(() => access.grantIfAbsent({
      userSub: denied,
      userIssuer: ISSUER,
      appName: APP,
      tier: 'admin',
      assignedBySub: OWNER,
      reason: 'Install owner: administrator of every application this installation staged',
    }));
    expect(granted, 'the grant claimed to write over an explicit deny').toBe(false);
    expect(await storedTier(denied), 'an explicit deny was overwritten by install-owner adoption').toBe('deny');
  });
});
