/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-PostgreSQL proof that an ADR-118 explicit tier resolves for the exact (subject, issuer) principal it was written for: a federated identity holding an admin assignment reaches a catalog-less application, the same identity without one is still refused, an issuer-less legacy row answers only a canonical local account, a row bound to one issuer never answers another, and one subject's grant never answers a different subject.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove simultaneous issuer isolation, independent clear and deny retention, owner RLS and nonoperator write refusal, local alias equivalence and migration compatibility.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Review findings on PR 605. (1) A pre-145 deny or viewer written for a federated subject must still apply after 145+146: the fixture rebuilds the pre-145 shape, inserts the row, runs both migrations and resolves for the Google issuer. (2) The owner-RLS reset case was vacuous - its last wrapped read carried no issuer and stamped the empty issuer itself, so removing the RESET stayed green; the last wrapped read now carries an issuer and an unwrapped read must see nothing.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Second review of PR 605: every case above resolved under an OPERATOR identity, which 145's owner-read policy admits to every row, so none could see that the enforcement paths (gate middleware, route mounter, visibility reads) resolve under the CALLER's identity and were blind to the legacy NULL row. Two cases now resolve under a non-operator federated request identity - one directly, one through the real createSwarmAppGateMiddleware over HTTP - and require the legacy deny to return 403 app_access_denied, the legacy viewer to cap, and the issuer-bound re-bind to admit.
 */

import { expect, test } from '@playwright/test';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { createSwarmAppGateMiddleware } from '@/app/middleware/swarm-app-gate-middleware';
import {
  AppAccessService,
  type SwarmAppAccessDeclaration,
  type SwarmApplicationRecord,
  type SwarmAppService,
} from '@/features/swarm-apps';
import {
  ApplicationAuthorizationService,
  AUTHORIZATION_SCHEMA,
  PostgresAuthorizationStore,
} from '@/features/application-authorization';
import { createLegacyTierResolver } from '@/app/composition/application-access-tier';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';

/**
 * An owner-capable URL. DATABASE_URL is deliberately NOT a fallback: this proof creates a schema
 * and a probe role, which the least-privilege runtime role cannot do, and an operator's live
 * database is not a place to discover that by accident.
 */
const ADMIN_URL = process.env.OSHAL_AUTHZ_ISSUER_DATABASE_URL
  ?? process.env.OSHAL_RLS_ADMIN_DATABASE_URL
  ?? process.env.BOOTSTRAP_DATABASE_URL
  ?? '';
const RUN = randomBytes(6).toString('hex');
const SCHEMA = `oshal_authz_issuer_${RUN}`;
const PROBE_ROLE = `oshal_authz_probe_${RUN}`;
const APP = 'guard-catalogless';
const GOOGLE_ISSUER = 'https://accounts.google.com';
/** One subject STRING shared by a federated identity and a local account — the leak case. */
const SHARED_SUB = `109${RUN}`;
const OTHER_SUB = `209${RUN}`;
const OPERATOR = `Operator-${RUN}`;

