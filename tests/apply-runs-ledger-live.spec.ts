/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove the Apply V2 ledger, active uniqueness, CAS transitions, confirmation evidence, and owner/operator FORCE RLS through a real wrapped PostgreSQL Pool and non-bypass role.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove the dispatched run replaces its short claim deadline with the full worker deadline.
 */

import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  bindApplyRunDispatch,
  createApplyRun,
  transitionApplyRun,
} from '@/app/apply-run-ledger';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

const ADMIN_URL = process.env.OSHAL_RLS_ADMIN_DATABASE_URL
  ?? process.env.BOOTSTRAP_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? '';
const PROBE_URL = process.env.OSHAL_RLS_PROBE_DATABASE_URL
  ?? process.env.BOT_DATABASE_URL
  ?? '';
const PROBE_ROLE = process.env.OSHAL_RLS_TEST_ROLE || 'oshal_bot';
const RUN = randomBytes(6).toString('hex');
const SCHEMA = `oshal_apply_runs_${RUN}`;
const OWNER_A = `Apply-Owner-A-${RUN}`;
const OWNER_B = `Apply-Owner-B-${RUN}`;
const STRANGER = `Apply-Stranger-${RUN}`;
const OPERATOR = `Apply-Operator-${RUN}`;

const ENV_KEYS = ['OSHAL_DB_GUC', 'OSHAL_DB_GUC_STRICT', 'OSHAL_OPERATOR_SUBS'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

let adminPool: Pool;
let probePool: Pool;
let wrappedPool: Pool;

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(value)) throw new TypeError('unsafe PostgreSQL identifier');
  return `"${value.replace(/"/g, '""')}"`;
}

async function visibleRuns(subject: string, isOperator = false): Promise<Array<{
  owner_sub: string;
  state: string;
}>> {
  return runWithRequestIdentity({ sub: subject, isOperator }, async () => {
    const result = await wrappedPool.query<{ owner_sub: string; state: string }>(
      'SELECT owner_sub, state FROM apply_runs ORDER BY owner_sub',
    );
    return result.rows;
  });
}

