/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-PostgreSQL proof that an ADR-118 explicit tier resolves for the exact (subject, issuer) principal it was written for: a federated identity holding an admin assignment reaches a catalog-less application, the same identity without one is still refused, an issuer-less legacy row answers only a canonical local account, a row bound to one issuer never answers another, and one subject's grant never answers a different subject.
 */

import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { AppAccessService, type SwarmApplicationRecord, type SwarmAppService } from '@/features/swarm-apps';
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

async function createFixture(): Promise<void> {
  const admin = await adminPool.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(`CREATE SCHEMA ${quotedIdentifier(SCHEMA)}`);
    await admin.query(`SET LOCAL search_path TO ${quotedIdentifier(SCHEMA)}, public`);
    await admin.query('CREATE TABLE swarm_applications (name VARCHAR(100) PRIMARY KEY)');
    await admin.query('INSERT INTO swarm_applications(name) VALUES ($1)', [APP]);
    await admin.query(readFileSync('scripts/migrations/121-app-access-tiers.sql', 'utf8'));
    await admin.query(readFileSync('scripts/migrations/145-app-access-principal-issuer.sql', 'utf8'));
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

test('an issuer-less legacy row answers a local account and never a federated subject that matches', async () => {
  await clearAssignments();
  await insertLegacyRow(SHARED_SUB, 'admin');

  const local = await asOperator(() => authorization.authorize(actor(SHARED_SUB, LOCAL_AUTH_PRINCIPAL_ISSUER), { app: APP }));
  expect(local, 'the row predates issuer provenance, so the local account keeps it').toMatchObject({
    allowed: true, tier: 'admin',
  });

  const google = await asOperator(() => authorization.authorize(actor(SHARED_SUB, GOOGLE_ISSUER), { app: APP }));
  expect(google, 'a matching subject string under another issuer is a different person').toMatchObject({
    allowed: false, reason: 'authorization_app_admin_required',
  });
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
  await adminPool.query(`ALTER TABLE ${quotedIdentifier(SCHEMA)}.oshal_app_access DROP COLUMN user_issuer`);
  try {
    const local = await asOperator(() => authorization.authorize(actor(SHARED_SUB, LOCAL_AUTH_PRINCIPAL_ISSUER), { app: APP }));
    expect(local, 'the local account keeps the tier it already had').toMatchObject({ allowed: true, tier: 'admin' });
    const google = await asOperator(() => authorization.authorize(actor(SHARED_SUB, GOOGLE_ISSUER), { app: APP }));
    expect(google, 'every stored row is issuer-less here, so no federated identity matches one').toMatchObject({
      allowed: false, reason: 'authorization_app_admin_required',
    });
    await expect(asOperator(() => appAccess.assign({
      userSub: OTHER_SUB, userIssuer: GOOGLE_ISSUER, appName: APP, tier: 'admin',
      assignedBySub: OPERATOR, reason: 'issuer binding that cannot be stored yet',
    })), 'an issuer binding must never be dropped silently').rejects.toThrow(/migration 145/);
  } finally {
    await adminPool.query(readFileSync('scripts/migrations/145-app-access-principal-issuer.sql', 'utf8'));
  }
});
