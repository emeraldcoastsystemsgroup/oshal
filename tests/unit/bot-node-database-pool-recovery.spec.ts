/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the bot that lost the cold-start race to Postgres and was pool-less for life while reporting healthy (2026-09-16 and 2026-09-17; 28 of 36 bots). The boundary that failed is the socket, so nothing here doubles it: the recoverable connect runs against a loopback port with NOTHING listening, exhausts its boot window, and only THEN is a real disposable PostgreSQL started on that port. Proven: the pool object handed out at exhaustion is the one that later answers; the real health routes over real HTTP fail `curl -f` (the Dockerfile.oshal HEALTHCHECK command) until the database answers and pass after; the real posture guard with the real ownership reader refuses with database_pool_unavailable while the socket is dead and returns to the authorization code once a database ANSWERS with an error; the one-shot connectPool still returns null. Scoped double: none. Not covered here: a probe of a built image.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectPool, connectRecoverableBotNodeDatabase, type BotNodeDatabase } from '@/app/bot-node-database-pool';
import { registerBotNodeHealthRoutes } from '@/app/bot-node-health-routes';
import { readProtectedBotApplication } from '@/app/bot-node-application-authorization';

const CONTAINER = `oshal-bot-pool-recovery-fixture-${randomUUID()}`;
const ENV_KEYS = ['DATABASE_URL', 'BOT_DB_CONNECT_ATTEMPTS', 'BOT_DB_CONNECT_RETRY_MS', 'BOT_DB_RECOVERY_MAX_DELAY_MS'] as const;
const AGENT = '00000000-0000-4000-8000-00000000b07a';
const savedEnv = new Map<string, string | undefined>();

let database: BotNodeDatabase;
let healthServer: Server;
let healthUrl = '';
let databasePort = 0;
let containerStarted = false;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
}

/** A loopback port that nothing is listening on: bound once to reserve the number, then released. */
async function reserveClosedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/**
 * The container HEALTHCHECK, verbatim in behaviour: `curl -f <url>`; the exit code is the verdict.
 * Asynchronous on purpose: the probed server runs in THIS process, and a synchronous spawn would
 * block the event loop it needs to answer.
 */
function curlFailOnError(url: string): Promise<number> {
  return new Promise((done) => {
    execFile('curl', ['-f', '-s', '-o', '-', url], { timeout: 15_000 }, (err) => done(err ? ((err as { code?: number | string }).code as number) ?? -1 : 0));
  });
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  databasePort = await reserveClosedPort();
  const password = randomUUID();
  process.env.DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:${databasePort}/oshal_fixture`;
  process.env.BOT_DB_CONNECT_ATTEMPTS = '2';
  process.env.BOT_DB_CONNECT_RETRY_MS = '100';
  process.env.BOT_DB_RECOVERY_MAX_DELAY_MS = '500';
  savedEnv.set('__password', password);
}, 30_000);

afterAll(async () => {
  database?.stop();
  try { await database?.pool?.end(); } catch { /* the pool may never have opened a client */ }
  if (healthServer) await new Promise<void>((done) => healthServer.close(() => done()));
  if (containerStarted) { try { docker(['rm', '--force', CONTAINER]); } catch { /* an --rm container may already be gone */ } }
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}, 120_000);

describe('a bot-node that loses the cold-start race to Postgres', () => {
  it('keeps the one-shot contract: connectPool gives up and returns null', async () => {
    expect(await connectPool()).toBeNull();
  }, 30_000);

  it('exhausts its boot window WITHOUT discarding the pool, and answers unhealthy', async () => {
    database = await connectRecoverableBotNodeDatabase();
    expect(database.pool).not.toBeNull();
    expect(database.status()).toMatchObject({ configured: true, ready: false });
    expect(database.status().attempts).toBeGreaterThanOrEqual(2);

    const app = express();
    registerBotNodeHealthRoutes(app, { databaseStatus: database.status, describe: () => ({ runtime: 'bot-node' }) });
    healthServer = createServer(app);
    await new Promise<void>((done) => healthServer.listen(0, '127.0.0.1', done));
    healthUrl = `http://127.0.0.1:${(healthServer.address() as AddressInfo).port}`;

    for (const path of ['/health', '/api/health']) {
      const response = await fetch(`${healthUrl}${path}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: 'unhealthy', reason: 'database_pool_unavailable' });
    }
    // The exact verdict Docker reads: curl -f exits 22 on an HTTP error status.
    expect(await curlFailOnError(`${healthUrl}/health`)).toBe(22);
  }, 60_000);

  it('refuses protected posture with the DATABASE as the named cause while the socket is dead', async () => {
    const raised = await readProtectedBotApplication(database.pool, AGENT, AGENT).catch((err) => err);
    expect(raised).toMatchObject({ name: 'BotApplicationAuthorizationError', code: 'database_pool_unavailable', status: 503 });
  }, 30_000);

  it('recovers on the FIRST success once a real Postgres starts AFTER it, through the same pool', async () => {
    const poolAtExhaustion = database.pool;
    docker(['run', '--detach', '--rm', '--name', CONTAINER, '--label', 'oshal.test-fixture=bot-pool-recovery-postgres',
      '--publish', `127.0.0.1:${databasePort}:5432`, '--tmpfs', '/var/lib/postgresql/data', '--memory', '256m', '--cpus', '1',
      '--env', `POSTGRES_PASSWORD=${savedEnv.get('__password')}`, '--env', 'POSTGRES_DB=oshal_fixture', 'postgres:16-alpine']);
    containerStarted = true;

    await database.whenReady;
    expect(database.status()).toMatchObject({ configured: true, ready: true });
    expect(database.status().lastError).toBeUndefined();
    expect(database.pool).toBe(poolAtExhaustion);
    const answer = await poolAtExhaustion!.query('SELECT current_database() AS name');
    expect(answer.rows[0].name).toBe('oshal_fixture');

    const response = await fetch(`${healthUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', database: { configured: true, ready: true } });
    expect(await curlFailOnError(`${healthUrl}/health`)).toBe(0);
  }, 180_000);

  it('goes back to the authorization code once a database ANSWERS with an error', async () => {
    // This private server has no oshal_application_execution_claims helper, so the read fails
    // with a SQL error from a reachable database: a posture fault, not a pool outage.
    const raised = await readProtectedBotApplication(database.pool, AGENT, AGENT).catch((err) => err);
    expect(raised).toMatchObject({ code: 'authorization_bot_posture_unavailable', status: 503 });
  }, 30_000);
});

describe('the long-lived server cannot go back to serving 200 without a pool', () => {
  const root = resolve(__dirname, '../..');
  const server = readFileSync(resolve(root, 'src/app/bot-node-server.ts'), 'utf8');

  it('builds its runtime with the recoverable database and mounts only the database-aware probes', () => {
    expect(server).toContain('createBotNodeRuntime({ recoverDatabase: true })');
    expect(server).toContain('registerBotNodeHealthRoutes(app,');
    expect(server).not.toMatch(/app\.get\(\s*['"]\/(api\/)?health['"]/);
  });

  it('is probed by Docker on the path those routes own, with a command that fails on 503', () => {
    const dockerfile = readFileSync(resolve(root, 'Dockerfile.oshal'), 'utf8');
    expect(dockerfile).toMatch(/HEALTHCHECK[^\n]*\\\r?\n\s*CMD curl -f http:\/\/localhost:5000\/health \|\| exit 1/);
  });
});
