/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove atomic recap/pump contention, exact-token renew/release, expiry takeover, CLI interoperability, and operator-only FORCE RLS through a real PostgreSQL role and schema.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Bound database connection startup so the live proof reports an unavailable PostgreSQL boundary instead of hanging behind a wedged local port forward.
 */

import { expect, test } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  acquireNodeResourceLease,
  getActiveNodeResourceLease,
  releaseNodeResourceLease,
  renewNodeResourceLease,
  vidsNodeResourceKey,
} from '@/app/node-resource-lease';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const ADMIN_URL = process.env.OSHAL_RLS_ADMIN_DATABASE_URL
  ?? process.env.BOOTSTRAP_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? '';
const PROBE_URL = process.env.OSHAL_RLS_PROBE_DATABASE_URL
  ?? process.env.BOT_DATABASE_URL
  ?? '';
const PROBE_ROLE = process.env.OSHAL_RLS_TEST_ROLE || 'oshal_bot';
const RUN = randomBytes(6).toString('hex');
const SCHEMA = `oshal_node_lease_${RUN}`;
const RESOURCE = vidsNodeResourceKey(`render-${RUN}`);
const OPERATOR = `Node-Lease-Operator-${RUN}`;
const ENV_KEYS = ['OSHAL_DB_GUC', 'OSHAL_DB_GUC_STRICT', 'OSHAL_OPERATOR_SUBS'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

let adminPool: Pool;
let probePool: Pool;
let wrappedPool: Pool;

/** @description Quote only a previously validated PostgreSQL identifier. */
function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(value)) throw new TypeError('unsafe PostgreSQL identifier');
  return `"${value.replace(/"/g, '""')}"`;
}

/** @description Build the exact persisted capability required by renew/release. */
function capability(lease: { resourceKey: string; leaseId: string; holder: string }) {
  return { resourceKey: lease.resourceKey, leaseId: lease.leaseId, holder: lease.holder };
}

test.beforeAll(async () => {
  expect(ADMIN_URL, 'DATABASE_URL is required for the real node-resource lease proof').not.toBe('');
  quotedIdentifier(PROBE_ROLE);
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) savedEnv[key] = value;
  }
  process.env.OSHAL_DB_GUC = 'on';
  process.env.OSHAL_DB_GUC_STRICT = 'deny';
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;

  adminPool = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 10_000 });
  const attributes = await adminPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1', [PROBE_ROLE],
  );
  expect(attributes.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

  const pumpMigration = readFileSync('scripts/migrations/097-video-pump.sql', 'utf8');
  const leaseMigration = readFileSync('scripts/migrations/120-shared-node-resource-leases.sql', 'utf8');
  const admin = await adminPool.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(`CREATE SCHEMA ${quotedIdentifier(SCHEMA)}`);
    await admin.query(`SET LOCAL search_path TO ${quotedIdentifier(SCHEMA)}, public`);
    await admin.query(pumpMigration);
    await admin.query(leaseMigration);
    await admin.query(`GRANT USAGE ON SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(PROBE_ROLE)}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quotedIdentifier(SCHEMA)}.oshal_node_resource_leases TO ${quotedIdentifier(PROBE_ROLE)}`,
    );
    await admin.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(PROBE_ROLE)}`,
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
    connectionTimeoutMillis: 10_000,
  });
  expect((await probePool.query<{ current_user: string }>('SELECT current_user')).rows[0].current_user)
    .toBe(PROBE_ROLE);
  wrappedPool = wrapPoolWithGuc(probePool);
});

test.afterAll(async () => {
  await probePool?.end().catch(() => undefined);
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(SCHEMA)} CASCADE`).catch(() => undefined);
    await adminPool.end().catch(() => undefined);
  }
  for (const key of ENV_KEYS) {
    const original = savedEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test('real lease authority serializes contenders and rejects stale capabilities', async () => {
  const contenders = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    acquireNodeResourceLease(wrappedPool, {
      resourceKey: RESOURCE,
      holder: `contender-${index}`,
      purpose: index === 0 ? 'daily-recap-build-publish' : 'video-pump-episode',
      ttlMs: 10 * 60_000,
      metadata: { contender: index },
    })
  )));
  const winners = contenders.filter((result) => result.acquired);
  expect(winners).toHaveLength(1);
  const winner = winners[0].lease;
  expect(new Set(contenders.map((result) => result.lease.leaseId))).toEqual(new Set([winner.leaseId]));

  expect(await renewNodeResourceLease(wrappedPool, {
    resourceKey: RESOURCE, leaseId: randomUUID(), holder: winner.holder,
  }, 10 * 60_000)).toBeNull();
  expect(await releaseNodeResourceLease(wrappedPool, {
    resourceKey: RESOURCE, leaseId: randomUUID(), holder: winner.holder,
  })).toBe(false);

  const renewed = await renewNodeResourceLease(wrappedPool, capability(winner), 20 * 60_000);
  expect(renewed?.leaseId).toBe(winner.leaseId);
  expect(new Date(renewed!.expiresAt).getTime()).toBeGreaterThan(new Date(winner.expiresAt).getTime());

  await runWithSystemIdentity(() => wrappedPool.query(
    `UPDATE oshal_node_resource_leases
        SET acquired_at=NOW()-INTERVAL '3 minutes', heartbeat_at=NOW()-INTERVAL '2 minutes',
            expires_at=NOW()-INTERVAL '1 minute'
      WHERE resource_key=$1 AND lease_id=$2`,
    [RESOURCE, winner.leaseId],
  ));
  const replacement = await acquireNodeResourceLease(wrappedPool, {
    resourceKey: RESOURCE,
    holder: 'replacement-pump',
    purpose: 'video-pump-episode',
    ttlMs: 10 * 60_000,
  });
  expect(replacement.acquired).toBe(true);
  expect(replacement.lease.leaseId).not.toBe(winner.leaseId);
  expect(await releaseNodeResourceLease(wrappedPool, capability(winner))).toBe(false);
  expect((await getActiveNodeResourceLease(wrappedPool, RESOURCE))?.leaseId)
    .toBe(replacement.lease.leaseId);
  expect(await releaseNodeResourceLease(wrappedPool, capability(replacement.lease))).toBe(true);
});

