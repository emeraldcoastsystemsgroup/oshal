/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Compose real Jarvis HTTP and isolated PostgreSQL with completed signed application execution fixtures.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createProtectedResultFixture } from './protected-results';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { createJarvisRoutes } from '@/app/routes/jarvis-routes';
import { ensureJarvisSchema } from '@/app/routes/jarvis-task-store';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

/**
 * @description Mount real Jarvis routes over disposable storage and server-owned fixture authentication.
 * @param database - Already started, isolated PostgreSQL lifetime owned by this suite.
 * @returns Actual route controls and cleanup, without using an operator database or model.
 */
export async function createProtectedJarvisFixture(database: DisposableAlertPostgres) {
  const fixture = await createProtectedResultFixture(), pool = database.pool;
  await ensureJarvisSchema(pool); await pool.query('TRUNCATE jarvis_tasks');
  const ctx = Object.assign(fixture.ctx, { pool, ticketService: { listTickets: async () => [],
    openChatTicket: async () => ({ ticketId: 'fixture-chat-ticket' }) } });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const actor = fixture.actors[String(req.get('x-fixture-user') || '')];
    if (!actor) { res.sendStatus(401); return; }
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: actor.sub, iss: actor.issuer } };
    runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, next);
  });
  app.use('/api/jarvis', createJarvisRoutes(ctx as never, 'src/api', async () => new Map()));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, user = 'alice', body?: unknown) => fetch(base + '/api/jarvis' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-fixture-user': user, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...fixture, pool, call,
    async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await fixture.close(); } };
}
