/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A guest reads the demo tickets the real seeder planted for it. The seeder runs against a stub pool that captures its SQL, so this is not a PostgreSQL commit or RLS check. Each ticket row it inserts before its COMMIT is written straight to an in-memory store, bypassing the ticket service as the raw insert does. Owner, metadata (the parsed jsonb value) and content come from the captured columns, as PostgresTicketStore.mapRow would read them; the store assigns its own id, timestamps and derived state. The rows are then read through the real guest chain in production order: signed guest cookie, guest-session injector, request identity, guest guard, ticket router. The seeding guest reads each one by id and its LIST is exactly them; another guest and the same sub under another issuer are refused. It guards the guest issuer stamp, without which a guest is refused its own demo tickets.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { createTicketRoutes } from '@/app/routes/ticket-routes';
import { seedGuestDemoData } from '@/app/routes/guest-demo-seed';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { createGuestSessionInjector, GUEST_COOKIE, mintGuestCookie } from '@/shared/middleware/guest-session';
import { createGuestGuard } from '@/shared/middleware/guest-guard';
import { getAuthenticatedPrincipalIssuer, GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

const OPERATOR = 'auth0|guest-demo-seed-operator';
const IDP = 'https://idp.fixture.test';
const ENV_KEYS = ['ENABLE_GUEST_MODE', 'SESSION_SECRET', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];

type Seeded = { ids: string[]; metadata: Array<Record<string, unknown>> };
type Caller = { cookie?: string; otherIssuer?: boolean };

let savedEnv: Record<string, string | undefined>;
let server: Server;
let base: string;
let guestA: { value: string; sub: string };
let guestB: { value: string; sub: string };
let seeded: { a: Seeded; b: Seeded };

/**
 * @description Runs the real seeder for a guest sub against a stub pool that captures its SQL, then writes each ticket
 * row it inserted before COMMIT straight to the store, as the seeder's raw insert bypasses the ticket service. Owner,
 * metadata (the parsed jsonb value) and content come from the captured columns, as PostgresTicketStore.mapRow reads
 * them; the store assigns its own id, timestamps and derived state.
 * @param tickets - The store the ticket router reads.
 * @param sub - The guest sub the seeder is handed.
 * @returns The stored ticket ids and each row's metadata.
 */
async function seedThroughRealSeeder(tickets: InMemoryTicketStore, sub: string): Promise<Seeded> {
  const statements: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      const columns = /INSERT INTO tickets \(([^)]+)\)/.exec(sql)?.[1].split(',').map((column) => column.trim());
      if (columns) rows.push(Object.fromEntries(columns.map((column, index) => [column, params[index]])));
      return { rows: [] };
    },
    release: () => undefined,
  };
  await seedGuestDemoData({ connect: async () => client } as never, sub);
  if (statements[statements.length - 1] !== 'COMMIT') throw new Error('the seed transaction did not commit');
  const result: Seeded = { ids: [], metadata: [] };
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata as string) as Record<string, unknown>;
    const ticket = await tickets.create({ title: row.title, description: row.description, ticketType: row.ticket_type,
      status: row.status, priority: row.priority, labels: row.labels, ownerSub: row.owner_sub, metadata } as never);
    result.ids.push(ticket.ticketId);
    result.metadata.push(metadata);
  }
  return result;
}

/** @description The same sub as guest A from an identity provider, placed before the injector (a real session wins). */
function otherIssuer(req: Request, _res: Response, next: NextFunction): void {
  if (req.get('x-other-issuer')) {
    (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, idTokenClaims: { iss: IDP, sub: guestA.sub },
      user: { sub: guestA.sub, iss: IDP } };
  }
  next();
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, { ENABLE_GUEST_MODE: 'true', SESSION_SECRET: 'guest-demo-seed-fixture-signing-secret-0123456789',
    OSHAL_OPERATOR_SUBS: OPERATOR, OSHAL_ALLOW_LEGACY_UNOWNED: 'false' });
  guestA = mintGuestCookie() as { value: string; sub: string };
  guestB = mintGuestCookie() as { value: string; sub: string };
  configureProtectedResultAccess({ isProtectedAgent: async () => false, hasTaskResults: async () => false,
    assertResultAccess: async () => { throw new Error('denied'); },
    assertTaskResultAccess: async () => { throw new Error('denied'); }, linkResult: async () => undefined } as never);
  const tickets = new InMemoryTicketStore();
  seeded = { a: await seedThroughRealSeeder(tickets, guestA.sub), b: await seedThroughRealSeeder(tickets, guestB.sub) };
  const resolveActor = createApplicationAuthorizationActorResolver({} as never, { env: {}, localSnapshot: async () => null,
    tenantIds: async () => [], nativePrincipal: async () => ({ isActive: true, isSwarmAdmin: false }), management: async () => false });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(otherIssuer);
  // Production order (server.ts): guest injector, then request identity, then the guest guard.
  app.use(createGuestSessionInjector());
  app.use((req, _res, next) => runWithRequestIdentity({ sub: getCaller(req).sub, principalIssuer: getAuthenticatedPrincipalIssuer(req),
    isOperator: isOperator(req) }, () => next()));
  app.use(createGuestGuard());
  app.use('/api/tickets', (req, res, next) => ((req as { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()
    ? next() : res.status(401).json({ error: 'not_authenticated' })),
  createTicketRoutes({ ticketService: new TicketService(tickets), taskStore: new InMemoryTaskStore(), messageStore: {},
    orchestrator: {}, pool: {}, applicationAuthorization: { resolveActor } } as never));
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

/** @description GET on the ticket API with a guest cookie, or as guest A's sub from another issuer. */
function read(path: string, caller: Caller): Promise<globalThis.Response> {
  return fetch(base + path, { headers: { ...(caller.cookie ? { cookie: `${GUEST_COOKIE}=${caller.cookie}` } : {}),
    ...(caller.otherIssuer ? { 'x-other-issuer': '1' } : {}) } });
}

/** @description The ticket ids the caller's LIST returns, sorted. */
async function listIds(caller: Caller): Promise<string[]> {
  const response = await read('', caller);
  expect(response.status).toBe(200);
  return ((await response.json()) as { tickets: Array<{ ticketId: string }> }).tickets.map((ticket) => ticket.ticketId).sort();
}

describe('guest demo seed own reads', () => {
  it('stamps every seeded ticket with exactly the guest issuer', () => {
    expect(seeded.a.metadata.length).toBeGreaterThan(0);
    for (const metadata of [...seeded.a.metadata, ...seeded.b.metadata]) {
      expect(metadata).toEqual({ demo: true, source: 'guest-demo-seed', [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: GUEST_PRINCIPAL_ISSUER });
    }
  });

  it('lets each guest read its own demo tickets by id and list exactly them', async () => {
    for (const id of seeded.a.ids) expect((await read(`/${id}`, { cookie: guestA.value })).status, id).toBe(200);
    expect(await listIds({ cookie: guestA.value })).toEqual([...seeded.a.ids].sort());
    expect(await listIds({ cookie: guestB.value })).toEqual([...seeded.b.ids].sort());
  });

  it("refuses another guest's demo tickets with the missing-id 404", async () => {
    for (const id of seeded.a.ids) expect((await read(`/${id}`, { cookie: guestB.value })).status, id).toBe(404);
  });

  it('refuses the same sub authenticated by another issuer', async () => {
    for (const id of seeded.a.ids) expect((await read(`/${id}`, { otherIssuer: true })).status, id).toBe(404);
    expect(await listIds({ otherIssuer: true })).toEqual([]);
  });
});
