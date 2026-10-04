/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Mount actual Jarvis reads/close over canonical ticket services and qualified identity, SQL and protected-authority seams without provider work; log the qualified actor-resolution failure while keeping guest/refusal behavior.
 */
import express, { type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { vi } from 'vitest';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import type { InternalTicket, CreateInternalTicketInput } from '@/entities/ticket';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { createJarvisRoutes } from '@/app/routes/jarvis-routes';
import { ensureThreadChatTicket } from '@/app/routes/jarvis-thread-tickets';
import { createJarvisTicketReadAccess } from '@/app/routes/jarvis-ticket-read-access';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { createWorkloadDelegationMiddleware } from '@/features/security';
import { getCaller, hasAuthenticatedUserIdentity, isOperator, serviceSecretOr } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer, GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { createGuestSessionInjector, GUEST_COOKIE, mintGuestCookie } from '@/shared/middleware/guest-session';
import { createGuestGuard } from '@/shared/middleware/guest-guard';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';

const logger = createChildLogger({ module: 'jarvis-ticket-principal-fixture' });
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { hasPostgresConfiguration } from '@/shared/services/database/optional-postgres-pool';
import type { DelegationTokenClaims } from '@/shared/types';

export const JARVIS_OWNER = 'oidc|jarvis-principal', JARVIS_OPERATOR = 'oidc|jarvis-operator';
export const JARVIS_ISSUER = 'https://jarvis-idp.fixture.test', JARVIS_TWIN_ISSUER = 'https://jarvis-other.fixture.test';
export const JARVIS_SECRET = 'unit-jarvis-principal-legacy-secret';

/** @description Synthetic durable shelf/authority controls, with every attempted shelf mutation recorded. */
function controls() {
  return { active: true, unavailableActor: false, denied: new Set<string>(), rows: [] as Array<Record<string, unknown>>,
    writes: [] as Array<{ sql: string; params: unknown[] }> };
}
type Controls = ReturnType<typeof controls>;

/** @description SQL seam supplies declared shelf rows; actual return-leg SQL is recorded and applied, not replaced. */
function fixturePool(state: Controls) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('UPDATE jarvis_tasks')) {
      state.writes.push({ sql, params });
      const row = state.rows.find(r => r.id === params[0] && r.user_sub === params[1]);
      if (row && sql.includes("SET status = 'error'")) { row.status = 'error'; row.error = params[2]; return { rows: [{ id: row.id }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT session_id FROM jarvis_tasks')) return { rows: state.rows.filter(r => r.id === params[0]), rowCount: 1 };
    if (sql.includes('FROM jarvis_tasks WHERE user_sub')) return { rows: state.rows.filter(r => r.user_sub === params[0]).map(r => ({ ...r })), rowCount: state.rows.length };
    if (sql.includes('FROM oshal_inbox_messages')) return { rows: [{ subject: 'Own comms', snippet: 'Own signal' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { query, connect: async () => ({ query, release() {} }) };
}

/** @description Browser/PAT seam supplies verified claims; real guest injection follows it. No body or service header supplies claims. */
function fixtureSession(guestSub: string): RequestHandler {
  return (req, _res, next) => {
    const caller = req.get('x-fixture-caller');
    if (caller && caller !== 'guest') {
      const spoof = caller === 'marker-without-issuer' || caller === 'issuer-without-marker';
      const sub = spoof ? guestSub : caller === 'operator' ? JARVIS_OPERATOR : JARVIS_OWNER;
      const issuer = caller === 'no-issuer' ? undefined : caller === 'issuer-without-marker' ? GUEST_PRINCIPAL_ISSUER
        : caller === 'twin' ? JARVIS_TWIN_ISSUER : JARVIS_ISSUER;
      (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true,
        idTokenClaims: { sub, iss: issuer }, user: { sub, iss: issuer, ...(caller === 'marker-without-issuer' ? { is_guest: true } : {}) } };
    }
    next();
  };
}

/** @description Current local-account lookups are doubled, while the actual session/delegation actor resolver runs. */
function actorResolver(pool: ReturnType<typeof fixturePool>, state: Controls) {
  return createApplicationAuthorizationActorResolver(pool as never, { env: {}, localSnapshot: async () => null,
    tenantIds: async () => [], management: async () => false,
    nativePrincipal: async () => {
      if (state.unavailableActor) throw new Error('fixture actor store unavailable');
      return { isActive: state.active, isSwarmAdmin: false };
    } });
}

/** @description Invoke real SEC-01 routing/private verified-claim attachment with explicit signature and durable-consumption doubles. */
function delegationGate(fallback: RequestHandler) {
  return createWorkloadDelegationMiddleware({ fallback, env: { OSHAL_WORKLOAD_DELEGATION_MODE: 'enforce' },
    verifier: { verify: (token: string, expected: { method: string; path: string; body_sha256: string; scope: string[] }) => {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as DelegationTokenClaims;
      assert.equal(claims.method, expected.method); assert.equal(claims.path, expected.path);
      assert.equal(claims.body_sha256, expected.body_sha256); assert(expected.scope.every(scope => claims.scope.includes(scope)));
      return claims;
    } } as never,
    store: { consumeDelegation: async () => 'authorized' } as never });
}

/** @description Protected-result authority port is doubled; real canonical ownership/result predicates consume it. */
function protectedAuthority(state: Controls): void {
  configureProtectedResultAccess({ isProtectedAgent: async () => false, hasTaskResults: async () => false,
    assertResultAccess: async (id: string) => { if (state.denied.has(id)) throw new Error('fixture result revoked'); },
    assertTaskResultAccess: async () => undefined, linkResult: async () => undefined });
}

/** @description Explicit module-witness endpoint exercises carrier creation without claiming to execute production /ask or a model. */
function openCarrier(ctx: AppContext): RequestHandler {
  return async (req, res) => {
    const sub = getCaller(req).sub;
    if (!hasAuthenticatedUserIdentity(req)) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const open = () => ensureThreadChatTicket(ctx, sub as string, String(req.body.sessionId), 'Own fixture chat',
      createJarvisTicketReadAccess(ctx, req));
    let actor;
    try { actor = await ctx.applicationAuthorization?.resolveActor(req); }
    catch (err) { logger.error({ err, sessionId: String(req.body.sessionId) }, 'Jarvis fixture actor resolution failed'); }
    res.json({ id: actor ? await runWithApplicationAuthorizationActor(actor, open) : await open() });
  };
}

/** @description Start one ephemeral loopback server with real read/close routes and in-memory product stores. */
export async function serveJarvisTicketPrincipal() {
  assert.equal(hasPostgresConfiguration(), false, 'This fixture refuses configured PostgreSQL instead of falling back from a live address');
  const state = controls(), pool = fixturePool(state), store = new InMemoryTicketStore();
  const tickets = new TicketService(store), tasks = new InMemoryTaskStore(), messages = new InMemoryMessageStore();
  const resolveActor = actorResolver(pool, state), guest = mintGuestCookie() as { value: string; sub: string };
  protectedAuthority(state);
  const ctx = { pool, ticketService: tickets, taskStore: tasks, messageStore: messages,
    applicationAuthorization: { resolveActor } } as unknown as AppContext;
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use(fixtureSession(guest.sub));
  app.use(createGuestSessionInjector());
  app.use((req, _res, next) => runWithRequestIdentity({ sub: getCaller(req).sub,
    principalIssuer: getAuthenticatedPrincipalIssuer(req), isOperator: isOperator(req) }, next));
  app.use(createGuestGuard());
  const auth: RequestHandler = (req, res, next) => hasAuthenticatedUserIdentity(req) ? next() : res.status(401).json({ error: 'not_authenticated' });
  app.post('/api/jarvis/__fixture/open', openCarrier(ctx));
  app.use('/api/jarvis', delegationGate(serviceSecretOr(auth)), createJarvisRoutes(ctx, process.cwd()));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); configureProtectedResultAccess(undefined); };
  return { base, state, pool, store, tickets, tasks, messages, guest, close,
    list: vi.spyOn(tickets, 'listTickets'), get: vi.spyOn(tickets, 'getTicket'), open: vi.spyOn(tickets, 'openChatTicket'),
    statusWrite: vi.spyOn(tickets, 'updateStatus') };
}
/** @description Owned real-route fixture controls and explicit authority doubles. */
export type JarvisTicketPrincipalFixture = Awaited<ReturnType<typeof serveJarvisTicketPrincipal>>;

/** @description Seed real tickets through TicketService under explicit request provenance (null: legacy unstamped system row). */
export async function seedJarvisTicket(f: JarvisTicketPrincipalFixture, input: Partial<CreateInternalTicketInput> = {},
  issuer: string | null = JARVIS_ISSUER): Promise<InternalTicket> {
  const create = () => f.tickets.createTicket(CreateInternalTicketSchema.parse({ title: 'Own work', ticketType: 'task', status: 'approved',
    ownerSub: JARVIS_OWNER, ...input }));
  return issuer ? runWithRequestIdentity({ sub: input.ownerSub ?? JARVIS_OWNER, principalIssuer: issuer, isOperator: false }, create)
    : runWithSystemIdentity(create);
}

/** @description Construct a read-only or explicit module-witness call; synthetic delegation is not a live security proof. */
export function jarvisPrincipalCall(f: JarvisTicketPrincipalFixture, path: string, caller = 'owner', body?: unknown,
  extra: Record<string, string> = {}): Promise<globalThis.Response> {
  return fetch(f.base + '/api/jarvis' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(caller === 'guest' ? { cookie: `${GUEST_COOKIE}=${f.guest.value}` }
      : caller === 'anonymous' ? {} : { 'x-fixture-caller': caller }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** @description Build fixture-only token-shaped claims consumed by the real middleware's explicit verifier double. */
export function fixtureJarvisDelegation(path: string, issuer = JARVIS_ISSUER, sub = JARVIS_OWNER): string {
  const now = Math.floor(Date.now() / 1000), claims: DelegationTokenClaims = { iss: 'fixture-controller', aud: 'fixture-api',
    sub, principal_iss: issuer, azp: 'fixture-workload', task_id: randomUUID(), method: 'GET', path: '/api/jarvis' + path,
    body_sha256: delegationRequestBodySha256(null), scope: ['jarvis:read'], iat: now, nbf: now, exp: now + 60, jti: randomUUID() };
  return [Buffer.from(JSON.stringify({ typ: 'OSHAL-DLG' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'), 'fixture-signature'].join('.');
}

/** @description Attach protected result metadata through the authoritative task store, not caller ticket creation. */
export async function protectJarvisTicket(f: JarvisTicketPrincipalFixture, id: string, execution: string): Promise<void> {
  await f.tasks.create({ taskId: id, title: 'Protected own work', ownerSub: JARVIS_OWNER, processingMode: 'agentic',
    metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: JARVIS_ISSUER, oshalProtectedExecutions: [execution] } });
}

/** @description Shelf test rows are intentionally own-principal while their linked ticket may be foreign or unavailable. */
export function jarvisShelfRow(ticketId: string | null, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomUUID(), user_sub: JARVIS_OWNER, principal_issuer: JARVIS_ISSUER, kind: 'complex', ticket_id: ticketId,
    session_id: null, title: 'Own shelf', status: 'queued', result: null, error: null, created_at: '2026-10-04', ...overrides };
}