let adminPool: Pool;
let probePool: Pool;
let appAccess: AppAccessService;
let authorization: ApplicationAuthorizationService;

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(value)) throw new TypeError(`Unsafe PostgreSQL identifier: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}

function actor(sub: string, issuer: string): AuthorizationActor {
  return { sub, issuer, isActive: true, isSwarmAdmin: false };
}

/** Operator identity, which is what the control plane reads assignments under. */
function asOperator<T>(fn: () => T): T {
  return runWithRequestIdentity({ sub: OPERATOR, isOperator: true }, fn);
}

/**
 * The identity the enforcement paths actually resolve under: the signed-in caller's own
 * request identity, non-operator, stamped on the connection by the GUC wrapper. 145's owner-read
 * policy admits this identity to exactly one row - the one bound to its own issuer.
 */
function asFederatedUser<T>(sub: string, fn: () => T): T {
  return runWithRequestIdentity({ sub, principalIssuer: GOOGLE_ISSUER, isOperator: false }, fn);
}

/** A fresh manifest declaration with the given default; `supported` is a new array each time. */
function declare(defaultTier: SwarmAppAccessDeclaration['defaultTier']): SwarmAppAccessDeclaration {
  return { supported: ['deny', 'viewer', 'editor', 'admin'], defaultTier };
}

/** Remove every assignment so each case starts from "no explicit grant exists". */
async function clearAssignments(): Promise<void> {
  await adminPool.query(`DELETE FROM ${quotedIdentifier(SCHEMA)}.oshal_app_access`);
}

/** Write the shape only a pre-145 database could hold: an assignment naming no issuer at all. */
async function insertLegacyRow(userSub: string, tier: string): Promise<void> {
  await adminPool.query(
    `INSERT INTO ${quotedIdentifier(SCHEMA)}.oshal_app_access
       (user_sub, app_name, tier, assigned_by_sub, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [userSub, APP, tier, OPERATOR, 'assignment written before issuer provenance existed'],
  );
}

/** Both issuer migrations, in order: 145 re-keys the table, 146 records the legacy-row contract. */
async function applyIssuerMigrations(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  await client.query(readFileSync('scripts/migrations/145-app-access-principal-issuer.sql', 'utf8'));
  await client.query(readFileSync('scripts/migrations/146-app-access-legacy-issuerless-rows.sql', 'utf8'));
}

/** Put the table back in its pre-145 shape (subject-only key, no issuer column). */
async function revertToPre145(): Promise<void> {
  await adminPool.query(`ALTER TABLE ${quotedIdentifier(SCHEMA)}.oshal_app_access DROP COLUMN user_issuer CASCADE`);
  await adminPool.query(`ALTER TABLE ${quotedIdentifier(SCHEMA)}.oshal_app_access ADD PRIMARY KEY (user_sub, app_name)`);
}

async function createFixture(): Promise<void> {
  const admin = await adminPool.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(`CREATE SCHEMA ${quotedIdentifier(SCHEMA)}`);
    await admin.query(`SET LOCAL search_path TO ${quotedIdentifier(SCHEMA)}, public`);
    await admin.query('CREATE TABLE swarm_applications (name VARCHAR(100) PRIMARY KEY)');
    await admin.query('INSERT INTO swarm_applications(name) VALUES ($1)', [APP]);
    await admin.query(readFileSync('scripts/migrations/121-app-access-tiers.sql', 'utf8'));
    await applyIssuerMigrations(admin);
    for (const statement of AUTHORIZATION_SCHEMA) await admin.query(statement);
    await admin.query(`CREATE ROLE ${quotedIdentifier(PROBE_ROLE)} LOGIN PASSWORD 'probe-${RUN}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(PROBE_ROLE)}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(PROBE_ROLE)}`,
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    admin.release();
  }
}

test.beforeAll(async () => {
  // Establishing the first connection to a containerised PostgreSQL through a published port can
  // take tens of seconds on a loaded host; the fixture itself is sub-second.
  test.setTimeout(180_000);
  expect(ADMIN_URL, 'Set OSHAL_AUTHZ_ISSUER_DATABASE_URL to a DISPOSABLE PostgreSQL for this proof').not.toBe('');
  adminPool = new Pool({ connectionString: ADMIN_URL, options: `-c search_path=${SCHEMA},public` });
  await createFixture();

  probePool = new Pool({ connectionString: ADMIN_URL, options: `-c role=${PROBE_ROLE} -c search_path=${SCHEMA},public` });
  const identity = await probePool.query<{ current_user: string }>('SELECT current_user');
  expect(identity.rows[0].current_user, 'the proof must read as a NOBYPASSRLS role').toBe(PROBE_ROLE);

  const pool = wrapPoolWithGuc(probePool);
  appAccess = new AppAccessService(pool);
  // The manifest declares no `access:` block and no `authorization:` catalog — the exact shape of
  // the store packages that answered authorization_app_admin_required to every federated identity.
  const apps = {
    getApp: async (name: string) => (name === APP ? ({ manifest: {} } as unknown as SwarmApplicationRecord) : null),
  } as unknown as SwarmAppService;
  authorization = new ApplicationAuthorizationService(new PostgresAuthorizationStore(pool), {
    resolveTier: createLegacyTierResolver(appAccess, () => apps),
  });
  await asOperator(() => authorization.registerApp({
    app: APP, source: `guard:${RUN}`, version: '1.0.0', mode: 'enforce', catalog: null,
  }));
});

