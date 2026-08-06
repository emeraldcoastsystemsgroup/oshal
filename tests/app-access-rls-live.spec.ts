/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: real PostgreSQL proof for FORCE RLS, exact owner reads, operator-only assignments, explicit deny, defaults, clearing, and a NOSUPERUSER/NOBYPASSRLS runtime role.
 */

import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { AppAccessService, type SwarmAppAccessDeclaration } from '@/features/swarm-apps';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';

const ADMIN_URL = process.env.OSHAL_RLS_ADMIN_DATABASE_URL
  ?? process.env.BOOTSTRAP_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? '';
const PROBE_URL = process.env.OSHAL_RLS_PROBE_DATABASE_URL
  ?? process.env.BOT_DATABASE_URL
  ?? '';
const PROBE_ROLE = process.env.OSHAL_RLS_TEST_ROLE || 'oshal_bot';
const RUN = randomBytes(6).toString('hex');
const SCHEMA = `oshal_app_access_${RUN}`;
const APP = 'test-access';
const OWNER_A = `Access-Owner-A-${RUN}`;
const OWNER_B = `Access-Owner-B-${RUN}`;
const OPERATOR = `Access-Operator-${RUN}`;

const DECLARATION: SwarmAppAccessDeclaration = {
  supported: ['deny', 'viewer', 'editor', 'admin'],
  defaultTier: 'viewer',
  mappings: { editor: 'internal_editor_bundle', admin: 'internal_admin_bundle' },
};

let adminPool: Pool;
let probePool: Pool;
let service: AppAccessService;

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(value)) throw new TypeError(`Unsafe PostgreSQL identifier: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}

function asIdentity<T>(sub: string, isOperator: boolean, fn: () => T): T {
  return runWithRequestIdentity({ sub, isOperator }, fn);
}

test.beforeAll(async () => {
  expect(ADMIN_URL, 'A real PostgreSQL admin URL is required for the ADR-118 RLS proof').not.toBe('');
  quotedIdentifier(PROBE_ROLE);
  adminPool = new Pool({ connectionString: ADMIN_URL });
  const attributes = await adminPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1',
    [PROBE_ROLE],
  );
  expect(attributes.rows, `${PROBE_ROLE} must exist`).toHaveLength(1);
  expect(attributes.rows[0].rolsuper, 'proof role must be NOSUPERUSER').toBe(false);
  expect(attributes.rows[0].rolbypassrls, 'proof role must be NOBYPASSRLS').toBe(false);

  const migration = readFileSync('scripts/migrations/121-app-access-tiers.sql', 'utf8');
  const admin = await adminPool.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(`CREATE SCHEMA ${quotedIdentifier(SCHEMA)}`);
    await admin.query(`SET LOCAL search_path TO ${quotedIdentifier(SCHEMA)}, public`);
    await admin.query(`CREATE TABLE swarm_applications (name VARCHAR(100) PRIMARY KEY)`);
    await admin.query(`INSERT INTO swarm_applications(name) VALUES ($1)`, [APP]);
    await admin.query(migration);
    await admin.query(`GRANT USAGE ON SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(PROBE_ROLE)}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quotedIdentifier(SCHEMA)}.oshal_app_access TO ${quotedIdentifier(PROBE_ROLE)}`,
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    admin.release();
  }

  const roleOption = PROBE_URL ? '' : `-c role=${PROBE_ROLE} `;
  probePool = new Pool({
    connectionString: PROBE_URL || ADMIN_URL,
    options: `${roleOption}-c search_path=${SCHEMA},public`,
  });
  const identity = await probePool.query<{ current_user: string }>('SELECT current_user');
  expect(identity.rows[0].current_user).toBe(PROBE_ROLE);
  service = new AppAccessService(wrapPoolWithGuc(probePool));
});

test.afterAll(async () => {
  await probePool?.end().catch(() => undefined);
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(SCHEMA)} CASCADE`).catch(() => undefined);
    await adminPool.end().catch(() => undefined);
  }
});

test('real PostgreSQL enforces exact assignments, explicit deny, defaults, and operator-only writes', async () => {
  await asIdentity(OPERATOR, true, () => service.assign({
    userSub: OWNER_A, appName: APP, tier: 'deny', assignedBySub: OPERATOR, reason: 'suspended pending review',
  }));
  await asIdentity(OPERATOR, true, () => service.assign({
    userSub: OWNER_B, appName: APP, tier: 'editor', assignedBySub: OPERATOR, reason: 'application operator',
  }));

  await expect(asIdentity(OWNER_A, false, () => service.resolve(APP, OWNER_A, DECLARATION))).resolves.toMatchObject({
    tier: 'deny', source: 'explicit',
  });
  await expect(asIdentity(OWNER_B, false, () => service.resolve(APP, OWNER_B, DECLARATION))).resolves.toMatchObject({
    tier: 'editor', bundle: 'internal_editor_bundle', source: 'explicit',
  });
  await expect(asIdentity(`Unassigned-${RUN}`, false, () => service.resolve(APP, `Unassigned-${RUN}`, DECLARATION))).resolves.toMatchObject({
    tier: 'viewer', source: 'default',
  });

  const ownerAVisible = await asIdentity(OWNER_A, false, () => service.listAssignments());
  expect(ownerAVisible.map((row) => [row.userSub, row.appName, row.tier])).toEqual([[OWNER_A, APP, 'deny']]);
  const operatorVisible = await asIdentity(OPERATOR, true, () => service.listAssignments());
  expect(operatorVisible.map((row) => row.userSub).sort()).toEqual([OWNER_A, OWNER_B].sort());

  await expect(asIdentity(OWNER_A, false, () => service.assign({
    userSub: OWNER_A, appName: APP, tier: 'admin', assignedBySub: OWNER_A, reason: 'self promotion attempt',
  }))).rejects.toThrow();
  await expect(asIdentity(OWNER_A, false, () => service.clear({
    userSub: OWNER_A, appName: APP, assignedBySub: OWNER_A, reason: 'self clear attempt',
  }))).rejects.toThrow();

  await expect(asIdentity(OPERATOR, true, () => service.clear({
    userSub: OWNER_A, appName: APP, assignedBySub: OPERATOR, reason: 'review completed',
  }))).resolves.toBe(true);
  await expect(asIdentity(OWNER_A, false, () => service.resolve(APP, OWNER_A, DECLARATION))).resolves.toMatchObject({
    tier: 'viewer', source: 'default',
  });
});