test.beforeAll(async () => {
  expect(ADMIN_URL, 'DATABASE_URL is required for the Apply V2 real PostgreSQL proof').not.toBe('');
  quotedIdentifier(PROBE_ROLE);
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) savedEnv[key] = value;
  }
  process.env.OSHAL_DB_GUC = 'on';
  process.env.OSHAL_DB_GUC_STRICT = 'deny';
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;

  adminPool = new Pool({ connectionString: ADMIN_URL });
  const attributes = await adminPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1', [PROBE_ROLE],
  );
  expect(attributes.rows).toHaveLength(1);
  expect(attributes.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

  const migration = readFileSync('scripts/migrations/118-apply-runs-ledger.sql', 'utf8');
  const admin = await adminPool.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(`CREATE SCHEMA ${quotedIdentifier(SCHEMA)}`);
    await admin.query(`SET LOCAL search_path TO ${quotedIdentifier(SCHEMA)}, public`);
    await admin.query(migration);
    await admin.query(`GRANT USAGE ON SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(PROBE_ROLE)}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quotedIdentifier(SCHEMA)}.apply_runs TO ${quotedIdentifier(PROBE_ROLE)}`,
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { admin.release(); }

  const roleOption = PROBE_URL ? '' : `-c role=${PROBE_ROLE} `;
  probePool = new Pool({
    connectionString: PROBE_URL || ADMIN_URL,
    options: `${roleOption}-c search_path=${SCHEMA},public`,
  });
  const identity = await probePool.query<{ current_user: string }>('SELECT current_user');
  expect(identity.rows[0].current_user).toBe(PROBE_ROLE);
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

test('real Apply ledger enforces CAS, verified evidence, uniqueness, and owner RLS', async () => {
  const timeoutAt = new Date(Date.now() + 30 * 60_000);
  const runA = await createApplyRun(wrappedPool, {
    ticketId: `ticket-a-${RUN}`, ownerSub: OWNER_A, postingId: 101, timeoutAt,
    metadata: {
      trigger: 'authenticated-single-job', initiatedBySub: OWNER_A,
      automationSettingsVersion: 'authenticated-single-job-v1',
    },
  });
  const runB = await createApplyRun(wrappedPool, {
    ticketId: `ticket-b-${RUN}`, ownerSub: OWNER_B, postingId: 202, timeoutAt,
    metadata: {
      trigger: 'assist-only', initiatedBySub: OWNER_B,
      automationSettingsVersion: 'assist-only-v1',
    },
  });
  expect(runA?.state).toBe('claimed');
  expect(runB?.state).toBe('claimed');

  await expect(createApplyRun(wrappedPool, {
    ticketId: `ticket-a-duplicate-${RUN}`, ownerSub: OWNER_A, postingId: 101, timeoutAt,
    metadata: {
      trigger: 'assist-only', initiatedBySub: OWNER_A,
      automationSettingsVersion: 'assist-only-v1',
    },
  })).resolves.toBeNull();

  const taskId = 'apply-11111111-2222-4333-8444-555555555555';
  const workerTimeout = new Date(Date.now() + 30 * 60_000);
  const bound = await bindApplyRunDispatch(
    wrappedPool, runA!.runId, taskId, 'desktop-a', workerTimeout,
  );
  expect(bound?.state).toBe('queued_to_worker');
  expect(bound?.timeoutAt).toBe(workerTimeout.toISOString());
  await expect(bindApplyRunDispatch(
    wrappedPool, runA!.runId, 'apply-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'attacker',
    workerTimeout,
  )).resolves.toBeNull();

  const running = await transitionApplyRun(wrappedPool, {
    runId: runA!.runId, from: ['queued_to_worker'], to: 'running',
  });
  expect(running).toMatchObject({ state: 'running', taskId, workerClientId: 'desktop-a' });
  await expect(transitionApplyRun(wrappedPool, {
    runId: runA!.runId, from: ['running'], to: 'submitted_verified',
  })).rejects.toThrow(/confirmation path and SHA-256/);

  const verified = await transitionApplyRun(wrappedPool, {
    runId: runA!.runId, from: ['running'], to: 'submitted_verified',
    confirmationPath: `confirmations/${taskId}.png`, confirmationSha256: 'a'.repeat(64),
  });
  expect(verified).toMatchObject({
    state: 'submitted_verified', confirmationSha256: 'a'.repeat(64),
  });

  expect(await visibleRuns(OWNER_A)).toEqual([{ owner_sub: OWNER_A, state: 'submitted_verified' }]);
  expect(await visibleRuns(OWNER_B)).toEqual([{ owner_sub: OWNER_B, state: 'claimed' }]);
  expect(await visibleRuns(STRANGER)).toEqual([]);
  expect(await visibleRuns(OPERATOR, true)).toEqual([
    { owner_sub: OWNER_A, state: 'submitted_verified' },
    { owner_sub: OWNER_B, state: 'claimed' },
  ]);

  await expect(probePool.query('SELECT run_id FROM apply_runs')).resolves.toMatchObject({ rows: [] });
  await expect(probePool.query(
    `INSERT INTO apply_runs
       (run_id,ticket_id,owner_sub,posting_id,claim_token,state,claimed_at,timeout_at,metadata)
     VALUES ($1,'raw',$2,303,$3,'claimed',NOW(),NOW()+INTERVAL '1 hour',$4::jsonb)`,
    ['bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', STRANGER,
      '99999999-8888-4777-8666-555555555555',
      JSON.stringify({ trigger: 'manual', initiatedBySub: STRANGER, automationSettingsVersion: 'manual-v1' })],
  )).rejects.toThrow(/row-level security/i);
});
