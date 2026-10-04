/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Local HTTP fixture uses real routers, ticket/task stores and protected-result policy with explicit synthetic authentication.
 */
import express, { type Request } from 'express';
import { get, type ClientRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createCockpitRoutes } from '@/app/routes/cockpit-routes';
import { createTaskExplorerRoutes } from '@/app/routes/task-explorer-routes';
import { createSwarmOrchestrationRoutes } from '@/app/extensions/swarm/routes/swarm-orchestration-routes';
import { handleCockpitTicketStream, type TicketActivityListener } from '@/app/routes/cockpit-ticket-stream-route';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { createProtectedResultFixture, RESULT_ISSUER } from './protected-results';

/** @description Close a real bounded HTTP server. @param server Owned server. @returns Closed server. */
async function closeServer(server: Server) {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}

/** @description Create only isolated records and a temporary registry. @returns Actual HTTP surfaces and explicit cleanup. */
export async function privateReadsFixture() {
  const fixture = await createProtectedResultFixture();
  fixture.ctx.ticketService = new TicketService(new InMemoryTicketStore());
  const directory = await mkdtemp(path.join(tmpdir(), 'cockpit-private-reads-'));
  Object.assign(fixture.ctx, { configOutputDir: directory });
  await writeFile(path.join(directory, 'projects.json'), JSON.stringify([
    { id: 'registry-secret', name: 'FOREIGN REGISTRY SECRET', identifier: 'registry-secret', projectId: 'registry-secret', workspaceSlug: 'registry-secret' },
    { id: 'shared-id', name: 'FOREIGN COLLISION LABEL', identifier: 'shared-id', projectId: 'shared-id', workspaceSlug: 'shared-id' },
  ]));
  const app = express(), bus = new Set<TicketActivityListener>(); app.use(express.json());
  app.use((req, res, next) => {
    const actor = fixture.actors[String(req.get('x-fixture-user'))];
    if (!actor) { res.sendStatus(401); return; }
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: actor.sub, iss: actor.issuer } } });
    runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
      principalIssuer: actor.issuer, isOperator: actor.isSwarmAdmin }, next));
  });
  app.use('/api/v1', createCockpitRoutes(fixture.ctx));
  app.use('/api/v1', createTaskExplorerRoutes(fixture.ctx));
  app.use('/fallback', createTaskExplorerRoutes(fixture.ctx));
  app.get('/helper/:ticketId/stream', handleCockpitTicketStream(fixture.ctx, bus));
  const listEscalations = vi.fn((_req, res) => res.json({ success: true, escalations: ['OPERATOR RECORD'] }));
  app.use('/api/swarm', createSwarmOrchestrationRoutes({ listEscalations,
    smokeTest: vi.fn(), processProvider: vi.fn(), listRuns: vi.fn(), getRun: vi.fn(),
    listWorkItems: vi.fn(), submitTickets: vi.fn() } as never));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...fixture, directory, bus, base, listEscalations,
    call: (route: string, user = 'alice') => fetch(base + route, { headers: { 'x-fixture-user': user } }),
    ticket: (ownerSub = 'alice', metadata: Record<string, unknown> = {}) => runWithRequestIdentity({ sub: ownerSub,
      principalIssuer: RESULT_ISSUER, isOperator: false }, () => fixture.ctx.ticketService.createTicket(
        CreateInternalTicketSchema.parse({ title: 'PRIVATE TICKET', ownerSub, ticketType: 'task', metadata }))),
    close: async () => { await closeServer(server); await fixture.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

/** @description Observe actual SSE bytes and terminal cleanup. @param url Local route. @param user Synthetic caller. @returns Actual response/stream. */
export function observeStream(url: string, user = 'alice') {
  return new Promise<{ status: number; cacheControl?: string; request: ClientRequest; text: () => string; next: () => Promise<string>; ended: Promise<void> }>((done, reject) => {
    const request = get(url, { headers: { 'x-fixture-user': user } }, response => {
      let content = ''; const chunks: string[] = [], waiters: Array<(s: string) => void> = [];
      const ended = new Promise<void>(resolve => response.once('end', resolve));
      response.on('data', bytes => { const s = String(bytes); content += s;
        const waiter = waiters.shift(); if (waiter) waiter(s); else chunks.push(s); });
      done({ status: response.statusCode!, cacheControl: response.headers['cache-control'], request, text: () => content, ended,
        next: () => chunks.length ? Promise.resolve(chunks.shift()!) : new Promise(resolve => waiters.push(resolve)) });
    });
    request.once('error', reject);
  });
}
