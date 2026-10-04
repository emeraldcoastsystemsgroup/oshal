/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One exact-principal ticket verdict for /api/tickets and the cockpit (P5 step 1), over the real ticket router and HTTP. On a ticket that recorded its owner's issuer, the owner reads it; the same sub from another issuer, the owner's inactive account and a session with no verified actor are refused with the missing-id 404 on load-by-id, parent selection and the state route, and nothing is written; an operator still reads it. A legacy ticket with no recorded issuer still binds by sub alone. For every caller the /api/tickets verdict equals the cockpit verdict.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { createTicketRoutes } from '@/app/routes/ticket-routes';
import { canReadTicket } from '@/app/routes/ticket-application-access';
import { canReadCockpitTicket } from '@/app/routes/cockpit-resource-access';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const OWNER = 'auth0|exact-owner';
const OPERATOR = 'auth0|exact-operator';
const ISSUER = 'https://owner-idp.fixture.test';
const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];

/** Each fixture caller's session sub, and the verified actor production would resolve for it (null: none). */
const CALLERS: Record<string, { sub: string; actor: { issuer: string; isActive: boolean } | null }> = {
  owner: { sub: OWNER, actor: { issuer: ISSUER, isActive: true } },
  twin: { sub: OWNER, actor: { issuer: 'https://other-idp.fixture.test', isActive: true } },
  inactive: { sub: OWNER, actor: { issuer: ISSUER, isActive: false } },
  'no-actor': { sub: OWNER, actor: null },
  operator: { sub: OPERATOR, actor: { issuer: ISSUER, isActive: true } },
};

let savedEnv: Record<string, string | undefined>;
let server: Server;
let base: string;
let ticketService: TicketService;
let ids: { stamped: string; legacy: string; child: string };

/** @description Injects the fixture caller's signed-in session. */
function fixtureSession(req: Request, _res: Response, next: NextFunction): void {
  (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub: CALLERS[String(req.get('x-fixture-caller'))].sub } };
  next();
}

/** @description Production's resolver: the verified actor for the session, or a refusal when there is none. */
async function resolveActor(req: Request): Promise<{ sub: string; issuer: string; isActive: boolean; isSwarmAdmin: boolean }> {
  const caller = CALLERS[String(req.get('x-fixture-caller'))];
  if (!caller.actor) throw new Error('A verified user identity is required for application authorization');
  return { sub: caller.sub, ...caller.actor, isSwarmAdmin: false };
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
  ticketService = new TicketService(new InMemoryTicketStore());
  // Trusted system work is the one path that keeps a supplied owner issuer (bindOwnerPrincipalIssuer).
  const stamped = await runWithSystemIdentity(() => ticketService.createTicket({ title: 'issuer-stamped', ticketType: 'task',
    ownerSub: OWNER, metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER } } as never));
  const legacy = await ticketService.createTicket({ title: 'legacy, no recorded issuer', ticketType: 'task', ownerSub: OWNER } as never);
  const child = await ticketService.createTicket({ title: 'child to re-parent', ticketType: 'task', ownerSub: OWNER } as never);
  ids = { stamped: stamped.ticketId, legacy: legacy.ticketId, child: child.ticketId };
  const ctx = { ticketService, taskStore: new InMemoryTaskStore(), messageStore: {}, orchestrator: {}, pool: {},
    applicationAuthorization: { resolveActor } } as never;
  const app = express();
  app.use(express.json());
  app.use(fixtureSession);
  app.use('/api/tickets', createTicketRoutes(ctx));
  app.get('/verdicts/:id', async (req, res) => {
    const ticket = await ticketService.getTicket(req.params.id);
    res.json({ api: await canReadTicket(ctx, req, ticket as never), cockpit: await canReadCockpitTicket(ctx, req, ticket as never) });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** @description Calls the app as one fixture caller. */
function call(path: string, caller: string, method = 'GET', body?: unknown): Promise<globalThis.Response> {
  return fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-fixture-caller': caller },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** @description What a refused caller could have changed: the ticket count, the child's parent, the stamped status. */
async function writableState(): Promise<unknown[]> {
  return [(await ticketService.listTickets({ limit: 500 })).length,
    (await ticketService.getTicket(ids.child))?.parentTicketId ?? null, (await ticketService.getTicket(ids.stamped))?.status];
}

/** @description Asserts the caller can neither read the stamped ticket nor use it, and wrote nothing. */
async function expectRefused(caller: string): Promise<void> {
  const before = await writableState();
  expect((await call(`/api/tickets/${ids.stamped}`, caller)).status).toBe(404);
  const created = await call('/api/tickets', caller, 'POST', { title: 'child', parentTicketId: ids.stamped });
  expect(created.status).toBe(404);
  expect(await created.json()).toEqual({ error: 'Parent ticket not found' });
  expect((await call(`/api/tickets/${ids.child}`, caller, 'PATCH', { parentTicketId: ids.stamped })).status).toBe(404);
  expect((await call(`/api/tickets/${ids.stamped}/state`, caller, 'PUT', { status: 'cancelled' })).status).toBe(404);
  expect(await writableState()).toEqual(before);
}

describe('one exact-principal ticket verdict', () => {
  it('admits the owner on a ticket that recorded its issuer', async () => {
    expect((await call(`/api/tickets/${ids.stamped}`, 'owner')).status).toBe(200);
    expect((await call('/api/tickets', 'owner', 'POST', { title: 'child', parentTicketId: ids.stamped })).status).toBe(201);
    expect((await call(`/api/tickets/${ids.stamped}/state`, 'owner', 'PUT', { status: 'cancelled' })).status).toBe(200);
  });

  it('refuses the same sub from another issuer', async () => {
    await expectRefused('twin');
  });

  it('refuses the owner\'s inactive account', async () => {
    await expectRefused('inactive');
  });

  it('refuses a session with no verified actor', async () => {
    await expectRefused('no-actor');
  });

  it('still admits an operator', async () => {
    expect((await call(`/api/tickets/${ids.stamped}`, 'operator')).status).toBe(200);
  });

  it('binds by sub alone where the ticket recorded no owner issuer (legacy rows)', async () => {
    expect((await call(`/api/tickets/${ids.legacy}`, 'twin')).status).toBe(200);
    expect((await call(`/api/tickets/${ids.legacy}`, 'inactive')).status).toBe(404);
  });

  it('gives /api/tickets and the cockpit the same verdict for every caller', async () => {
    for (const caller of Object.keys(CALLERS)) {
      for (const id of [ids.stamped, ids.legacy]) {
        const verdicts = await (await call(`/verdicts/${id}`, caller)).json() as { api: boolean; cockpit: boolean };
        expect(verdicts.api, `${caller} on ${id}`).toBe(verdicts.cockpit);
      }
    }
  });
});
