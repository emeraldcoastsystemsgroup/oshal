/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ticket filing integrity over the real ticket router and HTTP: a non-operator pin must pass the direct-call entitlement on create and on PATCH; a parent the caller cannot read is refused 404 with no ticket created (BACKLOG "POST /api/tickets accepts any parentTicketId": non-operator refused, owner and operator allowed); a privileged ticket type needs a super-admin filer and keeps the filer as owner; and a PATCH that echoes unchanged authority fields is not refused.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixture only: the context resolves the signed-in session as an active verified actor, as production's application-authorization runtime always does. The ticket read verdict now requires one (exact-principal ownership, P5 step 1) and fails closed without it. No assertion changed.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { createTicketRoutes } from '@/app/routes/ticket-routes';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';

const ALICE = 'auth0|filing-alice';
const BOB = 'auth0|filing-bob';
const OPERATOR = 'auth0|filing-operator';
const SUPERADMIN = 'auth0|filing-superadmin';
const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_SUPERADMIN_SUBS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];

/** @description The active registry's agent id for a bot name; fails loudly if the bot moved. */
function agentIdOf(name: string): string {
  const id = getActiveRegistry().find((definition) => definition.name === name)?.agentId;
  if (!id) throw new Error(`${name} is not in the active registry; pick another fixture bot`);
  return id;
}

let savedEnv: Record<string, string | undefined>;
let server: Server;
let base: string;
let ticketService: TicketService;

/** @description Calls the ticket API as one fixture user. */
function call(path: string, user: string, method = 'GET', body?: unknown): Promise<globalThis.Response> {
  return fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-fixture-user': user },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** @description Injects a signed-in session for the user named by the fixture header. */
function fixtureSession(req: Request, _res: Response, next: NextFunction): void {
  const sub = String(req.get('x-fixture-user') || ALICE);
  (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
  next();
}

/** @description The verified actor production resolves for a signed-in session: the session's own sub, active. */
async function sessionActor(req: Request): Promise<{ sub: string; issuer: string; isActive: boolean; isSwarmAdmin: boolean }> {
  return { sub: String(req.get('x-fixture-user') || ALICE), issuer: 'https://filing.fixture.test', isActive: true, isSwarmAdmin: false };
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  process.env.OSHAL_SUPERADMIN_SUBS = SUPERADMIN;
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
  ticketService = new TicketService(new InMemoryTicketStore());
  const app = express();
  app.use(express.json());
  app.use(fixtureSession);
  app.use('/api/tickets', createTicketRoutes({
    ticketService, taskStore: new InMemoryTaskStore(), messageStore: {}, orchestrator: {}, pool: {},
    applicationAuthorization: { resolveActor: sessionActor },
  } as never));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** @description How many tickets exist, read through the service rather than the route. */
async function ticketCount(): Promise<number> {
  return (await ticketService.listTickets({})).length;
}

describe('pinned agent (metadata.targetAgentId)', () => {
  it('refuses a non-operator pin to an agent outside its direct-call entitlement, creating nothing', async () => {
    const before = await ticketCount();
    const response = await call('', ALICE, 'POST', { title: 'pin it', metadata: { targetAgentId: agentIdOf('oshal-developer') } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'target_agent_not_permitted' });
    expect(await ticketCount()).toBe(before);
  });

  it('lets a non-operator pin an entitled agent and an operator pin any agent', async () => {
    expect((await call('', ALICE, 'POST', { title: 'open', metadata: { targetAgentId: agentIdOf('general-bot') } })).status).toBe(201);
    expect((await call('', OPERATOR, 'POST', { title: 'op', metadata: { targetAgentId: agentIdOf('oshal-developer') } })).status).toBe(201);
  });

  it('refuses adding a forbidden pin through PATCH after creation', async () => {
    const created = await (await call('', ALICE, 'POST', { title: 'plain' })).json() as { ticketId: string };
    const patched = await call(`/${created.ticketId}`, ALICE, 'PATCH', { metadata: { targetAgentId: agentIdOf('oshal-developer') } });
    expect(patched.status).toBe(403);
    expect((await ticketService.getTicket(created.ticketId))?.metadata?.targetAgentId).toBeUndefined();
  });

  it('does not re-check a pin that a PATCH merely echoes back unchanged', async () => {
    const pin = agentIdOf('oshal-developer');
    const created = await (await call('', OPERATOR, 'POST', { title: 'for alice', ownerSub: ALICE, metadata: { targetAgentId: pin } })).json() as { ticketId: string; metadata: Record<string, unknown> };
    const echoed = await call(`/${created.ticketId}`, ALICE, 'PATCH', { title: 'renamed', metadata: created.metadata });
    expect(echoed.status).toBe(200);
  });
});

describe('parent ticket (parentTicketId)', () => {
  it('refuses a parent the caller cannot read with 404, creating nothing; owner and operator may file', async () => {
    const parent = await ticketService.createTicket({ title: 'alice parent', ticketType: 'task', description: '', status: 'backlog', priority: 'none', labels: [], ownerSub: ALICE } as never);
    const before = await ticketCount();
    const refused = await call('', BOB, 'POST', { title: 'foreign child', parentTicketId: parent.ticketId });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'Parent ticket not found' });
    expect(await ticketCount()).toBe(before);
    expect((await call('', ALICE, 'POST', { title: 'own child', parentTicketId: parent.ticketId })).status).toBe(201);
    expect((await call('', OPERATOR, 'POST', { title: 'operator child', parentTicketId: parent.ticketId })).status).toBe(201);
  });

  it('answers a missing parent exactly like an unreadable one', async () => {
    const response = await call('', BOB, 'POST', { title: 'orphan', parentTicketId: '00000000-0000-4000-8000-00000000dead' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Parent ticket not found' });
  });

  it('refuses re-parenting onto an unreadable parent through PATCH', async () => {
    const parent = await ticketService.createTicket({ title: 'alice parent', ticketType: 'task', description: '', status: 'backlog', priority: 'none', labels: [], ownerSub: ALICE } as never);
    const own = await (await call('', BOB, 'POST', { title: 'bob ticket' })).json() as { ticketId: string };
    expect((await call(`/${own.ticketId}`, BOB, 'PATCH', { parentTicketId: parent.ticketId })).status).toBe(404);
    expect((await ticketService.getTicket(own.ticketId))?.parentTicketId ?? null).toBeNull();
  });
});

describe('privileged ticket type (oshal-dev)', () => {
  it('refuses an operator who is not a super-admin, even filing under a super-admin owner', async () => {
    const response = await call('', OPERATOR, 'POST', { title: 'dev work', ticketType: 'oshal-dev', ownerSub: SUPERADMIN });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'superadmin_required' });
  });

  it('lets a super-admin file one and keeps the filer as owner', async () => {
    process.env.OSHAL_OPERATOR_SUBS = `${OPERATOR},${SUPERADMIN}`;
    const response = await call('', SUPERADMIN, 'POST', { title: 'dev work', ticketType: 'oshal-dev', ownerSub: ALICE });
    expect(response.status).toBe(201);
    expect((await response.json() as { ownerSub: string }).ownerSub).toBe(SUPERADMIN);
  });

  it('refuses turning an existing ticket into a privileged type through PATCH', async () => {
    const own = await (await call('', ALICE, 'POST', { title: 'ordinary' })).json() as { ticketId: string };
    expect((await call(`/${own.ticketId}`, ALICE, 'PATCH', { ticketType: 'oshal-dev' })).status).toBe(403);
    expect((await ticketService.getTicket(own.ticketId))?.ticketType).not.toBe('oshal-dev');
  });
});
