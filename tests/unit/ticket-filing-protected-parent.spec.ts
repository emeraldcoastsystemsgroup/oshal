/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Parent selection uses the canonical ticket read verdict, over the real ticket router, HTTP and the real protected-result policy and execution fixture. A protected parent that GET /api/tickets/:id refuses is refused as a parent on POST and PATCH with the same 404 a missing parent gets, and nothing is written: the owner after their result rights are revoked, the exact-principal twin (same sub, another issuer), and an operator without result access. The owner with current rights still files under it.
 */
import express, { type Request } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTicketRoutes } from '@/app/routes/ticket-routes';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { createProtectedResultFixture } from '../fixtures/protected-results';

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];
const MISSING_PARENT = '00000000-0000-4000-8000-00000000dead';

let fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>;
let savedEnv: Record<string, string | undefined>;
let server: Server;
let base: string;
let parentId: string;
let childId: string;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  // The fixture's admin is a real operator here, so it passes ownership and only result rights can refuse it.
  process.env.OSHAL_OPERATOR_SUBS = 'admin';
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
  fixture = await createProtectedResultFixture();
  fixture.ctx.ticketService = new TicketService(new InMemoryTicketStore());
  const parent = await fixture.ctx.ticketService.createTicket(CreateInternalTicketSchema.parse({ title: 'PROTECTED PARENT', ownerSub: 'alice', ticketType: 'task' }));
  parentId = parent.ticketId;
  await fixture.seed(parentId);
  const child = await fixture.ctx.ticketService.createTicket(CreateInternalTicketSchema.parse({ title: 'plain child', ownerSub: 'alice', ticketType: 'task' }));
  childId = child.ticketId;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = fixture.actors[String(req.get('x-fixture-user') || 'alice')];
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: actor.sub, iss: actor.issuer } };
    (req as Request & { isOperator?: boolean }).isOperator = actor.isSwarmAdmin;
    runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
      principalIssuer: actor.issuer, isOperator: actor.isSwarmAdmin }, next));
  });
  app.use('/api/tickets', createTicketRoutes(fixture.ctx));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await fixture?.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** @description Calls the ticket API as one fixture actor. */
function call(path: string, user: string, method = 'GET', body?: unknown): Promise<globalThis.Response> {
  return fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': user },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** @description Every stored ticket id, so a refused create can be shown to write nothing. */
async function storedTicketIds(): Promise<string[]> {
  return (await fixture.ctx.ticketService.listTickets({ limit: 500 })).map((ticket) => ticket.ticketId).sort();
}

/** @description The child's stored parent, so a refused PATCH can be shown to write nothing. */
async function storedParentOfChild(): Promise<string | null> {
  return (await fixture.ctx.ticketService.getTicket(childId))?.parentTicketId ?? null;
}

/** @description Asserts GET refuses the parent and POST refuses it as a parent, creating nothing. */
async function expectCreateRefused(user: string): Promise<void> {
  expect((await call(`/${parentId}`, user)).status).toBe(404);
  const before = await storedTicketIds();
  const created = await call('', user, 'POST', { title: 'child under a parent I cannot read', parentTicketId: parentId });
  expect(created.status).toBe(404);
  expect(await created.json()).toEqual({ error: 'Parent ticket not found' });
  expect(await storedTicketIds()).toEqual(before);
}

/** @description Asserts GET refuses the parent and PATCH refuses re-parenting the child onto it, writing nothing. */
async function expectMoveRefused(user: string): Promise<void> {
  expect((await call(`/${parentId}`, user)).status).toBe(404);
  expect((await call(`/${childId}`, user)).status).toBe(200);
  const moved = await call(`/${childId}`, user, 'PATCH', { parentTicketId: parentId });
  expect(moved.status).toBe(404);
  expect(await moved.json()).toEqual({ error: 'Parent ticket not found' });
  expect(await storedParentOfChild()).toBeNull();
}

describe('a protected parent ticket is selectable only by a caller who can read it', () => {
  it('admits the owner with current result rights, on POST and on PATCH', async () => {
    expect((await call(`/${parentId}`, 'alice')).status).toBe(200);
    const created = await call('', 'alice', 'POST', { title: 'admitted child', parentTicketId: parentId });
    expect(created.status).toBe(201);
    expect((await created.json()).parentTicketId).toBe(parentId);
    expect((await call(`/${childId}`, 'alice', 'PATCH', { parentTicketId: parentId })).status).toBe(200);
    expect(await storedParentOfChild()).toBe(parentId);
  });

  it('refuses the owner on POST once their result rights are revoked, creating nothing', async () => {
    await fixture.change('alice', 'revoke');
    await expectCreateRefused('alice');
  });

  it('refuses the owner on PATCH once their result rights are revoked, moving nothing', async () => {
    await fixture.change('alice', 'revoke');
    await expectMoveRefused('alice');
  });

  it('refuses the exact-principal twin (same sub, another issuer) on POST, creating nothing', async () => {
    await expectCreateRefused('twin');
  });

  it('refuses an operator without result access on POST, creating nothing', async () => {
    await expectCreateRefused('admin');
  });

  it('refuses an operator without result access on PATCH, moving nothing', async () => {
    await expectMoveRefused('admin');
  });

  it('answers an unreadable protected parent exactly like a missing one', async () => {
    await fixture.change('alice', 'revoke');
    const unreadable = await call('', 'alice', 'POST', { title: 'a', parentTicketId: parentId });
    const missing = await call('', 'alice', 'POST', { title: 'b', parentTicketId: MISSING_PARENT });
    expect([unreadable.status, missing.status]).toEqual([404, 404]);
    expect(await unreadable.json()).toEqual(await missing.json());
  });
});
