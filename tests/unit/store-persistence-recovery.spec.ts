/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove a store that cannot reach Postgres at boot serves from memory AND recovers to persistent mode on a later call, against a real database and a real connection shortage.
 */
/**
 * Disposable local PostgreSQL only. Never consumes DATABASE_URL, oshal-local-db, or any
 * deployment credential: the fixture starts its own postgres:16-alpine on an ephemeral
 * loopback port with a generated password, and the process env is restored afterwards.
 *
 * The defect these cases exist for: every fallback-capable store built ONE eagerly created
 * init promise in its constructor and, when it rejected, set `persistentMode = false`, ended
 * the pool and nulled it. On the 2026-09-15 00:25:11Z boot the task store, the message store
 * and the memory layer each lost a pool acquire inside the api's own migration and
 * provisioning burst, and all three served from an in-memory Map for the rest of the process
 * lifetime - signalled only by three ERROR lines. The pool was gone, so nothing could retry.
 *
 * Both database cases therefore cross the boundary that actually failed: the store's own real
 * pool, a real connection shortage, and the real idempotent DDL against real PostgreSQL.
 * Nothing about the pool, the shortage or the schema is doubled, and recovery is asserted by
 * reading the row back out of Postgres over a separate connection - not by counting calls.
 *
 * Two fixture facts worth stating. The role the task store connects as carries BYPASSRLS, which
 * is the legacy single-role posture `buildOwnerRlsPolicyStatements` documents itself as inert
 * under; that keeps these cases measuring the connection boundary rather than RLS. And the
 * retry cooldown is set to 0 through its real environment variable so the second call retries
 * immediately instead of after the 30s production default.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTaskStore } from '../../src/entities/task/services/in-memory-task-store';
import { PostgresSwarmEscalationStore } from '../../src/features/swarm-orchestration/services/postgres-swarm-escalation-store';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import type { SwarmEscalationRecord } from '../../src/features/swarm-orchestration/services/swarm-cycle-policy';

const container = `oshal-store-persistence-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
/** Non-superuser, so its CONNECTION LIMIT is actually enforced (superusers are exempt). */
const STORE_ROLE = 'store_fixture_owner';
let started = false;
let port = 0;
let admin: Pool;
let taskFixture: Pool;
let escalationFixture: Pool;
const envKeys = [
  'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE',
  'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB',
  'OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS',
];
const savedEnv = new Map<string, string | undefined>();

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
}

function connection(database: string): PoolConfig {
  return { host: '127.0.0.1', port, user: 'postgres', password, database };
}

