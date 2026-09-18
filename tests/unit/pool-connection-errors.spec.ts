/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for BACKLOG "Deploy — the api process exits during the bot-recreate storm". The boundary that failed is the pg driver's connection-error routing under a REAL server-side session termination, so nothing on that path is doubled: a disposable postgres:16-alpine with idle_in_transaction_session_timeout set, the real `pg` Pool, the real process-crash-guards, and a child process whose exit code is the verdict. The unowned run reproduces the 2026-09-05 crash exactly (exit 1, "UNCAUGHT EXCEPTION", error text `terminating connection due to idle-in-transaction timeout`); the owned run must survive it with the pool still serving. The server's own log is read back to prove the termination really happened both times.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { ownPoolConnectionErrors } from '@/shared/services/database';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHILD = path.join('tests', 'fixtures', 'pool-connection-errors-child.ts');
/** The server terminates an idle transaction after this; the child idles for four times as long. */
const SERVER_IDLE_TIMEOUT = '500ms';
const CHILD_IDLE_MS = 2_000;
const CHILD_TIMEOUT_MS = 60_000;
const SERVER_TERMINATION = 'terminating connection due to idle-in-transaction timeout';

interface ChildRun {
  status: number | null;
  output: string;
  probes: Record<string, Record<string, unknown>>;
}

let server: DisposablePostgres;

/**
 * @description Run the child fixture under tsx against the disposable server.
 * @param own - Whether the child attaches ownPoolConnectionErrors to its pool.
 * @returns Exit status, combined output, and the parsed JSON probe lines.
 */
function runChild(own: boolean): ChildRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POOL_CHILD_CONNECTION: JSON.stringify(server.connection),
    POOL_CHILD_IDLE_MS: String(CHILD_IDLE_MS),
    POOL_CHILD_OWN: own ? '1' : '0',
  };
  // vitest's own NODE_OPTIONS must not leak into a plain tsx child, and a child inheriting
  // NODE_TEST_CONTEXT exits 0 on failure.
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [require.resolve('tsx/cli'), CHILD], {
    cwd: REPO_ROOT, env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS,
  });
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  const probes: Record<string, Record<string, unknown>> = {};
  for (const line of (run.stdout || '').split('\n')) {
    if (!line.startsWith('{"probe"')) continue;
    const parsed = JSON.parse(line) as Record<string, unknown> & { probe: string };
    probes[parsed.probe] = parsed;
  }
  return { status: run.status, output, probes };
}

/**
 * @description How many sessions the disposable server has terminated for idling in a transaction,
 * read from its own log - the proof that the termination the child saw came from the server.
 * @returns The count of termination lines.
 */
function serverTerminations(): number {
  // PostgreSQL writes its log to the container's STDERR, and `docker logs` replays each stream on
  // its own descriptor - so the termination lines are on stderr, not stdout.
  const run = spawnSync('docker', ['logs', server.containerName], { encoding: 'utf8', timeout: 30_000 });
  const log = `${run.stdout || ''}\n${run.stderr || ''}`;
  return log.split('\n').filter((line) => line.includes(SERVER_TERMINATION)).length;
}

beforeAll(async () => {
  server = new DisposablePostgres({ purpose: 'pool-connection-errors' });
  await server.start();
  // Database-level, like the role-level setting on the deployed server: every new session gets it.
  await server.pool.query(`ALTER DATABASE oshal_fixture SET idle_in_transaction_session_timeout = '${SERVER_IDLE_TIMEOUT}'`);
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

describe('a server-terminated checked-out connection', () => {
  it('unowned: is an uncaught exception, and the crash guards exit the process (the 2026-09-05 shape)', () => {
    const before = serverTerminations();
    const run = runChild(false);
    expect(run.probes['in-transaction'], run.output.slice(0, 600)).toBeDefined();
    expect(run.status).toBe(1);
    expect(run.probes['after-idle']).toBeUndefined();
    expect(run.output).toContain('UNCAUGHT EXCEPTION');
    expect(run.output).toContain(SERVER_TERMINATION);
    expect(serverTerminations()).toBeGreaterThan(before);
  }, 90_000);

  it('owned: is one ERROR line, one rejected statement, and a pool that still serves', () => {
    const before = serverTerminations();
    const run = runChild(true);
    expect(run.probes['in-transaction'], run.output.slice(0, 600)).toBeDefined();
    expect(run.status).toBe(0);
    expect(run.probes['after-idle']).toMatchObject({ commit: 'rejected' });
    expect(String(run.probes['after-idle']?.message)).toContain('not queryable');
    expect(run.probes['pool-serves']).toMatchObject({ one: 1 });
    expect(run.output).toContain('A checked-out Postgres connection was terminated by the server');
    expect(run.output).toContain(SERVER_TERMINATION);
    expect(run.output).not.toContain('UNCAUGHT EXCEPTION');
    expect(serverTerminations()).toBeGreaterThan(before);
  }, 90_000);
});

describe('ownPoolConnectionErrors', () => {
  it('attaches once per pool, and an idle connection killed by the server leaves the pool serving', async () => {
    const pool = new Pool({ ...server.connection, max: 2, connectionTimeoutMillis: 5_000 });
    try {
      expect(ownPoolConnectionErrors(pool, 'spec')).toBe(pool);
      ownPoolConnectionErrors(pool, 'spec-again');
      expect(pool.listenerCount('connect')).toBe(1);
      expect(pool.listenerCount('error')).toBe(1);

      const poolErrors: Error[] = [];
      pool.on('error', (error) => { poolErrors.push(error); });
      const client = await pool.connect();
      const pid = (client as { processID?: number | null }).processID;
      client.release();
      expect(typeof pid).toBe('number');

      // Kill the now-IDLE connection from a second session: pg-pool's idle listener discards it
      // and reports through the pool 'error' event, and the process stays up.
      await server.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      await new Promise((resolve) => { setTimeout(resolve, 1_000); });
      expect(poolErrors.length).toBe(1);
      const rows = await pool.query('SELECT 1 AS one');
      expect(rows.rows[0]?.one).toBe(1);
    } finally {
      await pool.end();
    }
  }, 60_000);
});
