/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify durable remote and queued authority against isolated PostgreSQL, forced RLS and real HTTP.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { LocalAccountFixture } from '../fixtures/local-account-administration';
import { RemoteExecutionFixture } from '../fixtures/application-remote-execution';
import { PostgresRemoteExecutionStore, REMOTE_EXECUTION_SCHEMA } from '@/features/application-remote-execution';
import { PostgresQueuedApplicationPrincipalStore, QUEUED_APPLICATION_PRINCIPAL_SCHEMA } from '@/features/ticketing';
import { createApplicationRemoteExecutionRoutes } from '@/app/routes/application-remote-execution-routes';
import { REMOTE_EXECUTION_PATH } from '@/shared/application-remote-execution';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';

const database = new LocalAccountFixture();
let fixture: RemoteExecutionFixture; let server: http.Server; let base: string;

beforeAll(async () => {
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', ''); await database.start();
  for (const file of ['132-application-remote-executions.sql', '133-queued-application-principals.sql']) {
    await database.owner.query(readFileSync('scripts/migrations/' + file, 'utf8'));
  }
  for (const statement of [...REMOTE_EXECUTION_SCHEMA, ...QUEUED_APPLICATION_PRINCIPAL_SCHEMA]) await database.owner.query(statement);
  await database.owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO users_runtime');
}, 90_000);
beforeEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  await database.owner.query('TRUNCATE oshal_application_remote_executions,oshal_queued_application_principals');
  fixture = await new RemoteExecutionFixture(new PostgresRemoteExecutionStore(database.runtime)).start();
  const app = express(); app.use(createApplicationRemoteExecutionRoutes(fixture.authority, (req, res, next) => {
    if (req.get('x-service-secret') !== 'fixture-service') { res.status(401).json({ error: 'machine_required' }); return; } next();
  }));
  server = http.createServer(app); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  await database.close(); vi.unstubAllEnvs();
}, 30_000);