test.afterAll(async () => {
  await probePool?.end().catch(() => undefined);
  if (!adminPool) return;
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(SCHEMA)} CASCADE`).catch(() => undefined);
  await adminPool.query(`DROP ROLE IF EXISTS ${quotedIdentifier(PROBE_ROLE)}`).catch(() => undefined);
  await adminPool.end().catch(() => undefined);
});

test('a federated identity holding an admin assignment reaches a catalog-less application', async () => {
  await clearAssignments();
  const google = actor(SHARED_SUB, GOOGLE_ISSUER);

  const before = await asOperator(() => authorization.authorize(google, { app: APP }));
  expect(before, 'no assignment exists yet, so the application must still refuse').toMatchObject({
    allowed: false, reason: 'authorization_app_admin_required',
  });

  const written = await asOperator(() => appAccess.assign({
    userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER, appName: APP, tier: 'admin',
    assignedBySub: OPERATOR, reason: 'operator owns this application',
  }));
  expect(written.userIssuer, 'the assignment must record the issuer it was written for').toBe(GOOGLE_ISSUER);

  const after = await asOperator(() => authorization.authorize(google, { app: APP }));
  expect(after).toMatchObject({ allowed: true, tier: 'admin' });
});

test('the same federated identity without an assignment is still refused', async () => {
  await clearAssignments();
  await asOperator(() => appAccess.assign({
    userSub: OTHER_SUB, userIssuer: GOOGLE_ISSUER, appName: APP, tier: 'admin',
    assignedBySub: OPERATOR, reason: 'a different person entirely',
  }));

  const decision = await asOperator(() => authorization.authorize(actor(SHARED_SUB, GOOGLE_ISSUER), { app: APP }));
  expect(decision, 'one subject grant must never answer a different subject').toMatchObject({
    allowed: false, reason: 'authorization_app_admin_required',
  });
  const resolved = await asOperator(() => appAccess.resolveForPrincipal(
    APP, SHARED_SUB, GOOGLE_ISSUER, { supported: ['deny', 'viewer', 'editor', 'admin'], defaultTier: 'deny' },
  ));
  expect(resolved).toMatchObject({ tier: 'deny', source: 'default' });
});

test('an issuer-less legacy grant answers a local account and never lifts a federated subject that matches', async () => {
  await clearAssignments();
  await insertLegacyRow(SHARED_SUB, 'admin');

  const local = await asOperator(() => authorization.authorize(actor(SHARED_SUB, LOCAL_AUTH_PRINCIPAL_ISSUER), { app: APP }));
  expect(local, 'the row predates issuer provenance, so the local account keeps it').toMatchObject({
    allowed: true, tier: 'admin',
  });

  const google = await asOperator(() => authorization.authorize(actor(SHARED_SUB, GOOGLE_ISSUER), { app: APP }));
  expect(google, 'a legacy grant is a ceiling for another issuer, never a lift above the default').toMatchObject({
    allowed: false, reason: 'authorization_app_admin_required',
  });
});

test('legacy deny on a federated subject still denies after migrations 145 and 146', async () => {
  await clearAssignments();
  // The exact pre-145 shape: subject-only key, no issuer column, a deny an operator wrote for a
  // Google-shaped subject while the SQL was subject-only and therefore enforced for any issuer.
  await revertToPre145();
  try {
    await insertLegacyRow(SHARED_SUB, 'deny');
    await applyIssuerMigrations(adminPool);
  } catch (error) {
    await applyIssuerMigrations(adminPool).catch(() => undefined);
    throw error;
  }

  const google = await asOperator(() => authorization.authorize(actor(SHARED_SUB, GOOGLE_ISSUER), { app: APP }));
  expect(google, 'main denied this subject for every issuer; 145 alone answered admin source=default').toMatchObject({
    allowed: false, reason: 'authorization_explicit_deny', tier: 'deny',
  });
  const declared = { supported: ['deny', 'viewer', 'editor', 'admin'] as const, defaultTier: 'admin' as const };
  const resolved = await asOperator(() => appAccess.resolveForPrincipal(APP, SHARED_SUB, GOOGLE_ISSUER,
    { ...declared, supported: [...declared.supported] }));
  expect(resolved, 'a default-admin manifest must not out-rank the legacy deny').toMatchObject({ tier: 'deny', source: 'explicit' });
  const local = await asOperator(() => authorization.authorize(actor(SHARED_SUB, LOCAL_AUTH_PRINCIPAL_ISSUER), { app: APP }));
  expect(local).toMatchObject({ allowed: false, reason: 'authorization_explicit_deny' });
});

test('a legacy viewer ceiling caps a federated subject and an issuer-bound row is the re-bind', async () => {
  await clearAssignments();
  await insertLegacyRow(SHARED_SUB, 'viewer');
  const editorByDefault = { supported: ['deny', 'viewer', 'editor', 'admin'] as const, defaultTier: 'editor' as const };
  const declare = () => ({ ...editorByDefault, supported: [...editorByDefault.supported] });

  expect(await asOperator(() => appAccess.resolveForPrincipal(APP, SHARED_SUB, GOOGLE_ISSUER, declare())),
    'the ceiling lowers the manifest default').toMatchObject({ tier: 'viewer', source: 'explicit' });
  expect(await asOperator(() => appAccess.resolveForPrincipal(APP, SHARED_SUB, 'urn:oshal:mock-oidc', declare())),
    'every issuer of the subject, not one').toMatchObject({ tier: 'viewer', source: 'explicit' });
  expect(await asOperator(() => appAccess.resolveForPrincipal(APP, OTHER_SUB, GOOGLE_ISSUER, declare())),
    'a different subject is untouched').toMatchObject({ tier: 'editor', source: 'default' });

  await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
    appName: APP, tier: 'admin', assignedBySub: OPERATOR, reason: 'Operator re-bound the federated identity' }));
  expect(await asOperator(() => appAccess.resolveForPrincipal(APP, SHARED_SUB, GOOGLE_ISSUER, declare())),
    'the issuer-bound row wins for its own issuer').toMatchObject({ tier: 'admin', source: 'explicit' });
  expect(await asOperator(() => appAccess.resolveForPrincipal(APP, SHARED_SUB, 'urn:oshal:mock-oidc', declare())),
    'the legacy ceiling keeps applying to every issuer that was not re-bound').toMatchObject({ tier: 'viewer', source: 'explicit' });
  expect(await asOperator(() => appAccess.listAssignments())).toHaveLength(2);
});

test('an assignment bound to one issuer never answers another issuer with the same subject', async () => {
  await clearAssignments();
  await asOperator(() => appAccess.assign({
    userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER, appName: APP, tier: 'admin',
    assignedBySub: OPERATOR, reason: 'bound to the federated identity only',
  }));

  const local = await asOperator(() => authorization.authorize(actor(SHARED_SUB, LOCAL_AUTH_PRINCIPAL_ISSUER), { app: APP }));
  expect(local, 'a local account must not inherit a federated assignment').toMatchObject({
    allowed: false, reason: 'authorization_app_admin_required',
  });
  const mock = await asOperator(() => authorization.authorize(actor(SHARED_SUB, 'urn:oshal:mock-oidc'), { app: APP }));
  expect(mock, 'no third issuer may read it either').toMatchObject({
    allowed: false, reason: 'authorization_app_admin_required',
  });
});

test('an explicit deny written for a federated identity is honoured, not ignored', async () => {
  await clearAssignments();
  await asOperator(() => appAccess.assign({
    userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER, appName: APP, tier: 'deny',
    assignedBySub: OPERATOR, reason: 'suspended pending review',
  }));

  const decision = await asOperator(() => authorization.authorize(actor(SHARED_SUB, GOOGLE_ISSUER), { app: APP }));
  expect(decision).toMatchObject({ allowed: false, reason: 'authorization_explicit_deny', tier: 'deny' });
});

test('a database without migration 145 keeps its pre-145 behaviour instead of failing', async () => {
  await clearAssignments();
  await insertLegacyRow(SHARED_SUB, 'admin');
  await insertLegacyRow(OTHER_SUB, 'deny');
  // Recreate the pre-145 key rather than leaving a partially migrated schema.
  await revertToPre145();
  try {
    const local = await asOperator(() => authorization.authorize(actor(SHARED_SUB, LOCAL_AUTH_PRINCIPAL_ISSUER), { app: APP }));
    expect(local, 'the local account keeps the tier it already had').toMatchObject({ allowed: true, tier: 'admin' });
    const google = await asOperator(() => authorization.authorize(actor(SHARED_SUB, GOOGLE_ISSUER), { app: APP }));
    expect(google, 'every stored row is issuer-less here, so a legacy grant lifts no federated identity').toMatchObject({
      allowed: false, reason: 'authorization_app_admin_required',
    });
    const denied = await asOperator(() => authorization.authorize(actor(OTHER_SUB, GOOGLE_ISSUER), { app: APP }));
    expect(denied, 'and a legacy deny still denies every issuer, as the subject-only SQL always did').toMatchObject({
      allowed: false, reason: 'authorization_explicit_deny',
    });
    await expect(asOperator(() => appAccess.assign({
      userSub: OTHER_SUB, userIssuer: GOOGLE_ISSUER, appName: APP, tier: 'admin',
      assignedBySub: OPERATOR, reason: 'issuer binding that cannot be stored yet',
    })), 'an issuer binding must never be dropped silently').rejects.toThrow(/migration 145/);
  } finally {
    await applyIssuerMigrations(adminPool);
  }
});

test('same-subject principals retain independent assignments and an explicit deny', async () => {
  await clearAssignments();
  await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
    appName: APP, tier: 'deny', assignedBySub: OPERATOR, reason: 'First principal denied' }));
  await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: 'https://second.identity.test',
    appName: APP, tier: 'admin', assignedBySub: OPERATOR, reason: 'Independent second principal' }));
  expect(await asOperator(() => authorization.authorize(actor(SHARED_SUB, GOOGLE_ISSUER), { app: APP })))
    .toMatchObject({ allowed: false, reason: 'authorization_explicit_deny' });
  expect(await asOperator(() => appAccess.listAssignments())).toHaveLength(2);
});

test('clearing an issuer-bound assignment never clears another issuer or the local alias', async () => {
  await clearAssignments();
  for (const userIssuer of [null, GOOGLE_ISSUER, 'https://second.identity.test']) {
    await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer,
      appName: APP, tier: 'deny', assignedBySub: OPERATOR, reason: 'Independent refusal' }));
  }
  await asOperator(() => appAccess.clear({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
    appName: APP, assignedBySub: OPERATOR, reason: 'Clear only first provider' }));
  const rows = await asOperator(() => appAccess.listAssignments());
  expect(rows.map(row => row.userIssuer).sort()).toEqual([null, 'https://second.identity.test'].sort());
  expect(await asOperator(() => authorization.authorize(actor(SHARED_SUB, LOCAL_AUTH_PRINCIPAL_ISSUER), { app: APP })))
    .toMatchObject({ reason: 'authorization_explicit_deny' });
});

test('owner RLS reads only its issuer and clears the issuer before connection reuse', async () => {
  await clearAssignments();
  await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
    appName: APP, tier: 'admin', assignedBySub: OPERATOR, reason: 'Provider-qualified row' }));
  const wrapped = wrapPoolWithGuc(probePool);
  const read = (principalIssuer?: string) => runWithRequestIdentity({ sub: SHARED_SUB, principalIssuer, isOperator: false },
    () => wrapped.query('SELECT user_sub, user_issuer FROM oshal_app_access'));
  expect((await read(GOOGLE_ISSUER)).rows).toHaveLength(1);
  expect((await read('https://second.identity.test')).rows).toHaveLength(0);
  expect((await read()).rows).toHaveLength(0);
  // The LAST wrapped read must carry an issuer. With the issuer-less read last, a wrapper that
  // never RESET the issuer still passed: that read stamped the empty issuer itself.
  expect((await read(GOOGLE_ISSUER)).rows).toHaveLength(1);
  const stamp = await probePool.query("SELECT current_setting('oshal.current_issuer', true) AS issuer");
  expect(stamp.rows[0].issuer || '', 'the issuer must not survive on the pooled connection').toBe('');
  const unwrapped = await probePool.query('SELECT user_sub FROM oshal_app_access');
  expect(unwrapped.rows, 'an unstamped connection must see no owner row').toHaveLength(0);
});

test('legacy NULL and canonical local are one principal without overwriting a federated row', async () => {
  await clearAssignments();
  await insertLegacyRow(SHARED_SUB, 'deny');
  await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
    appName: APP, tier: 'admin', assignedBySub: OPERATOR, reason: 'Independent provider' }));
  await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: LOCAL_AUTH_PRINCIPAL_ISSUER,
    appName: APP, tier: 'editor', assignedBySub: OPERATOR, reason: 'Update local alias' }));
  const rows = await asOperator(() => appAccess.listAssignments());
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.userIssuer === GOOGLE_ISSUER)?.tier).toBe('admin');
  expect(rows.find(row => row.userIssuer === LOCAL_AUTH_PRINCIPAL_ISSUER)?.tier).toBe('editor');
  // Re-running the migrations preserves both rows and NULL/local still has one key.
  await applyIssuerMigrations(adminPool);
  expect(await asOperator(() => appAccess.listAssignments())).toHaveLength(2);
});

test('owner RLS cannot insert, change or clear its own assignment', async () => {
  await clearAssignments();
  await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
    appName: APP, tier: 'deny', assignedBySub: OPERATOR, reason: 'Operator refusal' }));
  const own = <T>(fn: () => T) => runWithRequestIdentity({ sub: SHARED_SUB, principalIssuer: GOOGLE_ISSUER, isOperator: false }, fn);
  await expect(own(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
    appName: APP, tier: 'admin', assignedBySub: SHARED_SUB, reason: 'Self promotion attempt' }))).rejects.toThrow();
  expect(await own(() => appAccess.clear({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
    appName: APP, assignedBySub: SHARED_SUB, reason: 'Self clear attempt' }))).toBe(false);
  expect(await asOperator(() => authorization.authorize(actor(SHARED_SUB, GOOGLE_ISSUER), { app: APP })))
    .toMatchObject({ reason: 'authorization_explicit_deny' });
});

test('an additive-only issuer migration cannot fall back to a subject-only write', async () => {
  await clearAssignments();
  await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
    appName: APP, tier: 'deny', assignedBySub: OPERATOR, reason: 'Retain provider refusal' }));
  await adminPool.query(`ALTER TABLE ${quotedIdentifier(SCHEMA)}.oshal_app_access DROP COLUMN principal_issuer CASCADE`);
  await adminPool.query(`ALTER TABLE ${quotedIdentifier(SCHEMA)}.oshal_app_access ADD PRIMARY KEY (user_sub, app_name)`);
  try {
    await expect(asOperator(() => appAccess.assign({ userSub: SHARED_SUB,
      appName: APP, tier: 'admin', assignedBySub: OPERATOR, reason: 'Local-only assignment' }))).rejects.toThrow(/migration 145/);
    expect(await asOperator(() => appAccess.clear({ userSub: SHARED_SUB,
      appName: APP, assignedBySub: OPERATOR, reason: 'Clear local only' }))).toBe(false);
    expect((await asOperator(() => appAccess.listAssignments()))[0]).toMatchObject({ userIssuer: GOOGLE_ISSUER, tier: 'deny' });
  } finally {
    await applyIssuerMigrations(adminPool);
  }
});

test('a legacy ceiling resolves for a NON-operator federated caller under its own request identity', async () => {
  await clearAssignments();
  await insertLegacyRow(SHARED_SUB, 'deny');
  // Under the caller's identity the owner-read policy hides the NULL row (its principal_issuer
  // is urn:oshal:local-auth, the caller's is Google). The resolver must still see its own ceiling.
  expect(await asFederatedUser(SHARED_SUB, () => appAccess.resolveForPrincipal(APP, SHARED_SUB, GOOGLE_ISSUER, declare('admin'))),
    'a legacy deny must deny the federated caller on the enforcement path, not only under an operator read')
    .toMatchObject({ tier: 'deny', source: 'explicit' });

  await clearAssignments();
  await insertLegacyRow(SHARED_SUB, 'viewer');
  expect(await asFederatedUser(SHARED_SUB, () => appAccess.resolveForPrincipal(APP, SHARED_SUB, GOOGLE_ISSUER, declare('editor'))),
    'a legacy viewer must cap the federated caller below the manifest default')
    .toMatchObject({ tier: 'viewer', source: 'explicit' });
  expect(await asFederatedUser(OTHER_SUB, () => appAccess.resolveForPrincipal(APP, OTHER_SUB, GOOGLE_ISSUER, declare('editor'))),
    'a different subject is untouched').toMatchObject({ tier: 'editor', source: 'default' });
  expect(await asFederatedUser(SHARED_SUB, () => appAccess.listAssignments()),
    'the operator matrix is NOT opened by the resolver: the caller identity still lists only its own issuer-bound rows')
    .toHaveLength(0);
});

test('the real gate middleware refuses a legacy-denied federated caller and admits its re-bind', async () => {
  await clearAssignments();
  await insertLegacyRow(SHARED_SUB, 'deny');
  const access = declare('admin');
  const apps = {
    ownerOf: (path: string) => (path.startsWith('/api/security/') ? { appName: APP, status: 'active', access } : null),
  } as unknown as SwarmAppService;
  const app = express();
  // The production shape: the identity middleware stamps the signed-in caller, non-operator,
  // BEFORE the gate; the gate then resolves the tier and the handler runs only if admitted.
  app.use((_req, _res, next) => asFederatedUser(SHARED_SUB, () => next()));
  app.use(createSwarmAppGateMiddleware(apps, appAccess));
  app.post('/api/security/write', (_req, res) => { res.status(200).json({ reached: true }); });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const denied = await fetch(`${base}/api/security/write`, { method: 'POST' });
    expect(denied.status, 'a legacy deny must stop a federated caller at the gate').toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'app_access_denied', app: APP, tier: 'deny' });

    await asOperator(() => appAccess.assign({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
      appName: APP, tier: 'editor', assignedBySub: OPERATOR, reason: 'Operator re-bound the federated identity' }));
    const admitted = await fetch(`${base}/api/security/write`, { method: 'POST' });
    expect(admitted.status, 'the issuer-bound row is the re-bind for this issuer and admits the write').toBe(200);
    expect(await admitted.json()).toEqual({ reached: true });

    await asOperator(() => appAccess.clear({ userSub: SHARED_SUB, userIssuer: GOOGLE_ISSUER,
      appName: APP, assignedBySub: OPERATOR, reason: 'Remove the re-bind' }));
    expect((await fetch(`${base}/api/security/write`, { method: 'POST' })).status,
      'with the re-bind cleared the legacy ceiling governs again').toBe(403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
