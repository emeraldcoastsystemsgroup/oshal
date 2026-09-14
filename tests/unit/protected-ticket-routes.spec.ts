/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify real ticket HTTP surfaces enforce current protected-result rights and immutable queue ownership.
 */
import express, { type Request } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTicketRoutes } from '@/app/routes/ticket-routes';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { createProtectedResultFixture, RESULT_ISSUER } from '../fixtures/protected-results';

let fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>, server: Server, base: string, ticketId: string;
beforeEach(async () => {
  fixture = await createProtectedResultFixture(); fixture.ctx.ticketService = new TicketService(new InMemoryTicketStore());
  const ticket = await fixture.ctx.ticketService.createTicket({ title: 'PRIVATE TICKET', ownerSub: 'alice', ticketType: 'task' });
  ticketId = ticket.ticketId; await fixture.seed(ticketId);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const actor = fixture.actors[String(req.get('x-fixture-user') || 'alice')];
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: actor.sub, iss: actor.issuer } };
    (req as Request & { isOperator?: boolean }).isOperator = actor.isSwarmAdmin;
    runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
      principalIssuer: actor.issuer, isOperator: actor.isSwarmAdmin }, next));
  });
  app.use('/api/tickets', createTicketRoutes(fixture.ctx));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await fixture?.close(); });

function call(path: string, user = 'alice', method = 'GET', body?: unknown) {
  return fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': user },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

it('releases protected ticket detail only to the exact authorized principal', async () => {
  expect((await call(`/${ticketId}`)).status).toBe(200);
  for (const user of ['bob', 'twin', 'admin']) {
    const response = await call(`/${ticketId}`, user); expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('PRIVATE TICKET');
  }
});

it('withholds detail and listing immediately after access is revoked', async () => {
  expect(JSON.stringify(await (await call('')).json())).toContain('PRIVATE TICKET');
  await fixture.change('alice', 'revoke');
  expect((await call(`/${ticketId}`)).status).toBe(404);
  expect(JSON.stringify(await (await call('')).json())).not.toContain('PRIVATE TICKET');
});

it('forces nonoperator creation to the verified owner and strips forged authority', async () => {
  const response = await call('', 'alice', 'POST', { title: 'Queued work', ownerSub: 'admin',
    metadata: { oshalOwnerPrincipalIssuer: 'https://forged.test', oshalProtectedExecutions: ['forged'] } });
  expect(response.status).toBe(201); const ticket = await response.json();
  expect(ticket.ownerSub).toBe('alice'); expect(readOwnerPrincipalIssuer(ticket.metadata)).toBe(RESULT_ISSUER);
  expect(ticket.metadata).not.toHaveProperty('oshalProtectedExecutions');
});

it('rejects owner reassignment through the real PATCH path', async () => {
  const response = await call(`/${ticketId}`, 'alice', 'PATCH', { ownerSub: 'admin' });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect((await fixture.ctx.ticketService.getTicket(ticketId))!.ownerSub).toBe('alice');
});