/** Point the process at the disposable database as the connection-limited store role. */
function useStoreRoleEnv(database: string): void {
  delete process.env.DATABASE_URL;
  delete process.env.PGSSLMODE;
  process.env.PGHOST = '127.0.0.1';
  process.env.PGPORT = String(port);
  process.env.PGUSER = STORE_ROLE;
  process.env.PGPASSWORD = password;
  process.env.PGDATABASE = database;
  // Retry on the very next operation rather than after the production default window.
  process.env.OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS = '0';
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`]);
  return result.rows[0]?.present === true;
}

function escalation(runId: string): SwarmEscalationRecord {
  return {
    runId,
    ticketExternalId: `ticket-${runId}`,
    target: 'human_review',
    severity: 'high',
    retryClass: 'transient',
    reason: 'fixture escalation',
    attemptState: { verificationAttempt: 1, buildRegressionCount: 0, designRegressionCount: 0 },
    createdAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=store_persistence_fixture', 'postgres:16-alpine']);
  started = true;
  port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  admin = new Pool({ ...connection('store_persistence_fixture'), max: 2, connectionTimeoutMillis: 1_000 });
  let live = false;
  // A loaded box takes longer than a quiet one to bring a container's postmaster up; 60s of
  // patience here is the difference between a real result and a fixture-timeout that reads as a
  // code failure.
  for (let attempt = 0; attempt < 150; attempt++) {
    try { await admin.query('SELECT 1'); live = true; break; } catch { await new Promise(wait => setTimeout(wait, 400)); }
  }
  if (!live) throw new Error('Disposable store-persistence PostgreSQL did not become ready');
  // CONNECTION LIMIT 1 is the whole fixture: one held connection and the store's own pool
  // genuinely cannot reach the database, exactly as it could not during the migration burst.
  await admin.query(`CREATE ROLE ${STORE_ROLE} LOGIN BYPASSRLS CONNECTION LIMIT 1 PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE task_store_fixture OWNER ${STORE_ROLE}`);
  await admin.query('CREATE DATABASE escalation_store_fixture');
  taskFixture = new Pool({ ...connection('task_store_fixture'), max: 2, connectionTimeoutMillis: 5_000 });
  escalationFixture = new Pool({ ...connection('escalation_store_fixture'), max: 2, connectionTimeoutMillis: 5_000 });
}, 180_000);

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const pool of [taskFixture, escalationFixture, admin]) {
    if (pool) await pool.end().catch(() => undefined);
  }
  if (started) docker(['rm', '--force', container]);
});

describe('a store that cannot reach Postgres at boot', () => {
  it('still serves when Postgres is genuinely unavailable, so the process comes up', async () => {
    // A closed loopback port: every connection attempt is refused, every retry fails, and the
    // store must still answer. Losing the degrade would turn a database outage into an outage.
    delete process.env.DATABASE_URL;
    process.env.PGHOST = '127.0.0.1';
    process.env.PGPORT = '1';
    process.env.PGUSER = 'nobody';
    process.env.PGPASSWORD = 'nobody';
    process.env.PGDATABASE = 'nowhere';
    process.env.OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS = '0';

    const store = new InMemoryTaskStore();
    const created = await store.create({ title: 'no database at all', processingMode: 'agentic', metadata: {} });
    expect(created.taskId).toBeTruthy();
    // A second call retries activation, fails again, and still answers.
    await store.updateStatus(created.taskId, 'completed');
    expect((await store.get(created.taskId))?.status).toBe('completed');
  }, 120_000);

  it('serves from memory and then RECOVERS to persistent storage on a later call', async () => {
    useStoreRoleEnv('task_store_fixture');
    // Consume the store role's only connection the way the boot migration burst consumed the
    // pool. The store's private pool is built from the same env and cannot get a connection.
    const holder = new Pool({
      host: '127.0.0.1', port, user: STORE_ROLE, password, database: 'task_store_fixture',
      max: 1, connectionTimeoutMillis: 5_000,
    });
    const held = await holder.connect();
    let releasedHeldClient = false;
    const release = () => { if (!releasedHeldClient) { releasedHeldClient = true; held.release(); } };
    try {
      const store = new InMemoryTaskStore();

      // The degrade survives: the store answers rather than refusing, which is what keeps the
      // process up when the database is genuinely unavailable.
      const degraded = await store.create({ title: 'created during the burst', processingMode: 'agentic', metadata: {} });
      expect(await store.get(degraded.taskId)).not.toBeNull();
      // ...and it really is memory: the bootstrap never ran, so the table does not exist.
      expect(await tableExists(taskFixture, 'chat_tasks')).toBe(false);

      // The burst ends. Release the held connection and lift the shortage.
      release();
      await holder.end();
      await admin.query(`ALTER ROLE ${STORE_ROLE} CONNECTION LIMIT 10`);

      // The next operation must run the activation again rather than inherit the boot failure.
      // Before the fix the pool was ended and nulled here, so there was nothing left to retry.
      const recovered = await store.create({ title: 'created after the burst', processingMode: 'agentic', metadata: {} });
      expect(await tableExists(taskFixture, 'chat_tasks')).toBe(true);
      const rows = await taskFixture.query<{ task_id: string; title: string }>(
        'SELECT task_id, title FROM chat_tasks ORDER BY created_at',
      );
      // Read back over a SEPARATE connection: the recovered task is genuinely in Postgres, and
      // the one written during the degrade is genuinely not - that is what the fallback costs.
      expect(rows.rows.map(r => r.task_id)).toEqual([recovered.taskId]);
      expect(rows.rows[0]?.title).toBe('created after the burst');
    } finally {
      release();
      await holder.end().catch(() => undefined);
    }
  }, 180_000);

  it('recovers a store handed a pool whose only client was held (the injected-pool family)', async () => {
    const pool = new Pool({ ...connection('escalation_store_fixture'), max: 1, connectionTimeoutMillis: 2_000 });
    const held = await pool.connect();
    let releasedHeldClient = false;
    const release = () => { if (!releasedHeldClient) { releasedHeldClient = true; held.release(); } };
    try {
      process.env.OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS = '0';
      const store = new PostgresSwarmEscalationStore(wrapPoolWithGuc(pool));

      await store.save(escalation('run-during-burst'));
      expect(await tableExists(escalationFixture, 'swarm_escalations')).toBe(false);

      release();

      await store.save(escalation('run-after-burst'));
      expect(await tableExists(escalationFixture, 'swarm_escalations')).toBe(true);
      const rows = await escalationFixture.query<{ run_id: string }>('SELECT run_id FROM swarm_escalations');
      expect(rows.rows.map(r => r.run_id)).toEqual(['run-after-burst']);
    } finally {
      release();
      await pool.end().catch(() => undefined);
    }
  }, 180_000);

});
