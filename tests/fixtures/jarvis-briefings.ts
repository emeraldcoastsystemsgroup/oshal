/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Provide disposable PostgreSQL and real authenticated Jarvis briefing HTTP boundaries.
 */
import express, { type Request, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { JarvisBriefingService } from '@/app/composition/jarvis-briefing-service';
import { configureJarvisBriefingDelivery } from '@/app/routes/jarvis-briefing-delivery';
import { createJarvisBriefingRoutes } from '@/app/routes/jarvis-briefing-routes';
import { createJarvisRoutes } from '@/app/routes/jarvis-routes';
import { ensureJarvisSchema, saveTaskPending, finishTask } from '@/app/routes/jarvis-task-store';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { BriefingDeclaration } from '@/shared/briefings';

export const alice: AuthorizationActor = { sub: 'briefing-user', issuer: 'https://first.fixture.test', isActive: true, isSwarmAdmin: false };
export const otherIssuer: AuthorizationActor = { ...alice, issuer: 'https://other.fixture.test' };
export const source: BriefingDeclaration = { id: 'updates', title: 'Fixture <script> source', sessionId: 'fixture-briefing-updates' };
export const sourceId = 'briefing-fixture:updates';
/** @description Own every persistence and transport resource without using inherited deployment connections.
 * @returns A disposable database, real HTTP fixture and explicit cleanup function.
 */
export async function startBriefingFixture() {
  const database = new DisposableAlertPostgres(); const pool = await database.start();
  let server: Server | undefined;
  try {
    await ensureJarvisSchema(pool);
    await pool.query(readFileSync(resolve('scripts/migrations/130-jarvis-briefing-preferences.sql'), 'utf8'));
    const state = { allowed: true, recipient: alice as AuthorizationActor | null };
    const service = new JarvisBriefingService(pool, { resolveRecipient: async () => state.recipient, canAccess: async () => state.allowed });
    await service.register('briefing-fixture', '1.0.0', [source]);
    const resolveActor = async (req: Request) => req.get('x-fixture-issuer') === 'other' ? otherIssuer : alice;
    const auth: RequestHandler = (req, res, next) => {
      if (req.get('x-fixture-auth') !== '1' && req.get('cookie') !== 'briefing-fixture=1') { res.sendStatus(401); return; }
      (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: alice.sub, iss: req.get('x-fixture-issuer') === 'other' ? otherIssuer.issuer : alice.issuer } };
      next();
    };
    const runtime = { service, resolveActor, targetActor: async (sub: string, issuer: string) => sub === alice.sub && issuer === alice.issuer ? alice : null };
    configureJarvisBriefingDelivery(runtime);
    const app = express(); app.use(express.json());
    app.use('/shared/ui', express.static(resolve('src/shared/ui')));
    app.use('/api/jarvis/briefings', createJarvisBriefingRoutes(service, auth, resolveActor));
    const ctx = { pool, ticketService: { listTickets: async () => [] } };
    app.use('/api/jarvis', auth, createJarvisRoutes(ctx as never, resolve('src/api'), async () => new Map()));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server!.once('listening', done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { pool, service, state, runtime, base,
      async publish(id: string) { const saved = await saveTaskPending(pool, id, alice.sub, source.sessionId, 'Fixture: new update'); if (saved) await finishTask(pool, id, true, 'Fixture source result'); return saved; },
      async call(path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
        return fetch(base + '/api/jarvis/briefings' + path, { method, headers: { 'x-fixture-auth': '1', Origin: base,
          'X-Oshal-Briefing-Request': '1', 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      },
      async stop() { configureJarvisBriefingDelivery(undefined); server?.closeAllConnections(); if (server) await new Promise<void>(done => server!.close(() => done())); await database.stop(); },
    };
  } catch (error) { server?.closeAllConnections(); server?.close(); await database.stop(); throw error; }
}
