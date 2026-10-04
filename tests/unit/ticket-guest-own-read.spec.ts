/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guest own-ticket reads through the REAL guest chain in production order: cookie parsing, the signed guest-session injector with real minted cookies, the server's request-identity middleware, the guest guard, the production actor resolver (its DB lookups injected), and the ticket router. A guest reads its own guest-stamped ticket by id and in its LIST. Refused with the missing-id 404: its own unstamped row, another guest's ticket, operator-owned, ownerless and protected-app tickets. A marker without the guest issuer and a guest issuer without the marker are both refused, and a forged cookie gets no session. Guest mutations stay blocked by the guard before any route.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { createTicketRoutes } from '@/app/routes/ticket-routes';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { createGuestSessionInjector, GUEST_COOKIE, mintGuestCookie } from '@/shared/middleware/guest-session';
import { createGuestGuard } from '@/shared/middleware/guest-guard';
import { getAuthenticatedPrincipalIssuer, GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';

const OPERATOR = 'auth0|guest-read-operator';
const IDP = 'https://idp.fixture.test';
const PROTECTED_AGENT = 'protected-app-bot';
const ENV_KEYS = ['ENABLE_GUEST_MODE', 'SESSION_SECRET', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];

let savedEnv: Record<string, string | undefined>;
let server: Server;
let base: string;
let ticketService: TicketService;
let guestA: { value: string; sub: string };
let guestB: { value: string; sub: string };
let ids: Record<'ownStamped' | 'ownUnstamped' | 'foreign' | 'operatorOwned' | 'ownerless' | 'ownProtected', string>;

/** @description Creates a ticket the way the product does under the given request identity (null: none). */
async function createAs(identity: { sub: string; issuer: string } | null, input: Record<string, unknown>): Promise<string> {
  const create = () => ticketService.createTicket({ title: 'guest work', ticketType: 'task', ...input } as never);
  const ticket = identity ? await runWithRequestIdentity({ sub: identity.sub, principalIssuer: identity.issuer, isOperator: false }, create)
    : await create();
  return ticket.ticketId;
}

/** @description A spoofed session placed before the injector (a real session wins, so the injector is a no-op). */
function spoof(req: Request, _res: Response, next: NextFunction): void {
  const kind = req.get('x-spoof');
  if (kind === 'marker-without-issuer') {
    (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, idTokenClaims: { iss: IDP, sub: guestA.sub },
      user: { sub: guestA.sub, iss: IDP, is_guest: true } };
  } else if (kind === 'issuer-without-marker') {
    (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub: guestA.sub, iss: GUEST_PRINCIPAL_ISSUER } };
  }
  next();
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, { ENABLE_GUEST_MODE: 'true', SESSION_SECRET: 'guest-own-read-fixture-signing-secret-0123456789',
    OSHAL_OPERATOR_SUBS: OPERATOR, OSHAL_ALLOW_LEGACY_UNOWNED: 'false' });
  guestA = mintGuestCookie() as { value: string; sub: string };
  guestB = mintGuestCookie() as { value: string; sub: string };
  configureProtectedResultAccess({ isProtectedAgent: async (agent: string) => agent === PROTECTED_AGENT,
    hasTaskResults: async () => false, assertResultAccess: async () => { throw new Error('denied'); },
    assertTaskResultAccess: async () => { throw new Error('denied'); }, linkResult: async () => undefined } as never);
  ticketService = new TicketService(new InMemoryTicketStore());
  const asGuestA = { sub: guestA.sub, issuer: GUEST_PRINCIPAL_ISSUER };
  ids = {
    ownStamped: await createAs(asGuestA, { ownerSub: guestA.sub }),
    ownUnstamped: await createAs(null, { ownerSub: guestA.sub }),
    foreign: await createAs({ sub: guestB.sub, issuer: GUEST_PRINCIPAL_ISSUER }, { ownerSub: guestB.sub }),
    operatorOwned: await runWithSystemIdentity(() => createAs(null, { ownerSub: OPERATOR, metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: IDP } })),
    ownerless: await createAs(null, { ownerSub: null }),
    ownProtected: await createAs(asGuestA, { ownerSub: guestA.sub, assignedAgentId: PROTECTED_AGENT }),
  };
  const resolveActor = createApplicationAuthorizationActorResolver({} as never, { env: {}, localSnapshot: async () => null,
    tenantIds: async () => [], nativePrincipal: async () => ({ isActive: true, isSwarmAdmin: false }), management: async () => false });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(spoof);
  // Production order (server.ts): guest injector, then request identity, then the guest guard.
  app.use(createGuestSessionInjector());
  app.use((req, _res, next) => runWithRequestIdentity({ sub: getCaller(req).sub, principalIssuer: getAuthenticatedPrincipalIssuer(req),
    isOperator: isOperator(req) }, () => next()));
  app.use(createGuestGuard());
  app.use('/api/tickets', (req, res, next) => ((req as { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()
    ? next() : res.status(401).json({ error: 'not_authenticated' })),
  createTicketRoutes({ ticketService, taskStore: new InMemoryTaskStore(), messageStore: {}, orchestrator: {}, pool: {},
    applicationAuthorization: { resolveActor } } as never));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  configureProtectedResultAccess(undefined);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** @description Calls the ticket API with a guest cookie (or a forged one) and an optional spoof header. */
function call(path: string, cookie: string, method = 'GET', options: { spoof?: string; body?: unknown } = {}): Promise<globalThis.Response> {
  return fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `${GUEST_COOKIE}=${cookie}`,
    ...(options.spoof ? { 'x-spoof': options.spoof } : {}) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
}

describe('guest own-ticket reads', () => {
  it('reads its own guest-stamped ticket by id and in its LIST', async () => {
    expect((await call(`/${ids.ownStamped}`, guestA.value)).status).toBe(200);
    const list = await (await call('', guestA.value)).json() as { tickets: Array<{ ticketId: string }> };
    expect(list.tickets.map((ticket) => ticket.ticketId)).toEqual([ids.ownStamped]);
  });

  it('refuses everything else by id with the missing-id 404', async () => {
    for (const id of [ids.ownUnstamped, ids.foreign, ids.operatorOwned, ids.ownerless, ids.ownProtected]) {
      expect((await call(`/${id}`, guestA.value)).status, id).toBe(404);
    }
  });

  it('refuses a guest marker without the guest issuer, and the guest issuer without the marker', async () => {
    expect((await call(`/${ids.ownStamped}`, guestA.value, 'GET', { spoof: 'marker-without-issuer' })).status).toBe(404);
    expect((await call(`/${ids.ownStamped}`, guestA.value, 'GET', { spoof: 'issuer-without-marker' })).status).toBe(404);
  });

  it('gives a forged cookie no session', async () => {
    expect((await call(`/${ids.ownStamped}`, `${guestA.value}x`)).status).toBe(401);
  });

  it('keeps every guest mutation blocked by the guard before the route', async () => {
    const before = (await ticketService.getTicket(ids.ownStamped))?.status;
    expect((await call(`/${ids.ownStamped}/status`, guestA.value, 'PUT', { body: { status: 'cancelled' } })).status).toBe(403);
    expect((await call(`/${ids.ownStamped}`, guestA.value, 'PATCH', { body: { title: 'renamed' } })).status).toBe(403);
    expect((await call(`/${ids.ownStamped}`, guestA.value, 'DELETE')).status).toBe(403);
    expect((await ticketService.getTicket(ids.ownStamped))?.status).toBe(before);
  });
});