test('recap CLI and controller service contend on the same database row', async () => {
  const resource = vidsNodeResourceKey(`cli-${RUN}`);
  const roleOption = PROBE_URL ? '' : `-c role=${PROBE_ROLE} `;
  const result = spawnSync(process.execPath, [
    join(process.cwd(), 'scripts', 'oshal-node-lease.js'),
    'acquire', '--resource', resource, '--holder', `daily-recap:2026-08-06:${RUN}`,
    '--purpose', 'daily-recap-build-publish', '--ttl-seconds', '600',
    '--metadata-json', JSON.stringify({ requestedDate: '2026-08-06' }),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: PROBE_URL || ADMIN_URL,
      PGOPTIONS: `${roleOption}-c search_path=${SCHEMA},public`,
    },
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const cliLease = JSON.parse(result.stdout.trim()) as {
    acquired: boolean; lease_id: string; holder: string;
  };
  expect(cliLease.acquired).toBe(true);

  const pump = await acquireNodeResourceLease(wrappedPool, {
    resourceKey: resource,
    holder: 'joke-pump:interoperability',
    purpose: 'video-pump-episode',
    ttlMs: 10 * 60_000,
  });
  expect(pump).toMatchObject({
    acquired: false,
    lease: { leaseId: cliLease.lease_id, holder: cliLease.holder },
  });
  expect(await releaseNodeResourceLease(wrappedPool, {
    resourceKey: resource, leaseId: cliLease.lease_id, holder: cliLease.holder,
  })).toBe(true);
});

test('FORCE RLS hides and rejects lease access without explicit system identity', async () => {
  const lease = await acquireNodeResourceLease(wrappedPool, {
    resourceKey: vidsNodeResourceKey(`rls-${RUN}`),
    holder: 'rls-proof',
    purpose: 'test-proof',
    ttlMs: 10 * 60_000,
  });
  expect(lease.acquired).toBe(true);
  await expect(probePool.query('SELECT resource_key FROM oshal_node_resource_leases'))
    .resolves.toMatchObject({ rows: [] });
  await expect(probePool.query(
    `INSERT INTO oshal_node_resource_leases
       (resource_key,lease_id,holder,purpose,expires_at)
     VALUES ($1,$2,'raw','raw',NOW()+INTERVAL '10 minutes')`,
    [vidsNodeResourceKey(`raw-${RUN}`), randomUUID()],
  )).rejects.toThrow(/row-level security/i);
});