async function post(body: unknown, authenticated = true) {
  const response = await fetch(base + REMOTE_EXECUTION_PATH, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(authenticated ? { 'x-service-secret': 'fixture-service' } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

it('requires machine and exact original signed proof at the fixed bounded HTTP endpoint', async () => {
  const dispatch = await fixture.dispatch(); const input = { executionId: dispatch.executionId, token: dispatch.token, phase: 'start', nonce: randomUUID() };
  expect((await post(input, false)).status).toBe(401);
  expect((await post({ ...input, actor: fixture.admin })).status).toBe(400);
  expect((await post({ ...input, token: 'forged-token-value' })).status).toBe(403);
  const allowed = await post(input);
  expect(allowed.status).toBe(200); expect(allowed.headers.get('cache-control')).toBe('no-store');
  expect(allowed.body.permit).toMatchObject({ executionId: dispatch.executionId, phase: 'start' });
  expect((await post(input)).status).toBe(409);
  expect((await post({ ...input, padding: 'x'.repeat(40_000) })).status).toBe(400);
  expect((await fetch(base + '/api/internal/application-executions/anything')).status).toBe(404);
});

it('retains exact provenance across repository recreation and accepts one concurrent start', async () => {
  const dispatch = await fixture.dispatch();
  const started = await Promise.allSettled([fixture.check(dispatch, 'start'), fixture.check(dispatch, 'start')]);
  expect(started.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const restarted = new PostgresRemoteExecutionStore(database.runtime);
  expect(await restarted.read(dispatch.executionId)).toMatchObject({ status: 'started', actor: { sub: fixture.actor.sub, issuer: fixture.actor.issuer },
    claims: { jti: dispatch.receipt.claims.jti } });
  expect(JSON.stringify(await restarted.read(dispatch.executionId))).not.toContain(dispatch.token);
  await fixture.check(dispatch, 'complete');
  await fixture.authority.linkResult(dispatch.executionId, 'aggregate-one', fixture.actor);
  expect((await restarted.byTask('aggregate-one')).map(row => row.binding.executionId)).toEqual([dispatch.executionId]);
});

it('never exposes or mutates controller records under ordinary database identity', async () => {
  const dispatch = await fixture.dispatch();
  await runWithRequestIdentity({ sub: fixture.actor.sub, principalIssuer: fixture.actor.issuer, isOperator: false }, async () => {
    expect((await database.runtime.query('SELECT * FROM oshal_application_remote_executions')).rowCount).toBe(0);
    expect((await database.runtime.query("UPDATE oshal_application_remote_executions SET payload='{}'")).rowCount).toBe(0);
    await expect(database.runtime.query("INSERT INTO oshal_application_remote_executions(execution_id,payload) VALUES($1,'{}')", [randomUUID()])).rejects.toThrow(/row-level security/);
  });
  expect(await fixture.store.read(dispatch.executionId)).not.toBeNull();
});

it('releases every client before policy reads even when the pool has only one connection', async () => {
  const options = database.owner.options;
  const raw = new Pool({ host: options.host, port: options.port, database: options.database, user: 'users_runtime', password: 'fixture-runtime', max: 1, connectionTimeoutMillis: 500 });
  const pool = wrapPoolWithGuc(raw);
  try {
    fixture = await new RemoteExecutionFixture(new PostgresRemoteExecutionStore(pool)).start();
    fixture.beforeAuthorize = async () => { await pool.query('SELECT 1'); };
    const dispatch = await fixture.dispatch();
    const results = await Promise.allSettled([fixture.check(dispatch, 'start'), fixture.check(dispatch, 'start')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await fixture.check(dispatch, 'complete');
    expect(raw.waitingCount).toBe(0); expect(raw.idleCount).toBe(1);
  } finally { await pool.end(); }
});

it('atomically preserves concurrent aggregate links and detects foreign-owner lineage', async () => {
  const dispatch = await fixture.dispatch(); await fixture.check(dispatch, 'start'); await fixture.check(dispatch, 'complete');
  await Promise.all(['parent-a', 'parent-b', 'parent-c'].map(task => fixture.authority.linkResult(dispatch.executionId, task, fixture.actor)));
  expect((await fixture.store.read(dispatch.executionId))!.resultTaskIds?.sort()).toEqual(['parent-a', 'parent-b', 'parent-c']);
  const original = (await fixture.store.read(dispatch.executionId))!;
  await fixture.store.insert({ ...original, binding: { ...original.binding, executionId: randomUUID(), issuer: 'https://microsoft.fixture' } });
  expect(await fixture.authority.hasTaskResults('parent-a')).toBe(true);
  await expect(fixture.authority.assertTaskResultAccess('parent-a', fixture.actor)).rejects.toThrow('remote_execution_result_owner_mismatch');
});

it('captures queued authority once, preserves directory timestamps across restart and applies forced RLS', async () => {
  const store = new PostgresQueuedApplicationPrincipalStore(database.runtime, Promise.resolve());
  const actor = { ...fixture.actor, directory: [{ issuer: 'https://directory.fixture', tenantId: 'tenant', groups: ['g'],
    observedAt: new Date(fixture.now - 30_000).toISOString(), complete: true }], allowedPermissions: ['fixture-app:bot.execute'] };
  await store.capture('queued-ticket', actor); await store.capture('queued-ticket', fixture.admin);
  expect(await new PostgresQueuedApplicationPrincipalStore(database.runtime, Promise.resolve()).read('queued-ticket')).toEqual(actor);
  await runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, async () => {
    expect((await database.runtime.query('SELECT * FROM oshal_queued_application_principals')).rowCount).toBe(0);
    expect((await database.runtime.query("UPDATE oshal_queued_application_principals SET actor='{}'")).rowCount).toBe(0);
    await expect(database.runtime.query("INSERT INTO oshal_queued_application_principals(ticket_id,actor) VALUES('forged','{}')")).rejects.toThrow(/row-level security/);
  });
});

it('keeps completed history available after a failed later attempt but still denies revoked completed lineage', async () => {
  const completed = await fixture.dispatch(); await fixture.check(completed, 'start'); await fixture.check(completed, 'complete');
  const failed = await fixture.dispatch(); await fixture.check(failed, 'start');
  expect((await fixture.store.byTask('fixture-task')).map(row => row.binding.executionId)).toEqual([completed.executionId]);
  await fixture.authority.assertTaskResultAccess('fixture-task', fixture.actor);
  await fixture.store.update(completed.executionId, async row => { row.status = 'revoked'; });
  expect(await fixture.authority.hasTaskResults('fixture-task')).toBe(true);
  await expect(fixture.authority.assertTaskResultAccess('fixture-task', fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
});
